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
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const mobile = ios || /Android/.test(ua);
    let mode = 'webaudio', why = 'desktop browser';
    if (want === 'webaudio') why = 'chosen in Settings';
    else if (want === 'media' || mobile) {
      const ok = LJ.mediaSupported() && await LJ.selfTest();
      if (ok) { mode = 'media'; why = want === 'media' ? 'chosen in Settings' : (ios ? 'iPhone/iPad' : 'Android') + ': keeps playing with the screen locked'; }
      else why = 'this browser cannot play FLAC through a media element' + (ios ? ' (iOS 17.1 or later needed); keep the screen on' : '');
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
      singleContext: /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1),
    });
  }

  async function startLocalPlayer() {
    if (S.local || !S.server) return;
    if (!store.get('localEnabled', true)) return;
    const mac = macBytes();
    S.localId = mac.str;
    if (!S.output) S.output = await chooseOutput();
    const [maxRate, mp3] = await Promise.all([S.outputMode === 'media' ? Promise.resolve(192000) : LJ.detectMaxRate(), detectMp3()]);
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
      output: S.output, now: () => performance.now(), caps, maxRate, decoders,
      // Without AudioWorklet the output shares the main thread: decode in smaller slices.
      pumpBudget: window.AudioWorkletNode && window.isSecureContext ? 12 : 3,
      // A locked phone runs the page's code only now and then: keep more decoded ahead.
      decodeAhead: S.outputMode === 'media' ? 30 : 10,
      log: (...a) => console.warn('[slimproto]', ...a),
    });
    p.maxRateFound = maxRate;
    p.on((what) => {
      if (what === 'name') store.set('name', p.name);
      if (what === 'state' || what === 'track' || what === 'connected') { pollSoon(150); refreshUnlock(); }
      if (what === 'connected') {
        setTimeout(pollPlayers, 400);
        if (!S.pluginMenus || !S.pluginMenus.length) setTimeout(loadPluginMenus, 800);
        // Where the page can't set the volume (iOS), the device's buttons do: hold LMS at 100 %.
        if (S.output.volumeLocked && Math.abs(p.gain - 1) > 0.01) act(['mixer', 'volume', 100], null, S.localId);
      }
      renderLocalBadge();
    });
    S.local = p;
    S.output.onState = refreshUnlock;
    // The media element failed and was replaced (output/media.js): what was queued is lost, so
    // start the current track again where it was.
    S.output.onFailure = async (why, wasPlaying, fatal) => {
      if (fatal) {
        // The media element can't play here after all: use Web Audio from now on, in this browser.
        diag('media', 'media element unusable (' + why + '): switching this browser to Web Audio');
        store.set('outputMode', 'webaudio');
        toast('This browser can\'t play through the media element: switching to Web Audio…');
        setTimeout(() => location.reload(), 1500);
        return;
      }
      diag('media', 'recovering after: ' + why);
      if (!wasPlaying) return;
      try {
        const st = await S.lms.rpc(S.localId, ['status', '-', 1]);
        await S.lms.rpc(S.localId, ['playlist', 'index', +st.playlist_cur_index || 0]);
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
    renderLocalBadge();
  }

  /**
   * Only one tab per browser may be the player: two would share a MAC and fight. The tab that
   * gets the lock keeps it for its life (switching the player off and on again reuses it).
   */
  function claimPlayerThenStart() {
    if (S.ownsPlayer) { startLocalPlayer(); return; }
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('lyrionjs-player', { ifAvailable: true }, (lock) => {
        if (!lock) { S.ownsPlayer = false; S.localId = macBytes().str; toast('Another tab is this browser\'s player; this one is a remote control.'); return null; }
        S.ownsPlayer = true;
        startLocalPlayer();
        return new Promise(() => {}); // hold the lock for the life of the tab
      });
    } else { S.ownsPlayer = true; startLocalPlayer(); }
  }

  // Back from the back/forward cache: the player stopped when the page was hidden; start afresh.
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

  function refreshUnlock() {
    const el = document.getElementById('unlock');
    const need = S.local && S.output && S.output.needsGesture && ['playing', 'waiting', 'loaded', 'paused'].includes(S.local.state);
    el.hidden = !need;
  }
  function renderLocalBadge() {
    const el = document.getElementById('localBadge');
    if (!el) return;
    el.textContent = '';
    if (!S.local) { el.append('Browser player off'); el.className = 'badge off'; return; }
    const snap = S.local.snapshot();
    el.className = 'badge ' + (snap.connected ? 'on' : 'warn');
    el.append(snap.connected ? `${S.local.name} · ${snap.state}` : 'Connecting to LMS…');
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
