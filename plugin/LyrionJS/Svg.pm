package Plugins::LyrionJS::Svg;

# SVG pictures for the page (radio logos and the like). LMS's image proxy can't resize SVG, so
# for one it redirects the browser to the picture's own host, which the page doesn't load from
# (its CSP allows pictures from LMS only). This fetches SVGs only, and passes them on as they are
# with headers that let them be nothing but a picture.

use strict;

use Digest::MD5 qw(md5_hex);

use constant PATH        => '/plugins/LyrionJS/svg';
use constant MAX_BYTES   => 512 * 1024;
use constant MAX_URL     => 2048;
use constant TIMEOUT     => 15;
use constant KEEP        => '7 days';
use constant KEEP_FAILED => '1 hour';
# Opened on its own, an SVG is a document: no scripts, nothing loaded, nothing it can reach.
use constant CSP => "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

my ($log, $cache);

sub init {
	my ($class, $l) = @_;
	$log = $l;
	Slim::Web::Pages->addRawFunction(qr{^\Q${\PATH}\E$}, \&_handle);
}

# The address may be fetched: http(s), a path ending in .svg, no user name, not this machine.
sub urlAllowed {
	my $url = shift;
	return 0 unless defined $url && !ref $url && length $url <= MAX_URL;
	my ($host, $path) = $url =~ m{^https?://([^/?#]+)(/[^?#]*)?(?:[?#].*)?$}i or return 0;
	return 0 if $host =~ /@/ || !$path || $path !~ /\.svg$/i;
	$host =~ s/:\d+$//;
	$host = lc $host;
	return 0 if $host eq 'localhost' || $host =~ /^\[/ || $host =~ /^127\./ || $host eq '0.0.0.0';
	return 1;
}

# Is it an SVG (whatever its server called it)?
sub looksLikeSvg {
	my $ref = shift;
	return 0 unless length $$ref && length $$ref <= MAX_BYTES;
	return substr($$ref, 0, 4096) =~ /^(?:\xEF\xBB\xBF)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--.*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/si ? 1 : 0;
}

sub _handle {
	my ($httpClient, $response) = @_;
	my $req = $response->request;
	return _fail($httpClient, $response, 405) unless $req->method eq 'GET' || $req->method eq 'HEAD';
	# Pictures for this server's own pages, not for other sites to use it as a proxy.
	my $site = $req->header('Sec-Fetch-Site');
	return _fail($httpClient, $response, 403) if $site && $site ne 'same-origin' && $site ne 'none';

	my %q = $req->uri->query_form;
	my $url = $q{u};
	return _fail($httpClient, $response, 400) unless urlAllowed($url);

	# Loaded here, not above, so the checks can be tested without a running LMS.
	require Slim::Networking::SimpleAsyncHTTP;
	require Slim::Utils::Cache;
	$cache ||= Slim::Utils::Cache->new;
	my $key = 'lyrionjs_svg_' . md5_hex($url);
	if (defined(my $body = $cache->get($key))) {
		return length $body ? _send($httpClient, $response, \$body) : _fail($httpClient, $response, 404);
	}

	Slim::Networking::SimpleAsyncHTTP->new(
		sub {
			my $http = shift;
			my $ref = $http->contentRef;
			if (looksLikeSvg($ref)) {
				$cache->set($key, $$ref, KEEP);
				_send($httpClient, $response, $ref);
			}
			else {
				main::INFOLOG && $log->is_info && $log->info("Not an SVG: $url");
				$cache->set($key, '', KEEP_FAILED);
				_fail($httpClient, $response, 404);
			}
		},
		sub {
			my ($http, $error) = @_;
			main::INFOLOG && $log->is_info && $log->info("Can't fetch $url: $error");
			$cache->set($key, '', KEEP_FAILED);
			_fail($httpClient, $response, 404);
		},
		{ timeout => TIMEOUT },
	)->get($url, 'Accept' => 'image/svg+xml,image/*;q=0.8');
}

sub _send {
	my ($httpClient, $response, $ref) = @_;
	return unless $httpClient->connected;
	$response->code(200);
	$response->content_type('image/svg+xml');
	$response->header('Content-Security-Policy' => CSP);
	$response->header('X-Content-Type-Options' => 'nosniff');
	$response->header('Cache-Control' => 'public, max-age=86400');
	$response->header('Content-Length' => length $$ref);
	my $body = $response->request->method eq 'HEAD' ? '' : $$ref;
	Slim::Web::HTTP::addHTTPResponse($httpClient, $response, \$body);
}

sub _fail {
	my ($httpClient, $response, $code) = @_;
	return unless $httpClient->connected;
	my $text = '';
	$response->code($code);
	$response->content_type('text/plain');
	$response->header('Cache-Control' => 'no-store');
	$response->header('Content-Length' => 0);
	Slim::Web::HTTP::addHTTPResponse($httpClient, $response, \$text);
}

1;
