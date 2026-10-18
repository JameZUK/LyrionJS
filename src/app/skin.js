  // ---------------------------------------------------------------------------
  // Skins: the page's own look, or one like Material Skin's. A skin is a style sheet (scoped by
  // data-skin on the page) and the few pieces of layout it needs, made here.
  // ---------------------------------------------------------------------------
  const SKINS = { lyrionjs: 'LyrionJS', material: 'Material' };
  /** The page's own layout (LyrionJS's while an LMS skin is shown over it, below). */
  const skin = () => (SKINS[store.get('skin', 'lyrionjs')] ? store.get('skin', 'lyrionjs') : 'lyrionjs');
  /** The LMS skin shown over the page ('lms:<its folder>' in Settings), if one is. */
  const lmsSkin = () => { const m = /^lms:([\w.-]+)$/.exec(store.get('skin', '')); return m ? m[1] : null; };
  const narrow = matchMedia('(max-width: 860px)');

  function applySkin() {
    document.documentElement.dataset.skin = skin();
    updateSide();
    updateHost();
  }

  // -- An LMS skin over the page -----------------------------------------------------------------
  // LyrionJS stays the player (the stream, the sound, the lock screen's controls); the skin
  // installed on the server is the remote, in a frame over the page, pointed at this browser.
  // Nothing of the skin is copied: it's whatever version LMS has. The skin's own ways to
  // LyrionJS lead to LyrionJS's pages; "Back to <skin>" (top bar, menu, Back) returns.
  const HOST_WAIT_MS = 8000;   // for LMS to know this browser's player, before showing another
  let hostFrame = null, hostSince = 0;
  function hostWanted() {
    const s = lmsSkin(), known = S.config && S.config.skins;
    return s && S.lms && document.body.classList.contains('ready') && (!known || known[s]) ? s : null;
  }
  const hostName = () => (S.config && S.config.skins && S.config.skins[lmsSkin()]) || lmsSkin() || '';
  const hostOwn = () => document.documentElement.classList.contains('host-own');
  function updateHost() {
    const s = hostWanted(), root = document.documentElement;
    if (!s) {
      if (hostFrame) { hostFrame.remove(); hostFrame = null; }
      if (root.dataset.host) { delete root.dataset.host; root.classList.remove('host-own'); renderNav(); }
      return;
    }
    if (root.dataset.host !== s) { root.dataset.host = s; renderNav(); }
    document.getElementById('skinBtn').lastChild.textContent = hostName();
    hostSince = hostSince || performance.now();
    const local = (S.players || []).some((p) => isLocal(p.playerid));
    if (!local && performance.now() - hostSince < HOST_WAIT_MS) return;   // poll comes back here
    if (hostFrame && hostFrame.dataset.skin === s) return;
    if (!hostFrame) {
      hostFrame = h('iframe', { id: 'skinframe', title: hostName() });
      document.body.append(hostFrame);
    }
    hostFrame.dataset.skin = s;
    hostFrame.src = `/${encodeURIComponent(s)}/?player=${encodeURIComponent(local ? S.localId : S.target || '')}`;
  }

  /** An address of this page (whatever host name the skin's link has). */
  const isPageUrl = (u) => { try { return /^\/plugins\/LyrionJS\/(?:index\.html)?$/.test(new URL(u, location.href).pathname); } catch (e) { return false; } };
  /**
   * Each page the frame shows: a tap or key in it can start the sound here, and the skin's ways
   * to LyrionJS (Material's tile opens a window, an app's link is followed) come to this page
   * instead of opening another. Looked at often, so a page just loaded is caught soon.
   */
  setInterval(() => {
    if (!hostFrame) return;
    let d, w; try { d = hostFrame.contentDocument; w = hostFrame.contentWindow; } catch (e) { return; }
    if (!d || !w) return;
    if (!d.ljHooked) {
      d.ljHooked = true;
      for (const ev of ['touchend', 'click', 'keydown']) d.addEventListener(ev, unlock, true);
      d.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (a && isPageUrl(a.getAttribute('href'))) { e.preventDefault(); e.stopPropagation(); enterOwn(); }
      }, true);
      const open = w.open;
      w.open = function (u, ...rest) { if (u && isPageUrl(String(u))) { enterOwn(); return null; } return open.call(this, u, ...rest); };
    }
    if (d.title && !hostOwn()) document.title = d.title;
  }, 300);

  /** From the LMS skin to LyrionJS's own pages, a step in the history (so Back returns). */
  function enterOwn() {
    if (!document.documentElement.dataset.host || hostOwn()) return;
    document.documentElement.classList.add('host-own');
    root('about', { recursion: true });
    history.pushState(navState(1), '');
  }
  /** Back to the skin: all of LyrionJS's steps in the history (popstate, in router.js, does the rest). */
  function leaveOwn() {
    if (!hostOwn()) return;
    if (history.state && history.state.own) history.go(-S.nav.length);
    else document.documentElement.classList.remove('host-own');
  }
  document.getElementById('skinBtn').onclick = leaveOwn;

  // -- Home: what the menu offers, as a grid (Material's "Browse") -----------------------------
  VIEWS.home = () => {
    const tiles = [];
    for (const n of NAV) {
      if (n === 'plugins') {
        for (const m of S.pluginMenus || []) {
          const art = jiveArt(m, 96);
          tiles.push(h('button', { class: 'home-item', onclick: () => push('jive', { action: m.actions.go, title: m.text }) },
            art ? h('img', { class: 'home-img', src: art, alt: '' }) : icon('apps'), h('span', { text: m.text })));
        }
        continue;
      }
      if (!n || ['home', 'now', 'queue', 'search'].includes(n[0])) continue;   // search: the button over the page
      tiles.push(h('button', { class: 'home-item', onclick: () => push(n[0]) }, icon(n[2]), h('span', { text: n[1] })));
    }
    return { title: 'Home', el: h('div', { class: 'home' }, tiles) };
  };

  // -- Now playing over the page (Material's expanded now playing) -------------------------------
  /** Opens now playing; with the Material skin over the page, so closing it goes back to where it was. */
  function openNow() {
    if (skin() === 'material' && S.shown && S.shown.name !== 'now') push('now');
    else root('now');
  }
  function closeNow() {
    if (S.nav.length > 1) back();
    else root(store.get('browseView', 'home'));
  }

  // -- The queue beside the page (Material's desktop layout) -------------------------------------
  let sidePage = null;
  function sideWanted() {
    const v = S.shown && S.shown.name;
    return skin() === 'material' && !narrow.matches && store.get('sideQueue', false) && v !== 'now' && v !== 'queue' && !!S.lms;
  }
  function updateSide() {
    const el = document.getElementById('side'), sb = document.getElementById('sideBtn');
    const want = sideWanted();
    if (sb) sb.setAttribute('aria-pressed', String(skin() === 'material' && store.get('sideQueue', false)));
    if (want && !sidePage) {
      sidePage = VIEWS.queue();
      el.replaceChildren(h('div', { class: 'view-head side-head' }, h('h2', { text: 'Queue' }), h('div', { class: 'view-actions' }, sidePage.actions || [])), sidePage.el);
      if (sidePage.onShow) sidePage.onShow();
    }
    else if (!want && sidePage) closeSide();
    el.hidden = !want;
  }
  function closeSide() {
    if (!sidePage) return;
    if (sidePage.onHide) sidePage.onHide();
    disposeLists(sidePage.el);
    sidePage = null;
    document.getElementById('side').textContent = '';
  }
  /** Another player: its queue. */
  function sidePlayerChanged() { if (sidePage) { closeSide(); updateSide(); } }
  narrow.addEventListener('change', updateSide);
  // Material's search button, over the page.
  document.getElementById('fab').onclick = () => root('search');
  document.getElementById('sideBtn').onclick = () => {
    // On a narrow screen there's no room beside the page: the queue opens instead.
    if (narrow.matches) { root('queue'); return; }
    store.set('sideQueue', !store.get('sideQueue', false));
    if (S.shown && S.shown.name === 'queue' && store.get('sideQueue', false)) closeNow();
    updateSide();
  };
