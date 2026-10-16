  // ---------------------------------------------------------------------------
  // Common UI pieces: artwork, the sheet (menus and dialogs), lazily loaded lists, rows, cards
  // ---------------------------------------------------------------------------
  function artEl(src, fallback = 'note', cls = '') {
    const box = h('div', { class: 'art ' + cls }, icon(fallback, 'ph'));
    if (src) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', src });
      img.onload = () => box.classList.add('loaded');
      img.onerror = () => img.remove();
      box.append(img);
    }
    return box;
  }

  // -- the sheet --------------------------------------------------------------
  let sheetClosed = null;   // what the open sheet does when dismissed without a choice
  let sheetFocus = null;    // what had the focus before it opened

  function sheet(title, items, opts = {}) {
    closeSheet();
    const wrap = document.getElementById('sheet');
    const list = h('div', { class: 'sheet-list' });
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { list.append(h('div', { class: 'sheet-sep' })); continue; }
      if (it.el) { list.append(it.el); continue; }
      list.append(h('button', { class: 'sheet-item' + (it.checked ? ' checked' : '') + (it.danger ? ' danger' : ''),
        onclick: async () => { if (!it.keepOpen) closeSheet(true); try { await it.run(); } catch (e) { fail(e); } } },
      icon(it.icon || 'play'), h('span', { text: it.label }), it.checked ? icon('check', 'tick') : null));
    }
    const panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-head' }, opts.art ? artEl(opts.art, opts.artIcon || 'note', 'sm') : null,
        h('div', { class: 'sheet-title' }, h('div', { class: 't1', text: title }), opts.sub ? h('div', { class: 't2', text: opts.sub }) : null),
        btn('close', 'Close', () => closeSheet())),
      list);
    wrap.append(h('div', { class: 'sheet-scrim', onclick: () => closeSheet() }), panel);
    wrap.hidden = false;
    sheetClosed = opts.onDismiss || null;
    // Keyboard and screen readers go into the dialog, and back where they were when it closes.
    sheetFocus = document.activeElement;
    requestAnimationFrame(() => {
      wrap.classList.add('open');
      if (!panel.contains(document.activeElement)) { const first = panel.querySelector('.sheet-item, input, select, button'); if (first) first.focus(); }
    });
  }
  /** chosen: closed by picking something (not dismissed). */
  function closeSheet(chosen) {
    const w = document.getElementById('sheet');
    w.classList.remove('open'); w.hidden = true; w.textContent = '';
    const f = sheetClosed; sheetClosed = null;
    const back = sheetFocus; sheetFocus = null;
    if (back && back.isConnected && back.focus) back.focus();
    if (f && !chosen) f();
  }

  /** A text prompt; resolves the entered text, or null if cancelled or dismissed. */
  function prompt2(title, { value = '', placeholder = '', ok = 'OK', type = 'text', hint = '' } = {}) {
    return new Promise((resolve) => {
      const input = h('input', { class: 'field', type, value, placeholder, 'aria-label': title });
      const form = h('form', { class: 'prompt', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); closeSheet(true); resolve(v || null); } },
        input, h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => closeSheet() }, 'Cancel'), h('button', { class: 'btn', type: 'submit' }, ok)));
      sheet(title, [{ el: form }], { onDismiss: () => resolve(null), sub: hint || undefined });
      setTimeout(() => input.focus(), 50);
    });
  }
  /** Yes or no; resolves false if dismissed. */
  function confirm2(title, okLabel = 'Delete') {
    return new Promise((resolve) => {
      sheet(title, [
        { label: okLabel, icon: 'delete', danger: true, run: () => resolve(true) },
        { label: 'Cancel', icon: 'close', run: () => resolve(false) },
      ], { onDismiss: () => resolve(false) });
    });
  }

  // -- lists ------------------------------------------------------------------
  /**
   * A lazily loaded list or grid. fetch(start, count) -> {items, total, consumed?}: `consumed`
   * is how many entries of the collection the page covered, when items were filtered out of it.
   * Loading stops as soon as the list leaves the page.
   */
  function lazyList({ fetch, render, grid = false, empty = 'Nothing here.', page = 100 }) {
    const box = h('div', { class: grid ? 'grid' : 'list' });
    const sentinel = h('div', { class: 'sentinel' });
    const wrap = h('div', { class: 'lazy' }, box, sentinel);
    let start = 0, total = Infinity, loading = false, idx = 0, shown = 0, gen = 0;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { rootMargin: '600px' });
    async function more() {
      if (loading || start >= total) return;
      if (!wrap.isConnected && start > 0) return;   // gone from the page (or not shown): stop
      const my = gen;
      loading = true; sentinel.classList.add('busy');
      try {
        const r = await fetch(start, page);
        if (my !== gen) return;                       // reloaded meanwhile: this page is stale
        const covered = r.consumed != null ? r.consumed : r.items.length;
        total = r.total == null ? (covered < page ? start + covered : Infinity) : r.total;
        for (const it of r.items) { const el = render(it, idx++); if (el) { box.append(el); shown++; } }
        start += covered;
        if (!covered) total = start;
        if (start >= total && !shown) box.append(h('div', { class: 'empty', text: empty }));
      } catch (e) { if (my === gen) { fail(e); total = start; } }
      finally { if (my === gen) { loading = false; sentinel.classList.remove('busy'); } }
      if (my === gen && start < total && wrap.isConnected && sentinel.getBoundingClientRect().top < window.innerHeight + 600) more();
    }
    io.observe(sentinel);
    wrap.reload = () => { gen++; loading = false; box.textContent = ''; start = 0; total = Infinity; idx = 0; shown = 0; more(); };
    wrap.dispose = () => { gen++; io.disconnect(); };
    more();
    return wrap;
  }

  /** Stops the lazy lists in el (el itself may be one). */
  function disposeLists(el) {
    for (const l of [el, ...el.querySelectorAll('.lazy')]) if (l.dispose) l.dispose();
  }

  /** Replace what a holder shows; lists it showed stop loading. */
  function swap(holder, ...els) {
    for (const l of holder.querySelectorAll('.lazy')) if (l.dispose) l.dispose();
    holder.replaceChildren(...els);
  }

  /** fetch() for lazyList over an LMS query: cmd(start, count) -> result; key: the loop's name. */
  const loopFetch = (cmd, key, keep) => async (s, n) => {
    const r = await cmd(s, n);
    const raw = r[key] || [];
    return { items: keep ? raw.filter(keep) : raw, total: +r.count || 0, consumed: raw.length };
  };

  function row({ art, artIcon = 'note', title, sub, right, onclick, menu, cls = '', num, draggable }) {
    const r = h('div', { class: 'row ' + cls, tabindex: onclick ? 0 : null, role: onclick ? 'button' : null },
      num != null ? h('div', { class: 'num', text: num }) : (art !== undefined ? artEl(art, artIcon, 'sm') : null),
      h('div', { class: 'meta' }, h('div', { class: 't1', text: title || '' }), sub ? h('div', { class: 't2', text: sub }) : null),
      right != null ? h('div', { class: 'right', text: right }) : null,
      menu ? btn('more', 'More', (e) => { e.stopPropagation(); menu(); }, 'more') : null);
    if (onclick) {
      r.addEventListener('click', onclick);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === r) onclick(e); });
    }
    if (menu) r.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(); });
    if (draggable) r.draggable = true;
    return r;
  }

  /** A track row as LMS lists them (queue, playlists, search). */
  function trackRow(t, { onclick, menu, cls, draggable, sub } = {}) {
    return row({
      art: t.artwork_url ? S.lms.art(t.artwork_url, 96) : S.lms.cover(t.coverid, 96), title: t.title,
      sub: sub !== undefined ? sub : [t.artist, t.album].filter(Boolean).join(' · '), right: +t.duration ? fmtTime(t.duration) : '',
      onclick, menu, cls, draggable,
    });
  }

  function card({ art, artIcon = 'album', title, sub, onclick, menu, round }) {
    const c = h('div', { class: 'card' + (round ? ' round' : ''), tabindex: 0, role: 'button' },
      artEl(art, artIcon, 'lg'),
      h('div', { class: 't1', text: title || '' }), sub ? h('div', { class: 't2', text: sub }) : null,
      menu ? btn('more', 'More', (e) => { e.stopPropagation(); menu(); }, 'more') : null);
    c.addEventListener('click', onclick);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === c) onclick(e); });
    if (menu) c.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(); });
    return c;
  }

  /** Play / Shuffle / Queue buttons for an album, artist or playlist page. */
  function heroButtons(kind, id, cls = '') {
    return h('div', { class: 'row-btns ' + cls },
      h('button', { class: 'btn', onclick: () => pc('load', kind, id) }, icon('play'), 'Play'),
      h('button', { class: 'btn ghost', onclick: () => playShuffled(kind, id) }, icon('shuffle'), 'Shuffle'),
      h('button', { class: 'btn ghost', onclick: () => pc('add', kind, id) }, icon('add'), 'Queue'));
  }
