package Plugins::LyrionJS::Settings;

# Settings › Plugins › LyrionJS: the plugin's options, the browser players LMS knows, and a
# button to open the player.

use strict;
use base qw(Slim::Web::Settings);

use Slim::Utils::Prefs;

my $prefs = preferences('plugin.lyrionjs');

sub name { Slim::Web::HTTP::CSRF->protectName('PLUGIN_LYRIONJS') }

sub page { Slim::Web::HTTP::CSRF->protectURI('plugins/LyrionJS/settings/basic.html') }

sub prefs { ($prefs, qw(enabled proxyStreams defaultOutput clientDiagnostics)) }

sub handler {
	my ($class, $client, $params, @args) = @_;

	# Only these values are accepted for the output choice.
	if ($params->{saveSettings} && ($params->{pref_defaultOutput} || '') !~ /^(?:auto|webaudio|media)$/) {
		$params->{pref_defaultOutput} = 'auto';
	}
	for my $p (qw(enabled proxyStreams clientDiagnostics)) {
		$params->{"pref_$p"} = $params->{"pref_$p"} ? 1 : 0 if $params->{saveSettings};
	}

	my @players;
	for my $c (Slim::Player::Client::clients()) {
		next unless Plugins::LyrionJS::Bridge::isLyrionJSPlayer($c->id);
		push @players, { name => $c->name, id => $c->id, connected => $c->connected ? 1 : 0, model => $c->modelName };
	}
	$params->{lyrionjsPlayers} = [ sort { lc $a->{name} cmp lc $b->{name} } @players ];
	$params->{lyrionjsSessions} = Plugins::LyrionJS::Bridge::sessionCount();
	$params->{lyrionjsUrl} = Slim::Utils::Network::serverURL() . '/plugins/LyrionJS/';

	return $class->SUPER::handler($client, $params, @args);
}

1;
