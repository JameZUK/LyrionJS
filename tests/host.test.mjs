// The browser host's transport (host/transport.js), the output stage (output/worklet.js) and the
// resampler, under Node with fake browser APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LJ = require('./load.cjs')('core', 'output', 'host');
require('../src/output/webaudio.js');

// --- a fake clock and WebSocket ------------------------------------------------
function fakeEnv() {
  const env = { t: 0, timers: [], sockets: [], listeners: {} };
  env.now = () => env.t;
  env.setTimeout = (f, ms) => { const id = { f, at: env.t + ms }; env.timers.push(id); return id; };
  env.clearTimeout = (id) => { env.timers = env.timers.filter((x) => x !== id); };
  env.setInterval = (f, ms) => { const id = { f, at: env.t + ms, every: ms }; env.timers.push(id); return id; };
  env.clearInterval = env.clearTimeout;
  env.advance = (ms) => {
    const end = env.t + ms;
    for (;;) {
      const due = env.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      env.t = due.at;
      if (due.every) due.at += due.every; else env.timers = env.timers.filter((x) => x !== due);
      due.f();
    }
    env.t = end;
  };
  env.document = { hidden: false, addEventListener: (e, f) => { (env.listeners[e] = env.listeners[e] || new Set()).add(f); }, removeEventListener: (e, f) => { if (env.listeners[e]) env.listeners[e].delete(f); } };
  env.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; env.sockets.push(this); }
    send(d) { this.sent.push(d); }
    close() { this.readyState = 3; }
    // test helpers
    _open() { this.readyState = 1; this.onopen && this.onopen(); }
    _text(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    _bin(u8) { this.onmessage && this.onmessage({ data: u8.slice().buffer }); }
    _close(code) { this.readyState = 3; this.onclose && this.onclose({ code }); }
  };
  return env;
}
const bytes = (...a) => new Uint8Array(a);

test('resume: held frames go first, heartbeats are never held, and the replay is marked', () => {
  const env = fakeEnv();
  const got = []; let opened = 0, resumed = 0;
  const c = LJ.controlSocket('ws://x', env);
  c.onopen = () => opened++; c.onresumed = () => resumed++; c.ondata = (u8, r) => got.push([Array.from(u8), r]);
  const a = env.sockets[0]; a._open(); a._text({ session: 'S', secret: 'K', resumed: false, hold: 10 });
  assert.equal(opened, 1);
  a._bin(bytes(1, 2, 3));
  a._close(1006);                                   // drop
  const stmt = LJ.buildStat({ event: 'STMt', jiffies: 1 }), stms = LJ.buildStat({ event: 'STMs', jiffies: 1 });
  c.send(stmt); c.send(stms);                       // while away
  env.advance(300);
  const b = env.sockets[1]; b._open();
  assert.deepEqual(JSON.parse(b.sent[0]).resume, { session: 'S', secret: 'K', received: 3 });
  b._text({ session: 'S', secret: 'K', resumed: true, hold: 10, replay: 2 });
  assert.equal(b.sent.length, 2, 'the held STMs, not the STMt');
  assert.equal(LJ.latin1(b.sent[1].subarray(8, 12)), 'STMs');
  b._bin(bytes(4)); b._bin(bytes(5, 6, 7));          // replay split across messages, then live data
  assert.deepEqual(got.slice(1), [[[4], true], [[5], true], [[6, 7], false]]);
  assert.equal(resumed, 1, 'resumed once the replay is through');
  c.close();
});

test('a refused resume starts over; listeners are removed when a session ends', () => {
  const env = fakeEnv();
  let closedWith = null;
  const c = LJ.controlSocket('ws://x', env);
  c.onclose = (code) => { closedWith = code; };
  const a = env.sockets[0]; a._open(); a._text({ session: 'S', secret: 'K', resumed: false });
  a._close(1006); env.advance(300);
  env.sockets[1]._open(); env.sockets[1]._close(4404);
  assert.equal(closedWith, 4404);
  assert.equal(env.listeners.visibilitychange.size, 0, 'no visibility listener left');
  assert.equal(env.timers.length, 0, 'no timers left');
});

test('a socket that opens but never says hello is abandoned', () => {
  const env = fakeEnv();
  const c = LJ.controlSocket('ws://x', env);
  env.sockets[0]._open();                           // …and then nothing
  env.advance(7000);
  assert.equal(env.sockets.length, 1, 'no session yet, so nothing to resume');
  let closed = null; c.onclose = (code) => { closed = code; };
  // With a session, a silent new socket is replaced within the hold.
  const env2 = fakeEnv(); const c2 = LJ.controlSocket('ws://x', env2);
  env2.sockets[0]._open(); env2.sockets[0]._text({ session: 'S', secret: 'K', resumed: false });
  env2.sockets[0]._close(1006); env2.advance(300);
  env2.sockets[1]._open();                          // silent
  env2.advance(7500);
  assert.ok(env2.sockets.length >= 3, 'tried again after the silent one');
  c.close(); c2.close();
});

test('a socket silent for two missed LMS polls is dropped and resumed (before LMS gives up at 15 s)', () => {
  const env = fakeEnv();
  const c = LJ.controlSocket('ws://x', env);
  env.sockets[0]._open(); env.sockets[0]._text({ session: 'S', secret: 'K', resumed: false });
  env.advance(10500);
  assert.equal(env.sockets.length, 1, 'one missed poll is not death');
  env.advance(3000);
  assert.equal(env.sockets.length, 2, 'a new socket to resume on');
  env.sockets[1]._open();
  assert.ok(JSON.parse(env.sockets[1].sent[0]).resume);
  c.close();
});

test('the plugin\'s close codes end the session without a resume attempt; a drop resumes', () => {
  const session = (code) => {
    const env = fakeEnv(); let closed = null;
    const c = LJ.controlSocket('ws://x', env); c.onclose = (k) => { closed = k; };
    env.sockets[0]._open(); env.sockets[0]._text({ session: 'S', secret: 'K', resumed: false });
    env.sockets[0]._close(code); env.advance(3000);
    c.close();
    return { tries: env.sockets.length - 1, closed };
  };
  // docs/ARCHITECTURE.md, "Close codes the plugin sends"
  for (const code of [1000, 1001, 1002, 1008, 1009, 1011, 1013, 4000, 4403, 4404]) {
    assert.deepEqual(session(code), { tries: 0, closed: code }, 'close code ' + code);
  }
  for (const code of [1005, 1006]) assert.ok(session(code).tries > 0, 'resumes after ' + code);
});

// --- streams ---------------------------------------------------------------------
function fakeFetch(chunks, { status = 200, stall = false } = {}) {
  return async () => {
    let i = 0;
    return {
      status, statusText: 'OK', headers: new Map([['content-type', 'audio/flac']]),
      body: { getReader: () => ({
        read: () => (i < chunks.length ? Promise.resolve({ value: chunks[i++], done: false })
          : stall ? new Promise(() => {}) : Promise.resolve({ done: true })),
        cancel: () => Promise.resolve(),
      }) },
    };
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a stream stops reading at the window and an ack lets it continue', async () => {
  const env = fakeEnv(); env.fetch = fakeFetch([new Uint8Array(600), new Uint8Array(600), new Uint8Array(600)]); env.origin = 'http://lms:9000';
  const s = LJ.openStream({ ip: null, port: 9000, win: 1000 }, env);
  let got = 0, ended = null; s.ondata = (u8) => { got += u8.length; }; s.onclose = (clean) => { ended = clean; };
  s.send(new TextEncoder().encode('GET /stream.mp3?player=x HTTP/1.0\r\n\r\n'));
  for (let i = 0; i < 20; i++) await tick();
  const head = got - 1200;
  assert.ok(got >= 1200 && got < 1800, 'stopped at the window: ' + got);
  s.ack(got);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(got - head, 1800);
  assert.equal(ended, true);
});

test('a stream whose callback throws still ends (so the player hears about it)', async () => {
  const env = fakeEnv(); env.fetch = fakeFetch([new Uint8Array(10)]); env.origin = 'http://lms:9000';
  const s = LJ.openStream({ ip: null, port: 9000, win: 1e6 }, env);
  let ended = null; let n = 0;
  s.ondata = () => { if (++n === 2) throw new Error('decoder blew up'); };
  s.onclose = (clean) => { ended = clean; };
  s.send(new TextEncoder().encode('GET /x HTTP/1.0\r\n\r\n'));
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(ended, false);
});

test('a stream that stalls with room to send is given up after 30 s', async () => {
  const env = fakeEnv(); env.fetch = fakeFetch([new Uint8Array(10)], { stall: true }); env.origin = 'http://lms:9000';
  const s = LJ.openStream({ ip: null, port: 9000, win: 1e6 }, env);
  let ended = null; s.ondata = () => {}; s.onclose = (clean) => { ended = clean; };
  s.send(new TextEncoder().encode('GET /x HTTP/1.0\r\n\r\n'));
  for (let i = 0; i < 10; i++) await tick();
  env.advance(36000);
  assert.equal(ended, false);
});

test('a stream whose server never answers is given up', async () => {
  const env = fakeEnv();
  env.fetch = (u, o) => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const s = LJ.openStream({ ip: '10.0.0.9', port: 9000, win: 1e6 }, env);
  let ended = null; s.ondata = () => {}; s.onclose = (clean) => { ended = clean; };
  s.send(new TextEncoder().encode('GET /x HTTP/1.0\r\n\r\n'));
  for (let i = 0; i < 5; i++) await tick();
  env.advance(10000);
  assert.equal(ended, null, 'still waiting at 10 s');
  env.advance(10000);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(ended, false, 'given up by 20 s');
  assert.equal(env.timers.length, 0, 'no timers left');
});

// --- the output stage and resampler ---------------------------------------------------
function outputCore() {
  let frame = 0; const msgs = [];
  const port = { postMessage: (m) => msgs.push(m), onmessage: null };
  const core = new LJ.LyrionOutputCore(port, () => frame);
  const render = (n) => { const L = new Float32Array(n), R = new Float32Array(n); core.process([], [[L, R]]); frame += n; return L; };
  const send = (m) => port.onmessage({ data: m });
  return { core, render, send, msgs, setFrame: (f) => { frame = f; } };
}

test('output stage: a timed start begins on the exact frame', () => {
  const o = outputCore();
  o.send({ t: 'push', id: 1, seq: 1, l: new Float32Array(1000).fill(0.5), r: null });
  o.send({ t: 'gain', g: 1, now: true });
  o.send({ t: 'startAt', frame: 300 });
  const out = o.render(512);
  assert.equal(out[299], 0); assert.ok(out[300] > 0.49);
  const seg = o.msgs.find((m) => m.t === 'seg');
  assert.equal(seg.frame, 300);
});

test('output stage: skip crosses chunks; trim keeps the playing track; flush reports its epoch', () => {
  const o = outputCore();
  for (let i = 1; i <= 3; i++) o.send({ t: 'push', id: i, seq: i < 3 ? 1 : 2, l: new Float32Array(100).fill(i / 10), r: null });
  o.send({ t: 'gain', g: 1, now: true }); o.send({ t: 'play' });
  o.send({ t: 'skip', frames: 150 });
  const out = o.render(10);
  assert.ok(Math.abs(out[0] - 0.2) < 1e-6, 'skipped into the second chunk');
  o.send({ t: 'trim', keep: 1 });
  o.render(60);
  assert.ok(o.msgs.filter((m) => m.t === 'pos').at(-1).under, 'the trimmed track never plays');
  o.send({ t: 'flush', epoch: 7 });
  assert.equal(o.msgs.at(-1).epoch, 7);
});

test('resampler: chunked output equals one block, and the length follows the ratio', () => {
  const N = 44100, x = new Float32Array(N).map((_, i) => Math.sin(i / 7));
  const whole = LJ.resampleCubic([x], 44100, 48000, {})[0];
  const st = {}; const parts = [];
  for (let i = 0; i < N; i += 1234) parts.push(...LJ.resampleCubic([x.subarray(i, i + 1234)], 44100, 48000, st)[0]);
  assert.equal(parts.length, whole.length);
  let worst = 0; for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(parts[i] - whole[i]));
  assert.ok(worst < 1e-6, 'worst ' + worst);
  assert.ok(Math.abs(whole.length - 48000) < 5);
});

test('frames sent into a socket that died silently are sent again on resume, from what arrived', () => {
  const env = fakeEnv();
  const c = LJ.controlSocket('ws://x', env);
  const a = env.sockets[0]; a._open(); a._text({ session: 'S', secret: 'K', resumed: false, hold: 10 });
  const helo = new Uint8Array(40), stmd = LJ.buildStat({ event: 'STMd', jiffies: 1 }), hb = LJ.buildStat({ event: 'STMt', jiffies: 2 });
  c.send(helo); c.send(stmd); c.send(hb);            // the STMd and heartbeat never arrive
  a._close(1006); env.advance(300);
  const b = env.sockets[1]; b._open();
  b._text({ session: 'S', secret: 'K', resumed: true, hold: 10, replay: 0, got: helo.length });
  const again = b.sent.slice(1).map((u8) => LJ.latin1(u8.subarray(8, 12)));
  assert.deepEqual(again, ['STMd'], 'the lost STMd once, never the heartbeat');
  // Everything arrived: nothing sent again.
  c.send(stmd);
  b._close(1006); env.advance(300);
  const d = env.sockets[2]; d._open();
  d._text({ session: 'S', secret: 'K', resumed: true, hold: 10, replay: 0, got: helo.length + 2 * stmd.length });
  assert.equal(d.sent.length, 1, 'only the resume request');
  c.close();
});

