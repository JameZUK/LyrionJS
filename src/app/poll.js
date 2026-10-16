  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------
  const STATUS_TAGS = 'tags:aAlcdejJKNoqrstuyITRx';
  let pollTimer = null, pollCount = 0, polling = false, pollAgain = false;
  let localStatusFor = null;   // the local player's state when S.localStatus was fetched

  /** Poll soon. Only one poll runs at a time; a request made during one runs right after it. */
  function pollSoon(ms = 250) {
    if (polling) { pollAgain = true; return; }
    clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    clearTimeout(pollTimer);
    if (!S.lms) return;
    if (polling) { pollAgain = true; return; }
    polling = true;
    try {
      const target = S.target;
      if (target) {
        const st = await rpc(['status', '-', 1, STATUS_TAGS], target);
        if (target === S.target) {   // the player wasn't switched meanwhile
          S.status = st; S.statusAt = performance.now();
          if (st.playlist_timestamp !== S.lastPlaylistTs) { S.lastPlaylistTs = st.playlist_timestamp; emitPlaylistChanged(); }
          updateNowPlaying();
        }
      }
      if (pollCount++ % 5 === 0) await pollPlayers();
      // This browser's own status (the lock screen shows it) while another player is controlled:
      // now and then while it plays, and whenever its state changed (paused, stopped…).
      if (S.local && !isLocal(S.target)) {
        const state = S.local.state;
        if ((state === 'playing' && pollCount % 3 === 0) || state !== localStatusFor) {
          S.localStatus = await S.lms.rpc(S.localId, ['status', '-', 1, STATUS_TAGS]);
          localStatusFor = state;
        }
      } else if (isLocal(S.target)) { S.localStatus = S.status; localStatusFor = null; }
      updateMediaSession();
      setConn(true);
    } catch (e) {
      setConn(false, e.message);
    } finally {
      polling = false;
    }
    const again = pollAgain; pollAgain = false;
    pollTimer = setTimeout(poll, again ? 50 : (document.hidden ? 5000 : 1000));
  }

  async function pollPlayers() {
    const r = await S.lms.rpc('', ['players', 0, 100]);
    S.players = (r.players_loop || []).filter((p) => +p.connected || isLocal(p.playerid) || p.playerid === S.target);
    // First run: control this browser's own player once LMS has it.
    if (S.autoTarget && S.players.some((p) => isLocal(p.playerid))) { S.autoTarget = false; if (!isLocal(S.target)) setTarget(S.localId, true); }
    if (!S.target || !S.players.some((p) => p.playerid === S.target)) {
      const want = S.players.find((p) => isLocal(p.playerid)) || S.players[0];
      if (want && want.playerid !== S.target) setTarget(want.playerid, true);
    }
    try { const sg = await S.lms.rpc('', ['syncgroups', '?']); S.syncgroups = sg.syncgroups_loop || []; } catch (e) { S.syncgroups = []; }
    renderPlayerButton();
  }

  function setConn(ok, msg) {
    const el = document.getElementById('conn');
    el.hidden = ok; if (!ok) el.textContent = 'Lost contact with the server: ' + (msg || '') + ' — retrying…';
  }

  function setTarget(id, auto) {
    if (!auto) S.autoTarget = false;
    const changed = id !== S.target;
    S.target = id; store.set('target', id); S.status = null; S.lastPlaylistTs = null;
    renderPlayerButton(); updateNowPlaying(); pollSoon(10);
    loadPluginMenus();
    if (changed) playerChanged();
  }

  const playlistListeners = new Set();
  function emitPlaylistChanged() { for (const f of playlistListeners) f(); }

  // ---------------------------------------------------------------------------
  // Now playing model
  // ---------------------------------------------------------------------------
  function current(st = S.status) {
    if (!st) return null;
    const t = (st.playlist_loop || [])[0] || {};
    const rm = st.remoteMeta || {};
    const remote = !!(+t.remote || +st.remote);
    const title = t.title || rm.title || st.current_title || '';
    return {
      title, artist: t.artist || t.trackartist || t.albumartist || rm.artist || '', album: t.album || rm.album || '',
      artistId: t.artist_id, albumId: t.album_id, id: t.id, url: t.url, remote,
      stationTitle: remote && st.current_title && st.current_title !== title ? st.current_title : '',
      duration: +st.duration || +t.duration || 0, type: t.type, bitrate: t.bitrate, samplerate: t.samplerate, samplesize: t.samplesize,
      year: t.year, coverid: t.coverid, artwork: t.artwork_url,
    };
  }
  function elapsedNow() {
    const st = S.status; if (!st) return 0;
    let t = +st.time || 0;
    if (st.mode === 'play') t += (performance.now() - S.statusAt) / 1000 * (+st.rate || 1);
    const d = +st.duration || 0;
    return d ? Math.min(t, d) : t;
  }
  function nowArt(size) {
    const st = S.status; if (!st || !S.target) return null;
    const c = current(st);
    if (c && c.artwork && !/^\/?music\/current/.test(c.artwork)) { const u = S.lms.art(c.artwork, size); if (u) return u; }
    if (c && c.coverid) return S.lms.cover(c.coverid, size);
    return S.lms.url(`music/current/cover_${size}x${size}_f?player=${encodeURIComponent(S.target)}&t=${encodeURIComponent(st.playlist_timestamp || '')}`);
  }
  function qualityLabel(c) {
    if (!c) return '';
    const parts = [];
    if (c.type) parts.push(String(c.type).toUpperCase());
    if (c.samplesize && c.samplerate) parts.push(`${c.samplesize}/${(c.samplerate / 1000).toFixed(c.samplerate % 1000 ? 1 : 0)}`);
    else if (c.bitrate) parts.push(String(c.bitrate).replace(/\s*kbps.*/i, ' kb/s'));
    return parts.join(' · ');
  }
