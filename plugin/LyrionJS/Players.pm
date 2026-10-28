package Plugins::LyrionJS::Players;

# Removes the settings LMS keeps for LyrionJS players that are gone.
#
# LMS keeps every player's settings (a "_client:<MAC>" entry in each preferences namespace)
# for good, even after "Forget player". Each new browser, private window or cleared site makes
# a new LyrionJS player, so these pile up. When LMS starts, the plugin removes them for its own
# players (MAC prefix 02:4c:4a only) that haven't been seen for STALE_DAYS. LMS doesn't record
# when a player was last connected, so the plugin keeps that in its own preferences
# ('seen', MAC => time); a player it has no time for yet starts counting from now. Saved
# playlists and global preferences are left alone.
#
# Pure: the caller passes in LMS's state, so this is tested without LMS (plugin/t/players.t).

use strict;

use File::Find qw(find);
use File::Spec ();
use File::Spec::Functions qw(catfile);
use List::Util qw(max);

use Plugins::LyrionJS::Bridge;

use constant STALE_DAYS => 30;

# Client preferences LMS changes as a player is used; each change stamps "_ts_<name>".
my @USE_STAMPS = qw(
	_ts_currentSong _ts_maxBitrate _ts_model _ts_modelName _ts_playername
	_ts_power _ts_repeat _ts_shuffle _ts_volume
);

# The LyrionJS players whose settings can go: not connected now, and nothing about them (the
# plugin's 'seen' time, their settings' timestamps, their saved queue) newer than STALE_DAYS.
# $clients are server.prefs' client preferences ({clientid, prefs}), $seen the 'seen' hash; a
# player missing from it is added with $now.
sub staleIds {
	my ($clients, $seen, $now, $prefsDir, $isConnected) = @_;
	my $cutoff = $now - STALE_DAYS * 24 * 60 * 60;
	my @staleIds;

	for my $clientPrefs (@$clients) {
		my $id = $clientPrefs->{clientid};
		next unless Plugins::LyrionJS::Bridge::isLyrionJSPlayer($id);
		next if $isConnected->($id);

		$seen->{$id} ||= $now;
		my $ts = max($seen->{$id}, lastUsed($clientPrefs, $prefsDir));
		push @staleIds, $id if $ts <= $cutoff;
	}

	return @staleIds;
}

sub lastUsed {
	my ($clientPrefs, $prefsDir) = @_;

	my $ts = max(0, grep { defined } @{ $clientPrefs->{prefs} }{@USE_STAMPS});

	if (defined $prefsDir) {
		(my $playlistId = $clientPrefs->{clientid}) =~ s/://g;
		my @stat = stat catfile($prefsDir, "clientplaylist_$playlistId.m3u");
		$ts = max($ts, $stat[9]) if @stat;
	}

	return $ts;
}

# Every namespace with a preferences file in $prefsDir (plugin/foo.prefs is "plugin.foo", as
# LMS names them), as well as the loaded ones: a disabled plugin's file keeps players' settings too.
sub namespaces {
	my ($prefsDir, @activeNamespaces) = @_;
	my %namespaces = map { $_ => 1 } @activeNamespaces;

	find({
		no_chdir => 1,
		wanted   => sub {
			my $path = $File::Find::name;
			return unless -f $path && $path =~ /\.prefs\z/;

			my @parts = File::Spec->splitdir(File::Spec->abs2rel($path, $prefsDir));
			$parts[-1] =~ s/\.prefs\z//;
			return if grep { $_ eq '' || $_ eq '.' || $_ eq '..' } @parts;
			$namespaces{join('.', @parts)} = 1;
		},
	}, $prefsDir);

	return sort keys %namespaces;
}

# Removes just the players' "<$tag>:<MAC>" entries from each namespace ($getPrefs: LMS's
# preferences()).
sub removeClientPrefs {
	my ($ids, $namespaces, $getPrefs, $tag) = @_;

	for my $namespace (@$namespaces) {
		my $prefs = $getPrefs->($namespace);
		my @keys = map { "$tag:$_" } grep { Slim::Utils::Prefs::Client->hasPrefs($prefs, $_) } @$ids;
		$prefs->remove(@keys) if @keys;
	}
}

1;
