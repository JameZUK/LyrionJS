  // -- Settings ----------------------------------------------------------------
  VIEWS.settings = () => {
    const el = h('div', { class: 'settings' });
    async function render() {
      const sections = [];
      // This browser as a player.
      const enabled = store.get('localEnabled', true);
      const sw = h('input', { type: 'checkbox', class: 'switch', checked: enabled, 'aria-label': 'Use this browser as a player' });
      sw.addEventListener('change', () => { store.set('localEnabled', sw.checked); if (sw.checked) claimPlayerThenStart(); else stopLocalPlayer(); setTimeout(render, 500); });
      const out = S.output ? S.output.info() : null;
      const snap = S.local ? S.local.snapshot() : null;
      const trim = h('input', { type: 'range', min: 0, max: 100, value: Math.round((S.output ? S.output.level : 1) * 100), class: 'vol', 'aria-label': 'Output level' });
      trim.addEventListener('input', () => { store.set('localLevel', trim.value / 100); if (S.output) S.output.setLevel(trim.value / 100); });
      const mode = h('select', { class: 'select', 'aria-label': 'Audio output' },
        [['auto', 'Automatic'], ['webaudio', 'Web Audio (lowest latency)'], ['media', 'Media element (plays with the screen locked)']]
          .map(([v, t]) => h('option', { value: v, text: t, selected: store.get('outputMode', (S.config && S.config.defaultOutput) || 'auto') === v })));
      // A choice made here is tried afresh, even where the media element failed before.
      mode.addEventListener('change', () => { store.set('outputMode', mode.value); store.set('mediaUnusable', false); toast('Reloading to switch the output…'); setTimeout(() => location.reload(), 800); });
      sections.push(h('section', {}, h('h3', { text: 'This browser as a player' }),
        h('label', { class: 'setting' }, h('span', { text: 'Play music in this browser (a real Slimproto player in LMS)' }), sw),
        S.local ? h('div', { class: 'kv' },
          kv('Name', S.local.name, h('button', { class: 'btn ghost sm', onclick: () => renameLocal().then(render) }, 'Rename')),
          kv('Player ID', S.localId), kv('Connection', snap.connected ? 'Connected (Slimproto over a WebSocket to LMS)' : 'Connecting…'),
          kv('State', snap.state + (snap.error ? ' — ' + snap.error : '')),
          kv('Audio engine', S.output ? (S.output.engine || 'Web Audio (opens when music starts)') + (S.outputMode === 'webaudio' && !window.isSecureContext ? ' (plain http page)' : '') : '—'),
          kv('Why', S.outputWhy || ''),
          S.output && S.output.volumeLocked ? kv('Volume', 'Set with this device\'s own buttons (the page can\'t set it here); LMS volume is held at 100 %') : null,
          kv('Formats', S.local.caps.map((c) => ({ flc: 'FLAC', pcm: 'PCM/WAV/AIFF', mp3: 'MP3' }[c] || c)).join(', ') + ' (LMS converts everything else to FLAC)'),
          kv('Highest sample rate', (S.local.maxRateFound / 1000) + ' kHz'),
          kv('Output', out ? `${out.rate / 1000} kHz, ${out.state}, ~${out.latency} ms latency` : 'Opens when music starts'),
          kv('Buffered', snap.queued.toFixed(1) + ' s decoded ahead'),
          S.output && !S.output.volumeLocked ? h('label', { class: 'setting' }, h('span', { text: 'Output level in this browser (on top of the LMS volume)' }), trim) : null,
          h('label', { class: 'setting' }, h('span', { text: 'Audio output' }), mode)) : null));

      // The player being controlled.
      if (S.target) {
        const prefs = {};
        await Promise.all(['transitionType', 'transitionDuration', 'replayGainMode', 'plugin.dontstopthemusic:provider'].map(async (k) => {
          try { const r = await rpc(['playerpref', k, '?']); prefs[k] = r._p2; } catch (e) { prefs[k] = undefined; }
        }));
        const sel = (k, opts, label) => {
          const s = h('select', { class: 'select', 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v, text: t, selected: String(prefs[k]) === String(v) })));
          s.addEventListener('change', () => act(['playerpref', k, s.value], label + ' saved'));
          return h('label', { class: 'setting' }, h('span', { text: label }), s);
        };
        sections.push(h('section', {}, h('h3', { text: 'Player: ' + playerName(S.target) }),
          sel('replayGainMode', [[0, 'Off'], [1, 'Track gain'], [2, 'Album gain'], [3, 'Smart gain']], 'Volume levelling (ReplayGain)'),
          sel('transitionType', [[0, 'None (gapless)'], [1, 'Crossfade'], [2, 'Fade in'], [3, 'Fade out'], [4, 'Fade in and out']], 'Transition between tracks'),
          sel('transitionDuration', [[0, '0 s'], [1, '1 s'], [2, '2 s'], [3, '3 s'], [5, '5 s'], [8, '8 s'], [10, '10 s']], 'Transition length'),
          prefs['plugin.dontstopthemusic:provider'] !== undefined ? await dstmSetting(prefs['plugin.dontstopthemusic:provider']) : null,
          isLocal(S.target) ? h('p', { class: 't2', text: 'Crossfades need both tracks at the same sample rate; otherwise this browser plays them gaplessly.' }) : null));
      }

      // Server.
      let info = S.serverInfo;
      try { info = S.serverInfo = await S.lms.rpc('', ['serverstatus', 0, 0]); } catch (e) { /* keep last */ }
      sections.push(h('section', {}, h('h3', { text: 'Server' }),
        h('div', { class: 'kv' },
          kv('Server', `${S.server.name} (${location.host})`),
          info ? kv('Version', 'Lyrion Music Server ' + info.version) : null,
          info ? kv('Library', `${(+info['info total albums']).toLocaleString()} albums, ${(+info['info total artists']).toLocaleString()} artists, ${(+info['info total songs']).toLocaleString()} tracks`) : null,
          info && info.rescan ? kv('Scan', 'Scanning: ' + (info.progressname || '') + ' ' + (info.progressdone || '') + '/' + (info.progresstotal || '')) : null,
          info && info.lastscan ? kv('Last scan', new Date(+info.lastscan * 1000).toLocaleString()) : null),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn ghost', onclick: () => act(['rescan'], 'Library scan started', '') }, icon('refresh'), 'Scan for new music'))));

      // Appearance.
      const theme = h('select', { class: 'select', 'aria-label': 'Theme' }, [['auto', 'Match the system'], ['dark', 'Dark'], ['light', 'Light']].map(([v, t]) => h('option', { value: v, text: t, selected: store.get('theme', 'auto') === v })));
      theme.addEventListener('change', () => { store.set('theme', theme.value); applyTheme(); });
      const sk = h('select', { class: 'select', 'aria-label': 'Skin' }, Object.entries(SKINS).map(([v, t]) => h('option', { value: v, text: t, selected: skin() === v })));
      sk.addEventListener('change', () => { store.set('skin', sk.value); applySkin(); applyTheme(); render(); });
      // The highlight colour: a swatch each, and one to pick any colour.
      const cur = accentChoice();
      const setAccent = (v) => { store.set('accent', v); applyTheme(); for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.v === v || (b.dataset.v === 'custom' && isHex(v)))); };
      const swatch = (v, name, colour) => h('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(cur === v), 'aria-label': name, title: name, 'data-v': v, style: { background: colour }, onclick: () => setAccent(v) });
      const pick = h('input', { type: 'color', class: 'swatch-pick', value: isHex(cur) ? cur : '#f2a541', 'aria-label': 'Pick a colour', title: 'Pick a colour' });
      pick.addEventListener('input', () => setAccent(pick.value.toLowerCase()));
      const custom = h('label', { class: 'swatch custom', role: 'radio', 'aria-checked': String(isHex(cur)), 'aria-label': 'Your own colour', title: 'Your own colour', 'data-v': 'custom' }, pick);
      const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Highlight colour' },
        swatch('cover', 'From the cover art (as Material Skin)', 'conic-gradient(from 45deg, #d8a23a, #3f7fd0, #c2306f, #4caf50, #d8a23a)'),
        Object.entries(ACCENTS).map(([v, a]) => swatch(v, a.name, `linear-gradient(135deg, ${a.dark[0]} 50%, ${a.light[0]} 50%)`)), custom);
      const dg = h('input', { type: 'checkbox', class: 'switch', checked: store.get('diag', !!(S.config && S.config.clientDiagnostics)), 'aria-label': 'Send diagnostics' });
      dg.addEventListener('change', () => store.set('diag', dg.checked));
      sections.push(h('section', {}, h('h3', { text: 'Appearance' }),
        h('label', { class: 'setting' }, h('span', { text: 'Skin (Material: laid out like LMS\'s Material Skin)' }), sk),
        h('label', { class: 'setting' }, h('span', { text: 'Theme' }), theme),
        h('div', { class: 'setting' }, h('span', { text: 'Highlight colour' }), swatches),
        h('label', { class: 'setting' }, h('span', { text: 'Send playback diagnostics to the LMS server log (helps fix problems on phones and tablets)' }), dg)));
      sections.push(h('section', {}, h('h3', { text: 'About' }),
        h('div', { class: 'about' }, logo('about-logo'),
          h('div', {}, h('div', { class: 'about-name', text: `LyrionJS ${VERSION}` }),
            h('p', { class: 'about-text', text: 'A Slimproto player and controller for Lyrion Music Server in one page. Keyboard: Space play/pause, ←/→ previous/next, ↑/↓ volume, M mute.' }),
            h('button', { class: 'btn ghost sm about-more', onclick: () => push('about') }, 'More about LyrionJS…')))));
      el.replaceChildren(...sections);
    }
    render().catch(fail);
    return { title: 'Settings', el, perPlayer: true };
  };
  function kv(k, v, extra) { return h('div', { class: 'kv-row' }, h('div', { class: 'k', text: k }), h('div', { class: 'v' }, h('span', { text: v == null ? '' : String(v) }), extra || null)); }

  async function dstmSetting(cur) {
    // Don't Stop The Music: ask the plugin for its providers through the jive menu.
    let opts = [];
    try {
      const r = await rpc(['dontstopthemusicsetting', 0, 100, 'menu:1']);
      for (const it of r.item_loop || []) {
        const v = it.actions && it.actions.do && it.actions.do.cmd && it.actions.do.cmd[it.actions.do.cmd.length - 1];
        if (typeof v === 'string' || typeof v === 'number') opts.push([String(v), it.text]);
      }
    } catch (e) { /* plugin menu unavailable */ }
    if (!opts.length) opts.push(['0', 'Off']);
    const curStr = cur == null || cur === '' ? '0' : String(cur);
    if (!opts.some((o) => o[0] === curStr)) opts.push([curStr, curStr]);
    opts = opts.filter((o, i, a) => a.findIndex((x) => x[0] === o[0]) === i);
    const s = h('select', { class: 'select', 'aria-label': 'Don\'t Stop The Music' }, opts.map(([v, t]) => h('option', { value: v, text: t, selected: curStr === v })));
    s.addEventListener('change', () => act(['playerpref', 'plugin.dontstopthemusic:provider', s.value], 'Saved'));
    return h('label', { class: 'setting' }, h('span', { text: 'When the queue ends (Don\'t Stop The Music)' }), s);
  }
