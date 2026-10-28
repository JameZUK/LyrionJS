#!/usr/bin/perl
# Unit tests for Plugins::LyrionJS::Players: which old LyrionJS players' settings go, and that
# only their entries are removed. Run with LMS's libraries on @INC, e.g. in the test LMS:
#   perl -I/lms -I/lms/CPAN -I<plugin parent> plugin/t/players.t
use strict;
use warnings;
use Test::More 'no_plan';
use File::Path qw(make_path);
use File::Spec::Functions qw(catfile);
use File::Temp qw(tempdir);

# Constants LMS defines in its main script.
BEGIN { package main; use constant { ISWINDOWS => 0, INFOLOG => 0, DEBUGLOG => 0 } }

use Plugins::LyrionJS::Players;
my $P = 'Plugins::LyrionJS::Players';

# LMS's own check (Slim::Utils::Prefs::Client), which needs LMS's logging to load.
sub Slim::Utils::Prefs::Client::hasPrefs { $_[1]->{prefs}{"_client:$_[2]"} ? 1 : 0 }

my $prefsDir = tempdir(CLEANUP => 1);
sub touch {
	my ($path, $time) = @_;
	open my $fh, '>', $path or die "open $path: $!";
	close $fh;
	utime($time, $time, $path) if $time;
}

# --- which players are stale -------------------------------------------------------------
my $now    = 2_000_000_000;
my $cutoff = $now - $P->can('STALE_DAYS')->() * 24 * 60 * 60;
touch(catfile($prefsDir, 'clientplaylist_024c4a000005.m3u'), $cutoff + 1);

my %connected = ('02:4c:4a:00:00:06' => 1);
my @clients = (
	{ clientid => '02:4c:4a:00:00:01', prefs => { _ts_currentSong => $cutoff - 1 } },
	{ clientid => '02:4c:4a:00:00:02', prefs => { _ts_volume => $cutoff } },
	{ clientid => '02:4c:4a:00:00:03', prefs => {} },
	{ clientid => '02:4c:4a:00:00:04', prefs => { _ts_power => $cutoff + 1 } },
	{ clientid => '02:4c:4a:00:00:05', prefs => { _ts_currentSong => $cutoff - 1 } },
	{ clientid => '02:4c:4a:00:00:06', prefs => { _ts_currentSong => $cutoff - 1 } },
	{ clientid => '02:4c:4a:00:00:07', prefs => { _ts_currentSong => $cutoff - 1 } },
	{ clientid => '02:4c:4a:00:00:08', prefs => {} },
	{ clientid => '00:04:20:23:2d:84', prefs => { _ts_currentSong => $cutoff - 1 } },
);
my %seen = (
	'02:4c:4a:00:00:01' => $cutoff - 5,
	'02:4c:4a:00:00:02' => $cutoff - 5,
	'02:4c:4a:00:00:03' => $cutoff - 5,
	'02:4c:4a:00:00:04' => $cutoff - 5,
	'02:4c:4a:00:00:05' => $cutoff - 5,
	'02:4c:4a:00:00:06' => $cutoff - 5,
	'02:4c:4a:00:00:07' => $cutoff + 1,   # connected recently, though no setting changed
);
my @stale = Plugins::LyrionJS::Players::staleIds(\@clients, \%seen, $now, $prefsDir, sub { $connected{$_[0]} });
is_deeply(\@stale, [ '02:4c:4a:00:00:01', '02:4c:4a:00:00:02', '02:4c:4a:00:00:03' ],
	'stale: old, on the cutoff, and no settings timestamps; kept: recently used, saved queue, connected, recently seen, other players');
is($seen{'02:4c:4a:00:00:08'}, $now, 'a player not seen before starts counting from now');
ok(!exists $seen{'00:04:20:23:2d:84'}, 'other players aren\'t recorded');

# --- namespaces ----------------------------------------------------------------------------
make_path(catfile($prefsDir, 'plugin', 'disabled'));
touch(catfile($prefsDir, 'server.prefs'));
touch(catfile($prefsDir, 'plugin', 'disabled', 'prefs.prefs'));
touch(catfile($prefsDir, 'plugin', 'material-skin.prefs'));
is_deeply([ Plugins::LyrionJS::Players::namespaces($prefsDir, 'plugin.active') ],
	[ 'plugin.active', 'plugin.disabled.prefs', 'plugin.material-skin', 'server' ],
	'loaded namespaces and every preferences file');

# --- removal -------------------------------------------------------------------------------
my %data = (
	'plugin.disabled.prefs' => { '_client:02:4c:4a:00:00:01' => {}, '_client:02:4c:4a:00:00:04' => {} },
	server                  => { globalSetting => 1, '_client:02:4c:4a:00:00:04' => {} },
);
my @removed;
{
	package TestPrefs;
	sub remove { my ($self, @keys) = @_; delete $self->{prefs}{$_} for @keys; push @removed, [ $self->{ns}, @keys ] }
}
Plugins::LyrionJS::Players::removeClientPrefs([ '02:4c:4a:00:00:01' ], [ sort keys %data ],
	sub { bless { ns => $_[0], prefs => $data{$_[0]} }, 'TestPrefs' }, '_client');
is_deeply(\@removed, [ [ 'plugin.disabled.prefs', '_client:02:4c:4a:00:00:01' ] ],
	'only the stale player\'s entry, only where it has one');
ok(exists $data{'plugin.disabled.prefs'}{'_client:02:4c:4a:00:00:04'}, 'other players\' settings stay');
ok($data{server}{globalSetting}, 'global settings stay');
