package Plugins::LyrionJS::Plugin;

# LyrionJS: a Slimproto player that runs in the web browser.
#
# Everything about the player (Slimproto, decoding, sync, output, UI) runs in the page. This
# plugin only serves that page, pipes the page's WebSocket to LMS's own Slimproto port (see
# Bridge.pm), passes SVG pictures on to it (Svg.pm), offers links to open the page, a settings
# page, and asks LMS to proxy streams for LyrionJS players. When LMS starts, it removes the
# settings LMS keeps for LyrionJS players that are gone (Players.pm). It changes nothing else.

use strict;
use base qw(Slim::Plugin::OPMLBased);

use File::Basename qw(dirname);
use File::Spec::Functions qw(catfile);
use JSON::XS::VersionOneAndTwo;
use List::Util qw(min);
use Socket ();

use Slim::Utils::Log;
use Slim::Utils::Prefs;
use Slim::Utils::Strings qw(string cstring);

use Plugins::LyrionJS::Bridge;
use Plugins::LyrionJS::Players;
use Plugins::LyrionJS::Svg;

my $log = Slim::Utils::Log->addLogCategory({
	category     => 'plugin.lyrionjs',
	defaultLevel => 'WARN',
	description  => 'PLUGIN_LYRIONJS',
});

my $prefs       = preferences('plugin.lyrionjs');
my $serverPrefs = preferences('server');

$prefs->init({
	enabled           => 1,       # browsers may connect as players
	proxyStreams      => 1,       # set LMS's "proxied streaming" on LyrionJS players
	defaultOutput     => 'auto',  # auto | webaudio | media
	clientDiagnostics => 0,       # pages may write diagnostics to the LMS log
	pageUrl           => '',      # the player's address in links; empty: this server's DNS name
});
$prefs->setValidate({ validator => sub { ($_[1] || '') =~ /^(?:auto|webaudio|media)$/ } }, 'defaultOutput');
$prefs->setValidate({ validator => sub { validPageUrl($_[1]) } }, 'pageUrl');

use constant PAGE_URL => '/plugins/LyrionJS/';
use constant ICON     => 'plugins/LyrionJS/html/images/icon.png';   # PNG: Squeezer can't show SVG

my $pageFile = catfile(dirname(__FILE__), 'HTML', 'lyrionjs.html');
my ($pageBody, $pageMtime) = ('', 0);
my %materialActions;   # section => our entry in Material Skin's custom actions

sub initPlugin {
	my $class = shift;

	# An app in My Apps (Material Skin's Apps, and other controllers). LMS builds the Apps entry
	# itself, so it can't carry a link: opening the app lists the player's address, as a link
	# where the controller can follow one (Material opens it in a new tab).
	$class->SUPER::initPlugin(feed => \&_appFeed, tag => 'lyrionjs', is_app => 1);

	Slim::Web::Pages->addRawFunction(qr{^/plugins/LyrionJS/(?:index\.html)?$}, \&_page);
	Slim::Web::Pages->addRawFunction(qr{^/plugins/LyrionJS/config\.json$}, \&_config);
	Plugins::LyrionJS::Bridge->init($log, $prefs);
	Plugins::LyrionJS::Svg->init($log);

	if (main::WEBUI) {
		require Plugins::LyrionJS::Settings;
		Plugins::LyrionJS::Settings->new;
	}
	_registerLinks();
	$prefs->setChange(sub { _registerLinks() }, 'pageUrl');

	# LyrionJS players fetch audio from LMS itself (a browser can't reach most other hosts), so
	# ask LMS to proxy radio and podcast streams for them rather than send them direct. This is
	# LMS's own per-player option, set only on LyrionJS players.
	Slim::Control::Request::subscribe(\&_newClient, [['client'], ['new', 'reconnect']]);
	Slim::Control::Request::subscribe(\&_seenClient, [['client'], ['new', 'reconnect', 'disconnect']]);
	_seenConnected();
}

sub shutdownPlugin {
	Slim::Control::Request::unsubscribe(\&_newClient);
	Slim::Control::Request::unsubscribe(\&_seenClient);
	Slim::Utils::Timers::killTimers(undef, \&_seenConnected);
	_seen(map { $_->id } Slim::Player::Client::clients());   # the players still connected
	Plugins::LyrionJS::Bridge->shutdown();
}

# The player's address, as links give it: the pageUrl setting, or this server under its DNS name
# (so every link opens the same origin, and a browser keeps one player identity), or its address.
# The name is looked up once, without blocking LMS (AnyEvent's resolver, as LMS's own lookups);
# until it answers, and if it doesn't, links use the address.
my ($autoUrl, $autoFor) = ('', '');
sub pageUrl {
	if (my $url = $prefs->get('pageUrl')) {
		# Only a host (or host and /): the player's usual path on it. Otherwise the full address.
		return $url =~ m{^(https?://[^/]+)/?\z} ? $1 . PAGE_URL : $url;
	}
	my $base = Slim::Utils::Network::serverURL();
	_lookUpName($base) if $autoFor ne $base;   # first use, or the server's address changed
	return $autoUrl;
}

# Is this a usable pageUrl setting (empty for automatic)? A plain http(s) address, nothing that
# needs quoting where links are written out.
sub validPageUrl {
	my $u = shift // '';
	return 1 if $u eq '';
	return $u =~ m{^https?://[A-Za-z0-9.\-\[\]:]+(?:/[A-Za-z0-9._~!\$&()*+,;=:@%/\-]*)?\z} ? 1 : 0;
}

sub _lookUpName {
	my $base = shift;
	($autoFor, $autoUrl) = ($base, $base . PAGE_URL);
	my ($scheme, $ip, $port) = $base =~ m{^(https?)://(\d+\.\d+\.\d+\.\d+)(:\d+)?} or return;
	eval {
		require AnyEvent::DNS;
		# reverse_verify: only names that resolve back to this address.
		AnyEvent::DNS::reverse_verify($ip, sub {
			my ($name) = grep { /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.?\z/i } @_ or return;
			return unless $autoFor eq $base;        # the address changed meanwhile
			$name =~ s/\.\z//;
			$autoUrl = "$scheme://" . lc($name) . ($port || '') . PAGE_URL;
			main::INFOLOG && $log->is_info && $log->info("Player address: $autoUrl");
			_registerLinks();
		});
		1;
	} or $log->warn("Can't look up this server's name: $@");
}

# Links to the player in LMS's web UIs, with the absolute address: the classic UI's plugin menu,
# and Material Skin's "Extras" (with this icon; Material opens it in a frame, and the page then
# offers a tab of its own).
sub _registerLinks {
	my $url = pageUrl();
	$_->{weblink} = $url for values %materialActions;
	return unless main::WEBUI;
	Slim::Web::Pages->addPageLinks('plugins', { PLUGIN_LYRIONJS_LINK => $url });
	Slim::Web::Pages->addPageLinks('icons',   { PLUGIN_LYRIONJS_LINK => ICON });
}

# A tile on Material Skin's home screen that opens the player in a new tab with one click (a
# Material "pinned" custom action; Material adds it again on each load, so un-pinning doesn't
# stick). Material's plugin API keeps the hash given to it, so a new address is changed in it in
# place (_registerLinks). Once every plugin has loaded, as Material may load after this one.
sub postinitPlugin {
	# Before any player connects. A failure must never stop the plugin.
	eval { _removeStalePlayers(); 1 }
		or $log->warn("Can't remove old LyrionJS players' settings: $@");

	return unless Slim::Utils::PluginManager->isEnabled('Plugins::MaterialSkin::Plugin');
	my $register = Plugins::MaterialSkin::Plugin->can('registerCustomAction') or return;
	%materialActions = (pinned => { title => string('PLUGIN_LYRIONJS'), icon => 'music_note' });
	# Material's API may change: that must never stop this plugin.
	eval { $register->($_, $materialActions{$_}) for sort keys %materialActions; 1 }
		or $log->warn("Can't add LyrionJS to Material Skin: $@");
	_registerLinks();
}

sub _newClient {
	my $request = shift;
	my $client  = $request->client || return;

	return unless Plugins::LyrionJS::Bridge::isLyrionJSPlayer($client->id);
	return unless $prefs->get('proxyStreams');

	my $cprefs = $serverPrefs->client($client);
	if ( ($cprefs->get('mp3StreamingMethod') || 0) != 1 ) {
		main::INFOLOG && $log->is_info && $log->info('Proxying streams for ' . $client->id);
		$cprefs->set('mp3StreamingMethod', 1);
	}
}

# The app's one page: the player's address, as a link. It is answered here rather than by LMS's
# feed browser, which marks a text item inert (Squeezer then can't open it) or gives it a browse
# action (which controllers follow instead of the link). An item with only a weblink opens in the
# browser on Squeezer; parseURLs makes Material show it as a link that opens a new tab;
# controllers that can't follow links show the address to type into a browser.
sub initCLI {
	my $class = shift;
	$class->SUPER::initCLI(@_);
	Slim::Control::Request::addDispatch(['lyrionjs', 'items', '_index', '_quantity'], [0, 1, 1, \&_appItems]);
}

# The server's own web skin, with this browser as the player: LyrionJS showing that skin, as its
# Settings › Skin would ([its name, the address], or nothing if the skin isn't installed).
sub _skinLink {
	my $client = shift;
	my %skins = Slim::Web::HTTP::skins(1);
	my $want = lc($serverPrefs->get('skin') || '');
	my ($dir) = grep { lc $_ eq $want && /^[\w.-]+\z/ } keys %skins or return;
	# The skin's name alone if LMS hasn't read this string yet (its strings cache predates it).
	my $label = Slim::Utils::Strings::stringExists('PLUGIN_LYRIONJS_MENU_SKIN') ? cstring($client, 'PLUGIN_LYRIONJS_MENU_SKIN', $skins{$dir}) : $skins{$dir};
	return ($label, pageUrl() . '?skin=lms:' . $dir);
}

sub _appItems {
	my $request = shift;
	my $url = pageUrl();
	my ($skinName, $skinUrl) = _skinLink($request->client);
	my @items = (
		{ text => $url, weblink => $url, parseURLs => 1 },
		# The skin's name on a line of its own: Material shows an item's text as HTML (the link
		# parseURLs makes) only when the text starts with it.
		$skinUrl ? (
			{ text => $skinName, style => 'itemNoAction', action => 'none' },
			{ text => $skinUrl, weblink => $skinUrl, parseURLs => 1 },
		) : (),
		{ text => cstring($request->client, 'PLUGIN_LYRIONJS_MENU_INFO'), style => 'itemNoAction', action => 'none' },
	);
	# The page asked for (controllers fetch in pages, even of two items).
	my $start = $request->getParam('_index') || 0;
	my $count = $request->getParam('_quantity');
	$count = scalar @items unless defined $count && $count =~ /^\d+$/;
	$start = 0 unless $start =~ /^\d+$/;
	my $i = 0;
	for my $item (grep { defined } @items[$start .. min($start + $count, scalar @items) - 1]) {
		$request->addResultLoop('item_loop', $i, $_, $item->{$_}) for sort keys %$item;
		$i++;
	}
	$request->addResult('count', scalar @items);
	$request->addResult('offset', $start);
	$request->addResult('window', { windowStyle => 'text_list' });
	$request->setStatusDone();
}

# The same page for the classic web UI's browser.
sub _appFeed {
	my ($client, $callback) = @_;
	my $url = pageUrl();
	my ($skinName, $skinUrl) = _skinLink($client);
	$callback->({ items => [
		{ name => $url, type => 'text', weblink => $url },   # a link to open, not a feed to fetch
		$skinUrl ? ({ name => $skinName, type => 'text' }, { name => $skinUrl, type => 'text', weblink => $skinUrl }) : (),
		{ name => cstring($client, 'PLUGIN_LYRIONJS_MENU_INFO'), type => 'text' },
	] });
}

# What the page needs to know about this server's LyrionJS settings.
sub _config {
	my ($httpClient, $response) = @_;
	my $body = to_json({
		enabled           => $prefs->get('enabled') ? 1 : 0,
		defaultOutput     => $prefs->get('defaultOutput') || 'auto',
		clientDiagnostics => $prefs->get('clientDiagnostics') ? 1 : 0,
		version           => (Slim::Utils::PluginManager->dataForPlugin(__PACKAGE__) || {})->{version} || '',   # install.xml's
		page              => (stat $pageFile)[9] || 0,   # when the page last changed: a tab open since then reloads
		skins             => { Slim::Web::HTTP::skins(1) },   # the web skins installed, which the page can show over itself
		skin              => $serverPrefs->get('skin') || '',   # the server's own choice
	});
	$response->code(200);
	$response->content_type('application/json');
	$response->header('Cache-Control' => 'no-store');
	# The page's MAC (?mac=), kept in a cookie for the page to fall back on if the browser
	# deletes its storage (Safari does after 7 days without a visit; not cookies a server sets).
	# Browsers keep a cookie 400 days at most, so it's set again on each load. Only LyrionJS's
	# own path gets it.
	my %query = eval { $response->request->uri->query_form };
	my $mac = lc($query{mac} // '');
	$response->header('Set-Cookie' => "lj_mac=$mac; Max-Age=34560000; SameSite=Strict")
		if $mac =~ /^02:4c:4a(?::[0-9a-f]{2}){3}\z/;
	$response->header('Content-Length' => length $body);
	Slim::Web::HTTP::addHTTPResponse($httpClient, $response, \$body);
}

# The page: one self-contained file, read again whenever it changes on disk.
sub _page {
	my ($httpClient, $response) = @_;

	my $mtime = (stat $pageFile)[9] || 0;
	if ($mtime != $pageMtime) {
		if (open my $fh, '<:raw', $pageFile) {
			local $/;
			$pageBody  = <$fh>;
			$pageMtime = $mtime;
			close $fh;
		}
		else {
			$log->error("Can't read $pageFile: $!");
		}
	}

	my $body = $pageBody;
	if ($body eq '') {
		$body = 'LyrionJS page missing';
		$response->code(500);
		$response->content_type('text/plain');
	}
	else {
		$response->code(200);
		$response->content_type('text/html; charset=utf-8');
		$response->header('Cache-Control' => 'no-cache');
		$response->header('X-Content-Type-Options' => 'nosniff');
		$response->header('Referrer-Policy' => 'same-origin');
	}
	$response->header('Content-Length' => length($body));

	Slim::Web::HTTP::addHTTPResponse($httpClient, $response, \$body);
}

# When LyrionJS players were last connected, for Players.pm: LMS doesn't record it. On connecting
# and disconnecting, at shutdown, and each day for those still connected, as LMS may be stopped
# without a shutdown (a Docker container is, for one) and a page can stay open for weeks.
sub _seenConnected {
	_seen(map { $_->id } Slim::Player::Client::clients());
	Slim::Utils::Timers::setTimer(undef, time + 24 * 60 * 60, \&_seenConnected);
}

sub _seenClient {
	my $client = $_[0]->client || return;
	_seen($client->id);
}

sub _seen {
	my $now = time;
	for my $id (grep { Plugins::LyrionJS::Bridge::isLyrionJSPlayer($_) } @_) {
		Slim::Utils::Prefs::Client->new($prefs, $id)->set('lastSeen', $now);
	}
}

sub _removeStalePlayers {
	my $prefsDir = Slim::Utils::Prefs::dir();
	return unless defined $prefsDir && -d $prefsDir;

	# 0.2.32 and 0.2.33 kept the times in one global preference.
	if (my $old = $prefs->get('seen')) {
		Slim::Utils::Prefs::Client->new($prefs, $_)->set('lastSeen', $old->{$_}) for keys %$old;
		$prefs->remove('seen');
	}

	my %lastSeen = map { $_->{clientid} => $_->{prefs}{lastSeen} } $prefs->allClients;
	my %ids = map { $_->{clientid} => 1 } $serverPrefs->allClients;
	$ids{$_} = 1 for keys %lastSeen;
	_seen(grep { !$lastSeen{$_} } keys %ids);   # first seen now

	my @ids = Plugins::LyrionJS::Players::staleIds([ sort keys %ids ], \%lastSeen, time,
		\&Slim::Player::Client::getClient) or return;

	$log->info('Removing the settings of LyrionJS players not seen for '
		. Plugins::LyrionJS::Players::STALE_DAYS . " days: @ids");
	my @namespaces = Plugins::LyrionJS::Players::namespaces($prefsDir,
		@{ Slim::Utils::Prefs::namespaces() || [] });
	Plugins::LyrionJS::Players::removeClientPrefs(\@ids, \@namespaces, \&preferences,
		$Slim::Utils::Prefs::Client::clientPreferenceTag);
}

1;
