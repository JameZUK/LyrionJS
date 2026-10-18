# LyrionJS architecture

LyrionJS turns a web browser into a Slimproto player for Lyrion Music Server (LMS) and gives
it a full controller UI. It ships as an LMS plugin. **It adds a new way to play; it doesn't
change how LMS behaves.**

Principle: **all of Slimproto runs in the browser.** The plugin is a byte pipe with three
cheap checks. It does no decoding, keeps no player state and has no protocol logic beyond
finding Slimproto frame boundaries in what the page sends.

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
| 3 | Checks in the pipe | **Origin** (only the page LMS served may open the socket) and **MAC prefix** (every HELO must use `02:4c:4a`, and the same MAC throughout a session, so a page can't impersonate a hardware player). Otherwise no frame policing: the plugin only splits what the page sends into whole Slimproto frames. |
| 4 | iOS and mobile | **First build.** Detect iPhone, iPad and Android and play through an `<audio>` element fed by Managed Media Source or Media Source, so playback survives a locked screen. Desktops use Web Audio. Chosen automatically with a self-test; can be overridden in Settings. |
| 5 | Standalone relay | **Dev only.** `relay.py` emulates the plugin's URLs exactly and proxies everything else to a given LMS, so the page has one code path. Not for real use. |

## The plugin (`plugin/LyrionJS`)

Perl, inside LMS's event loop, using only LMS's own APIs:

- `Slim::Web::Pages->addRawFunction` takes these URLs, and only these:
  - `GET /plugins/LyrionJS/` (and `index.html`): the page, one static file.
  - `GET /plugins/LyrionJS/ws`: the WebSocket below.
  - `POST /plugins/LyrionJS/log`: opt-in page diagnostics, written to the LMS log.
- `GET /plugins/LyrionJS/config.json`: the plugin's settings the page needs (players on/off,
  default output, diagnostics), and `page`, when the page file last changed. An open tab
  (`src/app/update.js`) checks it after losing contact, on being shown again and every ten
  minutes. When it changes, the tab reloads itself, unless this browser's player isn't stopped or
  something is being typed. Then it shows a "reload" button and waits. Also `skins`, the web
  skins installed (LMS's own list, as its settings page shows it) and `skin`, the server's: see
  the next item.
- **An LMS skin over the page** (`src/app/skin.js`). With one of `config.json`'s `skins` chosen
  in *Settings › Skin*, the page shows that skin, as LMS serves it, in a frame over itself,
  pointed at this browser's player with `?player=`. Nothing of the skin is copied or changed. The
  page stays the player (stream, sound, lock-screen controls), and the skin is only a remote.
  Both are on the same origin, so the page can look into the frame and every frame inside it
  (Light and Classic are framesets):
  - a tap or key there unlocks the page's sound;
  - the skin's ways to LyrionJS lead to LyrionJS's own pages in the same tab, at the About page
    (its recursion joke, with Settings one tap away). The page catches the frame's
    `window.open` (Material's tile) and clicks on links to its own address, whatever host name
    they use, or to the LyrionJS app's page in a skin (`/<skin>/plugins/lyrionjs/index.html`).
    A LyrionJS page opened inside the skin anyway (Material's Extras dialog) switches this one
    over rather than start a second player;
  - LyrionJS's own pages mark their history entries (`own`), so Back from the first of them
    returns to the skin; so do the top bar's `← <skin name>`, the button on the About page, and
    choosing an LMS skin in Settings;
  - the tab is named `<skin name> · LyrionJS`, not after the skin's page (Material's names the
    player's MAC address).
- `GET /plugins/LyrionJS/svg?u=<address>` (`Svg.pm`): SVG pictures, such as radio logos. The page
  asks LMS's image proxy for every other picture from another host, always at a size: at full
  size, and always for SVG (which it can't resize), the proxy redirects the browser to the
  picture's own host, and the page's CSP only loads pictures from LMS. This fetches only http(s)
  addresses whose path ends in `.svg` (not this machine's), only for LMS's own pages
  (`Sec-Fetch-Site`), keeps only what is an SVG (up to 512 KB, in LMS's cache for a week), and
  sends it with a CSP that lets it be nothing but a picture.
- Ways in from LMS, all with the absolute player address (below):
  - a **LyrionJS tile on Material Skin's home screen** (Material's `registerCustomAction`,
    section `pinned`, registered in `postinitPlugin`): one click opens the player in a new
    tab. Material adds plugin tiles again on every load, so un-pinning it doesn't stick;
  - an app, *LyrionJS*, in **My Apps** (`Slim::Plugin::OPMLBased` with `is_app`, icon
    `html/images/icon.png`: a PNG, as Squeezer can't show SVG). LMS builds the Apps entry
    itself, so it can't carry a link, and no controller can be told to open a link when a page
    loads (Squeezer's `goNow` only knows Now Playing, the queue and Home). The app's one page,
    answered by the plugin's own `lyrionjs items` handler, is the address as an item with only
    a `weblink` (a tap opens the browser on Squeezer) and `parseURLs` (a link that opens a new
    tab in Material). LMS's feed browser can't produce such an item: it either marks a text
    item inert (`itemNoAction` + `action none`, which Squeezer won't open) or gives it a browse
    action (which controllers follow instead of the link);
  - a link in the classic UI's plugin menu and Material Skin's *Extras* (`addPageLinks`, with
    the icon). Material opens Extras in a frame; the page then offers a tab of its own;
  - the button on the settings page.
- The player address: the `pageUrl` setting (a host alone, or host and `/`, gets the player's
  path; anything longer is the full address), or else this server's URL with its IP address
  replaced by its DNS name when reverse DNS gives one that resolves back to it, or else the
  IP address. The name is looked up once, with AnyEvent's resolver as LMS's own lookups are,
  so LMS never waits on DNS; links use the IP address until the answer comes, and are all
  re-registered when it does. Links all use one address so that a browser stays one player
  (the page's identity is per origin).
- A settings page (`Settings.pm`, `HTML/EN/plugins/LyrionJS/settings/basic.html`), prefs in
  `plugin.lyrionjs`: `enabled`, `proxyStreams`, `defaultOutput`, `clientDiagnostics`, `pageUrl`.
- A subscription to `client new` / `client reconnect`: for players whose MAC starts with
  `02:4c:4a` only, set `mp3StreamingMethod = 1` (proxied) if it isn't already.

LMS checks its password, if one is set, before a raw handler runs, so the plugin needs no
authentication of its own.

### WebSocket protocol (`/plugins/LyrionJS/ws`)

1. The client opens the socket. The plugin refuses (403) if an `Origin` header is present
   and its host isn't the request's `Host` or a proxy's `X-Forwarded-Host`. A host without a
   port takes the Origin scheme's default (80 or 443), so a page behind an HTTPS proxy works.
   More than 64 sockets at once are refused (503).
2. Within 10 s the client's first message is text JSON, one of (otherwise **1008**):
   - `{"hello":1}`: a new session.
   - `{"resume":{"session":S,"secret":K,"received":N}}`: `N` is the number of Slimproto
     bytes the client has received in that session.
3. The plugin answers with text JSON:
   `{"session":S,"secret":K,"resumed":false,"hold":10}` for a new session, or
   `{"session":S,"secret":K,"resumed":true,"hold":10,"replay":R,"got":G}` for a resume, where
   the first `R` bytes that follow are the replay of what the client missed, and `G` is the
   number of bytes of the client's binary messages that arrived in that session (so it can
   send again what was lost in a socket that died without a word).
   A refused resume (unknown session, wrong secret, or bytes no longer held) is answered
   with close code **4404**; the client then starts a new session.
4. After that every message is **binary, raw Slimproto bytes**, in both directions. The
   plugin reads only the frame headers (4-byte opcode, 4-byte length) of what the client
   sends, and passes whole frames to LMS. A session's first frame must be a HELO whose MAC
   starts with `02:4c:4a`, and come within 10 s of the socket opening; any later HELO must
   carry the same MAC; bytes that aren't Slimproto, or a frame over 64 KiB, close the socket
   with **1008**. A close for breaking the rules (1002, 1008, 1009) ends the session: it is
   not held for a resume.
5. The plugin keeps the last 256 KiB sent to the client, counted from the start of the
   session, so a resume can replay from any `N` still held.
6. When the WebSocket drops, the plugin keeps the LMS connection open for **10 s**. A resume
   within that time attaches to it; otherwise the LMS connection is closed and LMS sees the
   player disconnect.
7. LMS closing its side ends the session (close code **1001**).
   An attached socket the plugin hears no message on for 30 s (LMS polls every player every
   5 s, and the page answers; pings don't count) is dropped as if it had disconnected, and
   so is one more than 64 writes behind (pings included); both then get the hold. A close
   frame is sent after whatever is already queued to that socket.
   Switching browser players off in Settings ends the sessions there are (**4403**) and
   refuses resumes as well as new sessions.
8. A new session whose HELO has the same MAC as an existing session ends that one first, so
   LMS never sees two connections for one player.

Limits: 32 sessions, 64 sockets, 64 KiB per client message.

Close codes the plugin sends:

| Code | Meaning | Client |
|---|---|---|
| 1000, 1001 | closed; LMS ended the player's connection, or the server is stopping | new session later |
| 1006 (no close frame) | the socket dropped | resume |
| 1002, 1009 | WebSocket protocol error; message too big | new session |
| 1008 | policy: no or bad hello, not a LyrionJS HELO, not Slimproto | new session |
| 1011 | LMS's Slimproto port can't be reached | retry later |
| 1013 | too many players | retry later |
| 4000 | replaced: a newer socket or session took this player | stop |
| 4403 | browser players are switched off in Settings | controller only |
| 4404 | resume refused | new session |

### What the client must do (the page)

- **Dead socket:** LMS talks to every player at least every 5 s and drops one that is silent
  for 15 s, so 11 s with nothing received (two missed polls) means the socket is dead.
  Abandon it and resume, in time for the resume to work.
- **Lost frames:** keep the frames sent in the session (not heartbeats). On a resume, send
  again those after the plugin's `got`, before what was held during the gap.
- **During a gap:** don't queue `STMt` heartbeats; send one fresh one on resume. Queue other
  STATs (`STMs`, `STMd`, `STMu`, …) and send them in order on resume. Drop sync corrections
  (`strm a`, timed `strm p` and `strm u`) that describe a moment already past. (These are
  lessons from Lyrion Anywhere: replayed heartbeats threw a sync group out.)
- **Resume refused (4404) or hold expired:** start a new session with a HELO carrying the
  *reconnect* flag; LMS keeps the queue for 5 minutes.

## The page

One self-contained HTML file built from `src/`:

| Folder | What |
|---|---|
| `src/core/` | No DOM, no I/O, runs under Node: `bytes.js` (byte queues), `slimproto.js` (framing, HELO, STAT), `decoder.js` (the decoder interface), `flac.js`, `pcm.js`, `mp3.js` (framing, gapless trim, the WebCodecs chunk decoder), `transition.js` (crossfade, fade in and out between the decoders and the output), `player.js` (the player state machine: tracks, sync, reports) |
| `src/output/` | `worklet.js` (the output stage: sample-accurate starts, sync pauses and skips, volume ramp, position reports; an AudioWorklet on secure pages, main thread elsewhere), `webaudio.js` (the Web Audio output and resampler), `fmp4.js` and `media.js` (PCM → FLAC verbatim frames → fragmented MP4 → `<audio>` via (Managed) Media Source) |
| `src/host/` | `transport.js`: the control socket with resume, and audio streams over `fetch()`, with the browser APIs injected so it runs under Node too |
| `src/app/` | The UI, sharing one scope: `util`, `theme` (light or dark, highlight colour), `lms` (JSON-RPC), `state`, `widgets`, `router`, `poll`, `actions`, `slimbrowse` (LMS menus), `local` (this browser's player), `views/` (one file per page), `skin` (the Material skin's layout, and an LMS skin over the page), `boot` |

`build.py` inlines them, in that order, into one HTML file: core, output and host as
`<script id="lj-lib">` modules on a shared `LJ` namespace (the worklet's text is also loaded
into the AudioWorklet from `lj-worklet`), the app wrapped in one function. The page sets a
Content-Security-Policy: nothing is loaded from other sites, and no inline handlers.

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

### Transitions (crossfade, fade in, fade out)

The player applies LMS's transition to the decoded audio, in `core/transition.js`, before it
reaches either output, so both modes have them. Each `strm` carries the transition into that
track: its type (`0` none, `1` crossfade, `2` fade in, `3` fade out, `4` both, `5` crossfade
straight away) and period in seconds. As squeezelite:

- **Fade in** ramps the first `period` seconds of the track. **Fade out** holds back its last
  `period` seconds and ramps them when the track ends. For **both**, each takes half the period.
- **Crossfade.** LMS sends the next track only after STMd, so the end of a track whose own
  transition is a crossfade is held back as a rolling `period`-second window. If the next track
  is a crossfade too, the two are mixed with linear gains. The mix belongs to the new track, so
  its STMs comes at the start of the crossfade. Otherwise the held end plays as it is. It also
  plays as it is when less than 3 s is left queued without it: the last track in the queue, or a
  slow stream. Crossfades need the same sample rate on both sides.

## The dev relay (`relay.py`)

For development only: `python3 relay.py --lms 192.168.1.20`. It serves the page and the same
`/plugins/LyrionJS/ws`, `/log` and `config.json` endpoints with the same protocol, rules and
close codes (`--no-players` acts as the plugin switched off), and proxies every other path to
that LMS. It hides the page's Origin from LMS, so it refuses cross-site POSTs itself, as LMS
would. That lets you test page changes against a real server without installing
the plugin. Not for real use: no TLS, no authentication beyond what LMS has.

## Testing

- `node --test tests/`: decoders (bit-exact FLAC), Slimproto, the player against a fake LMS,
  the MP3 chunk decoder, the fMP4 muxer (output decoded by `ffmpeg` and compared bit for bit).
- `python3 -m unittest discover -s tests`: the dev relay's socket protocol, against a fake LMS.
- `tests/perl.sh`: the plugin's tests with LMS's own libraries, in the test container:
  `bridge.t` (WebSocket framing, origin, HELO and Slimproto checks, the replay buffer) and
  `sessions.t` (hello, resume, hold, timeouts, closing and back-pressure, with LMS's event
  loop stubbed).
- `plugin/t/vectors.json`: protocol cases both the plugin's and the relay's tests run, so the
  two can't drift apart.
- End to end against a disposable LMS in Docker (`tests/e2e/`), never the household server:
  `bridge_live.py` runs against the plugin or the relay.
