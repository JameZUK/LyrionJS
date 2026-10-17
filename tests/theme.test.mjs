// Highlight colours (src/app/theme.js): the shades the page uses for a choice in Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/app/theme.js', import.meta.url), 'utf8');
const T = vm.runInNewContext(src + '; ({ ACCENTS, accentShades, customAccent, luminance, hexRgb })', {});
const contrast = (a, b) => { const [x, y] = [T.luminance(T.hexRgb(a)), T.luminance(T.hexRgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const DARK_BG = '#161920', LIGHT_BG = '#ffffff';
const full = (c) => (c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c);

test('a named highlight gives its own shades; anything unknown is orange', () => {
  assert.deepEqual(T.accentShades('blue'), T.ACCENTS.blue);
  assert.deepEqual(T.accentShades('nonsense'), T.ACCENTS.orange);
  assert.deepEqual(T.accentShades(undefined), T.ACCENTS.orange);
  assert.deepEqual(T.accentShades('#12345'), T.ACCENTS.orange);
});

test('every named highlight can be read on its theme, and its text on it', () => {
  for (const [k, a] of Object.entries(T.ACCENTS)) {
    assert.ok(contrast(a.dark[0], DARK_BG) >= 3, k + ' on dark');
    assert.ok(contrast(a.light[0], LIGHT_BG) >= 3, k + ' on light');
    assert.ok(contrast(a.dark[0], full(a.dark[2])) >= 3, k + ' text on dark accent');
    assert.ok(contrast(a.light[0], full(a.light[2])) >= 3, k + ' text on light accent');
  }
});

test('a colour picked by hand is lightened for the dark theme and darkened for the light one', () => {
  for (const hex of ['#000000', '#ffffff', '#ffff00', '#0000ff', '#3a7bd5', '#808080']) {
    const s = T.accentShades(hex);
    assert.ok(contrast(s.dark[0], DARK_BG) >= 3, hex + ' on dark');
    assert.ok(contrast(s.light[0], LIGHT_BG) >= 3, hex + ' on light');
    assert.ok(contrast(s.dark[0], full(s.dark[2])) >= 4.5, hex + ' text on dark accent');
    assert.ok(contrast(s.light[0], full(s.light[2])) >= 4.5, hex + ' text on light accent');
    for (const c of [...s.dark, ...s.light]) assert.match(c, /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/);
  }
  assert.equal(T.accentShades('#2a5db0').light[0], '#2a5db0');   // already fine on light: as picked
  assert.equal(T.accentShades('#5aa9ff').dark[0], '#5aa9ff');   // and on dark
});
