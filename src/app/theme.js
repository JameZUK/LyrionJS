  // ---------------------------------------------------------------------------
  // Theme: light or dark, and the highlight colour
  // ---------------------------------------------------------------------------
  // Each highlight comes in a dark-theme and a light-theme shade: [colour, hover colour, text on it].
  const ACCENTS = {
    orange: { name: N_('Orange'), dark: ['#f2a541', '#ffcf8a', '#1b1406'], light: ['#c46d08', '#e08a1e', '#fff'] },
    gold:   { name: N_('Gold'),   dark: ['#e8c547', '#f5df8f', '#1f1903'], light: ['#8f7100', '#a8860a', '#fff'] },
    green:  { name: N_('Green'),  dark: ['#6fd36a', '#a6e8a2', '#0a1f09'], light: ['#2e7d2a', '#3a9636', '#fff'] },
    teal:   { name: N_('Teal'),   dark: ['#3fd0c9', '#8ae6e1', '#04201e'], light: ['#0d7f7a', '#14998f', '#fff'] },
    blue:   { name: N_('Blue'),   dark: ['#5aa9ff', '#9ccbff', '#04121f'], light: ['#1f6fd1', '#3b86e3', '#fff'] },
    purple: { name: N_('Purple'), dark: ['#b18cff', '#d2bcff', '#170b2b'], light: ['#7046d6', '#8660e6', '#fff'] },
    pink:   { name: N_('Pink'),   dark: ['#ff7ab8', '#ffb1d6', '#2a0716'], light: ['#c2306f', '#d94c88', '#fff'] },
  };

  const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const rgbHex = (c) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
  const mix = (c, to, t) => c.map((x, i) => x + (to[i] - x) * t);
  /** Relative luminance (WCAG), 0 for black to 1 for white. */
  function luminance(c) {
    const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  /** Text on the colour: black or white, whichever stands out more. */
  const onColour = (c) => { const l = luminance(c); return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000' : '#fff'; };

  /** Both shades of a colour picked by hand: light enough to read on the dark theme, dark enough on the light one. */
  function customAccent(hex) {
    const c = hexRgb(hex), W = [255, 255, 255], K = [0, 0, 0];
    let d = c, l = c;
    for (let t = 0.1; luminance(d) < 0.25 && t <= 1; t += 0.1) d = mix(c, W, t);
    for (let t = 0.1; luminance(l) > 0.18 && t <= 1; t += 0.1) l = mix(c, K, t);
    return { dark: [rgbHex(d), rgbHex(mix(d, W, 0.35)), onColour(d)], light: [rgbHex(l), rgbHex(mix(l, W, 0.15)), onColour(l)] };
  }

  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
  // Material Skin's blue: what "from the cover" uses while there's no cover to take a colour from.
  const MATERIAL_BLUE = { name: N_('Blue'), dark: ['#82b1ff', '#b6d0ff', '#000'], light: ['#1976d2', '#2f86dc', '#fff'] };
  /** The highlight chosen in Settings: a name from ACCENTS, a colour as #rrggbb, or 'cover' (with the cover's colour, if known). */
  function accentShades(v, cover) {
    if (v === 'cover') return isHex(cover) ? customAccent(cover) : MATERIAL_BLUE;
    return ACCENTS[v] || (isHex(v) ? customAccent(v) : ACCENTS.orange);
  }

  /** The cover's colour: the most common clearly coloured shade among its pixels (null for a grey picture). */
  function dominantColour(px) {
    const buckets = new Map();
    let best = null, seen = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      seen++;
      const r = px[i], g = px[i + 1], b = px[i + 2], max = Math.max(r, g, b), sat = max - Math.min(r, g, b);
      if (max < 40 || sat < 40) continue;   // dark, or grey
      const k = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);   // 512 shades
      const c = buckets.get(k) || { w: 0, n: 0, r: 0, g: 0, b: 0 };
      c.w += sat / 255; c.n++; c.r += r; c.g += g; c.b += b;
      buckets.set(k, c);
      if (!best || c.w > best.w) best = c;
    }
    if (!best || best.n < seen * 0.02) return null;   // hardly any colour
    return rgbHex([best.r / best.n, best.g / best.n, best.b / best.n]);
  }

  let coverHex = null, coverFor;
  const accentChoice = () => store.get('accent', skin() === 'material' ? 'cover' : 'orange');
  /** The cover now shown changed: take its colour, where the highlight comes from the cover. */
  function coverAccent(url) {
    if (url === coverFor) return;
    coverFor = url;
    const done = (hex) => { if (coverFor !== url) return; const was = coverHex; coverHex = hex; if (accentChoice() === 'cover' && was !== hex) applyTheme(); };
    if (!url) return done(null);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 48;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 48, 48);
        done(dominantColour(g.getImageData(0, 0, 48, 48).data));
      } catch (e) { done(null); }
    };
    img.onerror = () => done(null);
    img.src = url;
  }

  function applyTheme() {
    const t = store.get('theme', 'auto');
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    // The same selectors as the style sheet's, later in the page: these win.
    const { dark, light } = accentShades(accentChoice(), coverHex);
    const rgb = (a) => hexRgb(a.length === 4 ? '#' + [...a.slice(1)].map((x) => x + x).join('') : a);
    const vars = ([a, a2, on]) => `--accent: ${a}; --accent2: ${a2}; --on-accent: ${on}; --accent-rgb: ${rgb(a).join(', ')};`;
    // Material tints the page with its colour (the deeper shade), more in the toolbars.
    const tint = (base, t) => rgbHex(mix(hexRgb(base), rgb(light[0]), t));
    const md = `--bg: ${tint('#212121', 0.15)}; --toolbar: ${tint('#212121', 0.25)}; --menu: ${tint('#303030', 0.15)};`;
    const ml = `--bg: ${tint('#fafafa', 0.25)}; --toolbar: ${tint('#fafafa', 0.35)}; --menu: ${tint('#fafafa', 0.15)};`;
    const M = '[data-skin="material"]';
    let el = document.getElementById('lj-theme');
    if (!el) { el = document.createElement('style'); el.id = 'lj-theme'; document.head.append(el); }
    el.textContent = `:root { ${vars(dark)} } :root${M} { ${md} }\n`
      + `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${vars(light)} } :root${M}:not([data-theme="dark"]) { ${ml} } }\n`
      + `:root[data-theme="light"] { ${vars(light)} } :root${M}[data-theme="light"] { ${ml} }`;
  }
