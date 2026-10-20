  // -- Players -----------------------------------------------------------------
  function groupOf(id) {
    for (const g of S.syncgroups) { const m = String(g.sync_members || '').split(','); if (m.includes(id)) return m; }
    return null;
  }

  VIEWS.players = () => {
    const list = h('div', { class: 'players' });
    let gen = 0;
    async function render() {
      const my = ++gen;   // renders overlap (each button re-renders): only the newest is shown
      const rows = await Promise.all(S.players.map(async (p) => {
        let st = {};
        try { st = await S.lms.rpc(p.playerid, ['status', '-', 1, 'tags:al']); } catch (e) { /* offline */ }
        const t = (st.playlist_loop || [])[0] || {};
        const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.abs(+st['mixer volume'] || 0), class: 'vol', 'aria-label': tr('Volume of {name}', { name: p.name }) });
        vol.addEventListener('input', debounce(() => act(['mixer', 'volume', vol.value], null, p.playerid), 120));
        const g = groupOf(p.playerid);
        const on = +st.power === 1 || st.power === undefined;
        return h('div', { class: 'pcard' + (p.playerid === S.target ? ' sel' : '') },
          h('div', { class: 'pcard-head' },
            icon(isLocal(p.playerid) ? 'laptop' : 'speaker'),
            h('div', { class: 'meta' }, h('div', { class: 't1', text: isLocal(p.playerid) ? tr('{name} (this browser)', { name: p.name }) : p.name }),
              h('div', { class: 't2', text: [p.modelname || p.model, !+p.connected ? tr('disconnected') : (!on ? tr('off') : stateWord({ play: 'playing', pause: 'paused', stop: 'stopped' }[st.mode] || st.mode)), g ? tr('synced with {names}', { names: g.filter((x) => x !== p.playerid).map(playerName).join(', ') }) : ''].filter(Boolean).join(' · ') })),
            +p.canpoweroff ? btn('power', on ? tr('Switch off') : tr('Switch on'), () => act(['power', on ? 0 : 1], null, p.playerid).then(render), on ? 'on' : '') : null),
          t.title ? h('div', { class: 'pcard-now', text: [t.title, t.artist].filter(Boolean).join(' — ') }) : null,
          h('div', { class: 'pcard-ctrls' },
            btn(st.mode === 'play' ? 'pause' : 'play', tr('Play/pause'), () => act(st.mode === 'play' ? ['pause', 1] : ['play'], null, p.playerid).then(render)),
            vol,
            h('button', { class: 'btn ghost sm', onclick: () => { setTarget(p.playerid); render(); } }, p.playerid === S.target ? tr('Controlling') : tr('Control')),
            h('button', { class: 'btn ghost sm', onclick: () => syncMenu(p.playerid, render) }, icon('sync'), tr('Sync…')),
            isLocal(p.playerid) ? h('button', { class: 'btn ghost sm', onclick: () => renameLocal().then(render) }, icon('edit'), tr('Rename…')) : null));
      }));
      if (my !== gen) return;
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty', text: tr('No players are connected to the server.') })]));
    }
    return { title: tr('Players'), el: h('div', {}, h('p', { class: 'view-sub', text: tr('Every player LMS knows, including this browser. Sync players to play the same music in step.') }), list), onShow: () => { pollPlayers().then(render).catch(fail); }, actions: [btn('refresh', tr('Refresh'), () => pollPlayers().then(render))] };
  };

  function syncMenu(id, after) {
    const g = groupOf(id) || [];
    const others = S.players.filter((p) => p.playerid !== id);
    sheet(tr('Sync {name} with…', { name: playerName(id) }), [
      ...others.map((p) => ({ label: p.name, icon: isLocal(p.playerid) ? 'laptop' : 'speaker', checked: g.includes(p.playerid), run: async () => {
        if (g.includes(p.playerid)) await rpc(['sync', '-'], p.playerid);
        else await rpc(['sync', p.playerid], id);
        toast(g.includes(p.playerid) ? tr('Unsynced {name}', { name: p.name }) : tr('Synced {name}', { name: p.name })); await pollPlayers(); after && after();
      } })),
      g.length ? { sep: true } : null,
      g.length ? { label: tr('Leave the group'), icon: 'close', run: async () => { await rpc(['sync', '-'], id); toast(tr('Unsynced')); await pollPlayers(); after && after(); } } : null,
    ]);
  }

  function renderPlayerButton() {
    const b = document.getElementById('playerBtn');
    b.replaceChildren(icon(isLocal(S.target) ? 'laptop' : 'speaker'), h('span', { text: playerName(S.target) }), icon('down', 'caret'));
  }
  function playerPicker() {
    sheet(tr('Choose a player'), [
      ...S.players.map((p) => ({ label: isLocal(p.playerid) ? tr('{name} (this browser)', { name: p.name }) : p.name, icon: isLocal(p.playerid) ? 'laptop' : 'speaker', checked: p.playerid === S.target, run: () => setTarget(p.playerid) })),
      { sep: true },
      S.target ? { label: tr('Sync this player…'), icon: 'sync', run: () => syncMenu(S.target) } : null,
      S.target ? { label: tr('Transfer playback here from…'), icon: 'next_up', run: () => transferMenu() } : null,
      S.local ? { label: tr('Rename this browser…'), icon: 'edit', run: () => renameLocal() } : null,
      { label: tr('All players'), icon: 'speaker', run: () => root('players') },
    ]);
  }
  const TRANSFER_MAX = 2000;   // tracks moved at most (one request each)
  let transferring = false;
  function transferMenu() {
    const to = S.target;
    sheet(tr('Move playback to {name} from…', { name: playerName(to) }), S.players.filter((p) => p.playerid !== to).map((p) => ({
      label: p.name, icon: 'speaker', run: async () => {
        if (transferring) return toast(tr('Already moving playback…'));
        transferring = true;
        try {
          // Read the queue and position there first: nothing changes here unless there's something to move.
          const st = await S.lms.rpc(p.playerid, ['status', '-', 1]);
          const q = await S.lms.rpc(p.playerid, ['status', 0, TRANSFER_MAX, 'tags:u']);
          const loop = q.playlist_loop || [];
          const cur = +st.playlist_cur_index || 0;
          const urls = loop.map((t) => t.url).filter(Boolean);
          if (!urls.length) return toast(tr('Nothing to move: {name}\'s queue is empty', { name: p.name }));
          // The playing track's place among the tracks that can be moved.
          const index = loop.slice(0, cur).filter((t) => t.url).length;
          const cut = +q.playlist_tracks > TRANSFER_MAX;
          toast(cut ? trn(urls.length, 'Moving {n} track (the first {max})…', 'Moving {n} tracks (the first {max})…', { max: TRANSFER_MAX }) : trn(urls.length, 'Moving {n} track…', 'Moving {n} tracks…'));
          await S.lms.rpc(to, ['playlist', 'clear']);
          for (const u of urls) await S.lms.rpc(to, ['playlist', 'add', u]);
          await S.lms.rpc(to, ['playlist', 'index', Math.min(index, urls.length - 1)]);
          if (+st.time) await S.lms.rpc(to, ['time', st.time]);
          await S.lms.rpc(p.playerid, ['pause', 1]);   // only once the move is complete
          toast(tr('Moved playback to {name}', { name: playerName(to) })); pollSoon();
        } catch (e) {
          fail(new Error(tr('Moving playback stopped part-way ({name} carries on): {error}', { name: p.name, error: e.message })));
        } finally { transferring = false; }
      },
    })));
  }

  // -- Alarms ------------------------------------------------------------------
  /** A weekday's short name in the page's language: 0 Sunday … 6 Saturday, as LMS counts. */
  const dayName = (i) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2023, 0, 1 + i, 12));
  VIEWS.alarms = () => {
    const list = h('div', { class: 'list' });
    const master = h('input', { type: 'checkbox', class: 'switch', 'aria-label': tr('Alarms enabled') });
    master.addEventListener('change', () => act(['playerpref', 'alarmsEnabled', master.checked ? 1 : 0], master.checked ? tr('Alarms on') : tr('Alarms off')));
    async function load() {
      if (!S.target) return;
      try {
        const [r, en] = await Promise.all([rpc(['alarms', 0, 100, 'filter:all']), rpc(['playerpref', 'alarmsEnabled', '?'])]);
        master.checked = +en._p2 === 1;
        const al = r.alarms_loop || [];
        list.replaceChildren(...(al.length ? al.map((a) => {
          const sw = h('input', { type: 'checkbox', class: 'switch', checked: +a.enabled === 1, 'aria-label': tr('Enabled') });
          sw.addEventListener('change', () => act(['alarm', 'update', 'id:' + a.id, 'enabled:' + (sw.checked ? 1 : 0)]));
          const days = String(a.dow || '').split(',').filter((x) => x !== '').map((d) => dayName(+d)).join(' ');
          return h('div', { class: 'row' }, icon('alarm'),
            h('div', { class: 'meta' }, h('div', { class: 't1 big', text: fmtClock(+a.time) }), h('div', { class: 't2', text: [days || tr('Never'), +a.repeat ? tr('repeats') : tr('once'), tr('volume {volume}', { volume: a.volume })].join(' · ') })),
            sw, btn('delete', tr('Delete alarm'), async () => { if (await confirm2(tr('Delete this alarm?'))) { await act(['alarm', 'delete', 'id:' + a.id], tr('Alarm deleted')); load(); } }));
        }) : [h('div', { class: 'empty', text: tr('No alarms on {name}.', { name: playerName(S.target) }) })]));
      } catch (e) { fail(e); }
    }
    async function add() {
      const time = h('input', { type: 'time', class: 'field', value: '07:00', 'aria-label': tr('Time') });
      const boxes = [0, 1, 2, 3, 4, 5, 6].map((i) => h('label', { class: 'day' }, h('input', { type: 'checkbox', checked: i > 0 && i < 6, value: i }), dayName(i)));
      const vol = h('input', { type: 'range', min: 0, max: 100, value: 40, class: 'vol', 'aria-label': tr('Volume') });
      const form = h('form', { class: 'prompt', onsubmit: async (e) => {
        e.preventDefault();
        const [hh, mm] = time.value.split(':').map(Number);
        const dow = boxes.map((b) => b.firstChild).filter((c) => c.checked).map((c) => c.value).join(',');
        closeSheet();
        await act(['alarm', 'add', 'time:' + (hh * 3600 + mm * 60), 'dow:' + dow, 'enabled:1', 'repeat:1', 'volume:' + vol.value], tr('Alarm set'));
        load();
      } }, time, h('div', { class: 'days' }, boxes), h('label', { class: 'lbl' }, tr('Volume'), vol),
      h('p', { class: 't2', text: tr('The alarm plays the current queue (or LMS\'s default alarm sound).') }),
      h('div', { class: 'row-btns' }, h('button', { class: 'btn', type: 'submit' }, tr('Add alarm'))));
      sheet(tr('New alarm on {name}', { name: playerName(S.target) }), [{ el: form }]);
    }
    return { title: tr('Alarms'), el: h('div', {}, h('label', { class: 'setting' }, h('span', { text: tr('Alarms enabled on this player') }), master), list), onShow: load, perPlayer: true, actions: [btn('add', tr('Add alarm'), add)] };
  };
  const fmtClock = (secs) => `${String(Math.floor(secs / 3600)).padStart(2, '0')}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}`;
