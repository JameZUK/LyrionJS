// Transitions between tracks: crossfade, fade in, fade out (src/core/transition.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LJ = require('./load.cjs')('core');
const { makePlayer, REQ, HTTP_OK } = require('./fakes.cjs')(LJ);

/** An output that records what reaches it. */
function rec(queued = 100) {
  const ops = [];
  return {
    ops, queued,
    push(seq, rate, chans) { ops.push({ op: 'push', seq, rate, l: Array.from(chans[0]), r: chans[1] ? Array.from(chans[1]) : null }); },
    endSeq(seq) { ops.push({ op: 'end', seq }); },
    queuedSeconds() { return this.queued; },
    frames(seq) { return this.ops.filter((o) => o.op === 'push' && o.seq === seq).reduce((a, o) => a + o.l.length, 0); },
    samples(seq) { return this.ops.filter((o) => o.op === 'push' && (seq == null || o.seq === seq)).flatMap((o) => o.l); },
    order() { return this.ops.map((o) => (o.op === 'end' ? 'end' + o.seq : 'p' + o.seq)).filter((x, i, a) => x !== a[i - 1]); },
  };
}
const block = (n, v) => [new Float32Array(n).fill(v), new Float32Array(n).fill(v)];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const RATE = 100;   // 100 Hz: a 1 s transition is 100 frames

test('no transition: audio passes straight through', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '0', 0);
  t.push(1, RATE, block(50, 1), 16); t.push(1, RATE, block(50, 1), 16);
  assert.equal(o.frames(1), 100);
  t.end(1);
  assert.deepEqual(o.order(), ['p1', 'end1']);
});

test('a period of 0 is no transition, whatever the type', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 0);
  t.push(1, RATE, block(80, 1), 16);
  assert.equal(o.frames(1), 80);
});

test('fade in ramps the start of each track', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '2', 1);
  t.push(1, RATE, block(60, 1), 16); t.push(1, RATE, block(90, 1), 16);
  const s = o.samples(1);
  assert.equal(s.length, 150);
  assert.ok(s[0] < 0.01 && near(s[49], 0.495) && s[99] > 0.99 && s[100] === 1 && s[149] === 1);
  for (let i = 1; i < 100; i++) assert.ok(s[i] > s[i - 1]);
});

test('fade out ramps the end of each track, then ends it', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '3', 1);
  t.push(1, RATE, block(250, 1), 16);
  assert.equal(o.frames(1), 150, 'the last second waits for the end');
  t.end(1);
  const s = o.samples(1);
  assert.equal(s.length, 250);
  assert.equal(s[149], 1); assert.ok(s[150] > 0.99 && s[249] < 0.01);
  assert.deepEqual(o.order(), ['p1', 'end1']);
});

test('fade in and out each take half the period', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '4', 2);
  t.push(1, RATE, block(400, 1), 16); t.end(1);
  const s = o.samples(1);
  assert.equal(s.length, 400);
  assert.ok(s[0] < 0.01 && s[99] > 0.99 && s[200] === 1 && s[300] > 0.99 && s[399] < 0.01);
});

test('crossfade: the end of one track is mixed with the start of the next, which owns the mix', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 1);
  t.push(1, RATE, block(300, 1), 16);
  t.end(1);
  assert.equal(o.frames(1), 200, 'the last second waits for the next track');
  assert.ok(!o.ops.some((x) => x.op === 'end'), 'and the track is not ended yet');
  t.begin(2, '1', 1);
  t.push(2, RATE, block(40, 0), 16); t.push(2, RATE, block(260, 0), 16);
  assert.equal(o.frames(1), 200);
  const b = o.samples(2);
  assert.equal(b.length, 200, 'its own last second waits in turn');
  // Over 100 frames the outgoing track fades from 1 to 0 under the (silent) incoming one.
  assert.ok(b[0] > 0.99 && near(b[49], 0.505) && b[99] < 0.01 && b[100] === 0);
  for (let i = 1; i < 100; i++) assert.ok(b[i] < b[i - 1]);
  assert.deepEqual(o.order().slice(0, 3), ['p1', 'end1', 'p2']);
});

test('crossfade: a shorter crossfade on the next track plays the rest of the held end first', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 2); t.push(1, RATE, block(300, 1), 16); t.end(1);
  assert.equal(o.frames(1), 100);
  t.begin(2, '5', 1); t.push(2, RATE, block(250, 0), 16);
  assert.equal(o.frames(1), 200, 'a second of the held end, as it is');
  const b = o.samples(2);
  assert.ok(b[0] > 0.99 && b[99] < 0.01);
});

test('crossfade: the held end plays as it is when the next track is not a crossfade', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 1); t.push(1, RATE, block(300, 1), 16); t.end(1);
  t.begin(2, '0', 0);
  assert.equal(o.frames(1), 300);
  assert.deepEqual(o.order(), ['p1', 'end1']);
  t.push(2, RATE, block(50, 0.5), 16);
  assert.deepEqual(o.samples(2), new Array(50).fill(0.5));
});

test('crossfade: the held end plays as it is when the output runs low first', () => {
  const o = rec(10), t = new LJ.Transitions(o);
  t.begin(1, '1', 1); t.push(1, RATE, block(300, 1), 16); t.end(1);
  assert.equal(o.frames(1), 200);
  o.queued = 2.5; t.check();
  assert.equal(o.frames(1), 300);
  assert.deepEqual(o.order(), ['p1', 'end1']);
  assert.equal(t.heldSeconds(), 0);
});

test('crossfade: not across a sample-rate change', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 1); t.push(1, RATE, block(300, 1), 16); t.end(1);
  t.begin(2, '1', 1); t.push(2, 2 * RATE, block(300, 0.5), 16);
  assert.equal(o.frames(1), 300);
  assert.equal(o.samples(2)[0], 0.5);
  assert.deepEqual(o.order().slice(0, 3), ['p1', 'end1', 'p2']);
});

test('crossfade: mono into stereo uses the mono channel on both sides', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 1); t.push(1, RATE, [new Float32Array(200).fill(1)], 16); t.end(1);
  t.begin(2, '1', 1); t.push(2, RATE, block(300, 0), 16);
  const b = o.ops.find((x) => x.op === 'push' && x.seq === 2);
  assert.ok(b.l[0] > 0.99 && b.r[0] > 0.99);
});

test('crossfade: a track shorter than the crossfade ends it, and the rest fades out alone', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 1); t.push(1, RATE, block(300, 1), 16); t.end(1);
  t.begin(2, '1', 1); t.push(2, RATE, block(30, 0), 16); t.end(2);
  assert.equal(o.frames(1), 200);
  const b = o.samples(2);
  assert.equal(b.length, 100, '30 mixed frames, then the 70 left of the outgoing track');
  for (let i = 1; i < 100; i++) assert.ok(b[i] < b[i - 1]);
  assert.deepEqual(o.order(), ['p1', 'end1', 'p2', 'end2']);
});

test('trim during a crossfade plays the rest of the outgoing track as it is', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 1); t.push(1, RATE, block(300, 1), 16); t.end(1);
  t.begin(2, '1', 1); t.push(2, RATE, block(40, 0), 16);
  t.trim(1);
  assert.equal(o.frames(1), 260);
  assert.deepEqual(o.samples(1).slice(200), new Array(60).fill(1));
});

test('stop: a dropped track still plays what it held', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '3', 1); t.push(1, RATE, block(300, 1), 16);
  t.stop(1);
  assert.equal(o.frames(1), 300);
  assert.deepEqual(o.order(), ['p1', 'end1']);
});

test('clear forgets everything', () => {
  const o = rec(), t = new LJ.Transitions(o);
  t.begin(1, '1', 1); t.push(1, RATE, block(300, 1), 16); t.end(1);
  t.clear();
  assert.equal(t.heldSeconds(), 0);
  t.begin(2, '1', 1); t.push(2, RATE, block(300, 0.5), 16);
  assert.equal(o.samples(2)[0], 0.5, 'no crossfade from a flushed track');
});

// -- through the player -------------------------------------------------------

/** 16-bit stereo PCM of n frames at `rate`, all at one level. */
function pcm(n, level) {
  const b = new Uint8Array(n * 4), v = new DataView(b.buffer), x = Math.round(level * 32767);
  for (let i = 0; i < n; i++) { v.setInt16(i * 4, x, true); v.setInt16(i * 4 + 2, x, true); }
  return b;
}
const strm = (o) => LJ.buildStrm(Object.assign({ command: 's', autostart: '1', format: 'p', pcmSize: '1', pcmRate: '3',
  pcmChannels: '2', pcmEndian: '1', request: REQ }, o));

test('player: a crossfade between two tracks, with STMd and STMs as LMS expects', () => {
  const P = makePlayer();
  P.p.start(); P.ctl().onopen();
  P.fromServer(strm({ transType: '1', transPeriod: 1 }));
  const s1 = P.tunnels[1]; s1.onopen(); s1.ondata(HTTP_OK); s1.ondata(pcm(44100 * 8, 0.5)); s1.onclose(true);
  P.p.pump();
  assert.equal(P.out.segs.find((s) => s.seq === 1).frames, 44100 * 7, 'its last second is held');
  // It plays, and is heard: STMs, then STMd (decoder done), and LMS sends the next track.
  P.out.advance(1000); P.tick(10); P.tick(10);
  assert.ok(P.events().includes('STMs') && P.events().includes('STMd'));
  P.fromServer(strm({ transType: '1', transPeriod: 1 }));
  const s2 = P.tunnels[2]; s2.onopen(); s2.ondata(HTTP_OK); s2.ondata(pcm(44100 * 8, 0.25)); s2.onclose(true);
  P.p.pump();
  const a = P.out.segs.find((s) => s.seq === 1), b = P.out.segs.find((s) => s.seq === 2);
  assert.equal(a.frames, 44100 * 7, 'the held end went into the mix');
  assert.ok(a.ended);
  assert.ok(b.frames > 44100, 'the mix and what follows it belong to the next track');
  // The new track starts at the start of the crossfade: STMs comes as the mix is heard.
  const stms = P.events().filter((e) => e === 'STMs').length;
  P.out.advance(44100 * 7 - 1000 + 10); P.tick(10);
  assert.equal(P.events().filter((e) => e === 'STMs').length, stms + 1);
});

test('player: the last track of the queue is not cut short by a crossfade that never comes', () => {
  const P = makePlayer();
  P.p.start(); P.ctl().onopen();
  P.fromServer(strm({ transType: '1', transPeriod: 2 }));
  const s1 = P.tunnels[1]; s1.onopen(); s1.ondata(HTTP_OK); s1.ondata(pcm(44100 * 6, 0.5)); s1.onclose(true);
  P.p.pump();
  assert.equal(P.out.segs[0].frames, 44100 * 4);
  P.out.advance(44100 * 2); P.tick(10);
  assert.equal(P.out.segs[0].frames, 44100 * 6, 'released once the output ran low');
  P.out.advance(44100 * 4); P.tick(10);
  assert.ok(P.events().includes('STMu'));
  assert.equal(P.p.state, 'stopped');
});

test('player: a flush drops a held end', () => {
  const P = makePlayer();
  P.p.start(); P.ctl().onopen();
  P.fromServer(strm({ transType: '1', transPeriod: 1 }));
  const s1 = P.tunnels[1]; s1.onopen(); s1.ondata(HTTP_OK); s1.ondata(pcm(44100 * 3, 0.5)); s1.onclose(true);
  P.p.pump();
  P.fromServer(LJ.buildStrm({ command: 'q' }));
  assert.equal(P.p.tx.heldSeconds(), 0);
});
