  // ---------------------------------------------------------------------------
  // Skins: the page's own look, or one like Material Skin's. A skin is a style sheet (scoped by
  // data-skin on the page) and the few pieces of layout it needs, made here.
  // ---------------------------------------------------------------------------
  const SKINS = { lyrionjs: 'LyrionJS', material: 'Material' };
  const skin = () => (SKINS[store.get('skin', 'lyrionjs')] ? store.get('skin', 'lyrionjs') : 'lyrionjs');
  const narrow = matchMedia('(max-width: 860px)');

  function applySkin() {
    document.documentElement.dataset.skin = skin();
    updateSide();
  }

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
