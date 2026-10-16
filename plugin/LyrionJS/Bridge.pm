package Plugins::LyrionJS::Bridge;

# A byte pipe between a browser's WebSocket and LMS's own Slimproto port.
#
# The page speaks Slimproto itself; this module only moves its bytes, with three checks:
#   - only the page LMS served may open the socket (Origin);
#   - a new session must start with a HELO whose MAC has LyrionJS's prefix, so a page can't
#     impersonate a hardware player;
#   - one session per player MAC.
# When the WebSocket drops, the LMS connection is held for HOLD seconds and what the browser
# missed is replayed when it resumes. Protocol: docs/ARCHITECTURE.md.

use strict;

use Digest::SHA qw(sha1_base64);
use IO::Socket::INET;
use JSON::XS::VersionOneAndTwo;
use Scalar::Util qw(refaddr);
use Socket qw(IPPROTO_TCP TCP_NODELAY);
use Time::HiRes;

use Slim::Utils::Errno;

use constant HOLD         => 10;          # seconds; LMS drops a player silent for 15 s
use constant REPLAY_BYTES => 256 * 1024;  # Slimproto bytes kept for a resume
use constant MAX_MESSAGE  => 64 * 1024;   # largest message accepted from the page
use constant MAX_SESSIONS => 32;
use constant SLIMPROTO    => 3483;
use constant MAC_PREFIX   => "\x02\x4c\x4a";
use constant WS_GUID      => '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

my ($log, $prefs);
my %conns;     # refaddr(client socket) => { sock, rbuf, frag, fragOp, session }
my %sessions;  # id => { id, secret, mac, up, conn, sent, buf, bufStart, heloOk, helo }
my %byUp;      # refaddr(LMS socket) => session id

sub init {
	my ($class, $logger, $pluginPrefs) = @_;
	$log = $logger;
	$prefs = $pluginPrefs;
	Slim::Web::Pages->addRawFunction(qr{^/plugins/LyrionJS/ws$}, \&_upgrade);
	Slim::Web::Pages->addRawFunction(qr{^/plugins/LyrionJS/log$}, \&_clientLog);
}

sub shutdown {
	_endSession($_, 1001) for values %sessions;
	_closeConn($_, 1001) for values %conns;
}

sub sessionCount { scalar keys %sessions }

sub isLyrionJSPlayer {
	my $mac = lc(shift || '');
	return $mac =~ /^02:4c:4a:/;
}

# ---------------------------------------------------------------------------
# Pure helpers (tested without LMS: plugin/t/)
# ---------------------------------------------------------------------------

sub acceptKey { sha1_base64($_[0] . WS_GUID) . '=' }

# Is a page from $origin allowed to talk to a server reached as $host? No Origin (not a
# browser page) is allowed: such a client could reach port 3483 directly anyway.
sub originAllowed {
	my ($origin, $host) = @_;
	return 1 unless defined $origin && length $origin;
	return 0 unless defined $host && length $host;
	my ($scheme, $ohost) = $origin =~ m{^(https?)://([^/]+)$}i or return 0;
	$ohost .= $scheme =~ /^https$/i ? ':443' : ':80' unless $ohost =~ /:\d+$/;
	$host  .= ':80' unless $host =~ /:\d+$/;
	return lc($ohost) eq lc($host) ? 1 : 0;
}

# Checks the first 16 bytes a new session sends: 'HELO', length, device id, revision, MAC.
# Returns the MAC string, '' if more bytes are needed, or undef if refused.
sub heloMac {
	my $bytes = shift;
	return '' if length($bytes) < 16;
	return undef unless substr($bytes, 0, 4) eq 'HELO';
	my $mac = substr($bytes, 10, 6);
	return undef unless substr($mac, 0, 3) eq MAC_PREFIX;
	return join(':', map { sprintf '%02x', $_ } unpack('C6', $mac));
}

sub encodeFrame {
	my ($op, $data) = @_;
	my $n = length $data;
	my $hdr = $n < 126   ? pack('CC', 0x80 | $op, $n)
	        : $n < 65536 ? pack('CCn', 0x80 | $op, 126, $n)
	        :              pack('CCNN', 0x80 | $op, 127, 0, $n);
	return $hdr . $data;
}

# Parses one client frame from the front of $$buf. Returns (op, fin, payload) and removes it,
# () if more bytes are needed, or ('error', code) for a protocol violation.
sub parseFrame {
	my $buf = shift;
	return () if length($$buf) < 2;
	my ($b1, $b2) = unpack('CC', $$buf);
	my ($fin, $op, $masked, $n) = ($b1 & 0x80, $b1 & 0x0f, $b2 & 0x80, $b2 & 0x7f);
	my $pos = 2;
	if ($n == 126) {
		return () if length($$buf) < 4;
		$n = unpack('n', substr($$buf, 2, 2)); $pos = 4;
	}
	elsif ($n == 127) {
		return () if length($$buf) < 10;
		my ($hi, $lo) = unpack('NN', substr($$buf, 2, 8));
		return ('error', 1009) if $hi;
		$n = $lo; $pos = 10;
	}
	return ('error', 1002) unless $masked;            # clients must mask
	return ('error', 1009) if $n > MAX_MESSAGE;
	return () if length($$buf) < $pos + 4 + $n;
	my $mask = substr($$buf, $pos, 4);
	my $data = substr($$buf, $pos + 4, $n);
	substr($$buf, 0, $pos + 4 + $n, '');
	$data ^= substr($mask x (int($n / 4) + 1), 0, $n) if $n;
	return ($op, $fin ? 1 : 0, $data);
}

# The bytes a resuming client hasn't seen, or undef if they're no longer held.
sub replayFrom {
	my ($s, $received) = @_;
	return undef if $received !~ /^\d+$/ || $received > $s->{sent} || $received < $s->{bufStart};
	return substr($s->{buf}, $received - $s->{bufStart});
}

sub _keep {
	my ($s, $data) = @_;
	$s->{buf} .= $data;
	$s->{sent} += length $data;
	my $over = length($s->{buf}) - REPLAY_BYTES;
	if ($over > 0) {
		substr($s->{buf}, 0, $over, '');
		$s->{bufStart} += $over;
	}
}

# ---------------------------------------------------------------------------
# The WebSocket upgrade (a raw LMS web handler: LMS has already checked its password)
# ---------------------------------------------------------------------------

sub _upgrade {
	my ($httpClient, $response) = @_;
	my $req = $response->request;

	my $key = $req->header('Sec-WebSocket-Key');
	if ($req->method ne 'GET' || ($req->header('Upgrade') || '') !~ /websocket/i || !$key) {
		return _plain($httpClient, $response, 400, 'WebSocket only');
	}
	if (!originAllowed($req->header('Origin'), $req->header('Host'))) {
		$log->warn('Refused a LyrionJS socket from origin ' . $req->header('Origin'));
		return _plain($httpClient, $response, 403, 'Forbidden origin');
	}

	# Take the socket over from LMS's web server.
	Slim::Utils::Timers::killTimers($httpClient, \&Slim::Web::HTTP::closeHTTPSocket);
	Slim::Networking::Select::removeRead($httpClient);
	delete $Slim::Web::HTTP::keepAlives{$httpClient};
	my $extra = $httpClient->read_buffer;
	$httpClient->read_buffer('');

	my $hs = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
	       . 'Sec-WebSocket-Accept: ' . acceptKey($key) . "\r\n\r\n";
	Slim::Networking::Select::writeNoBlock($httpClient, \$hs);

	my $c = $conns{refaddr $httpClient} = { sock => $httpClient, rbuf => defined $extra ? $extra : '', frag => '' };
	Slim::Networking::Select::addRead($httpClient, \&_wsRead);
	_wsFrames($c) if length $c->{rbuf};
}

sub _plain {
	my ($httpClient, $response, $code, $text) = @_;
	$response->code($code);
	$response->content_type('text/plain');
	$response->header('Connection' => 'close');
	$response->header('Content-Length' => length $text);
	Slim::Web::HTTP::addHTTPResponse($httpClient, $response, \$text);
}

sub _wsRead {
	my $sock = shift;
	my $c = $conns{refaddr $sock} or return;
	my $n = sysread($sock, my $data, 65536);
	if (!defined $n) {
		return if $! == EWOULDBLOCK || $! == EINTR;
		return _closeConn($c, 1006);
	}
	return _closeConn($c, 1006) if $n == 0;
	$c->{rbuf} .= $data;
	_wsFrames($c);
}

sub _wsFrames {
	my $c = shift;
	while ($conns{refaddr $c->{sock}}) {
		my ($op, $fin, $data) = parseFrame(\$c->{rbuf});
		last unless defined $op;
		return _closeConn($c, $fin) if $op eq 'error';
		if ($op == 0x8) { return _closeConn($c, 1000) }
		if ($op == 0x9) { _send($c, 0xA, $data); next }
		next if $op == 0xA;
		if ($op == 0x0) {
			return _closeConn($c, 1002) unless $c->{fragOp};
			$c->{frag} .= $data;
			return _closeConn($c, 1009) if length $c->{frag} > MAX_MESSAGE;
			next unless $fin;
			($op, $data) = ($c->{fragOp}, $c->{frag});
			$c->{frag} = ''; $c->{fragOp} = 0;
		}
		elsif (!$fin) {
			$c->{fragOp} = $op; $c->{frag} = $data;
			next;
		}
		_message($c, $op, $data);
	}
}

sub _send {
	my ($c, $op, $data) = @_;
	my $frame = encodeFrame($op, $data);
	Slim::Networking::Select::writeNoBlock($c->{sock}, \$frame);
}

# Close the WebSocket (and, if its session is attached, start the hold).
sub _closeConn {
	my ($c, $code, $reason) = @_;
	delete $conns{refaddr $c->{sock}} or return;
	if ($code && $code != 1006) {
		# A close frame, written directly: the socket is about to go.
		my $frame = encodeFrame(0x8, pack('n', $code) . ($reason || ''));
		syswrite($c->{sock}, $frame);
	}
	Slim::Web::HTTP::closeHTTPSocket($c->{sock});
	if (my $s = $c->{session}) {
		_detach($s) if $s->{conn} && $s->{conn} == $c;
	}
}

# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

sub _message {
	my ($c, $op, $data) = @_;
	my $s = $c->{session};

	if (!$s) {
		return _closeConn($c, 1008, 'expected hello') unless $op == 0x1;
		my $msg = eval { from_json($data) };
		return _closeConn($c, 1008, 'bad hello') unless ref $msg eq 'HASH';
		return _resume($c, $msg->{resume}) if ref $msg->{resume} eq 'HASH';
		return _newSession($c) if $msg->{hello};
		return _closeConn($c, 1008, 'bad hello');
	}

	return unless $op == 0x2;   # text after the hello: nothing defined, ignored
	if (!$s->{heloOk}) {
		$s->{helo} .= $data;
		my $mac = heloMac($s->{helo});
		return _closeConn($c, 1008, 'not a LyrionJS player') unless defined $mac;
		return if $mac eq '';
		# One session per player: LMS must never see two connections for one MAC.
		for my $other (values %sessions) {
			_endSession($other, 4000) if $other != $s && $other->{mac} && $other->{mac} eq $mac;
		}
		$s->{mac} = $mac;
		$s->{heloOk} = 1;
		$data = delete $s->{helo};
	}
	Slim::Networking::Select::writeNoBlock($s->{up}, \$data) if $s->{up};
}

sub _newSession {
	my $c = shift;
	# Browser players switched off in Settings: the page carries on as a controller.
	return _closeConn($c, 4403, 'disabled') if $prefs && !$prefs->get('enabled');
	return _closeConn($c, 1013, 'too many players') if keys %sessions >= MAX_SESSIONS;

	my $up = IO::Socket::INET->new(
		PeerAddr => $main::localClientNetAddr || '127.0.0.1',
		PeerPort => SLIMPROTO,
		Proto    => 'tcp',
		Timeout  => 2,
	);
	if (!$up) {
		$log->error("Can't reach LMS's Slimproto port: $!");
		return _closeConn($c, 1011, 'no slimproto');
	}
	setsockopt($up, IPPROTO_TCP, TCP_NODELAY, 1);
	Slim::Utils::Network::blocking($up, 0);

	my $s = {
		id => _random(16), secret => _random(16), up => $up, conn => $c,
		sent => 0, buf => '', bufStart => 0, heloOk => 0, helo => '',
	};
	$sessions{$s->{id}} = $s;
	$byUp{refaddr $up} = $s->{id};
	$c->{session} = $s;
	Slim::Networking::Select::addRead($up, \&_upRead);

	_send($c, 0x1, to_json({ session => $s->{id}, secret => $s->{secret}, resumed => 0, hold => HOLD + 0 }));
	main::INFOLOG && $log->is_info && $log->info("New LyrionJS session $s->{id}");
}

sub _resume {
	my ($c, $r) = @_;
	my $s = $sessions{ $r->{session} || '' };
	my $missed = $s && defined $r->{secret} && $r->{secret} eq $s->{secret} ? replayFrom($s, $r->{received}) : undef;
	return _closeConn($c, 4404, 'cannot resume') unless defined $missed;

	if (my $old = $s->{conn}) {   # a socket that lingered: the new one replaces it
		$s->{conn} = undef;
		_closeConn($old, 4000, 'replaced');
	}
	Slim::Utils::Timers::killTimers($s, \&_holdExpired);
	$s->{conn} = $c;
	$c->{session} = $s;
	_send($c, 0x1, to_json({ session => $s->{id}, secret => $s->{secret}, resumed => 1, hold => HOLD + 0, replay => length($missed) + 0 }));
	_send($c, 0x2, $missed) if length $missed;
	main::INFOLOG && $log->is_info && $log->info("Resumed LyrionJS session $s->{id} (" . length($missed) . ' bytes replayed)');
}

sub _detach {
	my $s = shift;
	$s->{conn} = undef;
	Slim::Utils::Timers::setTimer($s, Time::HiRes::time() + HOLD, \&_holdExpired);
	main::INFOLOG && $log->is_info && $log->info("LyrionJS session $s->{id} detached; holding for " . HOLD . ' s');
}

sub _holdExpired {
	my $s = shift;
	_endSession($s, 0) unless $s->{conn};
}

sub _endSession {
	my ($s, $code) = @_;
	delete $sessions{$s->{id}} or return;
	Slim::Utils::Timers::killTimers($s, \&_holdExpired);
	if (my $up = delete $s->{up}) {
		delete $byUp{refaddr $up};
		Slim::Networking::Select::removeRead($up);
		Slim::Networking::Select::removeWrite($up);
		close $up;
	}
	if (my $c = delete $s->{conn}) {
		delete $c->{session};
		_closeConn($c, $code || 1001);
	}
}

sub _upRead {
	my $up = shift;
	my $s = $sessions{ $byUp{refaddr $up} || '' } or return;
	my $n = sysread($up, my $data, 65536);
	if (!defined $n) {
		return if $! == EWOULDBLOCK || $! == EINTR;
		return _endSession($s, 1001);
	}
	return _endSession($s, 1001) if $n == 0;   # LMS closed the player's connection
	_keep($s, $data);
	_send($s->{conn}, 0x2, $data) if $s->{conn};
}

sub _random {
	my $n = shift;
	my $bytes = '';
	if (open my $fh, '<:raw', '/dev/urandom') {
		read $fh, $bytes, $n;
		close $fh;
	}
	$bytes = join '', map { chr int rand 256 } 1 .. $n if length($bytes) != $n;
	return unpack 'H*', $bytes;
}

# ---------------------------------------------------------------------------
# Opt-in diagnostics from the page (Settings › Send diagnostics), written to the LMS log
# ---------------------------------------------------------------------------

sub _clientLog {
	my ($httpClient, $response) = @_;
	my $req = $response->request;
	return _plain($httpClient, $response, 405, 'POST only') unless $req->method eq 'POST';
	return _plain($httpClient, $response, 403, 'Forbidden origin') unless originAllowed($req->header('Origin'), $req->header('Host'));

	my $msg = eval { from_json($req->content) };
	if ($prefs && !$prefs->get('clientDiagnostics')) {
		$msg = undef;   # switched off in Settings: accepted and dropped
	}
	if (ref $msg eq 'HASH' && ref $msg->{lines} eq 'ARRAY') {
		my $who = substr($msg->{id} || '-', 0, 32);
		my @lines = @{ $msg->{lines} };
		splice @lines, 200 if @lines > 200;
		for my $line (@lines) {
			$line = substr("$line", 0, 600);
			$line =~ s/[\r\n]+/ /g;
			$log->warn("[$who] $line");
		}
	}
	return _plain($httpClient, $response, 200, 'ok');
}

1;
