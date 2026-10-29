package Plugins::LyrionJS::Players;

# Removes the settings LMS keeps for LyrionJS players that are gone.
#
# LMS keeps every player's settings (a "_client:<MAC>" entry in each preferences namespace)
# for good, even after "Forget player". Each new browser, private window or cleared site makes
# a new LyrionJS player, so these pile up. When LMS starts, the plugin removes them for its own
# players (MAC prefix 02:4c:4a only) that haven't been seen for STALE_DAYS. LMS doesn't record
# when a player was last connected, so the plugin keeps that as a client preference of its own
# ('lastSeen' in plugin.lyrionjs), which goes with the rest; a player it has no time for yet
# starts counting from now. Saved playlists and global preferences are left alone.
#
# Pure: the caller passes in LMS's state, so this is tested without LMS (plugin/t/players.t).

use strict;

use File::Find qw(find);
use File::Spec ();

use Plugins::LyrionJS::Bridge;

use constant STALE_DAYS => 30;

# The LyrionJS players among $ids whose settings can go: not connected now, and last seen
# ($lastSeen: MAC => time) STALE_DAYS ago or more. A player with no time isn't stale.
sub staleIds {
	my ($ids, $lastSeen, $now, $isConnected) = @_;
	my $cutoff = $now - STALE_DAYS * 24 * 60 * 60;

	return grep {
		Plugins::LyrionJS::Bridge::isLyrionJSPlayer($_) && !$isConnected->($_)
			&& ($lastSeen->{$_} || $now) <= $cutoff
	} @$ids;
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
