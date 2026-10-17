// A new version of the page (src/app/update.js): when an open tab reloads itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/app/update.js', import.meta.url), 'utf8');
const stub = { getElementById: () => ({ hidden: true }), addEventListener: () => {} };
const U = vm.runInNewContext(src + '; ({ updateAction })', { document: stub, setInterval: () => 0 });

test('the same page, or a server that doesn\'t say, changes nothing', () => {
  assert.equal(U.updateAction(100, 100, null, false), 'none');
  assert.equal(U.updateAction(null, 200, null, false), 'none');   // an older plugin: no stamp at boot
  assert.equal(U.updateAction(100, null, null, false), 'none');   // not looked yet
});

test('a new page reloads when this browser isn\'t playing and nothing is in hand', () => {
  assert.equal(U.updateAction(100, 200, null, false), 'reload');        // no player in this browser
  assert.equal(U.updateAction(100, 200, 'stopped', false), 'reload');
});

test('it waits while this browser plays, is paused, or is being used', () => {
  for (const st of ['playing', 'paused', 'waiting', 'loaded']) assert.equal(U.updateAction(100, 200, st, false), 'wait', st);
  assert.equal(U.updateAction(100, 200, 'stopped', true), 'wait');
});
