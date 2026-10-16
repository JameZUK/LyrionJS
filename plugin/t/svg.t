#!/usr/bin/perl
# Unit tests for Plugins::LyrionJS::Svg's checks: which addresses it fetches, and what counts as
# an SVG. Run with LMS's libraries on @INC (tests/perl.sh).
use strict;
use warnings;
use Test::More 'no_plan';

BEGIN { package main; use constant { ISWINDOWS => 0, INFOLOG => 0, DEBUGLOG => 0 } }

use Plugins::LyrionJS::Svg;
my $ok  = \&Plugins::LyrionJS::Svg::urlAllowed;
my $svg = sub { Plugins::LyrionJS::Svg::looksLikeSvg(\$_[0]) };

# --- addresses ---------------------------------------------------------------------------------
ok($ok->('https://cdn.example/logos/radio1.svg'), 'https SVG');
ok($ok->('http://cdn.example:8080/a/B.SVG?v=3'), 'http, port, query, upper case');
ok($ok->('https://192.168.1.5/logo.svg'), 'a LAN host');
ok(!$ok->('https://cdn.example/logo.png'), 'not an SVG');
ok(!$ok->('https://cdn.example/logo.svg.php'), 'SVG only at the end of the path');
ok(!$ok->('https://cdn.example/?f=logo.svg'), 'SVG in the query only');
ok(!$ok->('file:///etc/logo.svg'), 'file:');
ok(!$ok->('ftp://cdn.example/logo.svg'), 'ftp:');
ok(!$ok->('//cdn.example/logo.svg'), 'no scheme');
ok(!$ok->('https://user:pw@cdn.example/logo.svg'), 'user name');
ok(!$ok->('http://localhost:9000/logo.svg'), 'localhost');
ok(!$ok->('http://127.0.0.1:9000/logo.svg'), 'loopback');
ok(!$ok->('http://[::1]/logo.svg'), 'IPv6 literal');
ok(!$ok->('https://cdn.example/' . ('a' x 3000) . '.svg'), 'too long');
ok(!$ok->(undef), 'none');
ok(!$ok->(['https://cdn.example/a.svg']), 'not a string');

# --- content -----------------------------------------------------------------------------------
ok($svg->('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'plain SVG');
ok($svg->(qq{\xEF\xBB\xBF<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>}), 'BOM, XML declaration, comment, doctype');
ok(!$svg->('<html><body><svg></svg></body></html>'), 'an HTML page');
ok(!$svg->("\x89PNG\r\n\x1a\n"), 'a PNG');
ok(!$svg->('{"svg": 1}'), 'JSON');
ok(!$svg->(''), 'empty');
ok(!$svg->('<svg>' . ('x' x (600 * 1024))), 'too big');
