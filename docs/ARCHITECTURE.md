# LyrionJS architecture

LyrionJS turns a web browser into a Slimproto player for Lyrion Music Server (LMS) and gives
it a full controller UI. It ships as an LMS plugin. **It adds a new way to play; it doesn't
change how LMS behaves.**

Principle: **all of Slimproto runs in the browser.** The plugin is a byte pipe with three
cheap checks. It does no decoding, keeps no player state and has no protocol logic.

```
 Browser: the LyrionJS page                                  LMS (unchanged)
 ┌──────────────────────────────────────┐   HTTP      ┌───────────────────────────────┐
 │ UI ── JSON-RPC, artwork ─────────────┼───────────▶│ :9000 /jsonrpc.js, /music/…   │
 │                                      │             │                               │
 │ Slimproto client + player state      │  WebSocket  │ ┌───────────────────────────┐ │
 │ machine, sync, resume                ├───────────▶│ │ LyrionJS plugin           │ │
 │                                      │             │ │  serves the page          │ │
 │ Audio: fetch('/stream.mp3?player=…') │             │ │  WS ⇄ Slimproto :3483     │─┼─▶ :3483
 │ Decoders: FLAC, PCM/WAV/AIFF, MP3    ├───────────▶│ │  (byte pipe + 10 s hold)  │ │
 │ Output: Web Audio  | <audio> + MSE   │   HTTP      │ └───────────────────────────┘ │
 └──────────────────────────────────────┘             │ :9000 /stream.mp3 (as for any │
                                                      │   squeezelite player)         │
                                                      └───────────────────────────────┘
```

## Decisions (agreed 2026-10-16)

| # | Topic | Decision |
|---|---|---|
| 1 | Dropouts | **Light resume.** The plugin holds LMS's Slimproto socket for 10 s after the WebSocket drops and replays what the browser missed. No heartbeats on the player's behalf: LMS drops a player silent for 15 s, so the hold stays under that. Longer outages fall back to a normal reconnect. |
| 2 | Direct streams | **A + C.** The plugin sets LMS's existing per-player *streaming method: proxied* option on LyrionJS players only, so radio and podcasts come through `/stream.mp3`. If a handler still sends a direct stream, the browser tries it itself (works only where the station allows cross-site requests); otherwise the track fails cleanly. |
| 3 | Checks in the pipe | **Origin** (only the page LMS served may open the socket) and **MAC prefix** (HELO must use `02:4c:4a`, so a page can't impersonate a hardware player). No frame policing. |
| 4 | iOS and mobile | **First build.** Detect iPhone, iPad and Android and play through an `<audio>` element fed by Managed Media Source or Media Source, so playback survives a locked screen. Desktops use Web Audio. Chosen automatically with a self-test; can be overridden in Settings. |
| 5 | Standalone relay | **Dev only.** `relay.py` emulates the plugin's URLs exactly and proxies everything else to a given LMS, so the page has one code path. Not for real use. |

## The plugin (`plugin/LyrionJS`)

Perl, inside LMS's event loop, using only LMS's own APIs:

- `Slim::Web::Pages->addRawFunction` takes these URLs, and only these:
  - `GET /plugins/LyrionJS/` (and `index.html`): the page, one static file.
  - `GET /plugins/LyrionJS/ws`: the WebSocket below.
  - `POST /plugins/LyrionJS/log`: opt-in page diagnostics, written to the LMS log.
- `GET /plugins/LyrionJS/config.json`: the plugin's settings the page needs (players on/off,
  default output, diagnostics).
- Ways in from LMS: a link in the classic UI's plugin menu and Material Skin's *Extras*
  (`addPageLinks`, with an icon), a home-menu entry carrying a `weblink` (Material opens it;
  other controllers show the address via `lyrionjs info`), and the settings page.
- A settings page (`Settings.pm`, `HTML/EN/plugins/LyrionJS/settings/basic.html`), prefs in
  `plugin.lyrionjs`: `enabled`, `proxyStreams`, `defaultOutput`, `clientDiagnostics`.
- A subscription to `client new` / `client reconnect`: for players whose MAC starts with
  `02:4c:4a` only, set `mp3StreamingMethod = 1` (proxied) if it isn't already.

LMS checks its password, if one is set, before a raw handler runs, so the plugin needs no
authentication of its own.

### WebSocket protocol (`/plugins/LyrionJS/ws`)

1. The client opens the socket. The plugin refuses (403) if an `Origin` header is present
   and its host isn't the request's `Host`.
2. The client's first message is text JSON, one of:
   - `{"hello":1}`: a new session.
   - `{"resume":{"session":S,"secret":K,"received":N}}`: `N` is the number of Slimproto
     bytes the client has received in that session.
3. The plugin answers with text JSON:
   `{"session":S,"secret":K,"resumed":false,"hold":10}` for a new session, or
   `{"session":S,"secret":K,"resumed":true,"hold":10,"replay":R}` for a resume, where the
   first `R` bytes that follow are the replay of what the client missed.
   A refused resume (unknown session, wrong secret, or bytes no longer held) is answered
   with close code **4404**; the client then starts a new session.
4. After that every message is **binary, raw Slimproto bytes**, in both directions. The
   plugin doesn't parse them, with one exception: in a new session, the first 16 bytes the
   client sends must be a HELO whose MAC starts with `02:4c:4a`, or the socket is closed
   with **1008**.
5. The plugin keeps the last 256 KiB sent to the client, counted from the start of the
   session, so a resume can replay from any `N` still held.
6. When the WebSocket drops, the plugin keeps the LMS connection open for **10 s**. A resume
   within that time attaches to it; otherwise the LMS connection is closed and LMS sees the
   player disconnect.
7. LMS closing its side ends the session (close code **1001**).
8. A new session whose HELO has the same MAC as an existing session ends that one first, so
   LMS never sees two connections for one player.

Limits: 32 sessions, 64 KiB per client message.

### What the client must do (the page)

- **Dead socket:** LMS talks to every player at least every 5 s, so 20 s with nothing
  received means the socket is dead. Abandon it and resume.
- **During a gap:** don't queue `STMt` heartbeats; send one fresh one on resume. Queue other
  STATs (`STMs`, `STMd`, `STMu`, …) and send them in order on resume. Drop sync corrections
  (`strm a`, timed `strm p` and `strm u`) that describe a moment already past. (These are
  lessons from Lyrion Anywhere: replayed heartbeats threw a sync group out.)
- **Resume refused (4404) or hold expired:** start a new session with a HELO carrying the
  *reconnect* flag; LMS keeps the queue for 5 minutes.

## The page

One self-contained HTML file built from `src/`:

| File | What |
|---|---|
| `core.js` | Slimproto framing, HELO/STAT, the player state machine, FLAC decoder, PCM, MP3 framing (no DOM, no I/O) |
| `worklet.js` | The output stage: sample-accurate starts, sync pauses and skips, volume ramp, position reports. Runs as an AudioWorklet on secure pages, on the main thread elsewhere |
| `media.js` | The media-element output: PCM → FLAC verbatim frames → fragmented MP4 → `<audio>` via (Managed) Media Source |
| `app.js` | The browser host (socket, streams, outputs) and the UI |

### Transport

- **Control:** the WebSocket above, with resume.
- **Audio:** `strm s` carries the HTTP request LMS wants the player to make. When its server
  address is 0 (LMS itself, which is always the case for proxied streams), the page
  `fetch()`es the same path from the origin it was loaded from, reading the body as a stream.
  It stops reading while it holds 2 MiB undecoded, so flow control is TCP's own. Otherwise it
  tries `fetch()` to that address directly (decision 2C).
- **Library and control of other players:** LMS's JSON-RPC, same-origin.

### LMS menus (SlimBrowse)

Plugins add to LMS through its menu system: home-menu nodes (`registerPluginMenu`) and context
menus (`registerInfoProvider`). The page renders that format generically, as Material Skin
does, so plugins need no special support:

- **Sidebar:** `menu 0 1000 direct:1` for the current player; entries under `myMusic` and
  `extras` that the page doesn't already provide (AudioMuse-AI, Custom Browse, Works…).
- **Context menus:** *More…* on tracks, albums, artists and genres opens `trackinfo` /
  `albuminfo` / `artistinfo` / `genreinfo items … menu:1`.
- **Rendering:** items take their actions from the item or from the window's `base` actions
  (with `itemsParams`); `go` browses, `play` / `add` / `add-hold` / `do` and anything with a
  `nextWindow` run as commands and then go `parent`, `home`, `nowPlaying` or `refresh`;
  `input` items prompt and fill `__TAGGEDINPUT__`; checkboxes use `on` / `off`.

### Output: chosen per device

| Mode | Used on | How | Notes |
|---|---|---|---|
| Web Audio | Desktops | AudioWorklet (HTTPS) or ScriptProcessor (http) | Sample-accurate sync, volume in the page |
| Media element | iPhone, iPad, Android | Decoded audio → FLAC verbatim frames (lossless) → fMP4 → `<audio>` via `ManagedMediaSource` (iOS 17.1+) or `MediaSource` | Keeps playing with the screen locked. iOS ignores page volume, so LMS volume is held at 100 % and the device buttons set the level. Sync is a little looser: the position comes from the element's clock |

The page probes support (`isTypeSupported('audio/mp4; codecs="flac"')` and a test append)
and falls back to Web Audio if the media path doesn't work.

## The dev relay (`relay.py`)

For development only: `python3 relay.py --lms 192.168.1.20`. It serves the page and the same
`/plugins/LyrionJS/ws` and `/log` endpoints with the same protocol, and proxies every other
path to that LMS. That lets you test page changes against a real server without installing
the plugin. Not for real use: no TLS, no authentication beyond what LMS has.

## Testing

- `node --test tests/`: decoders (bit-exact FLAC), Slimproto, the player against a fake LMS,
  the MP3 chunk decoder, the fMP4 muxer (output decoded by `ffmpeg` and compared bit for bit).
- `python3 -m unittest discover -s tests`: the dev relay's socket protocol.
- `prove plugin/t`: the plugin's WebSocket framing, resume and checks, with LMS stubs.
- End to end against a disposable LMS in Docker (`tests/e2e/`), never the household server.
