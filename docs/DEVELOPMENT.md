# Developing LyrionJS

```sh
python3 build.py                      # src/ -> lyrionjs.html (and into the plugin)
python3 build.py --package --url URL  # also dist/LyrionJS-<version>.zip and dist/repo.xml
python3 relay.py --lms 192.168.1.20   # dev only: the page against a real LMS without the plugin
```

Tests:

```sh
node --test tests/                               # decoders, Slimproto, player, transport, outputs, fMP4 (checked with ffmpeg)
python3 -m unittest discover -s tests            # the dev relay against a fake LMS
tests/e2e/testlms.sh                             # a disposable LMS 9.1 in Docker, plugin installed
tests/perl.sh                                    # the plugin's Perl tests, inside that container
python3 tests/e2e/bridge_live.py http://127.0.0.1:19000      # the plugin's socket protocol, live
```

Never run the live tests against a household server: they create and remove test players.

| Path | What |
|---|---|
| `plugin/LyrionJS/` | The LMS plugin: `Plugin.pm`, `Bridge.pm`, `Players.pm`, `Svg.pm`, `Settings.pm`, `install.xml`, `strings.txt`, `HTML/lyrionjs.html` (built) |
| `plugin/t/` | The plugin's Perl tests, and protocol vectors shared with the relay's tests |
| `assets/icon.svg` | The LyrionJS logo: inlined into the page (header, start screens, About, favicon) by `build.py`; `build.py --icons` renders the PNGs LMS and phones use (`html/images/icon.png`, `apple-touch-icon.png`; needs `rsvg-convert`) |
| `src/core/` | Slimproto, the player state machine, FLAC/PCM/MP3 decoding (no DOM, no I/O) |
| `src/output/` | Web Audio output stage and resampler; media-element output (FLAC verbatim frames → fMP4 → (Managed) Media Source) |
| `src/host/` | The control socket with resume, and audio streams |
| `src/app/` | The UI: router, widgets, LMS menus, this browser's player, one file per view |
| `src/i18n/` | The page's translations, one file per language (`tools/strings.mjs` keeps them in step) |
| `src/skins/` | Other looks than `style.css`'s, each scoped by `data-skin` (`material.css`: like LMS's Material Skin). An installed LMS skin itself is shown by `src/app/skin.js` |
| `relay.py` | Dev-only stand-in for the plugin |

## Languages

The page's text is English in the source, wrapped in `tr()` (see `src/app/i18n.js`); each language
is `src/i18n/<code>.json`, the English text mapped to its translation.

The translations (cs, da, de, es, fi, fr, hu, it, nb, nl, nn, pl, sv), and the plugin's LMS
strings in `plugin/LyrionJS/strings.txt`, were made with AI (Claude) from a brief: LMS's own
translations for the shared terms (queue, favourites, shuffle, crossfade…), the queue kept apart
from saved playlists, placeholders untouched, the jokes rewritten rather than translated word for
word. Bokmål (nb) has been reviewed by a native speaker; the others haven't been checked by one
yet. Corrections from speakers win: take them as they
come, and keep the wording LMS uses where a fix would part from it without reason.

To fix a translation, edit the value (never the English key) in `src/i18n/<code>.json`, keeping
every `{placeholder}`, then run `node --test tests/i18n.test.mjs`. For the plugin's LMS strings,
edit that language's line (`\t<CODE>\t<text>`) under the string's id in `strings.txt`; LMS reads
it at start, so a change there needs an LMS restart.

```sh
node tools/strings.mjs            # each language: how many of the page's keys are translated
node tools/strings.mjs --update   # add new keys to every language (empty) and drop removed ones
node tools/strings.mjs --keys     # every key, with the singular of counted text
```

After changing the page's text, run `--update` and translate the empty entries;
`tests/i18n.test.mjs` fails while a language is incomplete or a translation loses a
`{placeholder}`. To add a language, add it to `LANGS` in `i18n.js`, create
`src/i18n/<code>.json` as `{}` and run `--update`. Counted text needs the plural forms
`Intl.PluralRules` names for the language (`one`, `few`, `many`, `other`…).

## Screenshots

`docs/screenshots/` is taken from the test LMS (`tests/e2e/testlms.sh`) and its made-up library,
at 1280×800 for desktop and 390×844 for phones, with this browser's player playing at volume 0.
On that LMS, Material Skin's page never finishes loading (LMS doesn't answer
`/material/material/backdrops/browse.jpg` when no background is set), so block that address in
the browser first, or Material's buttons do nothing.

## Making a release

```sh
./release.sh     # builds dist/LyrionJS-<version>.zip and repo.xml, then prints the publish steps
```

Bump `<version>` in `plugin/LyrionJS/install.xml` first. `repo.xml` on `main` is what LMS reads,
so publish the GitHub release (with the zip attached) before pushing the new `repo.xml`.

## How it works

All of Slimproto runs in the page. The plugin is a lightweight byte pipe:

| | Where |
|---|---|
| Slimproto client, player state machine, sync, decoders, output, UI | the browser |
| Serve the page; pipe a WebSocket to LMS's own Slimproto port with a 10 s hold for dropouts; check the page's origin and that its HELO uses LyrionJS's MAC prefix | the plugin (about 550 lines of Perl) |
| Audio | the browser fetches LMS's normal `/stream.mp3`, as any squeezelite does |

The plugin also turns on LMS's existing *proxy streams* option for LyrionJS players only, so radio
comes through LMS rather than straight from the station, which a browser can't reach. Full design
and protocol: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
