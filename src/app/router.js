  // ---------------------------------------------------------------------------
  // Navigation: a stack of views mirrored in the browser history, so Back works everywhere.
  //   A view is a function (params) -> page: { title, el, actions?, onShow?, onHide?, dispose?,
  //   perPlayer? }. perPlayer views are rebuilt when the controlled player changes.
  // ---------------------------------------------------------------------------
  const VIEWS = {};
  const NAV = [
    ['home', 'Home', 'home'], ['now', 'Now playing', 'note'], ['queue', 'Queue', 'queue'], ['search', 'Search', 'search'], null,
    ['artists', 'Artists', 'artist'], ['albums', 'Albums', 'album'], ['genres', 'Genres', 'genre'], ['years', 'Years', 'year'],
    ['newmusic', 'New music', 'star'], ['folders', 'Music folder', 'folder'], ['playlists', 'Playlists', 'playlist'], 'plugins',
    ['favourites', 'Favourites', 'fav'], ['radio', 'Radio', 'radio'], ['apps', 'Apps', 'apps'], ['random', 'Random mix', 'random'], null,
    ['players', 'Players', 'speaker'], ['alarms', 'Alarms', 'alarm'], ['settings', 'Settings', 'settings'],
  ];

  function renderNav() {
    const nav = document.getElementById('nav');
    nav.textContent = '';
    const close = () => document.body.classList.remove('nav-open');
    for (const n of NAV) {
      if (n === 'plugins') {
        nav.append(h('div', { class: 'nav-sep' }));
        // What plugins add to LMS's "My Music" (AudioMuse-AI, Custom Browse…).
        if (S.pluginMenus && S.pluginMenus.length) {
          for (const m of S.pluginMenus) {
            const art = jiveArt(m, 48);
            nav.append(h('button', { class: 'nav-item', 'data-view': 'jive:' + m.id, title: m.text,
              onclick: () => { root('jive', { action: m.actions.go, title: m.text, navId: 'jive:' + m.id }); close(); } },
            art ? h('img', { class: 'ic nav-img', src: art, alt: '' }) : icon('apps'), h('span', { text: m.text })));
          }
          nav.append(h('div', { class: 'nav-sep' }));
        }
        continue;
      }
      if (!n) { nav.append(h('div', { class: 'nav-sep' })); continue; }
      nav.append(h('button', { class: 'nav-item', 'data-view': n[0], onclick: () => { root(n[0]); close(); } }, icon(n[2]), h('span', { text: n[1] })));
    }
    if (S.nav[0]) markNav(navKey(S.nav[0]));
  }
  const navKey = (e) => (e.params && e.params.navId) || e.name;
  function markNav(name) { for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === name); }

  function buildPage(entry) {
    try {
      const make = VIEWS[entry.name] || VIEWS.now;
      return make(entry.params || {});
    } catch (e) {
      console.error(e);
      return { title: 'Something went wrong', el: h('div', { class: 'empty', text: 'This page could not be shown: ' + (e && e.message || e) }) };
    }
  }

  function show(entry) {
    const main = document.getElementById('view');
    const cur = S.shown;
    if (cur && cur !== entry && cur.page && cur.page.onHide) cur.page.onHide();
    main.textContent = '';
    if (!entry.page) entry.page = buildPage(entry);
    const p = entry.page;
    p.head = h('h1', { text: p.title || '' });
    main.append(h('div', { class: 'view-head' }, S.nav.length > 1 ? btn('back', 'Back', () => back()) : null, p.head,
      h('div', { class: 'view-actions' }, p.actions || [])), p.el);
    S.shown = entry;
    if (p.onShow) p.onShow();
    main.scrollTop = entry.scroll || 0;
    markNav(S.nav[0] && navKey(S.nav[0]));
    // What the skin lays out around the page: now playing on its own, the queue beside it.
    document.body.dataset.view = entry.name;
    updateSide();
    document.title = tabTitle(p.title);
  }
  /** The tab's name for a page: its title and LyrionJS's (once, if the title already has it). */
  const tabTitle = (t) => (!t ? 'LyrionJS' : /LyrionJS/.test(t) ? t : t + ' · LyrionJS');
  /** A page may learn its title after it is shown (LMS menus). */
  function setTitle(page, t) { page.title = t; if (page.head) page.head.textContent = t; if (S.shown && S.shown.page === page) document.title = tabTitle(t); }

  function dispose(entry) {
    const p = entry.page;
    if (!p) return;
    if (p.onHide && S.shown === entry) p.onHide();
    if (p.dispose) try { p.dispose(); } catch (e) { console.error(e); }
    if (p.el) disposeLists(p.el);
    entry.page = null;
  }

  /** A history entry's state: how deep, and whether it's LyrionJS's own pages over an LMS skin. */
  const navState = (d) => (document.documentElement.classList.contains('host-own') ? { d, own: 1 } : { d });
  function saveScroll() { const top = S.nav[S.nav.length - 1]; if (top) top.scroll = document.getElementById('view').scrollTop; }
  function push(name, params) {
    saveScroll();
    S.nav.push({ name, params });
    history.pushState(navState(S.nav.length), '');
    show(S.nav[S.nav.length - 1]);
  }
  let ignorePop = 0;
  function root(name, params) {
    const extra = S.nav.length - 1;
    for (const e of S.nav) dispose(e);
    if (!params && VIEWS[name]) { store.set('view', name); if (name !== 'now' && name !== 'queue') store.set('browseView', name); }
    S.nav = [{ name, params }]; S.shown = null;
    show(S.nav[0]);
    // Take the browser history back to the root as well, so Back leaves the app only from there.
    if (extra > 0) { ignorePop++; history.go(-extra); }
  }
  /** Back n views (LMS menus may ask for two). */
  function back(n = 1) {
    n = Math.min(n, S.nav.length - 1);
    if (n > 0) history.go(-n);
  }
  window.addEventListener('popstate', (e) => {
    // Back leaves whatever was open over the page: a menu or dialog belongs to the page left.
    closeSheet();
    document.body.classList.remove('nav-open');
    if (ignorePop) { ignorePop--; history.replaceState(navState(1), ''); return; }
    // Back past LyrionJS's first page, over an LMS skin: the skin again.
    if (document.documentElement.classList.contains('host-own') && !(e.state && e.state.own)) document.documentElement.classList.remove('host-own');
    const d = (e.state && e.state.d) || 1;
    if (d >= S.nav.length) {
      // Forward to a view we have already left: there's nothing to go forward to.
      history.replaceState(navState(S.nav.length), '');
      return;
    }
    while (S.nav.length > d) dispose(S.nav.pop());
    show(S.nav[S.nav.length - 1]);
  });

  /**
   * The controlled player changed: views that show its settings or state start again, those
   * further back too (they are built afresh when Back reaches them).
   */
  function playerChanged() {
    const top = S.shown;
    let rebuild = false;
    for (const e of S.nav) {
      if (e.page && e.page.perPlayer) { if (e === top) rebuild = true; dispose(e); }
    }
    if (rebuild) show(top);
    sidePlayerChanged();
  }
