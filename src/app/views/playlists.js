  // -- Playlists ---------------------------------------------------------------
  VIEWS.playlists = () => {
    const holder = h('div');
    const build = () => swap(holder, lazyList({
      page: 200, empty: tr('No saved playlists.'),
      fetch: loopFetch((s, n) => rpc(['playlists', s, n, 'tags:u'], ''), 'playlists_loop'),
      render: (pl) => row({
        art: null, artIcon: 'playlist', title: pl.playlist, onclick: () => push('playlist', { id: pl.id, name: pl.playlist }),
        menu: () => libMenu('playlist', { ...pl, title: pl.playlist, favorites_url: pl.url }, playlistAdmin(pl, build)),
      }),
    }));
    build();
    // Back from a playlist that was renamed or deleted: show the list as it is now.
    let shown = false;
    const onShow = () => { if (shown) build(); shown = true; };
    return { title: tr('Playlists'), el: holder, onShow, actions: [btn('save', tr('Save queue as playlist'), async () => { const n = await prompt2(tr('Save queue as playlist'), { placeholder: tr('Playlist name'), ok: tr('Save') }); if (n) { await act(['playlist', 'save', n], tr('Saved as {name}', { name: n })); setTimeout(build, 800); } })] };
  };
  function playlistAdmin(pl, after) {
    return [
      { sep: true },
      { label: tr('Rename…'), icon: 'edit', run: async () => { const n = await prompt2(tr('Rename playlist'), { value: pl.playlist, ok: tr('Rename') }); if (n) { await act(['playlists', 'rename', 'playlist_id:' + pl.id, 'newname:' + n], tr('Renamed'), ''); after && after(); } } },
      { label: tr('Delete playlist'), icon: 'delete', danger: true, run: async () => { if (await confirm2(tr('Delete “{name}”?', { name: pl.playlist }))) { await act(['playlists', 'delete', 'playlist_id:' + pl.id], tr('Deleted'), ''); after && after(); } } },
    ];
  }
  VIEWS.playlist = (p) => {
    const holder = h('div');
    let count = 0;
    const tracks = loopFetch((s, n) => rpc(['playlists', 'tracks', s, n, 'playlist_id:' + p.id, 'tags:adlcuKs'], ''), 'playlisttracks_loop');
    const build = () => swap(holder, lazyList({
      page: 500, empty: tr('This playlist is empty.'),
      fetch: async (s, n) => { const r = await tracks(s, n); count = r.total; return r; },
      render: (t, i) => {
        const it = { ...t, art: S.lms.cover(t.coverid, 120) };
        const edits = [
          { sep: true },
          i > 0 ? { label: tr('Move up'), icon: 'up', run: async () => { await act(['playlists', 'edit', 'cmd:move', 'playlist_id:' + p.id, 'index:' + i, 'toindex:' + (i - 1)], null, ''); build(); } } : null,
          i < count - 1 ? { label: tr('Move down'), icon: 'down', run: async () => { await act(['playlists', 'edit', 'cmd:move', 'playlist_id:' + p.id, 'index:' + i, 'toindex:' + (i + 1)], null, ''); build(); } } : null,
          { label: tr('Remove from playlist'), icon: 'delete', run: async () => { await act(['playlists', 'edit', 'cmd:delete', 'playlist_id:' + p.id, 'index:' + i], tr('Removed'), ''); build(); } },
        ];
        return trackRow(t, {
          onclick: tapTrack(it, () => act(['playlistcontrol', 'cmd:load', 'playlist_id:' + p.id, 'play_index:' + i], tr('Playing')), edits),
          menu: () => libMenu('track', it, edits),
        });
      },
    }));
    build();
    return {
      title: p.name, el: h('div', {}, heroButtons('playlist', p.id, 'pad'), holder),
      actions: [btn('more', tr('More'), () => sheet(p.name, playlistAdmin({ id: p.id, playlist: p.name }, () => back()).slice(1)))],
    };
  };
