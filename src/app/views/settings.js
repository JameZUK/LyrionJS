  // -- Settings ----------------------------------------------------------------
  VIEWS.settings = () => {
    const el = h('div', { class: 'settings' });
    async function render() {
      const sections = [];
      // This browser as a player.
      const enabled = store.get('localEnabled', true);
      const sw = h('input', { type: 'checkbox', class: 'switch', checked: enabled, 'aria-label': tr('Use this browser as a player') });
      sw.addEventListener('change', () => { store.set('localEnabled', sw.checked); if (sw.checked) claimPlayerThenStart(); else stopLocalPlayer(); setTimeout(render, 500); });
      const out = S.output ? S.output.info() : null;
      const snap = S.local ? S.local.snapshot() : null;
      const trim = h('input', { type: 'range', min: 0, max: 100, value: Math.round((S.output ? S.output.level : 1) * 100), class: 'vol', 'aria-label': tr('Output level') });
      trim.addEventListener('input', () => { store.set('localLevel', trim.value / 100); if (S.output) S.output.setLevel(trim.value / 100); });
      const mode = h('select', { class: 'select', 'aria-label': tr('Audio output') },
        [['auto', tr('Automatic')], ['webaudio', tr('Web Audio (lowest latency)')], ['media', tr('Media element (plays with the screen locked)')]]
          .map(([v, t]) => h('option', { value: v, text: t, selected: store.get('outputMode', (S.config && S.config.defaultOutput) || 'auto') === v })));
      // A choice made here is tried afresh, even where the media element failed before.
      mode.addEventListener('change', () => { store.set('outputMode', mode.value); store.set('mediaUnusable', false); toast(tr('Reloading to switch the output…')); setTimeout(() => location.reload(), 800); });
      sections.push(h('section', {}, h('h3', { text: tr('This browser as a player') }),
        h('label', { class: 'setting' }, h('span', { text: tr('Play music in this browser (a real Slimproto player in LMS)') }), sw),
        S.local ? h('div', { class: 'kv' },
          kv(tr('Name'), S.local.name, h('button', { class: 'btn ghost sm', onclick: () => renameLocal().then(render) }, tr('Rename'))),
          kv(tr('Player ID'), S.localId), kv(tr('Connection'), snap.connected ? tr('Connected (Slimproto over a WebSocket to LMS)') : tr('Connecting…')),
          kv(tr('State'), stateWord(snap.state) + (snap.error ? ' — ' + snap.error : '')),
          kv(tr('Audio engine'), S.output ? (S.output.engine || tr('Web Audio (opens when music starts)')) + (S.outputMode === 'webaudio' && !window.isSecureContext ? ' ' + tr('(plain http page)') : '') : '—'),
          kv(tr('Why'), S.outputWhy ? tr(S.outputWhy) : ''),
          S.output && S.output.volumeLocked ? kv(tr('Volume'), tr('Set with this device\'s own buttons (the page can\'t set it here); LMS volume is held at 100 %')) : null,
          kv(tr('Formats'), tr('{formats} (LMS converts everything else to FLAC)', { formats: S.local.caps.map((c) => ({ flc: 'FLAC', pcm: 'PCM/WAV/AIFF', mp3: 'MP3' }[c] || c)).join(', ') })),
          kv(tr('Highest sample rate'), (S.local.maxRateFound / 1000).toLocaleString(lang) + ' kHz'),
          kv(tr('Output'), out ? tr('{rate} kHz, {state}, ~{latency} ms latency', { rate: (out.rate / 1000).toLocaleString(lang), state: stateWord(out.state), latency: out.latency }) : tr('Opens when music starts')),
          kv(tr('Buffered'), tr('{seconds} s decoded ahead', { seconds: snap.queued.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })),
          S.output && !S.output.volumeLocked ? h('label', { class: 'setting' }, h('span', { text: tr('Output level in this browser (on top of the LMS volume)') }), trim) : null,
          h('label', { class: 'setting' }, h('span', { text: tr('Audio output') }), mode)) : null));

      // The player being controlled.
      if (S.target) {
        const prefs = {};
        await Promise.all(['transitionType', 'transitionDuration', 'replayGainMode', 'plugin.dontstopthemusic:provider'].map(async (k) => {
          try { const r = await rpc(['playerpref', k, '?']); prefs[k] = r._p2; } catch (e) { prefs[k] = undefined; }
        }));
        const sel = (k, opts, label) => {
          const s = h('select', { class: 'select', 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v, text: t, selected: String(prefs[k]) === String(v) })));
          s.addEventListener('change', () => act(['playerpref', k, s.value], tr('{setting} saved', { setting: label })));
          return h('label', { class: 'setting' }, h('span', { text: label }), s);
        };
        sections.push(h('section', {}, h('h3', { text: tr('Player: {name}', { name: playerName(S.target) }) }),
          sel('replayGainMode', [[0, tr('Off')], [1, tr('Track gain')], [2, tr('Album gain')], [3, tr('Smart gain')]], tr('Volume levelling (ReplayGain)')),
          sel('transitionType', [[0, tr('None (gapless)')], [1, tr('Crossfade')], [2, tr('Fade in')], [3, tr('Fade out')], [4, tr('Fade in and out')]], tr('Transition between tracks')),
          sel('transitionDuration', [0, 1, 2, 3, 5, 8, 10].map((n) => [n, n + ' s']), tr('Transition length')),
          prefs['plugin.dontstopthemusic:provider'] !== undefined ? await dstmSetting(prefs['plugin.dontstopthemusic:provider']) : null,
          isLocal(S.target) ? h('p', { class: 't2', text: tr('Crossfades need both tracks at the same sample rate; otherwise this browser plays them gaplessly.') }) : null));
      }

      // Server.
      let info = S.serverInfo;
      try { info = S.serverInfo = await S.lms.rpc('', ['serverstatus', 0, 0]); } catch (e) { /* keep last */ }
      sections.push(h('section', {}, h('h3', { text: tr('Server') }),
        h('div', { class: 'kv' },
          kv(tr('Server'), `${S.server.name} (${location.host})`),
          info ? kv(tr('Version'), 'Lyrion Music Server ' + info.version) : null,
          info ? kv(tr('Library'), [trn(info['info total albums'], '{n} album', '{n} albums'), trn(info['info total artists'], '{n} artist', '{n} artists'), trn(info['info total songs'], '{n} track', '{n} tracks')].join(', ')) : null,
          info && info.rescan ? kv(tr('Scan'), tr('Scanning: {step} {done}/{total}', { step: info.progressname || '', done: info.progressdone || '', total: info.progresstotal || '' })) : null,
          info && info.lastscan ? kv(tr('Last scan'), new Date(+info.lastscan * 1000).toLocaleString(lang)) : null),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn ghost', onclick: () => act(['rescan'], tr('Library scan started'), '') }, icon('refresh'), tr('Scan for new music')))));

      // Appearance.
      const theme = h('select', { class: 'select', 'aria-label': tr('Theme') }, [['auto', tr('Match the system')], ['dark', tr('Dark')], ['light', tr('Light')]].map(([v, t]) => h('option', { value: v, text: t, selected: store.get('theme', 'auto') === v })));
      theme.addEventListener('change', () => { store.set('theme', theme.value); applyTheme(); });
      // LyrionJS's own skins, and the server's web skins, shown over the page with LyrionJS still the player.
      const lmsSkins = Object.entries((S.config && S.config.skins) || {}).sort((a, b) => a[1].localeCompare(b[1]));
      const curSkin = lmsSkin() ? 'lms:' + lmsSkin() : skin();
      const opt = (v, t) => h('option', { value: v, text: t, selected: curSkin === v });
      const sk = h('select', { class: 'select', 'aria-label': tr('Skin') }, h('optgroup', { label: 'LyrionJS' }, Object.entries(SKINS).map(([v, t]) => opt(v, t))),
        lmsSkins.length ? h('optgroup', { label: 'Lyrion Music Server' }, lmsSkins.map(([v, t]) => opt('lms:' + v, v === S.config.skin ? tr('{skin} (the server\'s)', { skin: t }) : t))) : null);
      sk.addEventListener('change', () => {
        store.set('skin', sk.value); applySkin(); applyTheme(); render();
        // An LMS skin: go to it now (from LyrionJS's own pages over another, or over none).
        if (lmsSkin()) { leaveOwn(); toast(tr('Showing {skin}', { skin: hostName() })); }
      });
      // The highlight colour: a swatch each, and one to pick any colour.
      const cur = accentChoice();
      const setAccent = (v) => { store.set('accent', v); applyTheme(); for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.v === v || (b.dataset.v === 'custom' && isHex(v)))); };
      const swatch = (v, name, colour) => h('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(cur === v), 'aria-label': name, title: name, 'data-v': v, style: { background: colour }, onclick: () => setAccent(v) });
      const pick = h('input', { type: 'color', class: 'swatch-pick', value: isHex(cur) ? cur : '#f2a541', 'aria-label': tr('Pick a colour'), title: tr('Pick a colour') });
      pick.addEventListener('input', () => setAccent(pick.value.toLowerCase()));
      const custom = h('label', { class: 'swatch custom', role: 'radio', 'aria-checked': String(isHex(cur)), 'aria-label': tr('Your own colour'), title: tr('Your own colour'), 'data-v': 'custom' }, pick);
      const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': tr('Highlight colour') },
        swatch('cover', tr('From the cover art (as Material Skin)'), 'conic-gradient(from 45deg, #d8a23a, #3f7fd0, #c2306f, #4caf50, #d8a23a)'),
        Object.entries(ACCENTS).map(([v, a]) => swatch(v, tr(a.name), `linear-gradient(135deg, ${a.dark[0]} 50%, ${a.light[0]} 50%)`)), custom);
      const dg = h('input', { type: 'checkbox', class: 'switch', checked: store.get('diag', !!(S.config && S.config.clientDiagnostics)), 'aria-label': tr('Send diagnostics') });
      dg.addEventListener('change', () => store.set('diag', dg.checked));
      // The language: LMS's (as its menus are), or one chosen for this browser.
      const lmsName = LANGS[store.get('lmsLang', 'en')] || LANGS.en;
      const lg = h('select', { class: 'select', 'aria-label': tr('Language') },
        h('option', { value: 'auto', text: tr('As Lyrion Music Server ({language})', { language: lmsName }), selected: langChoice() === 'auto' }),
        Object.entries(LANGS).map(([v, name]) => h('option', { value: v, text: name, selected: langChoice() === v })));
      lg.addEventListener('change', () => { store.set('lang', lg.value); relang(); });
      sections.push(h('section', {}, h('h3', { text: tr('Appearance') }),
        h('label', { class: 'setting' },  h('span', { text: tr('Skin: LyrionJS\'s own, or any skin installed on your Lyrion Music Server, with this browser still the player') }), sk),
        h('label', { class: 'setting' }, h('span', { text: tr('Language') }), lg),
        h('label', { class: 'setting' }, h('span', { text: tr('Theme') }), theme),
        h('div', { class: 'setting' }, h('span', { text: tr('Highlight colour') }), swatches),
        h('label', { class: 'setting' }, h('span', { text: tr('Send playback diagnostics to the LMS server log (helps fix problems on phones and tablets)') }), dg)));
      sections.push(h('section', {}, h('h3', { text: tr('About') }),
        h('div', { class: 'about' }, logo('about-logo'),
          h('div', {}, h('div', { class: 'about-name', text: `LyrionJS ${VERSION}` }),
            h('p', { class: 'about-text', text: tr('A Slimproto player and controller for Lyrion Music Server in one page. Keyboard: Space play/pause, ←/→ previous/next, ↑/↓ volume, M mute.') }),
            h('button', { class: 'btn ghost sm about-more', onclick: () => push('about') }, tr('More about LyrionJS…'))))));
      el.replaceChildren(...sections);
    }
    render().catch(fail);
    return { title: tr('Settings'), el, perPlayer: true };
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
    if (!opts.length) opts.push(['0', tr('Off')]);
    const curStr = cur == null || cur === '' ? '0' : String(cur);
    if (!opts.some((o) => o[0] === curStr)) opts.push([curStr, curStr]);
    opts = opts.filter((o, i, a) => a.findIndex((x) => x[0] === o[0]) === i);
    const s = h('select', { class: 'select', 'aria-label': tr('Don\'t Stop The Music') }, opts.map(([v, t]) => h('option', { value: v, text: t, selected: curStr === v })));
    s.addEventListener('change', () => act(['playerpref', 'plugin.dontstopthemusic:provider', s.value], tr('Saved')));
    return h('label', { class: 'setting' }, h('span', { text: tr('When the queue ends (Don\'t Stop The Music)') }), s);
  }
