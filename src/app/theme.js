  // ---------------------------------------------------------------------------
  // Theme: light or dark, and the highlight colour
  // ---------------------------------------------------------------------------
  // Each highlight comes in a dark-theme and a light-theme shade: [colour, hover colour, text on it].
  const ACCENTS = {
    orange: { name: 'Orange', dark: ['#f2a541', '#ffcf8a', '#1b1406'], light: ['#c46d08', '#e08a1e', '#fff'] },
    gold:   { name: 'Gold',   dark: ['#e8c547', '#f5df8f', '#1f1903'], light: ['#8f7100', '#a8860a', '#fff'] },
    green:  { name: 'Green',  dark: ['#6fd36a', '#a6e8a2', '#0a1f09'], light: ['#2e7d2a', '#3a9636', '#fff'] },
    teal:   { name: 'Teal',   dark: ['#3fd0c9', '#8ae6e1', '#04201e'], light: ['#0d7f7a', '#14998f', '#fff'] },
    blue:   { name: 'Blue',   dark: ['#5aa9ff', '#9ccbff', '#04121f'], light: ['#1f6fd1', '#3b86e3', '#fff'] },
    purple: { name: 'Purple', dark: ['#b18cff', '#d2bcff', '#170b2b'], light: ['#7046d6', '#8660e6', '#fff'] },
    pink:   { name: 'Pink',   dark: ['#ff7ab8', '#ffb1d6', '#2a0716'], light: ['#c2306f', '#d94c88', '#fff'] },
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
  /** The highlight chosen in Settings: a name from ACCENTS, or a colour as #rrggbb. */
  function accentShades(v) { return ACCENTS[v] || (isHex(v) ? customAccent(v) : ACCENTS.orange); }

  function applyTheme() {
    const t = store.get('theme', 'auto');
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    // The same selectors as the style sheet's, later in the page: these win.
    const { dark, light } = accentShades(store.get('accent', 'orange'));
    const vars = ([a, a2, on]) => `--accent: ${a}; --accent2: ${a2}; --on-accent: ${on};`;
    let el = document.getElementById('lj-theme');
    if (!el) { el = document.createElement('style'); el.id = 'lj-theme'; document.head.append(el); }
    el.textContent = `:root { ${vars(dark)} }\n`
      + `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${vars(light)} } }\n`
      + `:root[data-theme="light"] { ${vars(light)} }`;
  }
