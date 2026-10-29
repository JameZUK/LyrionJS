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
	my $path = shift;
	open my $fh, '>', $path or die "open $path: $!";
	close $fh;
}

# --- which players are stale -------------------------------------------------------------
my $now    = 2_000_000_000;
my $cutoff = $now - $P->can('STALE_DAYS')->() * 24 * 60 * 60;
my %connected = ('02:4c:4a:00:00:04' => 1);
my %lastSeen = (
	'02:4c:4a:00:00:01' => $cutoff - 1,
	'02:4c:4a:00:00:02' => $cutoff,
	'02:4c:4a:00:00:03' => $cutoff + 1,
	'02:4c:4a:00:00:04' => $cutoff - 1,
	'00:04:20:23:2d:84' => $cutoff - 1,
);
my @ids = (sort(keys %lastSeen), '02:4c:4a:00:00:05');
is_deeply([ Plugins::LyrionJS::Players::staleIds(\@ids, \%lastSeen, $now, sub { $connected{$_[0]} }) ],
	[ '02:4c:4a:00:00:01', '02:4c:4a:00:00:02' ],
	'stale: seen before or on the cutoff; kept: seen since, connected, no time yet, other players');

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
