// The media-element output against a fake Media Source: a SourceBuffer that works asynchronously
// (and refuses calls while busy), keeps real time ranges read from the MP4 fragments, and can run
// out of quota. These cover the faults found in the v0.1 review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// --- a fake browser ------------------------------------------------------------
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const find = (b, type, from = 0) => { for (let i = from; i + 4 <= b.length; i++) if (b[i] === type.charCodeAt(0) && b[i + 1] === type.charCodeAt(1) && b[i + 2] === type.charCodeAt(2) && b[i + 3] === type.charCodeAt(3)) return i; return -1; };

class Ranges {
  constructor() { this.r = []; }
  add(s, e) { this.r.push([s, e]); this.r.sort((a, b) => a[0] - b[0]); const out = []; for (const x of this.r) { const l = out[out.length - 1]; if (l && x[0] <= l[1] + 1e-6) l[1] = Math.max(l[1], x[1]); else out.push([...x]); } this.r = out; }
  remove(s, e) { const out = []; for (const [a, b] of this.r) { if (b <= s || a >= e) out.push([a, b]); else { if (a < s) out.push([a, s]); if (b > e) out.push([e, b]); } } this.r = out; }
  get length() { return this.r.length; } start(i) { return this.r[i][0]; } end(i) { return this.r[i][1]; }
  total() { return this.r.reduce((t, [a, b]) => t + b - a, 0); }
}

class FakeSourceBuffer {
  constructor(env) { this.env = env; this.updating = false; this.ranges = new Ranges(); this.listeners = {}; this.timescale = 44100; this.log = []; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  get buffered() { return this.ranges; }
  _later(fn) { this.updating = true; this.env.tasks.push(() => { fn(); this.updating = false; for (const f of this.listeners.updateend || []) f(); }); }
  changeType() { if (this.updating) throw Object.assign(new Error('busy'), { name: 'InvalidStateError' }); this.log.push('changeType'); }
  appendBuffer(data) {
    if (this.updating) throw Object.assign(new Error('busy'), { name: 'InvalidStateError' });
    const m = find(data, 'mdhd');
    if (m >= 0) { this.timescale = u32(data, m + 16); this.log.push('init'); this._later(() => {}); return; }
    const tf = find(data, 'tfdt'), tr = find(data, 'trun');
    const base = u32(data, tf + 8) * 4294967296 + u32(data, tf + 12);
    let dur = 0; const n = u32(data, tr + 8);
    for (let k = 0; k < n; k++) dur += u32(data, tr + 16 + 8 * k);
    const s = base / this.timescale, e = (base + dur) / this.timescale;
    if (this.env.quota != null && this.ranges.total() + (e - s) > this.env.quota) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    this.log.push(['append', +s.toFixed(3), +e.toFixed(3)]);
    this._later(() => this.ranges.add(s, e));
  }
  remove(s, e) {
    if (this.updating) throw Object.assign(new Error('busy'), { name: 'InvalidStateError' });
    this.log.push(['remove', s, e]);
    this._later(() => this.ranges.remove(s, e));
  }
  abort() { if (this.updating) throw Object.assign(new Error('busy'), { name: 'InvalidStateError' }); }
}

/** opts.cantPlay: addSourceBuffer refuses the type, as a browser without the codec does;
 *  opts.play: what the element's play() does (a function returning a promise). */
function fakeEnv(opts = {}) {
  const env = { tasks: [], quota: null, sbs: [], sources: 0 };
  class FakeMediaSource {
    constructor() { this.readyState = 'closed'; this.listeners = {}; env.sources++; }
    static isTypeSupported() { return true; }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    addSourceBuffer() {
      if (opts.cantPlay) throw new Error("MediaSource.addSourceBuffer: Can't play type");
      const sb = new FakeSourceBuffer(env); env.sbs.push(sb); return sb;
    }
    // sourceopen comes later, as in a browser
    _open() { env.tasks.push(() => { this.readyState = 'open'; for (const f of this.listeners.sourceopen || []) f(); }); }
  }
  env.MediaSource = FakeMediaSource;
  globalThis.MediaSource = FakeMediaSource;
  globalThis.ManagedMediaSource = undefined;
  globalThis.Audio = class { constructor() { this._v = 1; } get volume() { return this._v; } set volume(v) { this._v = v; } };
  globalThis.URL.createObjectURL = (ms) => { env.lastMs = ms; return 'blob:' + Math.random(); };
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  const el = {
    listeners: {}, paused: true, currentTime: 0, _src: '', played: [], srcs: [], loads: 0,
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    removeEventListener() {},
    set src(v) { this._src = v; this.srcs.push(String(v)); if (env.lastMs && String(v).startsWith('blob:')) env.lastMs._open(); },
    removeAttribute(n) { if (n === 'src') this._src = ''; },
    load() { this.loads++; },
    get src() { return this._src; },
    play() { if (opts.play) return opts.play(this); this.paused = false; return Promise.resolve(); },
    pause() { if (!this.paused) { this.paused = true; env.tasks.push(() => { for (const f of this.listeners.pause || []) f(); }); } },
    fire(ev) { for (const f of this.listeners[ev] || []) f(); },
  };
  env.el = el;
  env.run = () => { let n = 0; while (env.tasks.length && n++ < 10000) env.tasks.shift()(); };
  return env;
}

const LJ = require('./load.cjs')('core', 'output');
require('../src/output/media.js');
const sec = (rate, s, v = 0.1) => [new Float32Array(Math.round(rate * s)).fill(v), new Float32Array(Math.round(rate * s)).fill(v)];

async function ready(env) {
  const o = new LJ.MediaOutput(env.el);
  o.prime(); await Promise.resolve(); await Promise.resolve();
  env.run();
  return o;
}

test('a trim while the buffer is busy still removes the old next track', async () => {
  const env = fakeEnv(); const o = await ready(env);
  o.push(1, 44100, sec(44100, 3), 16); o.endSeq(1);
  o.push(2, 44100, sec(44100, 3), 16);           // the next track, appending as we trim
  assert.ok(env.sbs[0].updating, 'buffer busy at the moment of the trim');
  o.trimAfter(1);
  env.run();
  const r = env.sbs[0].buffered;
  assert.ok(r.length === 1 && Math.abs(r.end(0) - 3) < 0.01, `only track 1 left: ${JSON.stringify(r.r)}`);
  o.dispose();
});

test('a flush while a remove is running leaves no old audio behind', async () => {
  const env = fakeEnv(); const o = await ready(env);
  o.push(1, 44100, sec(44100, 5), 16); o.endSeq(1); env.run();
  env.el.currentTime = 30; o._evict(0);           // a remove is now running
  o.flush();
  o.push(2, 44100, sec(44100, 2), 16); o.endSeq(2);
  env.run();
  const r = env.sbs[0].buffered;
  assert.ok(r.r.every(([a]) => a >= 30), `nothing before the flush point remains: ${JSON.stringify(r.r)}`);
  o.dispose();
});

test('when the buffer is full, audio waits and is appended after eviction, in order', async () => {
  const env = fakeEnv(); const o = await ready(env);
  env.quota = 8;                                   // seconds the fake will hold
  o.push(1, 44100, sec(44100, 6), 16); env.run();
  env.el.currentTime = 5.5;                        // most of it played
  o.push(1, 44100, sec(44100, 6), 16); o.endSeq(1); env.run();
  assert.ok(o.sbq.full && o.sbq.pendingAppends, 'audio waits while the buffer is full');
  // Playback moves on; the eviction timer (driven directly here) makes room.
  for (let t = 6; t <= 12; t++) { env.el.currentTime = t; o._evict(2); env.run(); }
  const appends = env.sbs[0].log.filter((x) => x[0] === 'append');
  for (let i = 1; i < appends.length; i++) assert.ok(appends[i][1] >= appends[i - 1][1], 'in order');
  assert.ok(Math.abs(env.sbs[0].buffered.end(env.sbs[0].buffered.length - 1) - 12) < 0.01, 'everything appended in the end');
  o.dispose();
});

test('a long session keeps the buffer bounded (eviction actually runs)', async () => {
  const env = fakeEnv(); const o = await ready(env);
  for (let t = 0; t < 600; t += 10) {              // ten minutes in 10 s pushes
    o.push(1, 44100, sec(44100, 10), 16); env.run();
    env.el.currentTime = t + 5;
    o._evict(10); env.run();
  }
  assert.ok(env.sbs[0].buffered.total() < 40, 'buffered ' + env.sbs[0].buffered.total().toFixed(1) + ' s');
  o.dispose();
});

test('playback steps over a hole of any size to the next audio', async () => {
  const env = fakeEnv(); const o = await ready(env);
  o.push(1, 44100, sec(44100, 2), 16); o.endSeq(1); env.run();
  env.sbs[0].ranges.remove(2, 2); env.sbs[0].ranges.add(4.5, 6);   // audio after a 2.5 s hole
  o.play(); env.el.currentTime = 2;
  o._unstick();
  assert.equal(env.el.currentTime, 4.5);
  o.dispose();
});

test('after unlocking, a pause by the OS is still reported', async () => {
  const env = fakeEnv(); const o = await ready(env);
  let reported = 0; o.externalPause = () => reported++;
  o.play(); await Promise.resolve();
  env.el.pause(); env.run();                       // a phone call
  assert.equal(reported, 1);
  o.pause(); env.run();                            // our own pause is not reported
  assert.equal(reported, 1);
  o.dispose();
});

test('a failed media source is replaced and the host told', async () => {
  const env = fakeEnv(); const o = await ready(env);
  let told = null; o.onFailure = (why) => { told = why; };
  o.push(1, 44100, sec(44100, 2), 16); env.run();
  env.el.fire('error');
  env.run();
  assert.match(told, /element error/);
  assert.equal(env.sbs.length, 2, 'a new source buffer');
  o.push(2, 44100, sec(44100, 1), 16); o.endSeq(2); env.run();
  assert.ok(env.sbs[1].buffered.length === 1, 'and it takes audio');
  o.dispose();
});

test('a browser that refuses the unlock clip itself (not the sound) is still unlocked by the tap', async () => {
  // Firefox: an unplayable clip is a NotSupportedError; only NotAllowedError means "no sound yet".
  const notSupported = Object.assign(new Error('not suitable'), { name: 'NotSupportedError' });
  const env = fakeEnv({ play: (el) => (String(el.src).startsWith('data:') ? Promise.reject(notSupported) : Promise.resolve()) });
  const o = new LJ.MediaOutput(env.el);
  o.prime(); for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(o.needsGesture, false);
  const refused = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
  const env2 = fakeEnv({ play: () => Promise.reject(refused) });
  const o2 = new LJ.MediaOutput(env2.el);
  o2.prime(); for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(o2.needsGesture, true, 'a refusal keeps it locked');
  o.dispose(); o2.dispose();
});

test('a media source the browser keeps refusing is given up, not reopened for ever', async () => {
  const env = fakeEnv({ cantPlay: true });
  let fatal = 0, told = 0;
  const o = new LJ.MediaOutput(env.el);
  o.onFailure = (why, playing, isFatal) => { told++; if (isFatal) fatal++; };
  o.prime(); await Promise.resolve(); await Promise.resolve();
  env.run();
  assert.equal(fatal, 1, 'told once that it is fatal');
  assert.equal(told, 3);
  assert.ok(env.sources <= 4, 'stopped opening sources: ' + env.sources);
  o.dispose();
});

// --- review fixes (v0.2) ---------------------------------------------------------
const lastEnd = (sb) => sb.buffered.end(sb.buffered.length - 1);

test('hi-res with a quota under 12 s: a full buffer with the playhead at its end is evicted, not waited on for ever', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const env = fakeEnv(); const o = await ready(env);
  env.quota = 8;                                   // less than the 10 s kept behind the playhead
  o.play();
  for (let i = 0; i < 20; i++) o.push(1, 44100, sec(44100, 1), 16);
  o.endSeq(1); env.run();
  assert.ok(o.sbq.full && o.sbq.pendingAppends, 'audio waits while the buffer is full');
  const sb = env.sbs[0];
  // The element plays up to the end of what is buffered and waits there; only the timer runs.
  // (Not an underrun: with every track decoded the player would take that for the end, STMu.)
  for (let k = 0; k < 20 && o.sbq.pendingAppends; k++) { env.el.currentTime = lastEnd(sb); t.mock.timers.tick(5000); env.run(); }
  assert.ok(!o.sbq.pendingAppends, 'everything appended in the end');
  assert.ok(Math.abs(lastEnd(sb) - 20) < 0.01, 'buffered to ' + lastEnd(sb));
  o.dispose();
});

test('a full buffer is evicted as soon as the element waits', async () => {
  const env = fakeEnv(); const o = await ready(env);
  env.quota = 8;
  o.play();
  for (let i = 0; i < 12; i++) o.push(1, 44100, sec(44100, 1), 16);
  o.endSeq(1); env.run();
  assert.ok(o.sbq.full);
  const sb = env.sbs[0];
  env.el.currentTime = lastEnd(sb); env.el.fire('waiting'); env.run();
  assert.ok(sb.log.some((x) => x[0] === 'remove'), 'a remove ran');
  assert.ok(lastEnd(sb) > 8.5, 'more audio went in: ' + lastEnd(sb));
  o.dispose();
});

test('a source that took audio and then failed does not count toward giving up', async () => {
  const env = fakeEnv(); const o = await ready(env);
  let fatal = 0, told = 0; o.onFailure = (why, playing, isFatal) => { told++; if (isFatal) fatal++; };
  for (let i = 0; i < 5; i++) { o.push(1, 44100, sec(44100, 2), 16); o.endSeq(1); env.run(); env.el.fire('error'); env.run(); }
  assert.equal(told, 5); assert.equal(fatal, 0, 'each fresh source took audio');
  // Fresh sources that never take audio still count.
  for (let i = 0; i < 3; i++) { env.el.fire('error'); env.run(); }
  assert.equal(fatal, 1, 'three failures without audio are fatal');
  o.dispose();
});

test('a second tap while the first unlock is still pending sets the stream source once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const pend = [];
  const env = fakeEnv({ play: () => new Promise((res, rej) => pend.push({ res, rej })) });
  const o = new LJ.MediaOutput(env.el);
  o.unlock();                                      // tap 1: play() never settles…
  t.mock.timers.tick(2600);                        // …so the unlock gives up waiting
  o.unlock();                                      // tap 2
  pend[0].rej(Object.assign(new Error('interrupted by a new load'), { name: 'AbortError' }));
  pend[1].res();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  env.run();
  assert.equal(o.needsGesture, false);
  assert.equal(env.el.srcs.filter((s) => s.startsWith('blob:')).length, 1, 'stream source set once: ' + env.el.srcs);
  assert.equal(env.sbs.length, 1);
  o.dispose();
});

test('sync corrections do not pile up timers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const env = fakeEnv(); const o = await ready(env);
  o.play();
  for (let i = 0; i < 10; i++) { o.pauseFor(10); t.mock.timers.tick(20); }
  assert.equal(o.timers.length, 0);
  o.dispose();
});

test('the self test resolves false when the browser throws', async () => {
  fakeEnv();
  globalThis.document = { createElement: () => ({ removeAttribute() {}, load() {} }) };
  globalThis.URL.createObjectURL = () => { throw new Error('no blob URLs'); };
  try { assert.equal(await LJ.selfTest(), false); } finally { delete globalThis.document; }
});

test('dispose detaches the element from the media source', async () => {
  const env = fakeEnv(); const o = await ready(env);
  o.dispose();
  assert.equal(env.el.src, ''); assert.equal(env.el.loads, 1);
});
