  // -- Playlists ---------------------------------------------------------------
  VIEWS.playlists = () => {
    const holder = h('div');
    const build = () => swap(holder, lazyList({
      page: 200, empty: 'No saved playlists.',
      fetch: loopFetch((s, n) => rpc(['playlists', s, n, 'tags:u'], ''), 'playlists_loop'),
      render: (pl) => row({
        art: null, artIcon: 'playlist', title: pl.playlist, onclick: () => push('playlist', { id: pl.id, name: pl.playlist }),
        menu: () => libMenu('playlist', { ...pl, title: pl.playlist, favorites_url: pl.url }, playlistAdmin(pl, build)),
      }),
    }));
    build();
    return { title: 'Playlists', el: holder, actions: [btn('save', 'Save queue as playlist', async () => { const n = await prompt2('Save queue as playlist', { placeholder: 'Playlist name', ok: 'Save' }); if (n) { await act(['playlist', 'save', n], 'Saved as ' + n); setTimeout(build, 800); } })] };
  };
  function playlistAdmin(pl, after) {
    return [
      { sep: true },
      { label: 'Rename…', icon: 'edit', run: async () => { const n = await prompt2('Rename playlist', { value: pl.playlist, ok: 'Rename' }); if (n) { await act(['playlists', 'rename', 'playlist_id:' + pl.id, 'newname:' + n], 'Renamed', ''); after && after(); } } },
      { label: 'Delete playlist', icon: 'delete', danger: true, run: async () => { if (await confirm2(`Delete “${pl.playlist}”?`)) { await act(['playlists', 'delete', 'playlist_id:' + pl.id], 'Deleted', ''); after && after(); } } },
    ];
  }
  VIEWS.playlist = (p) => {
    const holder = h('div');
    let count = 0;
    const tracks = loopFetch((s, n) => rpc(['playlists', 'tracks', s, n, 'playlist_id:' + p.id, 'tags:adlcuKs'], ''), 'playlisttracks_loop');
    const build = () => swap(holder, lazyList({
      page: 500, empty: 'This playlist is empty.',
      fetch: async (s, n) => { const r = await tracks(s, n); count = r.total; return r; },
      render: (t, i) => trackRow(t, {
        onclick: () => act(['playlistcontrol', 'cmd:load', 'playlist_id:' + p.id, 'play_index:' + i], 'Playing'),
        menu: () => libMenu('track', { ...t, art: S.lms.cover(t.coverid, 120) }, [
          { sep: true },
          i > 0 ? { label: 'Move up', icon: 'up', run: async () => { await act(['playlists', 'edit', 'cmd:move', 'playlist_id:' + p.id, 'index:' + i, 'toindex:' + (i - 1)], null, ''); build(); } } : null,
          i < count - 1 ? { label: 'Move down', icon: 'down', run: async () => { await act(['playlists', 'edit', 'cmd:move', 'playlist_id:' + p.id, 'index:' + i, 'toindex:' + (i + 1)], null, ''); build(); } } : null,
          { label: 'Remove from playlist', icon: 'delete', run: async () => { await act(['playlists', 'edit', 'cmd:delete', 'playlist_id:' + p.id, 'index:' + i], 'Removed', ''); build(); } },
        ]),
      }),
    }));
    build();
    return {
      title: p.name, el: h('div', {}, heroButtons('playlist', p.id, 'pad'), holder),
      actions: [btn('more', 'More', () => sheet(p.name, playlistAdmin({ id: p.id, playlist: p.name }, () => back()).slice(1)))],
    };
  };
