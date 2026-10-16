# LyrionJS

An LMS plugin that turns any web browser into a **Slimproto player** for Lyrion Music Server,
with a full controller around it. Open `http://<your-lms>:9000/plugins/LyrionJS/` and that
browser appears in LMS as a player, like a Squeezebox or squeezelite. It plays in sync with
your other players, and it can control all of them.

It adds a new way to play and changes nothing else about LMS.

## What it does

- **A real LMS player in the browser.** The page itself speaks Slimproto: HELO, STAT and every
  `strm` command, gapless playback, sync groups (timed starts, pause and skip corrections,
  reporting what is actually heard), volume, power and renaming.
- **Lossless.** It has its own FLAC decoder (bit-exact, up to 24-bit/192 kHz), PCM/WAV/AIFF, and
  MP3. LMS converts everything else (AAC, Ogg, ALAC, radio, Spotify via Spotty…) to FLAC as usual.
- **Phones and tablets.** On iPhone, iPad and Android it detects the device and plays through an
  `<audio>` element fed with losslessly re-wrapped FLAC, so music keeps playing with the screen
  locked and the lock-screen controls work. Desktops use Web Audio. It's chosen automatically,
  and Settings can override it.
- **Rides out dropouts.** A Wi-Fi blip or a tablet waking up resumes the same player session, and
  LMS never sees the player leave.
- **Plugins appear as they do in Material.** The page renders LMS's own menus (SlimBrowse), so
  what plugins add shows up by itself: AudioMuse-AI, Custom Browse and the like in the sidebar,
  and their items in every track, album, artist and genre *More…* menu. Search can also run
  LMS's global search across apps and services.
- **The whole LMS.** Library browsing and search, queue (reorder, remove, save), saved playlists
  (create, rename, delete, edit), favourites, radio, every app and plugin menu, random mix,
  players (power, volume, sync, moving playback), alarms, sleep timer, and player settings.

## Install

1. Unzip `dist/LyrionJS-<version>.zip` (made by `python3 build.py --package`) into a `LyrionJS` folder in LMS's **manual** plugin folder
   (on Debian/Ubuntu `/var/lib/squeezeboxserver/Plugins/LyrionJS`; elsewhere, the plugin folders
   are listed under *Settings › Information*), owned by the LMS user. Not under `cache/InstalledPlugins`:
   LMS treats that folder as repository-managed and uninstalls anything it didn't download.
   Or publish the zip with `dist/repo.xml` and add that repository in *Settings › Plugins*.
2. Restart LMS.
3. Open `http://<your-lms>:9000/plugins/LyrionJS/`, or from LMS: the *LyrionJS* tile on
   Material Skin's home screen (opens it in a new tab), the *LyrionJS* app in *Apps* (then tap
   the address; this is the way in on Squeezer and other controllers), Material's *Extras*
   menu, the classic web UI's plugin menu, or the button on *Settings › Plugins › LyrionJS*.
   Tap or click once so the browser allows sound. LMS's links use the server's DNS name
   (reverse DNS) rather than its IP address, or the address set in Settings.

**Settings** (*Settings › Plugins › LyrionJS*): allow browsers to connect as players; fetch radio
and podcasts through LMS for LyrionJS players; the default audio output for new browsers
(automatic, Web Audio, media element); diagnostics to the LMS log; the player address LMS's
links use (for a reverse proxy, say); and the LyrionJS players LMS knows about.

Requirements: LMS 8 or later; a current browser. iPhone and iPad need iOS 17.1 or later for
screen-locked playback (older iOS still plays while the screen is on).

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

## Development

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
| `plugin/LyrionJS/` | The LMS plugin: `Plugin.pm`, `Bridge.pm`, `Settings.pm`, `install.xml`, `strings.txt`, `HTML/lyrionjs.html` (built) |
| `plugin/t/` | The plugin's Perl tests, and protocol vectors shared with the relay's tests |
| `assets/icon.svg` | The app icon's source; `rsvg-convert -w 128 -h 128 assets/icon.svg -o plugin/LyrionJS/HTML/EN/plugins/LyrionJS/html/images/icon.png` |
| `src/core/` | Slimproto, the player state machine, FLAC/PCM/MP3 decoding (no DOM, no I/O) |
| `src/output/` | Web Audio output stage and resampler; media-element output (FLAC verbatim frames → fMP4 → (Managed) Media Source) |
| `src/host/` | The control socket with resume, and audio streams |
| `src/app/` | The UI: router, widgets, LMS menus, this browser's player, one file per view |
| `relay.py` | Dev-only stand-in for the plugin |

## Limitations

- In media-element mode (phones and tablets) iOS doesn't let a page set the volume: the device's
  buttons set it, and LMS's volume for that player is held at 100 %. Sync in that mode is a little
  looser than with Web Audio.
- Crossfades configured in LMS aren't applied by the browser player (it's always gapless).
- A radio handler that insists on streaming directly from a station's server (ignoring LMS's
  proxy option) won't play unless the station allows cross-site requests.
- No authentication beyond LMS's own (its optional password applies). Like LMS, it's for your LAN.
