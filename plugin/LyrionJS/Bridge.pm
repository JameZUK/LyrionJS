package Plugins::LyrionJS::Bridge;

# A byte pipe between a browser's WebSocket and LMS's own Slimproto port.
#
# The page speaks Slimproto itself; this module only moves its bytes, with three checks:
#   - only the page LMS served may open the socket (Origin);
#   - a session must start with a HELO whose MAC has LyrionJS's prefix, and every later HELO
#     must carry the same MAC, so a page can't impersonate a hardware player;
#   - one session per player MAC.
# It reads just enough of what the page sends to find Slimproto frame boundaries.
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

use constant HOLD          => 10;          # seconds; LMS drops a player silent for 15 s
use constant HELLO_WAIT    => 10;          # seconds a new socket has to say hello
use constant IDLE          => 30;          # seconds of silence before an attached socket is dropped
use constant SWEEP         => 5;           # seconds between checks for the two above
use constant LINGER        => 2;           # seconds a closing socket has to send what's queued
use constant REPLAY_BYTES  => 256 * 1024;  # Slimproto bytes kept for a resume
use constant MAX_MESSAGE   => 64 * 1024;   # largest message (and Slimproto frame) from the page
use constant MAX_QUEUED    => 256;         # writes queued to a page that isn't reading
use constant MAX_SESSIONS  => 32;
use constant MAX_SOCKETS   => 64;
use constant LOG_PER_MIN   => 120;         # diagnostics posts accepted a minute (all pages)
use constant SLIMPROTO     => 3483;
use constant MAC_PREFIX    => "\x02\x4c\x4a";
use constant WS_GUID       => '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

# Close codes (the page's transport knows these; see docs/ARCHITECTURE.md)
use constant {
	CLOSE_NORMAL   => 1000, CLOSE_GOING => 1001, CLOSE_PROTOCOL => 1002, CLOSE_DROPPED => 1006,
	CLOSE_POLICY   => 1008, CLOSE_TOO_BIG => 1009, CLOSE_ERROR => 1011, CLOSE_TRY_LATER => 1013,
	CLOSE_REPLACED => 4000, CLOSE_DISABLED => 4403, CLOSE_NO_RESUME => 4404,
};

my ($log, $prefs);
my $active = 0;
my %conns;     # refaddr(page socket) => { sock, rbuf, frag, fragOp, session, opened, lastRx }
my %sessions;  # id => { id, secret, mac, up, conn, sent, buf, bufStart, out }
my %byUp;      # refaddr(LMS socket) => session id
my @logTimes;  # when recent diagnostics posts arrived

sub init {
	my ($class, $logger, $pluginPrefs) = @_;
	$log = $logger;
	$prefs = $pluginPrefs;
	$active = 1;
	Slim::Web::Pages->addRawFunction(qr{^/plugins/LyrionJS/ws$}, \&_upgrade);
	Slim::Web::Pages->addRawFunction(qr{^/plugins/LyrionJS/log$}, \&_clientLog);
	_sweepLater();
}

# LMS has no way to remove a raw handler, so they stay and refuse while shut down.
sub shutdown {
	$active = 0;
	Slim::Utils::Timers::killTimers(__PACKAGE__, \&_sweep);
	_endSession($_, CLOSE_GOING) for values %sessions;
	_closeConn($_, CLOSE_GOING) for values %conns;
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

# Is a page from $origin allowed to talk to a server reached as one of @hosts (the Host header,
# and X-Forwarded-Host from a proxy)? No Origin (not a browser page) is allowed: such a client
# could reach port 3483 directly anyway. A browser can't forge either header.
sub originAllowed {
	my ($origin, @hosts) = @_;
	return 1 unless defined $origin && length $origin;
	my ($scheme, $ohost) = $origin =~ m{^(https?)://([^/]+)$}i or return 0;
	my $port = lc $scheme eq 'https' ? ':443' : ':80';   # a host without a port uses the scheme's
	$ohost .= $port unless $ohost =~ /:\d+$/;
	for my $host (@hosts) {
		next unless defined $host && length $host;
		for my $h (split /\s*,\s*/, $host) {               # a proxy chain may list several
			$h .= $port unless $h =~ /:\d+$/;
			return 1 if lc($ohost) eq lc($h);
		}
	}
	return 0;
}

# Checks the start of a HELO frame: 'HELO', length, device id, revision, MAC.
# Returns the MAC string, '' if more bytes are needed, or undef if refused.
sub heloMac {
	my $bytes = shift;
	return '' if length($bytes) < 16;
	return undef unless substr($bytes, 0, 4) eq 'HELO';
	my $mac = substr($bytes, 10, 6);
	return undef unless substr($mac, 0, 3) eq MAC_PREFIX;
	return join(':', map { sprintf '%02x', $_ } unpack('C6', $mac));
}

# Splits the complete Slimproto frames (4-byte opcode, 4-byte length, payload) the page sent
# off the front of $$buf. Returns them in a list ref, or undef if the bytes can't be Slimproto.
sub clientFrames {
	my $buf = shift;
	my @out;
	while (length($$buf) >= 8) {
		my ($op, $n) = unpack('a4N', $$buf);
		return undef if $op !~ /^[\x20-\x7e]{4}$/ || $n > MAX_MESSAGE;
		last if length($$buf) < 8 + $n;
		push @out, substr($$buf, 0, 8 + $n, '');
	}
	return undef if length($$buf) > MAX_MESSAGE;
	return \@out;
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
		return ('error', CLOSE_TOO_BIG) if $hi;
		$n = $lo; $pos = 10;
	}
	return ('error', CLOSE_PROTOCOL) unless $masked;      # clients must mask
	return ('error', CLOSE_TOO_BIG) if $n > MAX_MESSAGE;
	return ('error', CLOSE_PROTOCOL) if ($op & 0x8) && (!$fin || $n > 125);   # control frames
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
	return undef if !defined $received || $received !~ /^\d+$/ || $received > $s->{sent} || $received < $s->{bufStart};
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

# Compares secrets in time that doesn't depend on where they differ.
sub sameSecret {
	my ($x, $y) = @_;
	return 0 unless defined $x && defined $y && !ref $x && length($x) == length($y);
	my $d = 0;
	$d |= ord(substr($x, $_, 1)) ^ ord(substr($y, $_, 1)) for 0 .. length($x) - 1;
	return $d == 0 ? 1 : 0;
}

sub _now { Time::HiRes::time() }

# ---------------------------------------------------------------------------
# The WebSocket upgrade (a raw LMS web handler: LMS has already checked its password)
# ---------------------------------------------------------------------------

sub _upgrade {
	my ($httpClient, $response) = @_;
	my $req = $response->request;

	return _plain($httpClient, $response, 503, 'Shutting down') unless $active;
	my $key = $req->header('Sec-WebSocket-Key');
	if ($req->method ne 'GET' || ($req->header('Upgrade') || '') !~ /websocket/i || !$key) {
		return _plain($httpClient, $response, 400, 'WebSocket only');
	}
	if (!originAllowed($req->header('Origin'), $req->header('Host'), $req->header('X-Forwarded-Host'))) {
		$log->warn('Refused a LyrionJS socket from origin ' . $req->header('Origin'));
		return _plain($httpClient, $response, 403, 'Forbidden origin');
	}
	return _plain($httpClient, $response, 503, 'Too many sockets') if keys %conns >= MAX_SOCKETS;

	# Take the socket over from LMS's web server.
	Slim::Utils::Timers::killTimers($httpClient, \&Slim::Web::HTTP::closeHTTPSocket);
	Slim::Networking::Select::removeRead($httpClient);
	delete $Slim::Web::HTTP::keepAlives{$httpClient};
	my $extra = $httpClient->read_buffer;
	$httpClient->read_buffer('');

	my $hs = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
	       . 'Sec-WebSocket-Accept: ' . acceptKey($key) . "\r\n\r\n";
	Slim::Networking::Select::writeNoBlock($httpClient, \$hs);

	_attach($httpClient, $extra);
}

# Starts serving a page's socket once the handshake is written.
sub _attach {
	my ($sock, $extra) = @_;
	my $now = _now();
	my $c = $conns{refaddr $sock} = {
		sock => $sock, rbuf => defined $extra ? $extra : '', frag => '', fragOp => 0,
		opened => $now, lastRx => $now,
	};
	Slim::Networking::Select::addRead($sock, \&_wsRead);
	_wsFrames($c) if length $c->{rbuf};
	return $c;
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
		return _closeConn($c, CLOSE_DROPPED);
	}
	return _closeConn($c, CLOSE_DROPPED) if $n == 0;
	$c->{lastRx} = _now();
	$c->{rbuf} .= $data;
	_wsFrames($c);
}

sub _wsFrames {
	my $c = shift;
	while ($conns{refaddr $c->{sock}}) {
		my ($op, $fin, $data) = parseFrame(\$c->{rbuf});
		last unless defined $op;
		return _closeConn($c, $fin) if $op eq 'error';
		if ($op == 0x8) { return _closeConn($c, CLOSE_NORMAL) }
		if ($op == 0x9) { _send($c, 0xA, $data); next }
		next if $op == 0xA;
		if ($op == 0x0) {
			return _closeConn($c, CLOSE_PROTOCOL) unless $c->{fragOp};
			$c->{frag} .= $data;
			return _closeConn($c, CLOSE_TOO_BIG) if length $c->{frag} > MAX_MESSAGE;
			next unless $fin;
			($op, $data) = ($c->{fragOp}, $c->{frag});
			$c->{frag} = ''; $c->{fragOp} = 0;
		}
		elsif ($op != 0x1 && $op != 0x2) {
			return _closeConn($c, CLOSE_PROTOCOL);
		}
		elsif ($c->{fragOp}) {
			return _closeConn($c, CLOSE_PROTOCOL);          # a new message inside a fragmented one
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

# Close a page's socket (and, if its session is attached, start the hold). With a code other
# than 1006 the page is told why, after whatever is already queued to it.
sub _closeConn {
	my ($c, $code, $reason) = @_;
	my $sock = $c->{sock};
	delete $conns{refaddr $sock} or return;
	Slim::Networking::Select::removeRead($sock);
	if (my $s = delete $c->{session}) {
		_detach($s) if $s->{conn} && $s->{conn} == $c;
	}
	if ($code && $code != CLOSE_DROPPED && $sock->opened) {
		_send($c, 0x8, pack('n', $code) . substr($reason || '', 0, 100));
		return _linger($sock, _now() + LINGER);
	}
	_dropSocket($sock);
}

sub _linger {
	my ($sock, $until) = @_;
	if ($sock->opened && Slim::Networking::Select::writeNoBlockQLen($sock) > 0 && _now() < $until) {
		return Slim::Utils::Timers::setTimer($sock, _now() + 0.1, \&_linger, $until);
	}
	_dropSocket($sock);
}

sub _dropSocket {
	my $sock = shift;
	Slim::Utils::Timers::killTimers($sock, \&_linger);
	Slim::Networking::Select::removeWriteNoBlockQ($sock);
	Slim::Web::HTTP::closeHTTPSocket($sock) if $sock->opened;
}

# Sockets that never said hello, and attached ones that went silent (a browser that vanished
# without closing), are dropped. LMS talks to every player at least every 5 s and the page
# answers, so an attached socket is never quiet for long.
sub _sweep {
	my $now = _now();
	for my $c (values %conns) {
		if (!$c->{session}) {
			_closeConn($c, CLOSE_POLICY, 'no hello') if $now - $c->{opened} > HELLO_WAIT;
		}
		elsif ($now - $c->{lastRx} > IDLE) {
			main::INFOLOG && $log->is_info && $log->info("LyrionJS session $c->{session}{id}: socket silent, dropped");
			_closeConn($c, CLOSE_DROPPED);
		}
	}
	_sweepLater();
}

sub _sweepLater {
	Slim::Utils::Timers::killTimers(__PACKAGE__, \&_sweep);
	Slim::Utils::Timers::setTimer(__PACKAGE__, _now() + SWEEP, \&_sweep) if $active;
}

# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

sub _message {
	my ($c, $op, $data) = @_;
	my $s = $c->{session};

	if (!$s) {
		return _closeConn($c, CLOSE_POLICY, 'expected hello') unless $op == 0x1;
		my $msg = eval { from_json($data) };
		return _closeConn($c, CLOSE_POLICY, 'bad hello') unless ref $msg eq 'HASH';
		return _resume($c, $msg->{resume}) if ref $msg->{resume} eq 'HASH';
		return _newSession($c) if $msg->{hello};
		return _closeConn($c, CLOSE_POLICY, 'bad hello');
	}

	return unless $op == 0x2;   # text after the hello: nothing defined, ignored

	# Pass whole Slimproto frames only, and check every HELO: it must carry LyrionJS's MAC
	# prefix and, once a session has one, the same MAC.
	$s->{out} .= $data;
	my $frames = clientFrames(\$s->{out});
	return _closeConn($c, CLOSE_POLICY, 'not slimproto') unless $frames;
	for my $f (@$frames) {
		if (substr($f, 0, 4) eq 'HELO') {
			my $mac = heloMac($f);
			return _closeConn($c, CLOSE_POLICY, 'not a LyrionJS player') unless $mac;
			if (!$s->{mac}) {
				# One session per player: LMS must never see two connections for one MAC.
				for my $other (values %sessions) {
					_endSession($other, CLOSE_REPLACED) if $other != $s && $other->{mac} && $other->{mac} eq $mac;
				}
				$s->{mac} = $mac;
			}
			elsif ($mac ne $s->{mac}) {
				return _closeConn($c, CLOSE_POLICY, 'another player');
			}
		}
		elsif (!$s->{mac}) {
			return _closeConn($c, CLOSE_POLICY, 'expected HELO');
		}
	}
	return unless @$frames && $s->{up};
	my $bytes = join '', @$frames;
	Slim::Networking::Select::writeNoBlock($s->{up}, \$bytes);
}

# LMS's Slimproto port on this machine. A blocking connect, but to LMS itself, so it is quick;
# the timeout covers an LMS too busy to accept.
sub _connectUp {
	my $up = IO::Socket::INET->new(
		PeerAddr => $main::localClientNetAddr || '127.0.0.1',
		PeerPort => SLIMPROTO,
		Proto    => 'tcp',
		Timeout  => 2,
	) or return undef;
	setsockopt($up, IPPROTO_TCP, TCP_NODELAY, 1);
	Slim::Utils::Network::blocking($up, 0);
	return $up;
}

sub _newSession {
	my $c = shift;
	# Browser players switched off in Settings: the page carries on as a controller.
	return _closeConn($c, CLOSE_DISABLED, 'disabled') if $prefs && !$prefs->get('enabled');
	return _closeConn($c, CLOSE_TRY_LATER, 'too many players') if keys %sessions >= MAX_SESSIONS;

	my $up = _connectUp();
	if (!$up) {
		$log->error("Can't reach LMS's Slimproto port: $!");
		return _closeConn($c, CLOSE_ERROR, 'no slimproto');
	}

	my $s = {
		id => _random(16), secret => _random(16), up => $up, conn => $c,
		sent => 0, buf => '', bufStart => 0, out => '',
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
	my $missed = $s && sameSecret($r->{secret}, $s->{secret}) ? replayFrom($s, $r->{received}) : undef;
	return _closeConn($c, CLOSE_NO_RESUME, 'cannot resume') unless defined $missed;

	if (my $old = $s->{conn}) {   # a socket that lingered: the new one replaces it
		$s->{conn} = undef;
		_closeConn($old, CLOSE_REPLACED, 'replaced');
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
	Slim::Utils::Timers::setTimer($s, _now() + HOLD, \&_holdExpired);
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
		Slim::Networking::Select::removeWriteNoBlockQ($up);
		$up->close;
	}
	if (my $c = delete $s->{conn}) {
		delete $c->{session};
		_closeConn($c, $code || CLOSE_GOING);
	}
}

sub _upRead {
	my $up = shift;
	my $s = $sessions{ $byUp{refaddr $up} || '' } or return;
	my $n = sysread($up, my $data, 65536);
	if (!defined $n) {
		return if $! == EWOULDBLOCK || $! == EINTR;
		return _endSession($s, CLOSE_GOING);
	}
	return _endSession($s, CLOSE_GOING) if $n == 0;   # LMS closed the player's connection
	_fromLMS($s, $data);
}

sub _fromLMS {
	my ($s, $data) = @_;
	_keep($s, $data);
	my $c = $s->{conn} or return;
	# A page that stopped reading: drop its socket rather than queue without limit. It resumes
	# from what it did receive, if that is still held.
	return _closeConn($c, CLOSE_DROPPED) if Slim::Networking::Select::writeNoBlockQLen($c->{sock}) > MAX_QUEUED;
	_send($c, 0x2, $data);
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
	return _plain($httpClient, $response, 403, 'Forbidden origin')
		unless originAllowed($req->header('Origin'), $req->header('Host'), $req->header('X-Forwarded-Host'));
	return _plain($httpClient, $response, 503, 'Shutting down') unless $active;

	my $now = _now();
	@logTimes = grep { $now - $_ < 60 } @logTimes;
	return _plain($httpClient, $response, 429, 'Too many') if @logTimes >= LOG_PER_MIN;
	push @logTimes, $now;

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
