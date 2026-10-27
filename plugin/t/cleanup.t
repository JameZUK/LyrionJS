#!/usr/bin/perl
use strict;
use warnings;
use Test::More;
use File::Path qw(make_path);
use File::Spec::Functions qw(catfile);
use File::Temp qw(tempdir);

BEGIN { package main; use constant { ISWINDOWS => 0, INFOLOG => 0, DEBUGLOG => 0 } }

use Plugins::LyrionJS::Plugin;

our @removed;
our %prefsByNamespace = (
	'plugin.disabled.prefs' => { '_client:02:4c:4a:00:00:01' => {} },
	server                  => { globalSetting => 1 },
);

my $prefsDir = tempdir(CLEANUP => 1);
my $now = 2_000_000_000;
my $cutoff = $now - Plugins::LyrionJS::Plugin::STALE_PLAYER_DAYS() * 24 * 60 * 60;
my $playlistId = '02:4c:4a:00:00:05';
(my $playlistFileId = $playlistId) =~ s/://g;
my $playlistPath = catfile($prefsDir, "clientplaylist_$playlistFileId.m3u");
open my $playlist, '>', $playlistPath or die "open $playlistPath: $!";
print {$playlist} "#EXTM3U\n";
close $playlist or die "close $playlistPath: $!";
utime($cutoff + 1, $cutoff + 1, $playlistPath) or die "utime $playlistPath: $!";

my $connectedId = '02:4c:4a:00:00:06';
my %connected = ($connectedId => 1);
my @clients = (
	{ clientid => '02:4c:4a:00:00:01', prefs => { _ts_currentSong => $cutoff - 1 } },
	{ clientid => '02:4c:4a:00:00:02', prefs => { _ts_volume => $cutoff } },
	{ clientid => '02:4c:4a:00:00:03', prefs => {} },
	{ clientid => '02:4c:4a:00:00:04', prefs => { _ts_power => $cutoff + 1 } },
	{ clientid => $playlistId, prefs => { _ts_currentSong => $cutoff - 1 } },
	{ clientid => $connectedId, prefs => { _ts_currentSong => $cutoff - 1 } },
	{ clientid => '00:04:20:23:2d:84', prefs => { _ts_currentSong => $cutoff - 1 } },
);
my @stale = Plugins::LyrionJS::Plugin::_stalePlayerIds(
	\@clients,
	$now,
	$prefsDir,
	sub { $connected{$_[0]} },
);
is_deeply(\@stale, [
	'02:4c:4a:00:00:01',
	'02:4c:4a:00:00:02',
	'02:4c:4a:00:00:03',
], 'stale, boundary, and unknown timestamps qualify; recent, playlist-recent, connected, and other players do not');

make_path(catfile($prefsDir, 'plugin', 'disabled'));
for my $path (
	catfile($prefsDir, 'server.prefs'),
	catfile($prefsDir, 'plugin', 'disabled', 'prefs.prefs'),
) {
	open my $file, '>', $path or die "open $path: $!";
	close $file or die "close $path: $!";
}
my @namespaces = Plugins::LyrionJS::Plugin::_prefsNamespaces($prefsDir, 'plugin.active');
is_deeply(\@namespaces, [ 'plugin.active', 'plugin.disabled.prefs', 'server' ], 'active and nested persisted namespaces are discovered');

{
	package CleanupTestPrefs;
	sub new { bless { namespace => $_[1], prefs => $main::prefsByNamespace{$_[1]} }, $_[0] }
	sub remove {
		my ($self, @keys) = @_;
		delete $self->{prefs}{$_} for @keys;
		push @main::removed, [ $self->{namespace}, @keys ];
	}
}
my @removeNamespaces = ( 'plugin.disabled.prefs', 'server' );
Plugins::LyrionJS::Plugin::_removeClientPrefs(
	[ '02:4c:4a:00:00:01' ],
	\@removeNamespaces,
	sub { CleanupTestPrefs->new($_[0]) },
);
is_deeply(\@removed, [
	[ 'plugin.disabled.prefs', '_client:02:4c:4a:00:00:01' ],
], 'only the target client preference key is removed from each namespace');
ok(!exists $prefsByNamespace{'plugin.disabled.prefs'}{'_client:02:4c:4a:00:00:01'}, 'stale client entry is removed');
ok(exists $prefsByNamespace{server}{globalSetting}, 'unrelated global prefs are preserved');

done_testing();