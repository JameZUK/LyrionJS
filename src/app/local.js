  // ---------------------------------------------------------------------------
  // The local Slimproto player
  // ---------------------------------------------------------------------------
  /**
   * Which output this device should use. Phones and tablets get the media element (it keeps
   * playing with the screen locked) if a self-test shows the browser plays our FLAC-in-MP4;
   * everything else, or a failed test, gets Web Audio. Settings can force either.
   */
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/plugins/LyrionJS/ws';

  async function chooseOutput() {
    const want = store.get('outputMode', (S.config && S.config.defaultOutput) || 'auto');
    const ua = navigator.userAgent;
    const ios = isIOS();
    const mobile = ios || /Android/.test(ua);
    // why: English, for the log; Settings shows it translated.
    let mode = 'webaudio', why = N_('desktop browser');
    if (want === 'webaudio') why = N_('chosen in Settings');
    else if (want !== 'media' && store.get('mediaUnusable', false)) why = N_('the media element failed here before');
    else if (want === 'media' || mobile) {
      const ok = LJ.mediaSupported() && await LJ.selfTest();
      if (ok) { mode = 'media'; why = want === 'media' ? N_('chosen in Settings') : ios ? N_('iPhone/iPad: keeps playing with the screen locked') : N_('Android: keeps playing with the screen locked'); }
      else why = ios ? N_('this browser cannot play FLAC through a media element (iOS 17.1 or later needed); keep the screen on') : N_('this browser cannot play FLAC through a media element');
    }
    diag('output', `mode ${mode} (${why}); ios=${ios} mobile=${mobile} mms=${!!window.ManagedMediaSource} mse=${!!window.MediaSource}`);
    S.outputMode = mode; S.outputWhy = why;
    if (mode === 'media') {
      const o = new LJ.MediaOutput(document.getElementById('lj-audio'), { diag });
      o.level = store.get('localLevel', store.get('localTrim', 1));
      // The OS paused us (a call, another app, headphones out): tell LMS, as a Squeezebox would.
      o.externalPause = () => { if (S.local && S.local.state === 'playing') act(['pause', 1], null, S.localId); };
      return o;
    }
    return new LJ.WebOutput({
      workletSource: document.getElementById('lj-worklet').textContent, diag,
      level: store.get('localLevel', store.get('localTrim', 1)), preferRate: store.get('outRate', 44100),
      onRate: (r) => store.set('outRate', r),
      // iPhone and iPad start a second audio context only inside a tap.
      singleContext: isIOS(),
    });
  }

  /** Starts this browser's player; a start already under way is shared, not repeated. */
  let starting = null;
  function startLocalPlayer() {
    if (!starting) starting = startNow().catch(fail).finally(() => { starting = null; });
    return starting;
  }

  async function startNow() {
    const wanted = () => !S.local && S.server && store.get('localEnabled', true);
    if (!wanted()) return;
    const mac = macBytes();
    S.localId = mac.str;
    if (!S.output) S.output = await chooseOutput();
    const [maxRate, mp3] = await Promise.all([S.outputMode === 'media' ? Promise.resolve(192000) : LJ.detectMaxRate(), detectMp3()]);
    if (!wanted()) return;   // switched off (or started) while the checks ran
    const caps = ['flc', 'pcm'].concat(mp3 ? ['mp3'] : []);
    const uuid = new Uint8Array(16); uuid.set(mac.bytes, 0);
    // Earlier versions named iPads "… on macOS" (iPadOS Safari reports a Mac).
    // Earlier test builds were misspelt "LyrianJS", and named iPads "… on macOS".
    const oldName = store.get('name', '');
    if (/^LyrianJS /.test(oldName) || (oldName === 'LyrionJS Safari on macOS' && defaultName() !== oldName)) store.set('name', defaultName());
    const decoders = { f: () => new LJ.FlacDecoder(), p: (s) => new LJ.PcmDecoder(s) };
    if (mp3 === 'webcodecs') decoders.m = () => new LJ.Mp3Decoder();
    else if (mp3 === 'chunks') decoders.m = () => new LJ.Mp3ChunkDecoder(decodeWithBrowser);
    const p = new LJ.SlimPlayer({
      mac: mac.bytes, uuid, name: store.get('name', defaultName()),
      openControl: () => LJ.controlSocket(WS_URL, LJ.browserEnv(), diag), openStream: (o) => LJ.openStream(o, LJ.browserEnv(), diag),
      output: S.output, now: () => performance.now(), caps, maxRate, decoders, firmware: VERSION,
      // Without AudioWorklet the output shares the main thread: decode in smaller slices.
      pumpBudget: window.AudioWorkletNode && window.isSecureContext ? 12 : 3,
      // A locked phone runs the page's code only now and then: keep more decoded ahead.
      decodeAhead: S.outputMode === 'media' ? 30 : 10,
      log: (...a) => console.warn('[slimproto]', ...a),
    });
    p.maxRateFound = maxRate;
    p.on((what) => {
      if (what === 'name') store.set('name', p.name);
      // The plugin ended this player: another session took it, or browser players were switched off.
      if (what === 'replaced' || what === 'disabled') {
        toast(what === 'replaced' ? tr('This player was taken over by another session; this page is now a remote control.')
          : tr('Browser players are switched off in LMS (Settings › Plugins › LyrionJS); this page is now a remote control.'));
        if (S.local === p) stopLocalPlayer();
        if (what === 'replaced') playerTaken();
        return;
      }
      if (what === 'state' || what === 'track' || what === 'connected') { pollSoon(150); refreshUnlock(); }
      if (what === 'connected') {
        setTimeout(pollPlayers, 400);
        if (!S.pluginMenus || !S.pluginMenus.length) setTimeout(loadPluginMenus, 800);
        setTimeout(maybeAskName, 2500);
        // Where the page can't set the volume (iOS), the device's buttons do: hold LMS at 100 %
        // (but leave it muted).
        if (S.output.volumeLocked && p.gain > 0.01 && Math.abs(p.gain - 1) > 0.01) act(['mixer', 'volume', 100], null, S.localId);
      }
      renderLocalBadge();
    });
    S.local = p;
    S.output.onState = refreshUnlock;
    // The media element failed and was replaced (output/media.js): what was queued is lost, so
    // start the current track again where it was.
    let lastRecovery = { index: -1, at: -1e9 };
    S.output.onFailure = async (why, wasPlaying, fatal) => {
      if (fatal) {
        diag('media', 'media element unusable: ' + why);
        // Chosen in Settings: say so, and leave the choice to the person.
        if (store.get('outputMode', 'auto') === 'media') { fail(new Error(tr('The media element can\'t play here: choose Web Audio in Settings › Audio output.'))); return; }
        // Automatic: this browser uses Web Audio from now on (Settings can still choose either).
        store.set('mediaUnusable', true);
        toast(tr('This browser can\'t play through the media element: switching to Web Audio…'));
        setTimeout(() => location.reload(), 1500);
        return;
      }
      diag('media', 'recovering after: ' + why);
      if (!wasPlaying) return;
      try {
        const st = await S.lms.rpc(S.localId, ['status', '-', 1]);
        const index = +st.playlist_cur_index || 0;
        // The same track failing again at once: it's the track, so go on to the next one.
        if (index === lastRecovery.index && performance.now() - lastRecovery.at < 30000) {
          diag('media', 'track ' + index + ' fails again: skipping it');
          lastRecovery = { index: -1, at: -1e9 };
          await S.lms.rpc(S.localId, ['playlist', 'index', '+1']);
          return;
        }
        lastRecovery = { index, at: performance.now() };
        await S.lms.rpc(S.localId, ['playlist', 'index', index]);
        if (+st.time > 1) await S.lms.rpc(S.localId, ['time', st.time]);
      } catch (e) { diag('error', 'recovery: ' + e.message); }
    };
    p.onStat = (ev) => { if (ev !== 'STMt') diag('stat', `${ev} state=${p.state}`); };
    p.onStrm = (s) => { if (s.command !== 't') diag('strm', `${s.command} autostart=${s.autostart} format=${s.format} threshold=${s.threshold} arg=${s.replayGain}`); };
    diag('player', `${p.name} ${mac.str} caps=${caps.join(',')} mp3=${mp3 || 'none'} maxRate=${maxRate} secure=${window.isSecureContext}`);
    const snapshot = setInterval(() => {
      if (p.state === 'stopped') return;
      const o = S.output, t = p.tracks.find((x) => !x.decoded) || p.tracks[p.tracks.length - 1];
      const out = o.el ? `el ${o.el.paused ? 'paused' : 'playing'} t=${o.el.currentTime.toFixed(2)} end=${o.writer.end.toFixed(2)} ops=${o.sbq.ops.length} full=${o.sbq.full} unlocked=${o.unlocked}`
        : `ctx=${o.ctx ? o.ctx.state + '@' + o.rate : 'none'} src=${o.srcRate} rep=${o.rep ? `pos ${o.rep.pos} q ${o.rep.queued} playing ${o.rep.playing} under ${o.rep.under}` : 'none'} pending=${o.pending.length} posts=${o.posts.length}`;
      diag('snap', `state=${p.state} conn=${p.connected} queued=${o.queuedSeconds().toFixed(1)}s ${out} ` +
        `track=${t ? `#${t.seq} ${t.format} bytes ${t.bytes} buf ${t.decoder ? t.decoder.buffered : '-'} open ${t.streamOpen} decoded ${t.decoded} ${t.describe}` : 'none'} err=${p.lastError || '-'}`);
    }, 3000);
    const onHide = () => { try { p.stop(); } catch (e) { /* closing */ } };
    window.addEventListener('pagehide', onHide);
    S.localCleanup = () => { clearInterval(snapshot); window.removeEventListener('pagehide', onHide); };
    p.start();
  }

  function stopLocalPlayer() {
    if (!S.local) return;
    S.local.stop(); S.local = null;
    if (S.localCleanup) { S.localCleanup(); S.localCleanup = null; }
    clearMediaSession();
    renderLocalBadge();
  }

  /**
   * Only one tab per browser may be the player: two would share a MAC, and the plugin would give
   * the player to the newer one, cutting off what the first was playing. So the first tab keeps
   * it for its life (switching the player off and on again reuses it); the others are remote
   * controls, and one of them takes over when it closes. The browser's lock does this where it
   * has one (HTTPS and localhost); elsewhere the tabs ask each other on a channel.
   */
  const ASK_MS = 400;   // for the player tab to answer a new one
  let claim = null;     // null, 'asking' (the other tabs), 'waiting' (a remote control) or 'lock'
  let chan = null, asked = null, askTimer = 0;
  function ownPlayer() { S.ownsPlayer = true; startLocalPlayer(); }
  function beRemote() {
    claim = claim === 'lock' ? 'lock' : 'waiting';
    toast(tr('Another tab is this browser\'s player; this one is a remote control.'));
  }
  function claimPlayerThenStart() {
    if (S.ownsPlayer) { startLocalPlayer(); return; }
    if (claim === 'asking') return;
    if (claim) { beRemote(); return; }
    if (navigator.locks && navigator.locks.request) {
      claim = 'lock';
      const hold = () => { ownPlayer(); return new Promise(() => {}); };   // for the life of the tab
      navigator.locks.request('lyrionjs-player', { ifAvailable: true }, (lock) => {
        if (lock) return hold();
        beRemote();
        navigator.locks.request('lyrionjs-player', hold);   // granted when the player tab closes
        return null;
      });
    } else if (window.BroadcastChannel) {
      if (!chan) {
        chan = new BroadcastChannel('lyrionjs-player');
        chan.onmessage = ({ data: m }) => {
          if (!m || typeof m !== 'object') return;
          // Two tabs asking at once: the one that asked first goes ahead.
          const first = asked && claim === 'asking' && (asked.at < m.at || (asked.at === m.at && asked.id < m.id));
          if (m.t === 'who' && (S.ownsPlayer || first)) chan.postMessage({ t: 'mine' });
          else if (m.t === 'mine' && claim === 'asking') { clearTimeout(askTimer); beRemote(); }
          else if (m.t === 'gone' && claim === 'waiting') { claim = null; setTimeout(claimPlayerThenStart, Math.random() * 200); }
        };
        window.addEventListener('pagehide', () => { if (S.ownsPlayer) chan.postMessage({ t: 'gone' }); });
      }
      claim = 'asking'; asked = { t: 'who', at: Date.now(), id: Math.random() };
      chan.postMessage(asked);
      askTimer = setTimeout(() => { claim = null; ownPlayer(); }, ASK_MS);
    } else ownPlayer();
  }
  /** The plugin gave this browser's player to another tab: this one waits for it, as a remote control. */
  function playerTaken() {
    if (S.ownsPlayer && claim !== 'lock') { S.ownsPlayer = false; claim = 'waiting'; }
  }

  // Back from the back/forward cache: the player stopped when the page was hidden; start afresh.
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

  function refreshUnlock() {
    const el = document.getElementById('unlock');
    const need = S.local && S.output && S.output.needsGesture && ['playing', 'waiting', 'loaded', 'paused'].includes(S.local.state);
    el.hidden = !need;
  }
  // -- naming ---------------------------------------------------------------------
  /** Lets the person name this browser's player (in LMS, so every controller shows it). */
  async function renameLocal(first) {
    if (!S.local) return;
    const n = await prompt2(first ? tr('Give this player a name') : tr('Name this player'), first
      ? { value: '', placeholder: tr('e.g. Kitchen tablet'), ok: tr('Save'), hint: tr('How this browser shows in LMS and your other controllers. Change it any time in Settings.') }
      : { value: S.local.name, placeholder: tr('e.g. Kitchen tablet'), ok: tr('Save') });
    store.set('named', true);   // asked once: never ask again by ourselves
    if (!S.local || !n || n === S.local.name) return;   // (the player may have been switched off meanwhile)
    const name = n.slice(0, 48);
    try { await S.lms.rpc(S.localId, ['name', name]); } catch (e) { fail(e); return; }
    S.local.name = name; store.set('name', name);
    toast(tr('This player is now “{name}”', { name }));
    renderLocalBadge();
    await pollPlayers().catch(() => {});
    renderPlayerButton();
  }

  /** The first time this browser is a player with the name it was given automatically, ask. */
  let askedName = false;
  async function maybeAskName() {
    if (askedName || store.get('named', false) || !S.local) return;
    askedName = true;
    await pollPlayers().catch(() => {});
    const known = S.players.find((x) => x.playerid === S.localId);
    const name = known ? known.name : S.local.name;
    if (name !== defaultName()) { store.set('named', true); return; }   // already named (perhaps in another controller)
    // Not over a dialog, nor while the person is typing somewhere (the prompt would take the keys).
    const busy = !document.getElementById('sheet').hidden || (document.activeElement && document.activeElement.matches('input, textarea, select'));
    if (!busy) renameLocal(true).catch(fail);
    else askedName = false;   // try again when they next connect
  }

  function renderLocalBadge() {
    const el = document.getElementById('localBadge');
    if (!el) return;
    el.textContent = '';
    if (!S.local) { el.append(tr('Browser player off')); el.className = 'badge off'; el.title = ''; el.disabled = true; return; }
    el.disabled = false;
    const snap = S.local.snapshot();
    el.className = 'badge ' + (snap.connected ? 'on' : 'warn');
    el.append(snap.connected ? `${S.local.name} · ${stateWord(snap.state)}` : tr('Connecting to LMS…'));
    el.title = tr('Rename this player');
  }

  /** 'webcodecs' (streaming, exact), 'chunks' (decodeAudioData fallback) or '' (no MP3). */
  async function detectMp3() {
    if (LJ.Mp3Decoder.supported()) {
      try { const r = await AudioDecoder.isConfigSupported({ codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 }); if (r.supported) return 'webcodecs'; }
      catch (e) { /* fall through */ }
    }
    return typeof OfflineAudioContext === 'function' ? 'chunks' : '';
  }
  function decodeWithBrowser(bytes, rate, channels) {
    const ctx = new OfflineAudioContext(channels, 1, rate);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return ctx.decodeAudioData(buf).then((b) => { const out = []; for (let c = 0; c < b.numberOfChannels; c++) out.push(b.getChannelData(c)); return out; });
  }

  // ---------------------------------------------------------------------------
  // Media Session (lock screen / media keys) for this browser's player
  // ---------------------------------------------------------------------------
  let lastMeta = '';
  /** The lock screen no longer shows this browser as playing, nor sends it commands. */
  function clearMediaSession() {
    lastMeta = null;
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    for (const a of ['play', 'pause', 'nexttrack', 'previoustrack', 'stop', 'seekto']) {
      try { navigator.mediaSession.setActionHandler(a, null); } catch (e) { /* unsupported action */ }
    }
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !S.local) return;
    const st = S.localStatus; if (!st) return;
    const c = current(st); if (!c) return;
    const key = c.title + c.artist + c.album;
    navigator.mediaSession.playbackState = st.mode === 'play' ? 'playing' : st.mode === 'pause' ? 'paused' : 'none';
    // The lock screen's position: the track's own, not the media element's whole session.
    if (navigator.mediaSession.setPositionState && c.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: c.duration, position: Math.min(c.duration, Math.max(0, +st.time || 0)), playbackRate: 1 }); } catch (e) { /* out of range */ }
    }
    if (key === lastMeta) return;
    lastMeta = key;
    try {
      const art = S.lms.url(`music/current/cover_512x512_f?player=${encodeURIComponent(S.localId)}&t=${encodeURIComponent(st.playlist_timestamp || '')}`);
      navigator.mediaSession.metadata = new MediaMetadata({ title: c.title, artist: c.artist, album: c.album, artwork: [{ src: new URL(art, location.href).href, sizes: '512x512' }] });
      const L = (cmd) => () => act(cmd, null, S.localId);
      navigator.mediaSession.setActionHandler('play', L(['pause', 0]));
      navigator.mediaSession.setActionHandler('pause', L(['pause', 1]));
      navigator.mediaSession.setActionHandler('nexttrack', L(['playlist', 'index', '+1']));
      navigator.mediaSession.setActionHandler('previoustrack', L(['button', 'jump_rew']));
      navigator.mediaSession.setActionHandler('stop', L(['stop']));
      navigator.mediaSession.setActionHandler('seekto', (d) => { if (d && d.seekTime != null) act(['time', d.seekTime.toFixed(1)], null, S.localId); });
    } catch (e) { /* not all browsers support every action */ }
  }
