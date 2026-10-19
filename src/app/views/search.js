  // -- Search ------------------------------------------------------------------
  VIEWS.search = (p = {}) => {
    const input = h('input', { class: 'field search-field', type: 'search', placeholder: tr('Artists, albums, tracks, playlists'), 'aria-label': tr('Search'), value: p.q || store.get('lastSearch', '') });
    const results = h('div', { class: 'results' });
    let seq = 0;
    async function run() {
      const q = input.value.trim(); store.set('lastSearch', q);
      const my = ++seq;
      if (q.length < 2) { results.replaceChildren(h('div', { class: 'empty', text: tr('Type at least two letters.') })); return; }
      results.replaceChildren(h('div', { class: 'empty', text: tr('Searching…') }));
      try {
        const [ar, al, ti, pl] = await Promise.all([
          rpc(['artists', 0, 30, 'search:' + q], ''), rpc(['albums', 0, 40, 'search:' + q, 'tags:aljyS'], ''),
          rpc(['titles', 0, 100, 'search:' + q, 'tags:aAdeltuyjJKs'], ''), rpc(['playlists', 0, 30, 'search:' + q], ''),
        ]);
        if (my !== seq) return;
        const out = [];
        const artists = ar.artists_loop || [], albums = al.albums_loop || [], tracks = ti.titles_loop || [], lists = pl.playlists_loop || [];
        if (artists.length) out.push(h('h3', { class: 'section', text: tr('Artists ({count})', { count: ar.count }) }), h('div', { class: 'list' }, artists.map(artistRow)));
        if (albums.length) out.push(h('h3', { class: 'section', text: tr('Albums ({count})', { count: al.count }) }), h('div', { class: 'grid' }, albums.map(albumCard)));
        if (tracks.length) out.push(h('h3', { class: 'section', text: tr('Tracks ({count})', { count: ti.count }) }), h('div', { class: 'list' }, tracks.map((t) => trackRow(t, {
          onclick: () => pc('load', 'track', t.id), menu: () => libMenu('track', { ...t, art: S.lms.cover(t.coverid, 120) }),
        }))));
        if (lists.length) out.push(h('h3', { class: 'section', text: tr('Playlists') }), h('div', { class: 'list' }, lists.map((x) => row({ art: null, artIcon: 'playlist', title: x.playlist, onclick: () => push('playlist', { id: x.id, name: x.playlist }) }))));
        if (!out.length) out.push(h('div', { class: 'empty', text: tr('Nothing in the library matches “{query}”.', { query: q }) }));
        out.push(h('div', { class: 'list' }, row({ art: null, artIcon: 'search', title: tr('Search apps and services for “{query}”', { query: q }), sub: tr('Everything LMS can search: your library, radio and installed apps'),
          onclick: () => push('jive', { action: { cmd: ['globalsearch', 'items'], params: { menu: 'globalsearch', search: q } }, title: tr('Search: {query}', { query: q }) }) })));
        results.replaceChildren(...out);
      } catch (e) {
        if (my !== seq) return;   // a newer search is under way
        results.replaceChildren(h('div', { class: 'empty', text: tr('The search failed: {error}', { error: (e && e.message) || e }) }));
      }
    }
    input.addEventListener('input', debounce(run, 350));
    if (input.value) run();
    return { title: tr('Search'), el: h('div', {}, h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); run(); } }, input), results), onShow: () => setTimeout(() => input.focus(), 30) };
  };
