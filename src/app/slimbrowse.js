  // -- Favourites, radio, apps (LMS's XMLBrowser menus) ------------------------
  function xmlArt(it) { return S.lms.art(it.image || it.icon || it.cover, 120); }

  function xmlMenu(cmd, it, extra = []) {
    const items = [];
    if (+it.isaudio) {
      items.push({ label: 'Play now', icon: 'play', run: () => act([cmd, 'playlist', 'play', 'item_id:' + it.id], 'Playing') });
      items.push({ label: 'Play next', icon: 'next_up', run: () => act([cmd, 'playlist', 'insert', 'item_id:' + it.id], 'Playing next') });
      items.push({ label: 'Add to queue', icon: 'add', run: () => act([cmd, 'playlist', 'add', 'item_id:' + it.id], 'Added to the queue') });
    }
    if (cmd !== 'favorites' && it.url && +it.isaudio) items.push({ label: 'Add to favourites', icon: 'fav', run: () => act(['favorites', 'add', 'url:' + it.url, 'title:' + it.name, ...(it.image ? ['icon:' + it.image] : [])], 'Added to favourites', '') });
    sheet(it.name, items.concat(extra), { art: xmlArt(it) });
  }

  // -- LMS menus (SlimBrowse) --------------------------------------------------
  // LMS describes its menus, and everything plugins add to them, in the format its own
  // controllers use. Rendering that format means AudioMuse-AI, Custom Browse, context menus
  // and any future plugin appear here without special code.
  const STANDARD_MYMUSIC = /^(myMusicArtists|myMusicAlbums|myMusicGenres|myMusicYears|myMusicNewMusic|myMusicMusicFolder|myMusicPlaylists|myMusicSearch|randomplay$|pluginLyrionJS$)/;

  async function loadPluginMenus() {
    const player = S.target || S.localId;
    if (!player) return;
    try {
      const r = await S.lms.rpc(player, ['menu', 0, 1000, 'direct:1']);
      S.pluginMenus = (r.item_loop || [])
        .filter((i) => (i.node === 'myMusic' || i.node === 'extras') && i.id && !STANDARD_MYMUSIC.test(i.id) && i.actions && i.actions.go)
        .sort((a, b) => (+a.weight || 0) - (+b.weight || 0) || String(a.text).localeCompare(String(b.text)));
      renderNav();
    } catch (e) { /* the menu is optional */ }
  }

  /** The LMS context menu for a library item, as a SlimBrowse action. */
  function contextMenu(kind, it) {
    if (kind === 'track') {
      if (it.id && +it.id > 0 && !it.remote) return { cmd: ['trackinfo', 'items'], params: { track_id: it.id, menu: 1 } };
      if (it.url) return { cmd: ['trackinfo', 'items'], params: { url: it.url, menu: 1 } };
      return null;
    }
    const map = { album: ['albuminfo', 'album_id'], artist: ['artistinfo', 'artist_id'], genre: ['genreinfo', 'genre_id'], year: ['yearinfo', 'year'] };
    const m = map[kind];
    return m && it.id != null ? { cmd: [m[0], 'items'], params: { [m[1]]: it.id, menu: 1 } } : null;
  }

  function jiveArt(item, size) {
    const id = item['icon-id'];
    if (id != null && /^-?[0-9a-f]+$/i.test(String(id))) return S.lms.cover(id, size);
    const src = item.image || item.icon || (id != null ? String(id) : '');
    return src ? S.lms.art(src, size) : null;
  }

  /** An item's action: its own, or the window's base action with the item's parameters. */
  function jiveAction(item, base, name) {
    if (item.actions && Object.prototype.hasOwnProperty.call(item.actions, name)) {
      const a = item.actions[name];
      if (!a) return null;
      if (a.itemsParams && item[a.itemsParams]) return Object.assign({}, a, { params: Object.assign({}, a.params, item[a.itemsParams]) });
      return a;
    }
    const b = base && base.actions && base.actions[name];
    if (!b) return null;
    return Object.assign({}, b, { params: Object.assign({}, b.params, (b.itemsParams && item[b.itemsParams]) || {}) });
  }

  function jiveArgs(a, input) {
    const sub = (v) => (input != null && typeof v === 'string' ? v.replace('__TAGGEDINPUT__', input).replace('__INPUT__', input) : v);
    const cmd = (a.cmd || []).map(sub);
    const params = [];
    for (const [k, v] of Object.entries(a.params || {})) if (v != null && v !== '') params.push(k + ':' + sub(v));
    return { cmd, params };
  }

  async function jiveFetch(a, start, count, input) {
    const { cmd, params } = jiveArgs(a, input);
    if (!(a.params && 'menu' in a.params)) params.push('menu:1');
    return S.lms.rpc(S.target || S.localId || '', [...cmd, start, count, ...params]);
  }

  async function jiveDo(a, input) {
    const { cmd, params } = jiveArgs(a, input);
    return S.lms.rpc(S.target || S.localId || '', [...cmd, ...params]);
  }

  function jiveNext(where, ctx) {
    pollSoon(150);
    if (where === 'parent') back();
    else if (where === 'grandparent') back(2);
    else if (where === 'home' || where === 'nowPlaying') root('now');
    else if ((where === 'refresh' || where === 'refreshOrigin') && ctx && ctx.reload) ctx.reload();
  }

  /** Only web addresses: a menu's link is never run as script or opened as a local file. */
  function safeLink(u) {
    try { const url = new URL(u, location.href); return /^https?:$/.test(url.protocol) ? url.href : null; } catch (e) { return null; }
  }

  const COMMAND_ACTIONS = ['play', 'add', 'add-hold', 'do', 'on', 'off'];

  /** The action a tap on the item means, as LMS's own controllers decide it. */
  function defaultAction(item, base) {
    if (item.goAction) return item.goAction;
    if (/item_?play/.test(item.style || '') && jiveAction(item, base, 'play')) return 'play';
    if (jiveAction(item, base, 'go')) return 'go';
    if (jiveAction(item, base, 'do')) return 'do';
    return null;
  }

  async function jiveActivate(item, base, name, ctx, actionOverride) {
    try {
      if (item.weblink && !name) { const u = safeLink(item.weblink); if (u) window.open(u, '_blank', 'noopener'); return; }
      const which = name || defaultAction(item, base);
      if (!which) return;
      const a = actionOverride || jiveAction(item, base, which);
      if (!a || !a.cmd) return;
      let input = null;
      if (item.input || item.type === 'entry' || item.type === 'search' || JSON.stringify(a).includes('__TAGGEDINPUT__')) {
        input = await prompt2(firstLine(item.text) || 'Search', { placeholder: (item.input && item.input.help && item.input.help.text) || '', ok: 'OK' });
        if (!input) return;
      }
      const title = firstLine(item.text);
      const next = a.nextWindow || item.nextWindow;
      const isCommand = !!next || COMMAND_ACTIONS.includes(which) || a.cmd[0] === 'playlistcontrol' || item.type === 'slideshow';
      if (!isCommand) { push('jive', { action: a, title, input }); return; }
      const r = await jiveDo(a, input);
      // A command that answered with a menu: show that answer (running it again could repeat it).
      if (r && r.item_loop && !next) { push('jive', { action: a, title, input, first: r }); return; }
      if (which === 'play') toast('Playing'); else if (which === 'add') toast('Added to the queue'); else if (which === 'add-hold') toast('Playing next');
      // A setting changed in place: show its new state.
      if (!next && (which === 'on' || which === 'off' || item.radio != null || item.choiceStrings)) { if (ctx.reload) ctx.reload(); pollSoon(150); return; }
      jiveNext(next, ctx);
    } catch (e) { fail(e); }
  }

  const firstLine = (t) => String(t == null ? '' : t).split('\n')[0];

  function jiveRow(item, getBase, ctx) {
    const base = getBase();
    const lines = String(item.text == null ? '' : item.text).split('\n');
    const has = (n) => !!jiveAction(item, base, n);
    // Settings-style items: a switch, a choice, or one of a set.
    if (item.checkbox != null) {
      const sw = h('input', { type: 'checkbox', class: 'switch', checked: +item.checkbox === 1, 'aria-label': lines[0] });
      sw.addEventListener('change', () => jiveActivate(item, base, sw.checked ? 'on' : 'off', ctx));
      return h('label', { class: 'setting' }, h('span', { text: lines[0] }), sw);
    }
    const choices = item.actions && item.actions.do && item.actions.do.choices;
    if (Array.isArray(item.choiceStrings) && Array.isArray(choices)) {
      const sel = h('select', { class: 'select', 'aria-label': lines[0] },
        item.choiceStrings.map((t, i) => h('option', { value: i, text: t, selected: i === (+item.selectedIndex || 1) - 1 })));
      sel.addEventListener('change', () => jiveActivate(item, base, 'do', ctx, choices[+sel.value]));
      return h('label', { class: 'setting' }, h('span', { text: lines[0] }), sel);
    }
    const playable = has('play') || has('add');
    const clickable = !!item.weblink || !!defaultAction(item, base);
    if (!clickable && !playable) return h('div', { class: 'xml-text', text: lines.join('\n') });
    const art = jiveArt(item, 96);
    const menu = playable || has('more') ? () => sheet(lines[0], [
      has('play') ? { label: 'Play now', icon: 'play', run: () => jiveActivate(item, base, 'play', ctx) } : null,
      has('add-hold') ? { label: 'Play next', icon: 'next_up', run: () => jiveActivate(item, base, 'add-hold', ctx) } : null,
      has('add') ? { label: 'Add to queue', icon: 'add', run: () => jiveActivate(item, base, 'add', ctx) } : null,
      has('more') ? { label: 'More…', icon: 'more', run: () => push('jive', { action: jiveAction(item, base, 'more'), title: lines[0] }) } : null,
    ], { art: art || undefined, sub: lines[1] }) : null;
    return row({
      art: item.radio != null ? undefined : (art || (ctx.textOnly ? undefined : null)), artIcon: playable ? 'note' : 'folder',
      title: (item.radio != null ? (+item.radio === 1 ? '● ' : '○ ') : '') + lines[0], sub: lines.slice(1).join(' · ') || null,
      onclick: () => jiveActivate(item, base, null, ctx), menu,
    });
  }

  /** p: { action, title?, input?, first? (the first page, already fetched), navId? } */
  VIEWS.jive = (p) => {
    const holder = h('div');
    let base = null, first = p.first || null;
    const page = { title: p.title || '', el: holder, perPlayer: true };
    const ctx = { textOnly: false };
    const build = () => swap(holder, lazyList({
      page: 100, empty: 'Nothing here.',
      fetch: async (s, n) => {
        let r;
        if (s === 0 && first) { r = first; first = null; } else r = await jiveFetch(p.action, s, n, p.input);
        if (r.base) base = r.base;
        if (s === 0) {
          ctx.textOnly = !!(r.window && /text/.test(r.window.menustyle || r.window.windowStyle || ''));
          const t = (r.window && r.window.text) || r.title;
          if (t && !p.title) setTitle(page, t);
        }
        const items = r.item_loop || [];
        return { items, total: +r.count || 0, consumed: items.length };
      },
      render: (it) => jiveRow(it, () => base, ctx),
    }));
    ctx.reload = build;
    build();
    return page;
  };

  VIEWS.xml = (p) => {
    const holder = h('div');
    const page = { title: p.title || '', el: holder, perPlayer: true };
    const items = loopFetch((s, n) => rpc([p.cmd, 'items', s, n, 'want_url:1', ...(p.item ? ['item_id:' + p.item] : []), ...(p.search ? ['search:' + p.search] : [])]), 'loop_loop');
    const build = () => swap(holder, lazyList({
      page: 200, empty: 'Nothing here.',
      fetch: items,
      render: (it) => {
        const name = it.name || it.title || '';
        if (it.type === 'text' || it.type === 'textarea' || (!+it.hasitems && !+it.isaudio && it.type !== 'search' && it.type !== 'link')) {
          return h('div', { class: 'xml-text', text: name });
        }
        const isSearch = it.type === 'search';
        const go = async () => {
          if (isSearch) {
            const q = await prompt2(name || 'Search', { placeholder: 'Search', ok: 'Search' });
            if (q) push('xml', { cmd: p.cmd, item: it.id, search: q, title: `${name}: ${q}` });
          } else if (+it.hasitems || it.type === 'link') push('xml', { cmd: p.cmd, item: it.id, title: name, fav: p.fav });
          else if (+it.isaudio) act([p.cmd, 'playlist', 'play', 'item_id:' + it.id], 'Playing');
        };
        const extra = p.fav ? [{ sep: true },
          { label: 'Rename…', icon: 'edit', run: async () => { const n = await prompt2('Rename favourite', { value: name, ok: 'Rename' }); if (n) { await act(['favorites', 'rename', 'item_id:' + it.id, 'title:' + n], 'Renamed', ''); build(); } } },
          { label: 'Remove from favourites', icon: 'delete', danger: true, run: async () => { if (await confirm2(`Remove “${name}” from favourites?`, 'Remove')) { await act(['favorites', 'delete', 'item_id:' + it.id], 'Removed', ''); build(); } } }] : [];
        return row({
          art: xmlArt(it), artIcon: isSearch ? 'search' : (+it.hasitems ? 'folder' : 'note'), title: name, sub: it.line2 || it.subtitle || null,
          onclick: go, menu: (+it.isaudio || p.fav) ? () => xmlMenu(p.cmd, it, extra) : null,
        });
      },
    }));
    build();
    return page;
  };

  VIEWS.favourites = () => VIEWS.xml({ cmd: 'favorites', title: 'Favourites', fav: true });

  function serviceList(kind) {
    return lazyList({
      page: 100, empty: kind === 'radios' ? 'No radio services are installed on the server.' : 'No apps are installed on the server.',
      fetch: loopFetch((s, n) => rpc([kind, s, n], ''), kind + 's_loop', (x) => x.cmd),
      render: (a) => row({ art: S.lms.art(a.icon, 96), artIcon: kind === 'radios' ? 'radio' : 'apps', title: a.name, onclick: () => push('xml', { cmd: a.cmd, title: a.name }) }),
    });
  }
  VIEWS.radio = () => ({ title: 'Radio', el: serviceList('radios') });
  VIEWS.apps = () => ({ title: 'Apps', el: serviceList('apps') });

  VIEWS.random = () => {
    const kinds = [['tracks', 'Songs', 'note'], ['albums', 'Albums', 'album'], ['contributors', 'Artists', 'artist'], ['year', 'Years', 'year']];
    const el = h('div', { class: 'tiles' }, kinds.map(([k, t, i]) => h('button', { class: 'tile', onclick: () => act(['randomplay', k], `Random ${t.toLowerCase()} mix started`) }, icon(i), h('span', { text: t }))),
      h('button', { class: 'tile ghost', onclick: () => act(['randomplay', 'disable'], 'Random mix stopped') }, icon('stop'), h('span', { text: 'Stop mix' })));
    return { title: 'Random mix', el: h('div', {}, h('p', { class: 'view-sub', text: 'LMS keeps the queue topped up with random picks from your library.' }), el) };
  };
