  // ---------------------------------------------------------------------------
  /** A volume slider for the controlled player. It follows LMS, except just after a touch. */
  function volumeSlider() {
    const vol = h('input', { type: 'range', min: 0, max: 100, step: 1, class: 'vol', 'aria-label': 'Volume' });
    const send = debounce(() => act(['mixer', 'volume', vol.value]), 120);
    const touch = () => { vol.touchedAt = performance.now(); };
    vol.addEventListener('pointerdown', touch);
    vol.addEventListener('input', () => { touch(); send(); });
    return vol;
  }
  const showVolume = (vol, v) => { if (!(performance.now() - (vol.touchedAt || -1e9) < 1500)) vol.value = v; };

  // Views
  // ---------------------------------------------------------------------------
  let npEls = null;

  VIEWS.now = () => {
    const art = h('div', { class: 'np-art' });
    const title = h('div', { class: 'np-title' }), artist = h('button', { class: 'np-link np-artist' }), album = h('button', { class: 'np-link np-album' });
    const station = h('div', { class: 'np-station' });
    const quality = h('div', { class: 'np-quality' });
    const seek = h('input', { type: 'range', min: 0, max: 100, step: 'any', value: 0, class: 'seek', 'aria-label': 'Position' });
    const tNow = h('span', { class: 'tm' }), tDur = h('span', { class: 'tm' });
    const playBtn = btn('play', 'Play', () => togglePlay(), 'big');
    const shuf = btn('shuffle', 'Shuffle', () => cycleShuffle()), rep = btn('repeat', 'Repeat', () => cycleRepeat());
    const vol = volumeSlider();
    const muteBtn = btn('volume', 'Mute', () => act(['mixer', 'muting', 'toggle']));
    const upNext = h('div', { class: 'np-next' });
    const empty = h('div', { class: 'np-empty' }, icon('note', 'huge'), h('p', { text: 'Nothing playing. Pick something from the library, favourites, radio or apps.' }));
    let seeking = false;
    seek.addEventListener('input', () => { seeking = true; tNow.textContent = fmtTime(seek.value); });
    seek.addEventListener('change', () => { seeking = false; act(['time', seek.value]); });
    artist.addEventListener('click', () => { const c = current(); if (c && c.artistId) push('artist', { id: c.artistId, name: c.artist }); });
    album.addEventListener('click', () => { const c = current(); if (c && c.albumId) push('album', { id: c.albumId, title: c.album, artist: c.artist, artist_id: c.artistId }); });
    const main = h('div', { class: 'np' },
      art,
      h('div', { class: 'np-info' }, title, h('div', { class: 'np-sub' }, artist, album), station, quality,
        h('div', { class: 'np-seek' }, tNow, seek, tDur),
        h('div', { class: 'np-ctrls' }, shuf, btn('prev', 'Previous', () => act(['button', 'jump_rew'])), playBtn, btn('next', 'Next', () => act(['playlist', 'index', '+1'])), rep),
        h('div', { class: 'np-vol' }, muteBtn, vol),
        upNext));
    const el = h('div', {}, empty, main);
    const els = { art, title, artist, album, station, quality, seek, tNow, tDur, playBtn, shuf, rep, vol, muteBtn, upNext, empty, main, isSeeking: () => seeking, lastArt: null };
    const actions = [btn('fav', 'Add to favourites', () => {
      const c = current(); if (!c || !c.url) return toast('Nothing to add');
      act(['favorites', 'add', 'url:' + c.url, 'title:' + (c.stationTitle || c.title)], 'Added to favourites', '');
    }), btn('sleep', 'Sleep timer', sleepMenu), btn('more', 'More', () => {
      const c = current(); if (!c) return;
      libMenu('track', { id: c.id, title: c.title, artist: c.artist, album: c.album, artist_id: c.artistId, album_id: c.albumId, url: c.url, remote: c.remote, art: nowArt(120) });
    })];
    // Shown again after Back, the same page must start updating again.
    return { title: 'Now playing', el, actions, onShow: () => { npEls = els; updateNowPlaying(true); }, onHide: () => { if (npEls === els) npEls = null; } };
  };

  function sleepMenu() {
    const st = S.status || {};
    const left = +st.will_sleep_in || 0;
    sheet('Sleep timer', [
      ...[15, 30, 45, 60, 90].map((m) => ({ label: `${m} minutes`, icon: 'sleep', run: () => act(['sleep', m * 60], `Sleeping in ${m} minutes`) })),
      { label: 'At the end of this track', icon: 'note', run: () => act(['jiveendoftracksleep'], 'Sleeping after this track') },
      left ? { label: `Cancel (${fmtTime(left)} left)`, icon: 'close', run: () => act(['sleep', 0], 'Sleep timer off') } : null,
    ], { sub: playerName(S.target) });
  }

  function togglePlay() {
    const st = S.status;
    if (S.output && S.output.needsGesture) S.output.unlock();
    if (!st) return;
    if (st.mode === 'play') act(['pause', 1]);
    else if (st.mode === 'pause') act(['pause', 0]);
    else act(['play']);
  }
  const SHUFFLE = ['Shuffle off', 'Shuffle songs', 'Shuffle albums'];
  const REPEAT = ['Repeat off', 'Repeat song', 'Repeat queue'];
  function cycleShuffle() { const v = +(S.status && S.status['playlist shuffle']) || 0; act(['playlist', 'shuffle', (v + 1) % 3], SHUFFLE[(v + 1) % 3]); }
  function cycleRepeat() { const v = +(S.status && S.status['playlist repeat']) || 0; act(['playlist', 'repeat', (v + 1) % 3], REPEAT[(v + 1) % 3]); }

  function setIcon(b, name, label) { b.replaceChildren(icon(name)); if (label) { b.title = label; b.setAttribute('aria-label', label); } }

  function updateNowPlaying(force) {
    updateBar();
    if (!npEls) return;
    const st = S.status, c = current(st);
    const has = !!(c && (c.title || +st.playlist_tracks));
    npEls.empty.hidden = has; npEls.main.hidden = !has;
    if (!has) return;
    const artUrl = nowArt(600);
    if (force || artUrl !== npEls.lastArt) { npEls.lastArt = artUrl; npEls.art.replaceChildren(artEl(artUrl, 'album', 'xl')); }
    npEls.title.textContent = c.title || 'Unknown';
    npEls.artist.textContent = c.artist; npEls.artist.disabled = !c.artistId;
    npEls.album.textContent = c.album; npEls.album.disabled = !c.albumId; npEls.album.hidden = !c.album;
    npEls.station.textContent = c.stationTitle; npEls.station.hidden = !c.stationTitle;
    let q = qualityLabel(c);
    if (isLocal(S.target) && S.local) { const f = S.local.snapshot().format; if (f) q = (q ? q + '  →  ' : '') + 'decoding ' + f; }
    npEls.quality.textContent = q;
    const d = c.duration, t = elapsedNow();
    npEls.seek.max = d || 1; npEls.seek.disabled = !d || st.can_seek === 0;
    if (!npEls.isSeeking()) { npEls.seek.value = t; npEls.tNow.textContent = fmtTime(t); }
    npEls.tDur.textContent = d ? fmtTime(d) : (c.remote ? 'Live' : '');
    setIcon(npEls.playBtn, st.mode === 'play' ? 'pause' : 'play', st.mode === 'play' ? 'Pause' : 'Play');
    const sh = +st['playlist shuffle'] || 0, rp = +st['playlist repeat'] || 0;
    npEls.shuf.classList.toggle('on', sh > 0); npEls.shuf.title = SHUFFLE[sh];
    npEls.rep.classList.toggle('on', rp > 0); setIcon(npEls.rep, rp === 1 ? 'repeat1' : 'repeat', REPEAT[rp]);
    const v = Math.abs(+st['mixer volume'] || 0), muted = (+st['mixer volume'] || 0) < 0;
    showVolume(npEls.vol, v);
    setIcon(npEls.muteBtn, muted ? 'mute' : 'volume', muted ? 'Unmute' : 'Mute'); npEls.muteBtn.classList.toggle('on', muted);
    const idx = +st.playlist_cur_index, total = +st.playlist_tracks || 0;
    npEls.upNext.textContent = total ? `Track ${idx + 1} of ${total}` : '';
  }

  function updateBar() {
    const bar = document.getElementById('bar');
    const st = S.status, c = current(st);
    const has = !!(c && c.title);
    const els = bar._els || (bar._els = buildBar(bar));
    els.title.textContent = has ? c.title : (S.target ? 'Nothing playing' : 'No player');
    els.sub.textContent = has ? [c.artist, c.album].filter(Boolean).join(' · ') : playerName(S.target);
    const art = has ? nowArt(120) : null;
    if (art !== els.lastArt) { els.lastArt = art; els.art.replaceChildren(artEl(art, 'note', 'sm')); }
    setIcon(els.play, st && st.mode === 'play' ? 'pause' : 'play', st && st.mode === 'play' ? 'Pause' : 'Play');
    const d = c ? c.duration : 0, t = elapsedNow();
    els.prog.style.width = d ? Math.min(100, t / d * 100) + '%' : '0%';
    els.time.textContent = has ? (d ? `${fmtTime(t)} / ${fmtTime(d)}` : fmtTime(t)) : '';
    const v = Math.abs(+(st && st['mixer volume']) || 0), muted = (+(st && st['mixer volume']) || 0) < 0;
    showVolume(els.vol, v);
    setIcon(els.mute, muted ? 'mute' : 'volume', muted ? 'Unmute' : 'Mute'); els.mute.classList.toggle('on', muted);
  }
  function buildBar(bar) {
    const art = h('div', { class: 'bar-art' });
    const title = h('div', { class: 't1' }), sub = h('div', { class: 't2' });
    const play = btn('play', 'Play', () => togglePlay(), 'mid');
    const prog = h('div', { class: 'bar-prog-fill' });
    const time = h('div', { class: 'bar-time' });
    const vol = volumeSlider();
    const mute = btn('volume', 'Mute', () => act(['mixer', 'muting', 'toggle']));
    const progBar = h('div', { class: 'bar-prog', title: 'Seek' }, prog);
    progBar.addEventListener('click', (e) => {
      const c = current(); if (!c || !c.duration) return;
      const r = progBar.getBoundingClientRect(); act(['time', ((e.clientX - r.left) / r.width * c.duration).toFixed(1)]);
    });
    bar.append(progBar, h('div', { class: 'bar-main' },
      h('button', { class: 'bar-np', onclick: () => root('now') }, art, h('div', { class: 'meta' }, title, sub)),
      h('div', { class: 'bar-ctrls' }, btn('prev', 'Previous', () => act(['button', 'jump_rew'])), play, btn('next', 'Next', () => act(['playlist', 'index', '+1']))),
      h('div', { class: 'bar-right' }, time, h('div', { class: 'bar-vol' }, mute, vol), btn('queue', 'Queue', () => root('queue')))));
    return { art, title, sub, play, prog, time, vol, mute, lastArt: undefined };
  }
  setInterval(() => { if (S.status && S.status.mode === 'play') { updateBar(); if (npEls) updateNowPlaying(); } renderLocalBadge(); }, 500);
