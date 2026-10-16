  // -- Queue -------------------------------------------------------------------
  VIEWS.queue = () => {
    const list = h('div', { class: 'list queue' });
    const info = h('div', { class: 'view-sub' });
    let dragFrom = null, gen = 0;
    const SHOWN = 1000;
    async function load() {
      if (!S.target) { list.replaceChildren(h('div', { class: 'empty', text: 'No player selected.' })); return; }
      const my = ++gen;
      try {
        const r = await rpc(['status', 0, SHOWN, 'tags:aAlcdeKNsjJtux']);
        if (my !== gen) return;   // a newer load has started
        const cur = +r.playlist_cur_index;
        const items = r.playlist_loop || [];
        const count = +r.playlist_tracks || items.length;
        let total = 0; for (const t of items) total += +t.duration || 0;
        info.textContent = items.length ? `${plural(count, 'track')}${count > items.length ? ` (the first ${items.length} shown)` : ` · ${fmtTime(total)}`} · ${playerName(S.target)}` : '';
        list.replaceChildren(...(items.length ? items.map((t) => {
          const i = +t['playlist index'];
          const el = trackRow(t, {
            cls: i === cur ? 'current' : '', draggable: true,
            onclick: () => act(['playlist', 'index', i]),
            menu: () => sheet(t.title, [
              { label: 'Play now', icon: 'play', run: () => act(['playlist', 'index', i]) },
              i !== cur ? { label: 'Play next', icon: 'next_up', run: () => act(['playlist', 'move', i, i < cur ? cur : cur + 1], 'Moved') } : null,
              i > 0 ? { label: 'Move up', icon: 'up', run: () => act(['playlist', 'move', i, i - 1]) } : null,
              i < count - 1 ? { label: 'Move down', icon: 'down', run: () => act(['playlist', 'move', i, i + 1]) } : null,
              { label: 'Remove from queue', icon: 'delete', run: () => act(['playlist', 'delete', i], 'Removed') },
              t.artist_id ? { label: 'Go to artist', icon: 'artist', run: () => push('artist', { id: t.artist_id, name: t.artist }) } : null,
              t.album_id ? { label: 'Go to album', icon: 'album', run: () => push('album', { id: t.album_id, title: t.album, artist: t.artist }) } : null,
              { label: 'More…', icon: 'more', run: () => push('jive', { action: { cmd: ['trackinfo', 'items'], params: { playlist_index: i, menu: 1 } }, title: t.title }) },
              t.url && !+t.remote ? { label: 'Add to playlist…', icon: 'playlist', run: () => addToPlaylist([t.url]) } : null,
            ], { sub: t.artist }),
          });
          el.addEventListener('dragstart', (e) => { dragFrom = i; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
          el.addEventListener('dragend', () => el.classList.remove('dragging'));
          el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
          el.addEventListener('dragleave', () => el.classList.remove('over'));
          el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (dragFrom != null && dragFrom !== i) act(['playlist', 'move', dragFrom, i]); dragFrom = null; });
          return el;
        }) : [h('div', { class: 'empty', text: 'The queue is empty.' })]));
        const curEl = list.querySelector('.current');
        if (curEl && !list.dataset.scrolled) { list.dataset.scrolled = '1'; curEl.scrollIntoView({ block: 'center' }); }
      } catch (e) { fail(e); }
    }
    const actions = [
      btn('shuffle', 'Shuffle', () => cycleShuffle()), btn('repeat', 'Repeat', () => cycleRepeat()),
      btn('save', 'Save as playlist', async () => { const n = await prompt2('Save queue as playlist', { placeholder: 'Playlist name', ok: 'Save' }); if (n) act(['playlist', 'save', n], 'Saved as ' + n); }),
      btn('delete', 'Clear queue', async () => { if (await confirm2('Clear the queue?', 'Clear')) act(['playlist', 'clear'], 'Queue cleared'); }),
    ];
    return { title: 'Queue', el: h('div', {}, info, list), actions, perPlayer: true,
      onShow: () => { playlistListeners.add(load); load(); }, onHide: () => playlistListeners.delete(load) };
  };
