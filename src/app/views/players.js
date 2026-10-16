  // -- Players -----------------------------------------------------------------
  function groupOf(id) {
    for (const g of S.syncgroups) { const m = String(g.sync_members || '').split(','); if (m.includes(id)) return m; }
    return null;
  }

  VIEWS.players = () => {
    const list = h('div', { class: 'players' });
    async function render() {
      const rows = await Promise.all(S.players.map(async (p) => {
        let st = {};
        try { st = await S.lms.rpc(p.playerid, ['status', '-', 1, 'tags:al']); } catch (e) { /* offline */ }
        const t = (st.playlist_loop || [])[0] || {};
        const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.abs(+st['mixer volume'] || 0), class: 'vol', 'aria-label': 'Volume of ' + p.name });
        vol.addEventListener('input', debounce(() => act(['mixer', 'volume', vol.value], null, p.playerid), 120));
        const g = groupOf(p.playerid);
        const on = +st.power === 1 || st.power === undefined;
        return h('div', { class: 'pcard' + (p.playerid === S.target ? ' sel' : '') },
          h('div', { class: 'pcard-head' },
            icon(isLocal(p.playerid) ? 'laptop' : 'speaker'),
            h('div', { class: 'meta' }, h('div', { class: 't1', text: p.name + (isLocal(p.playerid) ? ' (this browser)' : '') }),
              h('div', { class: 't2', text: [p.modelname || p.model, !+p.connected ? 'disconnected' : (!on ? 'off' : st.mode === 'play' ? 'playing' : st.mode), g ? 'synced with ' + g.filter((x) => x !== p.playerid).map(playerName).join(', ') : ''].filter(Boolean).join(' · ') })),
            +p.canpoweroff ? btn('power', on ? 'Switch off' : 'Switch on', () => act(['power', on ? 0 : 1], null, p.playerid).then(render), on ? 'on' : '') : null),
          t.title ? h('div', { class: 'pcard-now', text: [t.title, t.artist].filter(Boolean).join(' — ') }) : null,
          h('div', { class: 'pcard-ctrls' },
            btn(st.mode === 'play' ? 'pause' : 'play', 'Play/pause', () => act(st.mode === 'play' ? ['pause', 1] : ['play'], null, p.playerid).then(render)),
            vol,
            h('button', { class: 'btn ghost sm', onclick: () => { setTarget(p.playerid); render(); } }, p.playerid === S.target ? 'Controlling' : 'Control'),
            h('button', { class: 'btn ghost sm', onclick: () => syncMenu(p.playerid, render) }, icon('sync'), 'Sync…')));
      }));
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty', text: 'No players are connected to the server.' })]));
    }
    return { title: 'Players', el: h('div', {}, h('p', { class: 'view-sub', text: 'Every player LMS knows, including this browser. Sync players to play the same music in step.' }), list), onShow: () => { pollPlayers().then(render).catch(fail); }, actions: [btn('refresh', 'Refresh', () => pollPlayers().then(render))] };
  };

  function syncMenu(id, after) {
    const g = groupOf(id) || [];
    const others = S.players.filter((p) => p.playerid !== id);
    sheet('Sync ' + playerName(id) + ' with…', [
      ...others.map((p) => ({ label: p.name, icon: isLocal(p.playerid) ? 'laptop' : 'speaker', checked: g.includes(p.playerid), run: async () => {
        if (g.includes(p.playerid)) await rpc(['sync', '-'], p.playerid);
        else await rpc(['sync', p.playerid], id);
        toast(g.includes(p.playerid) ? 'Unsynced ' + p.name : 'Synced ' + p.name); await pollPlayers(); after && after();
      } })),
      g.length ? { sep: true } : null,
      g.length ? { label: 'Leave the group', icon: 'close', run: async () => { await rpc(['sync', '-'], id); toast('Unsynced'); await pollPlayers(); after && after(); } } : null,
    ]);
  }

  function renderPlayerButton() {
    const b = document.getElementById('playerBtn');
    b.replaceChildren(icon(isLocal(S.target) ? 'laptop' : 'speaker'), h('span', { text: playerName(S.target) }), icon('down', 'caret'));
  }
  function playerPicker() {
    sheet('Choose a player', [
      ...S.players.map((p) => ({ label: p.name + (isLocal(p.playerid) ? ' (this browser)' : ''), icon: isLocal(p.playerid) ? 'laptop' : 'speaker', checked: p.playerid === S.target, run: () => setTarget(p.playerid) })),
      { sep: true },
      S.target ? { label: 'Sync this player…', icon: 'sync', run: () => syncMenu(S.target) } : null,
      S.target ? { label: 'Transfer playback here from…', icon: 'next_up', run: () => transferMenu() } : null,
      { label: 'All players', icon: 'speaker', run: () => root('players') },
    ]);
  }
  function transferMenu() {
    const to = S.target;
    sheet('Move playback to ' + playerName(to) + ' from…', S.players.filter((p) => p.playerid !== to).map((p) => ({
      label: p.name, icon: 'speaker', run: async () => {
        // Read the queue and position there first: nothing changes here unless there's something to move.
        const st = await S.lms.rpc(p.playerid, ['status', '-', 1]);
        const q = await S.lms.rpc(p.playerid, ['status', 0, 2000, 'tags:u']);
        const urls = (q.playlist_loop || []).map((t) => t.url).filter(Boolean);
        if (!urls.length) return toast('Nothing to move: ' + p.name + '\'s queue is empty');
        toast(`Moving ${plural(urls.length, 'track')}…`);
        await S.lms.rpc(to, ['playlist', 'clear']);
        for (const u of urls) await S.lms.rpc(to, ['playlist', 'add', u]);
        await S.lms.rpc(to, ['playlist', 'index', +st.playlist_cur_index || 0]);
        if (+st.time) await S.lms.rpc(to, ['time', st.time]);
        await S.lms.rpc(p.playerid, ['pause', 1]);
        toast('Moved playback to ' + playerName(to)); pollSoon();
      },
    })));
  }

  // -- Alarms ------------------------------------------------------------------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  VIEWS.alarms = () => {
    const list = h('div', { class: 'list' });
    const master = h('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Alarms enabled' });
    master.addEventListener('change', () => act(['playerpref', 'alarmsEnabled', master.checked ? 1 : 0], master.checked ? 'Alarms on' : 'Alarms off'));
    async function load() {
      if (!S.target) return;
      try {
        const [r, en] = await Promise.all([rpc(['alarms', 0, 100, 'filter:all']), rpc(['playerpref', 'alarmsEnabled', '?'])]);
        master.checked = +en._p2 === 1;
        const al = r.alarms_loop || [];
        list.replaceChildren(...(al.length ? al.map((a) => {
          const sw = h('input', { type: 'checkbox', class: 'switch', checked: +a.enabled === 1, 'aria-label': 'Enabled' });
          sw.addEventListener('change', () => act(['alarm', 'update', 'id:' + a.id, 'enabled:' + (sw.checked ? 1 : 0)]));
          const days = String(a.dow || '').split(',').filter((x) => x !== '').map((d) => DAYS[+d]).join(' ');
          return h('div', { class: 'row' }, icon('alarm'),
            h('div', { class: 'meta' }, h('div', { class: 't1 big', text: fmtClock(+a.time) }), h('div', { class: 't2', text: [days || 'Never', +a.repeat ? 'repeats' : 'once', 'volume ' + a.volume].join(' · ') })),
            sw, btn('delete', 'Delete alarm', async () => { if (await confirm2('Delete this alarm?')) { await act(['alarm', 'delete', 'id:' + a.id], 'Alarm deleted'); load(); } }));
        }) : [h('div', { class: 'empty', text: 'No alarms on ' + playerName(S.target) + '.' })]));
      } catch (e) { fail(e); }
    }
    async function add() {
      const time = h('input', { type: 'time', class: 'field', value: '07:00', 'aria-label': 'Time' });
      const boxes = DAYS.map((d, i) => h('label', { class: 'day' }, h('input', { type: 'checkbox', checked: i > 0 && i < 6, value: i }), d));
      const vol = h('input', { type: 'range', min: 0, max: 100, value: 40, class: 'vol', 'aria-label': 'Volume' });
      const form = h('form', { class: 'prompt', onsubmit: async (e) => {
        e.preventDefault();
        const [hh, mm] = time.value.split(':').map(Number);
        const dow = boxes.map((b) => b.firstChild).filter((c) => c.checked).map((c) => c.value).join(',');
        closeSheet();
        await act(['alarm', 'add', 'time:' + (hh * 3600 + mm * 60), 'dow:' + dow, 'enabled:1', 'repeat:1', 'volume:' + vol.value], 'Alarm set');
        load();
      } }, time, h('div', { class: 'days' }, boxes), h('label', { class: 'lbl' }, 'Volume', vol),
      h('p', { class: 't2', text: 'The alarm plays the current queue (or LMS\'s default alarm sound).' }),
      h('div', { class: 'row-btns' }, h('button', { class: 'btn', type: 'submit' }, 'Add alarm')));
      sheet('New alarm on ' + playerName(S.target), [{ el: form }]);
    }
    return { title: 'Alarms', el: h('div', {}, h('label', { class: 'setting' }, h('span', { text: 'Alarms enabled on this player' }), master), list), onShow: load, perPlayer: true, actions: [btn('add', 'Add alarm', add)] };
  };
  const fmtClock = (secs) => `${String(Math.floor(secs / 3600)).padStart(2, '0')}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}`;
