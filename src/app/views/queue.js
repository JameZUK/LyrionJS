  // -- Queue -------------------------------------------------------------------
  VIEWS.queue = () => {
    const list = h('div', { class: 'list queue' });
    const info = h('div', { class: 'view-sub' });
    let dragFrom = null, gen = 0;
    const SHOWN = 1000;
    async function load() {
      if (!S.target) { list.replaceChildren(h('div', { class: 'empty', text: tr('No player selected.') })); return; }
      const my = ++gen;
      try {
        const r = await rpc(['status', 0, SHOWN, 'tags:aAlcdeKNsjJtux']);
        if (my !== gen) return;   // a newer load has started
        const cur = +r.playlist_cur_index;
        const items = r.playlist_loop || [];
        const count = +r.playlist_tracks || items.length;
        let total = 0; for (const t of items) total += +t.duration || 0;
        info.textContent = items.length ? [trn(count, '{n} track', '{n} tracks') + (count > items.length ? ' ' + tr('(the first {shown} shown)', { shown: items.length }) : ''), count > items.length ? null : fmtTime(total), playerName(S.target)].filter(Boolean).join(' · ') : '';
        list.replaceChildren(...(items.length ? items.map((t) => {
          const i = +t['playlist index'];
          const el = trackRow(t, {
            cls: i === cur ? 'current' : '', draggable: true,
            onclick: () => act(['playlist', 'index', i]),
            menu: () => sheet(t.title, [
              { label: tr('Play now'), icon: 'play', run: () => act(['playlist', 'index', i]) },
              i !== cur ? { label: tr('Play next'), icon: 'next_up', run: () => act(['playlist', 'move', i, i < cur ? cur : cur + 1], tr('Moved')) } : null,
              i > 0 ? { label: tr('Move up'), icon: 'up', run: () => act(['playlist', 'move', i, i - 1]) } : null,
              i < count - 1 ? { label: tr('Move down'), icon: 'down', run: () => act(['playlist', 'move', i, i + 1]) } : null,
              { label: tr('Remove from queue'), icon: 'delete', run: () => act(['playlist', 'delete', i], tr('Removed')) },
              t.artist_id ? { label: tr('Go to artist'), icon: 'artist', run: () => push('artist', { id: t.artist_id, name: t.artist }) } : null,
              t.album_id ? { label: tr('Go to album'), icon: 'album', run: () => push('album', { id: t.album_id, title: t.album, artist: t.artist }) } : null,
              { label: tr('More…'), icon: 'more', run: () => push('jive', { action: { cmd: ['trackinfo', 'items'], params: { playlist_index: i, menu: 1 } }, title: t.title }) },
              t.url && !+t.remote ? { label: tr('Add to playlist…'), icon: 'playlist', run: () => addToPlaylist([t.url]) } : null,
            ], { sub: t.artist }),
          });
          el.addEventListener('dragstart', (e) => { dragFrom = i; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
          el.addEventListener('dragend', () => el.classList.remove('dragging'));
          el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
          el.addEventListener('dragleave', () => el.classList.remove('over'));
          el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (dragFrom != null && dragFrom !== i) act(['playlist', 'move', dragFrom, i]); dragFrom = null; });
          return el;
        }) : [h('div', { class: 'empty', text: tr('The queue is empty.') })]));
        const curEl = list.querySelector('.current');
        if (curEl && !list.dataset.scrolled) { list.dataset.scrolled = '1'; curEl.scrollIntoView({ block: 'center' }); }
      } catch (e) { fail(e); }
    }
    const actions = [
      btn('shuffle', tr('Shuffle'), () => cycleShuffle()), btn('repeat', tr('Repeat'), () => cycleRepeat()),
      btn('save', tr('Save as playlist'), async () => { const n = await prompt2(tr('Save queue as playlist'), { placeholder: tr('Playlist name'), ok: tr('Save') }); if (n) act(['playlist', 'save', n], tr('Saved as {name}', { name: n })); }),
      btn('delete', tr('Clear queue'), async () => { if (await confirm2(tr('Clear the queue?'), tr('Clear'))) act(['playlist', 'clear'], tr('Queue cleared')); }),
    ];
    return { title: tr('Queue'), el: h('div', {}, info, list), actions, perPlayer: true,
      onShow: () => { playlistListeners.add(load); load(); }, onHide: () => playlistListeners.delete(load) };
  };
