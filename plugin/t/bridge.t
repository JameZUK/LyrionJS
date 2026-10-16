#!/usr/bin/perl
# Unit tests for Plugins::LyrionJS::Bridge's pure parts: the WebSocket codec, the origin and
# HELO checks, and the replay buffer. Run with LMS's libraries on @INC, e.g. in the test LMS:
#   perl -I/lms -I/lms/CPAN -I<plugin parent> plugin/t/bridge.t
use strict;
use warnings;
use Test::More 'no_plan';

# Constants LMS defines in its main script.
BEGIN { package main; use constant { ISWINDOWS => 0, INFOLOG => 0, DEBUGLOG => 0 } }

use Plugins::LyrionJS::Bridge;
my $B = 'Plugins::LyrionJS::Bridge';

# --- WebSocket handshake (RFC 6455's own example) -------------------------------------------
is($B->can('acceptKey')->('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'accept key');

# --- origin ----------------------------------------------------------------------------------
my $ok = \&Plugins::LyrionJS::Bridge::originAllowed;
ok($ok->(undef, 'lms:9000'), 'no Origin (not a browser page) is allowed');
ok($ok->('http://lms:9000', 'lms:9000'), 'same origin');
ok($ok->('http://LMS:9000', 'lms:9000'), 'host compared without case');
ok($ok->('http://lms', 'lms:80'), 'default http port');
ok($ok->('https://music.example.com', 'music.example.com:443'), 'default https port');
ok(!$ok->('http://evil.example', 'lms:9000'), 'another site is refused');
ok(!$ok->('http://lms:9001', 'lms:9000'), 'another port is refused');
ok(!$ok->('http://lms:9000.evil.example', 'lms:9000'), 'suffix trick refused');
ok(!$ok->('null', 'lms:9000'), 'opaque origin refused');
ok(!$ok->('http://lms:9000', undef), 'no Host refused');

# --- HELO check --------------------------------------------------------------------------------
sub helo { my $mac = shift; 'HELO' . pack('N', 36) . "\x0c\x00" . pack('C6', @$mac) . ("\0" x 20) }
my $mac = \&Plugins::LyrionJS::Bridge::heloMac;
is($mac->(substr(helo([2, 0x4c, 0x4a, 1, 2, 3]), 0, 15)), '', 'needs 16 bytes');
is($mac->(helo([2, 0x4c, 0x4a, 0xab, 2, 3])), '02:4c:4a:ab:02:03', 'LyrionJS MAC accepted');
is($mac->(helo([0, 4, 0x20, 0x23, 0x2d, 0x84])), undef, 'a hardware player MAC is refused');
is($mac->('STAT' . ("\0" x 20)), undef, 'must start with HELO');
ok(Plugins::LyrionJS::Bridge::isLyrionJSPlayer('02:4C:4A:00:00:01'), 'player test is case-insensitive');
ok(!Plugins::LyrionJS::Bridge::isLyrionJSPlayer('00:04:20:23:2d:84'), 'hardware player is not ours');

# --- frames ----------------------------------------------------------------------------------
sub clientFrame {
	my ($op, $data, %o) = @_;
	my $n = length $data;
	my $mask = pack('N', 0x12345678);
	my $hdr = $n < 126 ? pack('CC', ($o{fin} // 1 ? 0x80 : 0) | $op, 0x80 | $n)
	        : $n < 65536 ? pack('CCn', ($o{fin} // 1 ? 0x80 : 0) | $op, 0x80 | 126, $n)
	        : pack('CCNN', 0x80 | $op, 0x80 | 127, 0, $n);
	my $m = $n ? substr($mask x (int($n / 4) + 1), 0, $n) : '';
	return $hdr . $mask . ($data ^ $m);
}
my $parse = \&Plugins::LyrionJS::Bridge::parseFrame;
for my $len (0, 5, 125, 126, 300, 65535, 65536) {
	my $data = join '', map { chr(($_ * 7) & 255) } 1 .. $len;
	my $buf = clientFrame(0x2, $data) . 'next';
	my ($op, $fin, $got) = $parse->(\$buf);
	is($op, 2, "op for $len bytes");
	ok($got eq $data, "payload of $len bytes unmasked");
	is($buf, 'next', 'the rest is left in the buffer');
}
{
	my $whole = clientFrame(0x1, '{"hello":1}');
	my $buf = '';
	my @r;
	for my $i (0 .. length($whole) - 1) {      # a byte at a time
		$buf .= substr($whole, $i, 1);
		@r = $parse->(\$buf);
		last if @r;
	}
	is($r[2], '{"hello":1}', 'reassembled from single bytes');
}
{
	my $buf = pack('CC', 0x82, 3) . 'abc';
	is(($parse->(\$buf))[1], 1002, 'unmasked client frame refused');
	$buf = pack('CCNN', 0x82, 0x80 | 127, 0, 70000) . 'x';
	is(($parse->(\$buf))[1], 1009, 'over-size message refused before it arrives');
	$buf = pack('CCNN', 0x82, 0x80 | 127, 1, 0);
	is(($parse->(\$buf))[1], 1009, 'giant length refused');
}
my $enc = \&Plugins::LyrionJS::Bridge::encodeFrame;
is(unpack('H*', $enc->(0x2, 'ab')), '820261' . '62', 'small server frame');
is(length($enc->(0x2, 'x' x 200)), 4 + 200, '16-bit length');
is(length($enc->(0x2, 'x' x 70000)), 10 + 70000, '64-bit length');

# --- replay buffer -----------------------------------------------------------------------------
my $s = { sent => 0, buf => '', bufStart => 0 };
Plugins::LyrionJS::Bridge::_keep($s, 'a' x 1000);
is(Plugins::LyrionJS::Bridge::replayFrom($s, 1000), '', 'nothing missed');
is(Plugins::LyrionJS::Bridge::replayFrom($s, 400), 'a' x 600, 'missed bytes replayed');
is(Plugins::LyrionJS::Bridge::replayFrom($s, 1001), undef, 'claims more than was sent: refused');
is(Plugins::LyrionJS::Bridge::replayFrom($s, '1e3'), undef, 'not a number: refused');
Plugins::LyrionJS::Bridge::_keep($s, 'b' x (300 * 1024));
is($s->{sent}, 1000 + 300 * 1024, 'total counted');
is(length $s->{buf}, 256 * 1024, 'buffer bounded');
is(Plugins::LyrionJS::Bridge::replayFrom($s, 500), undef, 'bytes no longer held: refused');
is(length(Plugins::LyrionJS::Bridge::replayFrom($s, $s->{sent} - 10)), 10, 'recent bytes still held');


