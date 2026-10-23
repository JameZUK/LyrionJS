  // -- Library -----------------------------------------------------------------
  function albumCard(a) {
    return card({
      art: S.lms.cover(a.artwork_track_id, 300), title: a.album, sub: [a.artist, a.year && +a.year ? a.year : ''].filter(Boolean).join(' · '),
      onclick: () => push('album', { id: a.id, title: a.album, artist: a.artist, artist_id: a.artist_id, art: a.artwork_track_id, year: a.year }),
      menu: () => libMenu('album', { ...a, title: a.album, art: S.lms.cover(a.artwork_track_id, 120) }),
    });
  }
  const artistImg = (id, size = 300) => S.lms.url(`imageproxy/mai/artist/${id}/image_${size}x${size}_f`);
  function artistRow(a) {
    return row({ art: artistImg(a.id, 96), artIcon: 'artist', title: a.artist, onclick: () => push('artist', { id: a.id, name: a.artist }), menu: () => libMenu('artist', { ...a, title: a.artist }) });
  }

  VIEWS.artists = () => {
    let role = store.get('artistRole', 'ALBUMARTIST');
    const holder = h('div');
    const pick = h('select', { class: 'select', 'aria-label': tr('Which artists'), onchange: () => { role = pick.value; store.set('artistRole', role); build(); } },
      h('option', { value: 'ALBUMARTIST', text: tr('Album artists'), selected: role === 'ALBUMARTIST' }),
      h('option', { value: '', text: tr('All artists'), selected: role === '' }),
      h('option', { value: 'COMPOSER', text: tr('Composers'), selected: role === 'COMPOSER' }));
    function build() {
      swap(holder, lazyList({
        fetch: loopFetch((s, n) => rpc(['artists', s, n, ...(role ? ['role_id:' + role] : [])], ''), 'artists_loop'),
        render: artistRow, page: 200,
      }));
    }
    build();
    return { title: tr('Artists'), el: holder, actions: [pick] };
  };

  VIEWS.albums = (p = {}) => {
    let sort = p.sort || store.get('albumSort', 'album');
    const holder = h('div');
    const pick = p.sort ? null : h('select', { class: 'select', 'aria-label': tr('Sort albums'), onchange: () => { sort = pick.value; store.set('albumSort', sort); build(); } },
      [['album', tr('By title')], ['artistalbum', tr('By artist')], ['yearalbum', tr('By year')], ['new', tr('Recently added')], ['random', tr('Random')]].map(([v, t]) => h('option', { value: v, text: t, selected: sort === v })));
    function build() {
      const all = loopFetch((s, n) => rpc(['albums', s, n, 'tags:aljyS', 'sort:' + sort, ...(p.filter || [])], ''), 'albums_loop');
      // LMS shuffles each page it's asked for afresh: random albums come as one batch, never paged.
      const once = async () => { const r = await all(0, RANDOM_BATCH); r.total = r.items.length; return r; };
      swap(holder, lazyList({
        grid: true, page: 120, render: albumCard,
        // "New music" shows the newest 300 albums, not the whole library newest-first.
        fetch: sort === 'random' ? once : p.sort === 'new' ? async (s, n) => { const r = await all(s, n); r.total = Math.min(r.total, 300); return r; } : all,
      }));
    }
    build();
    const again = btn('refresh', tr('Other random albums'), () => build());
    if (sort !== 'random') again.hidden = true;
    if (pick) pick.addEventListener('change', () => { again.hidden = sort !== 'random'; });
    return { title: p.title || tr('Albums'), el: holder, actions: [again, ...(pick ? [pick] : [])] };
  };
  const RANDOM_BATCH = 50;
  VIEWS.randomalbums = () => VIEWS.albums({ sort: 'random', title: tr('Random albums') });
  VIEWS.newmusic = () => VIEWS.albums({ sort: 'new', title: tr('New music') });

  VIEWS.artist = (p) => {
    const header = h('div', { class: 'hero' }, artEl(artistImg(p.id, 300), 'artist', 'hero-art round'),
      h('div', { class: 'hero-meta' }, h('h2', { text: p.name || '' }), heroButtons('artist', p.id)));
    const albums = lazyList({
      grid: true, page: 200, empty: tr('No albums.'), render: albumCard,
      fetch: loopFetch((s, n) => rpc(['albums', s, n, 'artist_id:' + p.id, 'tags:aljyS', 'sort:yearalbum'], ''), 'albums_loop'),
    });
    return { title: p.name || tr('Artist'), el: h('div', {}, header, h('h3', { class: 'section', text: tr('Albums') }), albums), actions: [btn('more', tr('More'), () => libMenu('artist', { id: p.id, title: p.name, favorites_url: 'db:contributor.name=' + encodeURIComponent(p.name || '') }))] };
  };

  VIEWS.album = (p) => {
    const list = h('div', { class: 'list' });
    const meta = h('div', { class: 't2' });
    const artist = h('button', { class: 'np-link', text: p.artist || '', onclick: () => p.artist_id && push('artist', { id: p.artist_id, name: p.artist }) });
    const header = h('div', { class: 'hero' }, artEl(p.art ? S.lms.cover(p.art, 500) : null, 'album', 'hero-art'),
      h('div', { class: 'hero-meta' }, h('h2', { text: p.title || '' }), artist, meta, heroButtons('album', p.id)));
    let tracks = [];
    (async () => {
      try {
        const r = await rpc(['titles', 0, 1000, 'album_id:' + p.id, 'tags:aAdeltuyjJKsiqr', 'sort:tracknum'], '');
        tracks = r.titles_loop || [];
        let total = 0; for (const t of tracks) total += +t.duration || 0;
        const first = tracks[0] || {};
        if (!p.art && first.coverid) header.firstChild.replaceWith(artEl(S.lms.cover(first.coverid, 500), 'album', 'hero-art'));
        if (!p.artist_id && first.artist_id) { p.artist_id = first.artist_id; }
        if (!p.artist && first.artist) artist.textContent = p.artist = first.artist;
        meta.textContent = [first.year && +first.year ? first.year : '', trn(tracks.length, '{n} track', '{n} tracks'), fmtTime(total), qualityLabel(first)].filter(Boolean).join(' · ');
        const discs = new Set(tracks.map((t) => t.disc || 1));
        let lastDisc = null;
        const rows = [];
        tracks.forEach((t, i) => {
          if (discs.size > 1 && t.disc !== lastDisc) { lastDisc = t.disc; rows.push(h('div', { class: 'disc', text: tr('Disc {n}', { n: t.disc || 1 }) })); }
          rows.push(row({
            num: t.tracknum || i + 1, title: t.title, sub: t.artist && t.artist !== p.artist ? t.artist : null, right: fmtTime(t.duration),
            onclick: () => act(['playlistcontrol', 'cmd:load', 'album_id:' + p.id, 'play_index:' + i], tr('Playing')),
            menu: () => libMenu('track', { ...t, art: S.lms.cover(t.coverid, 120) }),
          }));
        });
        list.replaceChildren(...rows);
      } catch (e) { fail(e); }
    })();
    return {
      title: p.title || tr('Album'), el: h('div', {}, header, list),
      actions: [btn('more', tr('More'), () => libMenu('album', { id: p.id, title: p.title, artist: p.artist, artist_id: p.artist_id, favorites_url: tracks[0] ? `db:album.title=${encodeURIComponent(p.title || '')}&contributor.name=${encodeURIComponent(p.artist || '')}` : null }, [
        tracks.length ? { label: tr('Add album to playlist…'), icon: 'playlist', run: () => addToPlaylist(tracks.map((t) => t.url).filter(Boolean)) } : null,
      ]))],
    };
  };

  VIEWS.genres = () => ({
    title: tr('Genres'),
    el: lazyList({
      page: 200, fetch: loopFetch((s, n) => rpc(['genres', s, n], ''), 'genres_loop'),
      render: (g) => row({ art: null, artIcon: 'genre', title: g.genre, onclick: () => push('albums', { title: g.genre, filter: ['genre_id:' + g.id], sort: 'artistalbum' }), menu: () => libMenu('genre', { ...g, title: g.genre }) }),
    }),
  });

  VIEWS.years = () => ({
    title: tr('Years'),
    el: lazyList({
      page: 200, fetch: loopFetch((s, n) => rpc(['years', s, n], ''), 'years_loop', (y) => +y.year),
      render: (y) => row({ art: null, artIcon: 'year', title: String(y.year), onclick: () => push('albums', { title: String(y.year), filter: ['year:' + y.year], sort: 'artistalbum' }), menu: () => libMenu('year', { id: y.year, title: String(y.year) }) }),
    }),
  });

  VIEWS.folders = (p = {}) => ({
    title: p.title || tr('Music folder'),
    el: lazyList({
      page: 200, empty: tr('This folder is empty.'),
      fetch: loopFetch((s, n) => rpc(['musicfolder', s, n, 'tags:cdu', ...(p.id ? ['folder_id:' + p.id] : [])], ''), 'folder_loop'),
      render: (f) => {
        if (f.type === 'folder') return row({ art: null, artIcon: 'folder', title: f.filename, onclick: () => push('folders', { id: f.id, title: f.filename }), menu: () => libMenu('folder', { ...f, title: f.filename }) });
        if (f.type === 'track') return row({ art: S.lms.cover(f.coverid || f.id, 96), title: f.filename, right: f.duration ? fmtTime(f.duration) : '', onclick: () => pc('load', 'track', f.id), menu: () => libMenu('track', { ...f, title: f.filename }) });
        if (f.type === 'playlist') return row({ art: null, artIcon: 'playlist', title: f.filename, onclick: () => pc('load', 'playlist', f.id), menu: () => libMenu('playlist', { ...f, title: f.filename }) });
        return row({ art: null, artIcon: 'note', title: f.filename, cls: 'dim' });
      },
    }),
    actions: p.id ? [btn('play', tr('Play folder'), () => pc('load', 'folder', p.id)), btn('add', tr('Queue folder'), () => pc('add', 'folder', p.id))] : [],
  });
