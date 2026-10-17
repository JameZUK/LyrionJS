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
| `plugin/LyrionJS/` | The LMS plugin: `Plugin.pm`, `Bridge.pm`, `Svg.pm`, `Settings.pm`, `install.xml`, `strings.txt`, `HTML/lyrionjs.html` (built) |
| `plugin/t/` | The plugin's Perl tests, and protocol vectors shared with the relay's tests |
| `assets/icon.svg` | The LyrionJS logo: inlined into the page (header, start screens, About, favicon) by `build.py`; `build.py --icons` renders the PNGs LMS and phones use (`html/images/icon.png`, `apple-touch-icon.png`; needs `rsvg-convert`) |
| `src/core/` | Slimproto, the player state machine, FLAC/PCM/MP3 decoding (no DOM, no I/O) |
| `src/output/` | Web Audio output stage and resampler; media-element output (FLAC verbatim frames → fMP4 → (Managed) Media Source) |
| `src/host/` | The control socket with resume, and audio streams |
| `src/app/` | The UI: router, widgets, LMS menus, this browser's player, one file per view |
| `src/skins/` | Other looks than `style.css`'s, each scoped by `data-skin` (`material.css`: like LMS's Material Skin) |
| `relay.py` | Dev-only stand-in for the plugin |

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
