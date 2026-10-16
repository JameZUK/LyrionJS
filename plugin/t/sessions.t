#!/usr/bin/perl
# Tests for Plugins::LyrionJS::Bridge's sessions: hello and resume, the HELO checks, the hold,
# timeouts and closing. LMS's event loop, timers and sockets are replaced by stubs here, so
# only the libraries Bridge.pm itself uses are needed (run as for bridge.t).
use strict;
use warnings;
use Test::More 'no_plan';

BEGIN { package main; use constant { ISWINDOWS => 0, INFOLOG => 0, DEBUGLOG => 0 } }

# --- stubs for the parts of LMS the bridge calls ----------------------------------------------
our $T = 1000;      # the clock
our @timers;        # [obj, when, sub, args]
our %reads;         # refaddr => socket being read
our %pages;         # raw handlers
{
	package FakeSock;
	sub new { my ($c, %o) = @_; bless { open => 1, out => '', queued => -1, %o }, $c }
	sub opened { $_[0]{open} }
	sub close { $_[0]{open} = 0 }
	sub read_buffer { my $s = shift; $s->{rb} = shift if @_; $s->{rb} // '' }

	package Slim::Web::Pages;
	sub addRawFunction { $main::pages{"$_[1]"} = $_[2] }

	package Slim::Utils::Timers;
	sub setTimer { my ($o, $w, $f, @a) = @_; push @main::timers, [$o, $w, $f, \@a]; 1 }
	sub killTimers { my ($o, $f) = @_; @main::timers = grep { !($_->[0] eq $o && $_->[2] == $f) } @main::timers }

	package Slim::Networking::Select;
	use Scalar::Util qw(refaddr);
	sub addRead { $main::reads{refaddr $_[0]} = $_[0] }
	sub removeRead { delete $main::reads{refaddr $_[0]} }
	sub removeWrite {}
	sub removeWriteNoBlockQ { $_[0]{queued} = -1 }
	sub writeNoBlockQLen { $_[0]{queued} }
	sub writeNoBlock { my ($s, $r) = @_; return unless $s->{open}; $s->{out} .= $$r }

	package Slim::Web::HTTP;
	our %keepAlives;
	sub closeHTTPSocket { $_[0]{open} = 0 }

	package Slim::Utils::Network;
	sub blocking {}

	package FakeLog;
	sub new { bless { lines => [] }, shift }
	sub warn { push @{ $_[0]{lines} }, $_[1] } sub error { push @{ $_[0]{lines} }, $_[1] }
	sub info {} sub is_info { 0 }

	package FakePrefs;
	sub new { my ($c, %p) = @_; bless {%p}, $c }
	sub get { $_[0]{$_[1]} }
}

use Plugins::LyrionJS::Bridge;
my $B = 'Plugins::LyrionJS::Bridge';
my @ups;
{
	no warnings 'redefine';
	*Plugins::LyrionJS::Bridge::_now = sub { $T };
	*Plugins::LyrionJS::Bridge::_connectUp = sub { my $u = FakeSock->new(up => 1); push @ups, $u; $u };
}
my $prefs = FakePrefs->new(enabled => 1);
$B->init(FakeLog->new, $prefs);

# Advance the clock, running timers that fall due.
sub advance {
	my $end = $T + shift;
	while (my ($t) = sort { $a->[1] <=> $b->[1] } grep { $_->[1] <= $end } @timers) {
		@timers = grep { $_ != $t } @timers;
		$T = $t->[1];
		$t->[2]->($t->[0], @{ $t->[3] });
	}
	$T = $end;
}

# --- the page's side ---------------------------------------------------------------------------
sub mask {
	my ($op, $data) = @_;
	my $n = length $data;
	my $hdr = $n < 126 ? pack('CC', 0x80 | $op, 0x80 | $n) : pack('CCn', 0x80 | $op, 0x80 | 126, $n);
	my $m = pack('N', 0x0badf00d);
	return $hdr . $m . ($n ? $data ^ substr($m x (int($n / 4) + 1), 0, $n) : '');
}
# The server frames written to a socket since last asked: [op, payload] each.
sub frames {
	my $sock = shift;
	my @out;
	while (length $sock->{out} >= 2) {
		my ($b1, $n) = unpack('CC', $sock->{out});
		my $pos = 2;
		if ($n == 126) { $n = unpack('n', substr($sock->{out}, 2, 2)); $pos = 4 }
		elsif ($n == 127) { $n = unpack('N', substr($sock->{out}, 6, 4)); $pos = 10 }
		push @out, [$b1 & 0x0f, substr($sock->{out}, $pos, $n)];
		substr($sock->{out}, 0, $pos + $n, '');
	}
	return @out;
}
sub closeCode { my @f = grep { $_->[0] == 8 } @_; @f ? unpack('n', $f[-1][1]) : undef }

sub page {
	my $sock = FakeSock->new;
	my $c = Plugins::LyrionJS::Bridge::_attach($sock, '');
	return { sock => $sock, c => $c };
}
sub say { my ($p, $op, $data) = @_; $p->{c}{rbuf} .= mask($op, $data); $p->{c}{lastRx} = $T; Plugins::LyrionJS::Bridge::_wsFrames($p->{c}) }
sub hello { my $p = page(); say($p, 1, '{"hello":1}'); my ($f) = frames($p->{sock}); ($p, Plugins::LyrionJS::JSON::decode($f->[1])) }
sub helo { my $mac = shift; my $body = "\x0c\x00" . pack('C6', @$mac) . ("\0" x 20); 'HELO' . pack('N', length $body) . $body }
sub session { my $p = shift; $p->{c}{session} }

{ package Plugins::LyrionJS::JSON; use JSON::XS::VersionOneAndTwo; sub decode { from_json($_[0]) } }

# --- a new session -------------------------------------------------------------------------------
my ($p, $h) = hello();
ok($h->{session} && $h->{secret} && !$h->{resumed} && $h->{hold} == 10, 'hello answered with a session');
my $up = $ups[-1];
say($p, 2, substr(helo([2, 0x4c, 0x4a, 0, 0, 1]), 0, 12));
is($up->{out}, '', 'a partial HELO is held back');
say($p, 2, substr(helo([2, 0x4c, 0x4a, 0, 0, 1]), 12) . 'STAT' . pack('N', 0));
is($up->{out}, helo([2, 0x4c, 0x4a, 0, 0, 1]) . 'STAT' . pack('N', 0), 'whole frames go to LMS');
is(session($p)->{mac}, '02:4c:4a:00:00:01', 'MAC noted');

Plugins::LyrionJS::Bridge::_fromLMS(session($p), 'strm' x 10);
is((frames($p->{sock}))[0][1], 'strm' x 10, 'LMS bytes go to the page');

say($p, 2, helo([2, 0x4c, 0x4a, 0, 0, 1]));
ok($p->{sock}{open}, 'the same HELO again (a reconnect) is fine');
say($p, 2, helo([2, 0x4c, 0x4a, 0, 0, 2]));
is(closeCode(frames($p->{sock})), 1008, 'a HELO for another player closes the socket');
ok(!$p->{sock}{open}, 'and the socket is closed');

# --- HELO checks ---------------------------------------------------------------------------------
{
	my ($q) = hello();
	say($q, 2, helo([0, 4, 0x20, 1, 2, 3]));
	is(closeCode(frames($q->{sock})), 1008, 'a hardware MAC is refused');
	is($ups[-1]{out}, '', 'and nothing reached LMS');
	my ($r) = hello();
	say($r, 2, 'STAT' . pack('N', 0));
	is(closeCode(frames($r->{sock})), 1008, 'a session must start with HELO');
	my ($x) = hello();
	say($x, 2, "\xff\xfe" . ('x' x 20));
	is(closeCode(frames($x->{sock})), 1008, 'bytes that are not Slimproto are refused');
}

# --- drop, hold and resume -----------------------------------------------------------------------
{
	my ($q, $hq) = hello();
	my $s = session($q);
	say($q, 2, helo([2, 0x4c, 0x4a, 0, 0, 3]));
	Plugins::LyrionJS::Bridge::_fromLMS($s, 'A' x 100);
	frames($q->{sock});
	Plugins::LyrionJS::Bridge::_closeConn($q->{c}, 1006);       # the connection drops
	ok(!$q->{sock}{open}, 'dropped socket closed');
	Plugins::LyrionJS::Bridge::_fromLMS($s, 'B' x 50);            # LMS carries on meanwhile
	advance(5);

	my $bad = page();
	say($bad, 1, '{"resume":{"session":"' . $hq->{session} . '","secret":"nope","received":100}}');
	is(closeCode(frames($bad->{sock})), 4404, 'wrong secret: 4404');

	my $r = page();
	say($r, 1, '{"resume":{"session":"' . $hq->{session} . '","secret":"' . $hq->{secret} . '","received":100}}');
	my ($ans, @rest) = frames($r->{sock});
	my $j = Plugins::LyrionJS::JSON::decode($ans->[1]);
	ok($j->{resumed} && $j->{replay} == 50, 'resumed with the bytes missed');
	is($rest[0][1], 'B' x 50, 'and they are replayed');
	advance(20);
	ok(session($r) == $s && $s->{conn} == $r->{c}, 'the hold timer no longer ends it');

	# a second resume replaces the first socket
	my $r2 = page();
	say($r2, 1, '{"resume":{"session":"' . $hq->{session} . '","secret":"' . $hq->{secret} . '","received":150}}');
	is(closeCode(frames($r->{sock})), 4000, 'the old socket is told it was replaced');
	ok(session($r2) == $s && $s->{conn} == $r2->{c}, 'the new socket has the session');

	# a hold that runs out ends the session
	my $sup = $s->{up};
	Plugins::LyrionJS::Bridge::_closeConn($r2->{c}, 1006);
	advance(11);
	ok(!$sup->{open}, 'hold expired: LMS connection closed');
	my $late = page();
	say($late, 1, '{"resume":{"session":"' . $hq->{session} . '","secret":"' . $hq->{secret} . '","received":150}}');
	is(closeCode(frames($late->{sock})), 4404, 'and it cannot be resumed');
}

# --- one session per MAC --------------------------------------------------------------------------
{
	my ($a1) = hello(); say($a1, 2, helo([2, 0x4c, 0x4a, 0, 0, 9]));
	my ($a2) = hello(); say($a2, 2, helo([2, 0x4c, 0x4a, 0, 0, 9]));
	is(closeCode(frames($a1->{sock})), 4000, 'a second session for a MAC ends the first');
	ok($a2->{sock}{open}, 'the new one carries on');
}

# --- timeouts -------------------------------------------------------------------------------------
{
	my $silent = page();
	advance(16);
	is(closeCode(frames($silent->{sock})), 1008, 'no hello within 10 s: closed');

	my ($q) = hello(); say($q, 2, helo([2, 0x4c, 0x4a, 0, 0, 4]));
	my $s = session($q);
	advance(20); say($q, 2, 'STAT' . pack('N', 0));
	advance(20);
	ok($q->{sock}{open}, 'a socket that talks stays');
	advance(16);
	ok(!$q->{sock}{open}, 'silent for 30 s: dropped');
	ok(!$s->{conn} && exists $s->{up}, 'and its session is held');
}

# --- closing and back-pressure --------------------------------------------------------------------
{
	my ($q) = hello(); say($q, 2, helo([2, 0x4c, 0x4a, 0, 0, 5]));
	$q->{sock}{queued} = 3;                                      # the page is behind
	Plugins::LyrionJS::Bridge::_closeConn($q->{c}, 4000, 'x');
	ok($q->{sock}{open}, 'a closing socket first sends what is queued');
	advance(0.5);
	ok($q->{sock}{open}, 'still sending');
	$q->{sock}{queued} = 0;
	advance(0.2);
	ok(!$q->{sock}{open}, 'closed once sent');
	is(closeCode(frames($q->{sock})), 4000, 'with the close frame after the data');

	my ($w) = hello(); say($w, 2, helo([2, 0x4c, 0x4a, 0, 0, 6]));
	$w->{sock}{queued} = 3;
	Plugins::LyrionJS::Bridge::_closeConn($w->{c}, 4000);
	advance(3);
	ok(!$w->{sock}{open}, 'a page that never reads is closed anyway');

	my ($v) = hello(); say($v, 2, helo([2, 0x4c, 0x4a, 0, 0, 7]));
	my $s = session($v);
	$v->{sock}{queued} = 300;
	Plugins::LyrionJS::Bridge::_fromLMS($s, 'C' x 10);
	ok(!$v->{sock}{open}, 'a page far behind is dropped');
	ok(!$s->{conn} && $s->{sent} == 10, 'its session is held with the bytes counted');
}

# --- switched off ---------------------------------------------------------------------------------
{
	$prefs->{enabled} = 0;
	my $q = page(); say($q, 1, '{"hello":1}');
	is(closeCode(frames($q->{sock})), 4403, 'players off: 4403');
	$prefs->{enabled} = 1;
}

# --- shutdown ---------------------------------------------------------------------------------------
{
	my ($q) = hello(); say($q, 2, helo([2, 0x4c, 0x4a, 0, 0, 8]));
	my $u = $ups[-1];
	$B->shutdown;
	is(Plugins::LyrionJS::Bridge::sessionCount(), 0, 'shutdown ends every session');
	ok(!$u->{open}, 'LMS sockets closed');
	is(closeCode(frames($q->{sock})), 1001, 'pages are told the server is going');
	ok(!grep({ $_->[2] == \&Plugins::LyrionJS::Bridge::_sweep } @timers), 'no sweep left running');
}
