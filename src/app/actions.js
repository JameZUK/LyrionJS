  // ---------------------------------------------------------------------------
  // Actions on library items
  // ---------------------------------------------------------------------------
  const QUAL = { artist: 'artist_id', album: 'album_id', track: 'track_id', genre: 'genre_id', playlist: 'playlist_id', folder: 'folder_id', year: 'year' };

  function pc(cmd, kind, id, extra = []) {
    const q = `${QUAL[kind]}:${id}`;
    const msgs = { load: tr('Playing'), insert: tr('Playing next'), add: tr('Added to the queue') };
    return act(['playlistcontrol', 'cmd:' + cmd, q, ...extra], msgs[cmd]);
  }
  async function playShuffled(kind, id) {
    try { await rpc(['playlist', 'shuffle', 1]); await rpc(['playlistcontrol', 'cmd:load', `${QUAL[kind]}:${id}`]); toast(tr('Playing shuffled')); pollSoon(); }
    catch (e) { fail(e); }
  }

  function libMenu(kind, it, extra = []) {
    const name = it.title || it.album || it.artist || it.playlist || it.genre || it.year || it.filename || '';
    const items = [
      { label: tr('Play now'), icon: 'play', run: () => pc('load', kind, it.id) },
      { label: tr('Play next'), icon: 'next_up', run: () => pc('insert', kind, it.id) },
      { label: tr('Add to queue'), icon: 'add', run: () => pc('add', kind, it.id) },
    ];
    if (kind !== 'track') items.push({ label: tr('Shuffle'), icon: 'shuffle', run: () => playShuffled(kind, it.id) });
    if (kind === 'track' || kind === 'album') {
      if (it.artist_id) items.push({ label: tr('Go to artist'), icon: 'artist', run: () => push('artist', { id: it.artist_id, name: it.artist }) });
      if (kind === 'track' && it.album_id) items.push({ label: tr('Go to album'), icon: 'album', run: () => push('album', { id: it.album_id, title: it.album, artist: it.artist, artist_id: it.artist_id }) });
    }
    if (kind === 'track' && it.url) items.push({ label: tr('Add to playlist…'), icon: 'playlist', run: () => addToPlaylist([it.url]) });
    if (it.favorites_url || (kind === 'track' && it.url)) items.push({ label: tr('Add to favourites'), icon: 'fav', run: () => act(['favorites', 'add', 'url:' + (it.favorites_url || it.url), 'title:' + (it.favorites_title || name)], tr('Added to favourites'), '') });
    const info = contextMenu(kind, it);
    if (info) items.push({ label: tr('More…'), icon: 'more', run: () => push('jive', { action: info, title: name }) });
    sheet(name, items.concat(extra), { sub: it.artist && kind !== 'artist' ? it.artist : (kind === 'track' && it.album ? it.album : null), art: it.art });
  }

  async function addToPlaylist(urls) {
    try {
      const r = await rpc(['playlists', 0, 500], '');
      const lists = r.playlists_loop || [];
      sheet(tr('Add to playlist'), [
        { label: tr('New playlist…'), icon: 'add', run: async () => {
          const name = await prompt2(tr('New playlist'), { placeholder: tr('Name'), ok: tr('Create') });
          if (!name) return;
          const nr = await rpc(['playlists', 'new', 'name:' + name], '');
          // LMS doesn't create a second playlist with a name in use: it names the existing one.
          if (!nr.playlist_id && nr.overwritten_playlist_id && !(await confirm2(tr('“{name}” already exists. Add to it?', { name }), tr('Add to it')))) return;
          const id = nr.playlist_id || nr.overwritten_playlist_id;
          for (const u of urls) await rpc(['playlists', 'edit', 'cmd:add', 'playlist_id:' + id, 'url:' + u], '');
          toast(tr('Added to {name}', { name }));
        } },
        { sep: true },
        ...lists.map((p) => ({ label: p.playlist, icon: 'playlist', run: async () => {
          for (const u of urls) await rpc(['playlists', 'edit', 'cmd:add', 'playlist_id:' + p.id, 'url:' + u], '');
          toast(tr('Added to {name}', { name: p.playlist }));
        } })),
      ]);
    } catch (e) { fail(e); }
  }
