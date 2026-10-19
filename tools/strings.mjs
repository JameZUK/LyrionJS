// The page's English text, as the keys of src/i18n/<code>.json (see src/app/i18n.js).
//   node tools/strings.mjs            lists each language's missing and stale keys
//   node tools/strings.mjs --update   adds missing keys (empty, to translate) and drops stale ones
//   node tools/strings.mjs --keys     prints every key, with its singular for counted text
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N = path.join(ROOT, 'src', 'i18n');

/** A JS string literal starting at text[i] (a quote): [its value, the index after it]. */
function literal(text, i) {
  const q = text[i];
  let out = '';
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { const n = text[++j]; out += n === 'n' ? '\n' : n; continue; }
    if (c === q) return [out, j + 1];
    if (c === '\n' || (q === '`' && c === '$' && text[j + 1] === '{')) return [null, j];   // not plain text
    out += c;
  }
  return [null, text.length];
}

/** The arguments of a call whose "(" ends just before text[i]: each a plain string literal's value, or null. */
function args(text, i) {
  const out = [];
  let depth = 0, start = i, lit = null;   // lit: [value, from, to] of the last literal at depth 0
  for (; i < text.length; i++) {
    const c = text[i];
    if (/['"`]/.test(c)) {
      const [s, j] = literal(text, i);
      if (depth === 0) lit = [s, i, j];
      i = j - 1;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    else if ((c === ',' || c === ')') && depth === 0) {
      const whole = text.slice(start, i).trim();
      out.push(lit && whole === text.slice(lit[1], lit[2]) ? lit[0] : null);
      lit = null; start = i + 1;
      if (c === ')') return out;
    }
  }
  return out;
}

/** Every key: Map(key -> { one?: English singular, files: Set }). */
export function extract() {
  const keys = new Map();
  const add = (k, file, one) => {
    if (!k) return;
    const e = keys.get(k) || { files: new Set() };
    if (one) e.one = one;
    e.files.add(file);
    keys.set(k, e);
  };
  const dir = path.join(ROOT, 'src', 'app');
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)),
    ...readdirSync(path.join(dir, 'views')).map((f) => path.join(dir, 'views', f))];
  for (const f of files) {
    const text = readFileSync(f, 'utf8'), rel = path.relative(ROOT, f);
    for (const m of text.matchAll(/\b(tr|trn|N_)\(/g)) {
      if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;   // its definition
      const a = args(text, m.index + m[0].length);
      if (m[1] === 'trn') { if (a[1] != null && a[2] != null) add(a[2], rel, a[1]); }
      else if (a[0] != null) add(a[0], rel);   // tr(variable): its text is marked where it's made
    }
  }
  const html = readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-label|-aria|-title)?="([^"]+)"/g)) add(m[1], 'src/index.html');
  return keys;
}

/** {code: {key: translation}} for each language file. */
export function languages() {
  const out = {};
  for (const f of readdirSync(I18N).filter((x) => x.endsWith('.json')).sort()) out[f.slice(0, -5)] = JSON.parse(readFileSync(path.join(I18N, f), 'utf8'));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const keys = extract();
  if (process.argv.includes('--keys')) {
    for (const [k, e] of [...keys].sort((a, b) => a[0].localeCompare(b[0]))) console.log(e.one ? `${JSON.stringify(k)}  (counted; singular ${JSON.stringify(e.one)})` : JSON.stringify(k));
    process.exit(0);
  }
  const update = process.argv.includes('--update');
  for (const [code, dict] of Object.entries(languages())) {
    const missing = [...keys.keys()].filter((k) => !dict[k] || (typeof dict[k] === 'object' && !dict[k].other));
    const stale = Object.keys(dict).filter((k) => !keys.has(k));
    console.log(`${code}: ${keys.size - missing.length}/${keys.size} translated${missing.length ? `, ${missing.length} missing` : ''}${stale.length ? `, ${stale.length} stale` : ''}`);
    if (update) {
      const next = {};
      for (const k of [...keys.keys()].sort((a, b) => a.localeCompare(b))) next[k] = dict[k] || (keys.get(k).one ? { one: '', other: '' } : '');
      writeFileSync(path.join(I18N, code + '.json'), JSON.stringify(next, null, 2) + '\n');
    }
  }
}
