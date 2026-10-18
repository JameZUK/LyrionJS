// Which player the page controls (src/app/poll.js): after a reopen, LMS forgets this browser's
// player until it connects again, and the page mustn't keep the stand-in it used meanwhile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/app/poll.js', import.meta.url), 'utf8');
const P = vm.runInNewContext(src + '; ({ pickTarget })', {});
const ME = '02:4c:4a:00:00:01', KITCHEN = 'aa:00:00:00:00:01', BEDROOM = 'aa:00:00:00:00:02';

test('reopened before LMS has this browser\'s player: a stand-in, then this browser\'s again', () => {
  assert.equal(P.pickTarget([KITCHEN, BEDROOM], ME, ME, ME), KITCHEN);      // picked by hand last time
  assert.equal(P.pickTarget([KITCHEN, BEDROOM, ME], KITCHEN, ME, ME), ME);   // and back once it's there
  assert.equal(P.pickTarget([KITCHEN, BEDROOM], null, null, ME), KITCHEN);   // never picked: the same
  assert.equal(P.pickTarget([KITCHEN, BEDROOM, ME], KITCHEN, null, ME), ME);
});

test('a player picked by hand stays picked, over this browser\'s', () => {
  assert.equal(P.pickTarget([KITCHEN, BEDROOM, ME], BEDROOM, BEDROOM, ME), null);
  assert.equal(P.pickTarget([KITCHEN, BEDROOM, ME], ME, BEDROOM, ME), BEDROOM);
});

test('a picked player that has gone: this browser\'s, else the one controlled, else any', () => {
  assert.equal(P.pickTarget([KITCHEN, ME], BEDROOM, BEDROOM, ME), ME);
  assert.equal(P.pickTarget([KITCHEN, BEDROOM], BEDROOM, 'gone', ME), null);
  assert.equal(P.pickTarget([KITCHEN], 'gone', 'gone', ME), KITCHEN);
  assert.equal(P.pickTarget([], null, null, ME), null);
});
