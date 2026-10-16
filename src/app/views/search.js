  // -- Search ------------------------------------------------------------------
  VIEWS.search = (p = {}) => {
    const input = h('input', { class: 'field search-field', type: 'search', placeholder: 'Artists, albums, tracks, playlists', 'aria-label': 'Search', value: p.q || store.get('lastSearch', '') });
    const results = h('div', { class: 'results' });
    let seq = 0;
    async function run() {
      const q = input.value.trim(); store.set('lastSearch', q);
      const my = ++seq;
      if (q.length < 2) { results.replaceChildren(h('div', { class: 'empty', text: 'Type at least two letters.' })); return; }
      results.replaceChildren(h('div', { class: 'empty', text: 'Searching…' }));
      try {
        const [ar, al, tr, pl] = await Promise.all([
          rpc(['artists', 0, 30, 'search:' + q], ''), rpc(['albums', 0, 40, 'search:' + q, 'tags:aljyS'], ''),
          rpc(['titles', 0, 100, 'search:' + q, 'tags:aAdeltuyjJKs'], ''), rpc(['playlists', 0, 30, 'search:' + q], ''),
        ]);
        if (my !== seq) return;
        const out = [];
        const artists = ar.artists_loop || [], albums = al.albums_loop || [], tracks = tr.titles_loop || [], lists = pl.playlists_loop || [];
        if (artists.length) out.push(h('h3', { class: 'section', text: `Artists (${ar.count})` }), h('div', { class: 'list' }, artists.map(artistRow)));
        if (albums.length) out.push(h('h3', { class: 'section', text: `Albums (${al.count})` }), h('div', { class: 'grid' }, albums.map(albumCard)));
        if (tracks.length) out.push(h('h3', { class: 'section', text: `Tracks (${tr.count})` }), h('div', { class: 'list' }, tracks.map((t) => trackRow(t, {
          onclick: () => pc('load', 'track', t.id), menu: () => libMenu('track', { ...t, art: S.lms.cover(t.coverid, 120) }),
        }))));
        if (lists.length) out.push(h('h3', { class: 'section', text: 'Playlists' }), h('div', { class: 'list' }, lists.map((x) => row({ art: null, artIcon: 'playlist', title: x.playlist, onclick: () => push('playlist', { id: x.id, name: x.playlist }) }))));
        if (!out.length) out.push(h('div', { class: 'empty', text: `Nothing in the library matches “${q}”.` }));
        out.push(h('div', { class: 'list' }, row({ art: null, artIcon: 'search', title: `Search apps and services for “${q}”`, sub: 'Everything LMS can search: your library, radio and installed apps',
          onclick: () => push('jive', { action: { cmd: ['globalsearch', 'items'], params: { menu: 'globalsearch', search: q } }, title: 'Search: ' + q }) })));
        results.replaceChildren(...out);
      } catch (e) { fail(e); }
    }
    input.addEventListener('input', debounce(run, 350));
    if (input.value) run();
    return { title: 'Search', el: h('div', {}, h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); run(); } }, input), results), onShow: () => setTimeout(() => input.focus(), 30) };
  };
