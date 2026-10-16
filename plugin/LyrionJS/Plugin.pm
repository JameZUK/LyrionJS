package Plugins::LyrionJS::Plugin;

# LyrionJS: a Slimproto player that runs in the web browser.
#
# Everything about the player (Slimproto, decoding, sync, output, UI) runs in the page. This
# plugin only serves that page, pipes the page's WebSocket to LMS's own Slimproto port (see
# Bridge.pm), offers links to open the page, a settings page, and asks LMS to proxy streams
# for LyrionJS players. It changes nothing else.

use strict;
use base qw(Slim::Plugin::Base);

use File::Basename qw(dirname);
use File::Spec::Functions qw(catfile);
use JSON::XS::VersionOneAndTwo;
use Socket ();

use Slim::Utils::Log;
use Slim::Utils::Prefs;
use Slim::Utils::Strings qw(string cstring);

use Plugins::LyrionJS::Bridge;

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
$prefs->setValidate({ validator => sub { ($_[1] // '') =~ m{^(?:|https?://[^\s/?#]+(?:/[^\s?#]*)?)$} } }, 'pageUrl');

use constant VERSION  => '0.2.1';
use constant PAGE_URL => '/plugins/LyrionJS/';
use constant ICON     => 'plugins/LyrionJS/html/icon.svg';
use constant MENU_ID  => 'pluginLyrionJS';

my $pageFile = catfile(dirname(__FILE__), 'HTML', 'lyrionjs.html');
my ($pageBody, $pageMtime) = ('', 0);

sub initPlugin {
	my $class = shift;
	$class->SUPER::initPlugin(@_);

	Slim::Web::Pages->addRawFunction(qr{^/plugins/LyrionJS/(?:index\.html)?$}, \&_page);
	Slim::Web::Pages->addRawFunction(qr{^/plugins/LyrionJS/config\.json$}, \&_config);
	Plugins::LyrionJS::Bridge->init($log, $prefs);

	if (main::WEBUI) {
		require Plugins::LyrionJS::Settings;
		Plugins::LyrionJS::Settings->new;
	}
	Slim::Control::Request::addDispatch(['lyrionjs', 'info', '_index', '_quantity'], [0, 1, 1, \&_info]);
	_registerLinks();
	$prefs->setChange(sub { _registerLinks() }, 'pageUrl');

	# LyrionJS players fetch audio from LMS itself (a browser can't reach most other hosts), so
	# ask LMS to proxy radio and podcast streams for them rather than send them direct. This is
	# LMS's own per-player option, set only on LyrionJS players.
	Slim::Control::Request::subscribe(\&_newClient, [['client'], ['new', 'reconnect']]);
}

sub shutdownPlugin {
	Slim::Control::Request::unsubscribe(\&_newClient);
	Slim::Control::Jive::deleteMenuItem(MENU_ID);
	Plugins::LyrionJS::Bridge->shutdown();
}

# The player's address, as links give it: the pageUrl setting, or this server under its DNS name
# (so every link opens the same origin, and a browser keeps one player identity), or its address.
my ($autoUrl, $autoAt) = ('', 0);
sub pageUrl {
	my $url = $prefs->get('pageUrl');
	if ($url) {
		$url .= PAGE_URL unless $url =~ m{^https?://[^/]+/};
		return $url;
	}
	if (!$autoUrl || time() - $autoAt > 3600) {
		my $base = Slim::Utils::Network::serverURL();
		my ($scheme, $host, $port) = $base =~ m{^(https?)://([^/:]+)(:\d+)?};
		if ($host && $host =~ /^\d+\.\d+\.\d+\.\d+$/) {
			my $name = _reverseName($host);
			$base = "$scheme://$name" . ($port || '') if $name;
		}
		($autoUrl, $autoAt) = ($base . PAGE_URL, time());
	}
	return $autoUrl;
}

# A fully qualified name for an IPv4 address, from reverse DNS; undef if there isn't one.
sub _reverseName {
	my $ip = shift;
	my $name = eval {
		local $SIG{ALRM} = sub { die "timeout\n" };
		alarm 2;                                   # never hold up LMS on a slow resolver
		my $n = gethostbyaddr(Socket::inet_aton($ip), Socket::AF_INET());
		alarm 0;
		$n;
	};
	alarm 0;
	return undef unless $name && $name =~ /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
	# Only a name that leads back to this address.
	my $back = eval { Socket::inet_ntoa(scalar gethostbyname($name)) } || '';
	return $back eq $ip ? lc $name : undef;
}

# Ways to open the player from LMS. Each uses the absolute address, so a controller opens it as
# its own page (Material Skin opens an absolute http link in a new tab).
sub _registerLinks {
	my $url = pageUrl();
	if (main::WEBUI) {
		# The classic web UI's plugin menu, and Material Skin's "Extras" (with this icon).
		Slim::Web::Pages->addPageLinks('plugins', { PLUGIN_LYRIONJS_LINK => $url });
		Slim::Web::Pages->addPageLinks('icons',   { PLUGIN_LYRIONJS_LINK => ICON });
	}
	# An entry in My Music (Material Skin's browse page, and other controllers). It opens the
	# list from `lyrionjs info`, whose first item opens the player.
	Slim::Control::Jive::registerPluginMenu([{
		text    => string('PLUGIN_LYRIONJS_MENU'),
		id      => MENU_ID,
		node    => 'myMusic',
		weight  => 1000,
		icon    => ICON,
		weblink => $url,
		actions => { go => { cmd => ['lyrionjs', 'info'], player => 0 } },
		window  => { menustyle => 'text' },
	}]);
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

# The menu entry's list: Material Skin builds My Music entries from their actions alone, so the
# link that opens the player (in a tab of its own) is here; other controllers show the address.
sub _info {
	my $request = shift;
	my $url = pageUrl();
	my @items = (
		{ text => cstring($request->client, 'PLUGIN_LYRIONJS_MENU_INFO'), style => 'itemNoAction' },
		# parseURLs: Material shows the address as a link that opens a new tab.
		{ text => $url, style => 'itemNoAction', weblink => $url, parseURLs => 1 },
	);
	my $i = 0;
	for my $item (@items) {
		$request->addResultLoop('item_loop', $i, $_, $item->{$_}) for sort keys %$item;
		$i++;
	}
	$request->addResult('count', $i);
	$request->addResult('offset', 0);
	$request->setStatusDone();
}

# What the page needs to know about this server's LyrionJS settings.
sub _config {
	my ($httpClient, $response) = @_;
	my $body = to_json({
		enabled           => $prefs->get('enabled') ? 1 : 0,
		defaultOutput     => $prefs->get('defaultOutput') || 'auto',
		clientDiagnostics => $prefs->get('clientDiagnostics') ? 1 : 0,
		version           => VERSION,
	});
	$response->code(200);
	$response->content_type('application/json');
	$response->header('Cache-Control' => 'no-store');
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

1;
