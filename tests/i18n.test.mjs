// Translations (src/i18n/<code>.json, src/app/i18n.js): every language has every key the page
// uses and no others, and keeps each {placeholder} the English has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extract, languages } from '../tools/strings.mjs';

const keys = extract();
const langs = languages();
const slots = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('the page has text to translate, and languages to translate it into', () => {
  assert.ok(keys.size > 300, `${keys.size} keys`);
  assert.ok(Object.keys(langs).length >= 12);
});

for (const [code, dict] of Object.entries(langs)) {
  test(`${code}: every key, translated, and nothing stale`, () => {
    const missing = [...keys.keys()].filter((k) => !dict[k] || (typeof dict[k] === 'object' && !dict[k].other));
    const stale = Object.keys(dict).filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], 'missing');
    assert.deepEqual(stale, [], 'stale');
  });

  test(`${code}: placeholders kept, and every plural form given`, () => {
    const cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const [k, v] of Object.entries(dict)) {
      const want = slots(k);
      if (keys.get(k) && keys.get(k).one) {
        assert.equal(typeof v, 'object', `${k}: counted text needs its plural forms`);
        for (const c of cats) {
          assert.ok(v[c], `${k}: no "${c}" form`);
          // A form for exactly one may say "one" in words instead of {n}.
          const strip = (a) => (c === 'one' ? a.filter((x) => x !== 'n') : a);
          assert.deepEqual(strip(slots(v[c])), strip(want), `${k} (${c}): placeholders`);
        }
      } else {
        assert.equal(typeof v, 'string', k);
        assert.deepEqual(slots(v), want, `${k}: placeholders in ${JSON.stringify(v)}`);
      }
    }
  });
}

test('the page picks the translation, fills it in, and falls back to English', () => {
  const src = readFileSync(new URL('../src/app/i18n.js', import.meta.url), 'utf8');
  const stored = { lang: 'de' };
  const store = { get: (k, d) => (k in stored ? stored[k] : d), set: (k, v) => { stored[k] = v; } };
  const document = { documentElement: { style: { setProperty: () => {} } }, querySelectorAll: () => [] };
  const I18N = { de: { 'Play now': 'Jetzt abspielen', 'Player: {name}': 'Player: {name}', '{n} tracks': { one: 'ein Titel', other: '{n} Titel' } } };
  const L = vm.runInNewContext(src + '; ({ tr, trn, applyLang, fromLms })', { store, document, I18N, Intl });
  L.applyLang();
  assert.equal(L.tr('Play now'), 'Jetzt abspielen');
  assert.equal(L.tr('Player: {name}', { name: 'Küche' }), 'Player: Küche');
  assert.equal(L.tr('Not translated'), 'Not translated');
  assert.equal(L.trn(1, '{n} track', '{n} tracks'), 'ein Titel');
  assert.equal(L.trn(3, '{n} track', '{n} tracks'), '3 Titel');
  assert.equal(L.fromLms('EN_GB'), 'en');
  assert.equal(L.fromLms('NO'), 'no');
  assert.equal(L.fromLms('ZH_CN'), 'en');   // not one of ours (yet)
});
