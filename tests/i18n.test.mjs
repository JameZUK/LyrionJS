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
  assert.equal(L.fromLms('NO'), 'nb');   // NO, before LMS 9.2, is Norwegian (bokmål)
  assert.equal(L.fromLms('NB'), 'nb');
  assert.equal(L.fromLms('NN'), 'nn');
  assert.equal(L.fromLms('ZH_CN'), 'en');   // not one of ours (yet)
});

test('dates as LMS\'s date and time settings write them, ISO included', () => {
  const src = readFileSync(new URL('../src/app/i18n.js', import.meta.url), 'utf8');
  const store = { get: (k, d) => d, set: () => {} };
  const L = vm.runInNewContext(src + '; ({ lmsDate, regionOf })', { store, document: {}, I18N: {}, Intl });
  const d = new Date(2026, 9, 6, 20, 4, 9);   // 6 October 2026, 20:04:09 local time
  assert.equal(L.lmsDate(d, '%Y-%m-%d %H:%M:%S', 'en-GB'), '2026-10-06 20:04:09');
  assert.equal(L.lmsDate(d, '%m/%d/%Y |%I:%M %p', 'en-US'), '10/06/2026 8:04 PM');
  assert.equal(L.lmsDate(d, '%A, %B |%d, %Y', 'en-GB'), 'Tuesday, October 6, 2026');
  assert.equal(L.lmsDate(d, '%a |%d. %b %Y', 'de'), 'Di 6. Okt 2026');
  assert.equal(L.lmsDate(d, '%d.%m.%y %H:%M', 'de'), '06.10.26 20:04');
  // The browser's region within the page's language, else the language alone.
  assert.equal(L.regionOf('en', ['en-GB', 'en']), 'en-GB');
  assert.equal(L.regionOf('de', ['en-GB', 'de-AT']), 'de-AT');
  assert.equal(L.regionOf('fr', ['en-GB']), 'fr');
  assert.equal(L.regionOf('nb', ['nb-NO']), 'nb-NO');
  assert.equal(L.regionOf('nb', ['no-NO']), 'no-NO');   // Norwegian, as some browsers call bokmål
  assert.equal(L.regionOf('nn', ['nb-NO', 'nn-NO']), 'nn-NO');
  assert.equal(L.regionOf('nn', ['nb-NO']), 'nn');      // not bokmål's month names
});

test('a language chosen as "no" (before nb and nn) is now Norwegian (bokmål)', () => {
  const src = readFileSync(new URL('../src/app/i18n.js', import.meta.url), 'utf8');
  const stored = { lang: 'no' };
  const store = { get: (k, d) => (k in stored ? stored[k] : d), set: (k, v) => { stored[k] = v; } };
  const document = { documentElement: { style: { setProperty: () => {} } }, querySelectorAll: () => [] };
  const I18N = { nb: { 'Play now': 'Spill av nå' } };
  const L = vm.runInNewContext(src + '; ({ tr, applyLang, langChoice })', { store, document, I18N, Intl });
  L.applyLang();
  assert.equal(L.langChoice(), 'nb');
  assert.equal(L.tr('Play now'), 'Spill av nå');
  assert.equal(document.documentElement.lang, 'nb');
});
