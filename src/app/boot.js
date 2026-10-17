  // ---------------------------------------------------------------------------
  // Keyboard, boot
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet(); document.body.classList.remove('nav-open'); return; }   // also while typing
    if (!document.body.classList.contains('ready') || !S.lms) return;   // not before the app has started
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') {
      if (e.target.closest('button, [role="button"], a')) return;   // Space activates what has focus
      e.preventDefault(); togglePlay();
    }
    else if (e.key === 'ArrowRight') act(['playlist', 'index', '+1']);
    else if (e.key === 'ArrowLeft') act(['button', 'jump_rew']);
    else if (e.key === 'ArrowUp') { e.preventDefault(); act(['mixer', 'volume', '+5']); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); act(['mixer', 'volume', '-5']); }
    else if (e.key === 'm' || e.key === 'M') act(['mixer', 'muting', 'toggle']);
    else if (e.key === '/') { e.preventDefault(); root('search'); }
  });
  // Browsers only let audio start inside a user gesture. On iPad a touch counts on touchend or
  // click, not pointerdown, and the audio context must be created or resumed right there.
  const unlock = () => { if (S.output) S.output.unlock(); refreshUnlock(); };
  for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, unlock, true);
  // Safari 17+: play as media, so the silent switch and Control Centre's silent mode don't mute it.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older Safari */ }

  function unreachable(msg) {
    document.getElementById('view').replaceChildren(h('div', { class: 'discover' },
      h('div', { class: 'logo' }, logo()), h('h1', { text: 'LyrionJS' }),
      h('p', { text: 'Lyrion Music Server is not answering at ' + location.host + '.' }),
      h('p', { class: 't2', text: msg || '' }),
      h('button', { class: 'btn', onclick: () => location.reload() }, icon('refresh'), 'Try again')));
  }

  /**
   * Inside another page's frame (Material Skin opens its Extras that way), the player stops when
   * that window closes: offer it a tab of its own, or carry on here.
   */
  function leaveFrame() {
    let inFrame = true;
    try { inFrame = window.top !== window; } catch (e) { /* a parent on another origin */ }
    if (!inFrame) return Promise.resolve();
    return new Promise((resolve) => {
      document.getElementById('view').replaceChildren(h('div', { class: 'discover' },
        h('div', { class: 'logo' }, logo()), h('h1', { text: 'LyrionJS' }),
        h('p', { text: 'LyrionJS plays best in a tab of its own: in this window it stops when the window closes.' }),
        h('div', { class: 'row-btns' },
          h('a', { class: 'btn', href: location.origin + location.pathname, target: '_blank', rel: 'noopener' }, icon('play'), 'Open in a new tab'),
          h('button', { class: 'btn ghost', onclick: () => resolve() }, 'Use it here'))));
    });
  }

  async function boot() {
    applyTheme();
    applySkin();
    renderNav();
    await leaveFrame();
    document.getElementById('menuBtn').onclick = () => document.body.classList.toggle('nav-open');
    // The menu button says whether the drawer is open, whoever opened or closed it.
    new MutationObserver(() => document.getElementById('menuBtn').setAttribute('aria-expanded', String(document.body.classList.contains('nav-open'))))
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.getElementById('scrim').onclick = () => document.body.classList.remove('nav-open');
    document.getElementById('playerBtn').onclick = () => S.lms && playerPicker();
    document.getElementById('localBadge').onclick = () => renameLocal();
    document.getElementById('unlock').onclick = unlock;
    S.lms = new LMS();
    try {
      const v = await S.lms.rpc('', ['version', '?'], 8000);
      let name = '';
      try { name = (await S.lms.rpc('', ['pref', 'libraryname', '?'], 5000))._p2 || ''; } catch (e) { /* older LMS */ }
      S.server = { name: name || 'Lyrion Music Server', version: v._version };
    } catch (e) { unreachable(e.message); return; }
    document.getElementById('serverName').textContent = S.server.name;
    document.body.classList.add('ready');
    S.localId = macBytes().str;
    try { S.config = serverConfig = await (await fetch('/plugins/LyrionJS/config.json', { cache: 'no-store' })).json(); } catch (e) { S.config = serverConfig = {}; }
    notePage(S.config);
    if (S.config.enabled === 0) toast('Browser players are switched off in LMS (Settings › Plugins › LyrionJS). This page controls your other players.');
    else claimPlayerThenStart();
    history.replaceState({ d: 1 }, '');
    const saved = store.get('view', 'now');
    root(VIEWS[saved] ? saved : 'now');
    try { await pollPlayers(); } catch (e) { setConn(false, e.message); }
    if (S.target && S.players.some((p) => p.playerid === S.target)) loadPluginMenus();
    poll();
  }

  window.LyrionJS = { S, VERSION };   // for diagnostics from the browser console
  boot();
