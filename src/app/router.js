  // ---------------------------------------------------------------------------
  // Navigation: a stack of views mirrored in the browser history, so Back works everywhere.
  //   A view is a function (params) -> page: { title, el, actions?, onShow?, onHide?, dispose?,
  //   perPlayer? }. perPlayer views are rebuilt when the controlled player changes.
  // ---------------------------------------------------------------------------
  const VIEWS = {};
  const NAV = [
    ['now', 'Now playing', 'note'], ['queue', 'Queue', 'queue'], ['search', 'Search', 'search'], null,
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

  function build(entry) {
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
    if (!entry.page) entry.page = build(entry);
    const p = entry.page;
    p.head = h('h1', { text: p.title || '' });
    main.append(h('div', { class: 'view-head' }, S.nav.length > 1 ? btn('back', 'Back', () => back()) : null, p.head,
      h('div', { class: 'view-actions' }, p.actions || [])), p.el);
    S.shown = entry;
    if (p.onShow) p.onShow();
    main.scrollTop = entry.scroll || 0;
    markNav(S.nav[0] && navKey(S.nav[0]));
    document.title = (p.title ? p.title + ' · ' : '') + 'LyrionJS';
  }
  /** A page may learn its title after it is shown (LMS menus). */
  function setTitle(page, t) { page.title = t; if (page.head) page.head.textContent = t; if (S.shown && S.shown.page === page) document.title = t + ' · LyrionJS'; }

  function dispose(entry) {
    const p = entry.page;
    if (!p) return;
    if (p.onHide && S.shown === entry) p.onHide();
    if (p.dispose) try { p.dispose(); } catch (e) { console.error(e); }
    if (p.el) for (const l of p.el.querySelectorAll('.lazy')) if (l.dispose) l.dispose();
    entry.page = null;
  }

  function saveScroll() { const top = S.nav[S.nav.length - 1]; if (top) top.scroll = document.getElementById('view').scrollTop; }
  function push(name, params) {
    saveScroll();
    S.nav.push({ name, params });
    history.pushState({ d: S.nav.length }, '');
    show(S.nav[S.nav.length - 1]);
  }
  let ignorePop = 0;
  function root(name, params) {
    const extra = S.nav.length - 1;
    for (const e of S.nav) dispose(e);
    if (!params && VIEWS[name]) store.set('view', name);
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
    if (ignorePop) { ignorePop--; history.replaceState({ d: 1 }, ''); return; }
    const d = (e.state && e.state.d) || 1;
    if (d >= S.nav.length) {
      // Forward to a view we have already left: there's nothing to go forward to.
      history.replaceState({ d: S.nav.length }, '');
      return;
    }
    while (S.nav.length > d) dispose(S.nav.pop());
    show(S.nav[S.nav.length - 1]);
  });

  /** The controlled player changed: views that show its settings or state start again. */
  function playerChanged() {
    const e = S.shown;
    if (e && e.page && e.page.perPlayer) { dispose(e); show(e); }
  }
