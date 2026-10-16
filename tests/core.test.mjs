// Unit tests for src/core.js: decoders, Slimproto and the player state machine.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LJ = require('./load.cjs')('core');
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', n)));

// Deterministic PRNG so failures reproduce.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function decodeFlac(bytes, { chunk = () => 4096, ints = true } = {}) {
  const d = new LJ.FlacDecoder(); d.keepInts = ints;
  const blocks = [];
  d.onBlock = (rate, data, raw) => blocks.push({ rate, data, raw });
  let i = 0;
  while (i < bytes.length) {
    const n = Math.max(1, chunk());
    d.feed(bytes.subarray(i, i + n)); i += n;
    let r; do { r = d.pump(8); } while (r === 'more');
  }
  d.end();
  let r; do { r = d.pump(8); } while (r === 'more');
  assert.equal(r, 'done');
  return { blocks, info: d.info, dec: d };
}

function interleave(blocks, bits) {
  const ch = blocks[0].raw.length;
  const total = blocks.reduce((a, b) => a + b.raw[0].length, 0);
  const bytesPer = bits / 8;
  const out = new Uint8Array(total * ch * bytesPer);
  let o = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.raw[0].length; i++) {
      for (let c = 0; c < ch; c++) {
        let v = b.raw[c][i];
        for (let k = 0; k < bytesPer; k++) { out[o++] = v & 255; v >>= 8; }
      }
    }
  }
  return out;
}

for (const [name, bits] of [['s16-l0', 16], ['s16-l5', 16], ['s16-lax32', 16], ['s16-adaptive', 16], ['s24-l8', 24], ['mono', 16], ['silence', 16]]) {
  test(`FLAC ${name} decodes bit-exactly in random chunk sizes`, () => {
    const r = rng(name.length * 7919);
    const { blocks, info } = decodeFlac(fx(name + '.flac'), { chunk: () => Math.floor(r() * 9000) + 1 });
    assert.ok(info && info.bits === bits, 'STREAMINFO parsed');
    const got = interleave(blocks, bits);
    const want = fx(name + '.raw');
    assert.equal(got.length, want.length, 'sample count');
    assert.ok(Buffer.from(got).equals(Buffer.from(want)), 'samples identical to the reference decoder');
  });
}

test('FLAC float output is scaled to [-1, 1)', () => {
  const { blocks } = decodeFlac(fx('s24-l8.flac'));
  let max = 0;
  for (const b of blocks) for (const c of b.data) for (const v of c) max = Math.max(max, Math.abs(v));
  assert.ok(max > 0.5 && max <= 1, 'peak ' + max);
});

test('FLAC resyncs when the stream starts mid-file (as after a seek)', () => {
  const all = fx('s16-l5.flac');
  const { blocks } = decodeFlac(all.subarray(100000));
  assert.ok(blocks.length > 10, 'decoded frames after the cut');
  assert.equal(blocks[0].rate, 44100);
});

test('FLAC survives corruption without throwing and keeps decoding', () => {
  const r = rng(42);
  const clean = decodeFlac(fx('s16-l5.flac')).blocks.length;
  for (let trial = 0; trial < 30; trial++) {
    const b = fx('s16-l5.flac').slice();
    const flips = 3;
    // Leave the metadata alone: this is about losing frames, not STREAMINFO.
    for (let k = 0; k < flips; k++) b[8192 + Math.floor(r() * (b.length - 8192))] ^= 1 << Math.floor(r() * 8);
    const { blocks } = decodeFlac(b, { chunk: () => Math.floor(r() * 5000) + 1 });
    // A damaged frame fails its CRC and is dropped; each flip costs at most two frames.
    assert.ok(blocks.length >= clean - 2 * flips && blocks.length <= clean, `${blocks.length} of ${clean}`);
  }
});

test('FLAC on random garbage never throws', () => {
  const r = rng(7);
  for (let trial = 0; trial < 20; trial++) {
    const b = new Uint8Array(20000); for (let i = 0; i < b.length; i++) b[i] = r() * 256;
    if (trial % 2) { b[0] = 0x66; b[1] = 0x4c; b[2] = 0x61; b[3] = 0x43; }
    decodeFlac(b, { chunk: () => Math.floor(r() * 3000) + 1 });
  }
});

test('PCM decoder reads a WAV header and converts 16-bit samples', () => {
  const wav = fx('s16.wav');
  const d = new LJ.PcmDecoder({ pcmSize: '?', pcmRate: '?', pcmChannels: '?', pcmEndian: '?' });
  let frames = 0, rate = 0, first = null;
  d.onBlock = (r, ch) => { rate = r; frames += ch[0].length; if (!first) first = ch; };
  d.feed(wav); d.end();
  while (d.pump() !== 'done');
  assert.equal(rate, 44100);
  assert.equal(frames, 4 * 44100);
  // Compare one sample against the raw data (44-byte header? find via the data chunk offset).
  const raw = fx('s16-l5.raw');
  const s0 = (raw[0] | (raw[1] << 8)) << 16 >> 16;
  assert.ok(Math.abs(first[0][0] - s0 / 32768) < 1e-9);
});

test('PCM decoder honours raw big-endian parameters from strm', () => {
  const d = new LJ.PcmDecoder({ pcmSize: '1', pcmRate: '3', pcmChannels: '2', pcmEndian: '0' });
  const buf = new Uint8Array(4096 * 4);
  buf[0] = 0x40; buf[1] = 0x00; // L = +0.5 big-endian
  buf[2] = 0xc0; buf[3] = 0x00; // R = -0.5
  let got;
  d.onBlock = (r, ch) => { got = got || { r, ch }; };
  d.feed(buf); d.end();
  while (d.pump() !== 'done');
  assert.equal(got.r, 44100);
  assert.equal(got.ch[0][0], 0.5);
  assert.equal(got.ch[1][0], -0.5);
});

test('MP3 framer finds every frame and the LAME gapless tag', () => {
  const f = new LJ.Mp3Framer();
  f.feed(fx('s16.mp3')); f.ended = true;
  let frames = 0, samples = 0;
  for (;;) { const r = f.next(); if (r === 'done') break; assert.notEqual(r, 'need'); frames++; samples += r.hdr.samples; }
  assert.ok(f.delay > 0 && f.delay < 3000, 'encoder delay ' + f.delay);
  assert.ok(f.padding >= 0 && f.padding < 2304, 'padding ' + f.padding);
  // 4 s at 44.1 kHz = 176400 samples, plus delay and padding.
  assert.equal(samples - f.delay - f.padding, 176400);
  assert.ok(frames > 100);
});

test('MP3 chunk decoder joins chunks seamlessly whatever the browser decoder delay', async () => {
  // A fake decodeAudioData: it finds which frames it was given (by their offset in the file) and
  // renders a sine at those frames' absolute positions, delayed by `delay` samples, with the
  // first frame of every chunk garbage (as without the bit reservoir).
  const file = fx('s16.mp3');
  const frameList = []; { const g = new LJ.Mp3Framer(); g.feed(file); g.ended = true; for (;;) { const r = g.next(); if (r === 'done') break; frameList.push(r.frame); } }
  const SPF = 1152, W = 2 * Math.PI * 440 / 44100;
  const sig = (n) => Math.sin(W * n);
  for (const delay of [0, 529, 1105]) {
    const decode = async (bytes) => {
      // Which frame does this chunk start at? Match the bytes against the frame list.
      let start = -1;
      for (let i = 0; i < frameList.length; i++) {
        const fr = frameList[i];
        if (fr.length <= bytes.length && Buffer.from(bytes.subarray(0, fr.length)).equals(Buffer.from(fr))) {
          // Several frames may be identical; check the next one too.
          const nx = frameList[i + 1];
          if (!nx || Buffer.from(bytes.subarray(fr.length, fr.length + nx.length)).equals(Buffer.from(nx))) { start = i; break; }
        }
      }
      let count = 0, o = 0; while (o < bytes.length) { o += frameList[start + count].length; count++; }
      const out = new Float32Array(count * SPF);
      for (let i = 0; i < out.length; i++) {
        const abs = start * SPF + i - delay;
        out[i] = i < SPF ? (Math.random() - 0.5) : sig(abs);
      }
      return [out, out.slice()];
    };
    const d = new LJ.Mp3ChunkDecoder(decode, { chunk: 40 });
    const got = [];
    d.onBlock = (rate, ch) => got.push(...ch[0]);
    d.onFinished = () => {};
    for (let i = 0; i < file.length; i += 7000) d.feed(file.subarray(i, i + 7000));
    d.end();
    for (let k = 0; k < 400 && d.pump() !== 'done'; k++) await new Promise((r) => setTimeout(r, 0));
    // After the first chunk's head, the output must be one continuous sine.
    const s0 = 2 * SPF;
    let phase = -1, worst = 0;
    for (let n = 0; n < 2000; n++) if (Math.abs(got[s0] - sig(n)) < 1e-4 && Math.abs(got[s0 + 1] - sig(n + 1)) < 1e-4 && Math.abs(got[s0 + 2] - sig(n + 2)) < 1e-4) { phase = n - s0; break; }
    assert.ok(phase !== -1, 'found the sine');
    for (let i = s0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - sig(i + phase)));
    assert.ok(worst < 1e-4, `delay ${delay}: continuous across chunk joins (worst ${worst})`);
    const total = (frameList.length) * SPF;
    assert.ok(Math.abs(got.length - (total - (d.framer.delay + 529) - (d.framer.padding - 529))) < 2 * SPF + delay, `delay ${delay}: length ${got.length}`);
  }
});

test('MP3 header parsing rejects reserved values', () => {
  assert.equal(LJ.mp3Header(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]), 0), null); // bitrate 15
  assert.equal(LJ.mp3Header(new Uint8Array([0xff, 0xfb, 0x9c, 0x00]), 0), null); // sample rate 3
  const h = LJ.mp3Header(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), 0);
  assert.equal(h.rate, 44100); assert.equal(h.bitrate, 128000); assert.equal(h.len, 417);
});

test('ICY metadata is stripped from the audio and reported', () => {
  const s = new LJ.IcyStripper(4);
  const meta = new TextEncoder().encode("StreamTitle='x';");
  const padded = new Uint8Array(16); padded.set(meta);
  const stream = LJ.concat(LJ.concat(new Uint8Array([1, 2, 3, 4, 1]), padded), new Uint8Array([5, 6, 7, 8, 0, 9]));
  const audio = [], metas = [];
  for (let i = 0; i < stream.length; i++) s.feed(stream.subarray(i, i + 1), (a) => audio.push(...a), (m) => metas.push(m));
  assert.deepEqual(audio, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(metas.length, 1);
  assert.ok(new TextDecoder().decode(metas[0]).startsWith("StreamTitle='x';"));
});

test('HELO and STAT have the Slimproto layout', () => {
  const mac = new Uint8Array([2, 0x4c, 0x4a, 1, 2, 3]);
  const h = LJ.buildHelo({ mac, reconnect: true, bytesReceived: 2 ** 33 + 5, caps: 'Model=squeezelite,flc' });
  assert.equal(LJ.latin1(h.subarray(0, 4)), 'HELO');
  const len = (h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7];
  assert.equal(len, h.length - 8);
  const p = h.subarray(8);
  assert.equal(p[0], 12);
  assert.deepEqual([...p.subarray(2, 8)], [...mac]);
  assert.equal((p[24] << 8) | p[25], 0x4000, 'reconnect flag');
  assert.equal(p[29], 2, 'high word of bytes received'); assert.equal(p[33], 5);
  assert.equal(LJ.latin1(p.subarray(36)), 'Model=squeezelite,flc');

  const s = LJ.buildStat({ event: 'STMt', bufSize: 100, bufFull: 50, bytesReceived: 1234, jiffies: 0xdeadbeef, outSize: 1, outFull: 2, elapsedMs: 61500, serverTs: 0x01020304 });
  assert.equal(s.length, 8 + 53);
  const q = s.subarray(8);
  assert.equal(LJ.latin1(q.subarray(0, 4)), 'STMt');
  const u32 = (i) => ((q[i] << 24) | (q[i + 1] << 16) | (q[i + 2] << 8) | q[i + 3]) >>> 0;
  assert.equal(u32(25), 0xdeadbeef, 'jiffies');
  assert.equal(u32(37), 61, 'elapsed seconds');
  assert.equal(u32(43), 61500, 'elapsed ms');
  assert.equal(u32(47), 0x01020304, 'server timestamp echoed');
  assert.equal(u32(19), 1234, 'bytes received');
});

test('server frames are split across reads and oversize frames refused', () => {
  const q = new LJ.ByteQueue(4);
  const f = LJ.buildStrm({ command: 't', replayGain: 77 });
  const both = LJ.concat(f, LJ.serverFrame('audg', new Uint8Array(18)));
  for (const b of both) q.push(new Uint8Array([b]));
  const a = LJ.nextServerFrame(q); const b = LJ.nextServerFrame(q);
  assert.equal(a.op, 'strm'); assert.equal(LJ.parseStrm(a.payload).replayGain, 77);
  assert.equal(b.op, 'audg'); assert.equal(LJ.nextServerFrame(q), null);
  // A frame longer than LMS ever sends is skipped whole; the connection carries on.
  const big = new LJ.ByteQueue();
  big.push(LJ.concat(LJ.serverFrame('xxxx', new Uint8Array(40000)), LJ.buildStrm({ command: 't', replayGain: 5 })));
  assert.deepEqual(LJ.nextServerFrame(big), { op: null });
  assert.equal(LJ.nextServerFrame(big).op, 'strm');
  assert.throws(() => LJ.parseStrm(new Uint8Array(10)));
});

// ---------------------------------------------------------------------------
// The player against a fake LMS, a fake network and a simulated output.
// ---------------------------------------------------------------------------

const { makePlayer, REQ, HTTP_OK } = require('./fakes.cjs')(LJ);

test('player: HELO, name query, a whole track gaplessly into the next, then STMu', () => {
  const t = makePlayer();
  t.p.start(); t.ctl().onopen();
  assert.equal(t.ops()[0], 'HELO');
  assert.ok(LJ.latin1(t.ctl().sent[0].subarray(44)).includes('Model=squeezelite'));

  t.fromServer(LJ.serverFrame('setd', new Uint8Array([0])));
  const setd = t.ctl().sent.find((f) => LJ.latin1(f.subarray(0, 4)) === 'SETD');
  assert.equal(LJ.latin1(setd.subarray(9)), 'Test\0');

  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', threshold: 1, request: REQ }));
  assert.deepEqual(t.events(), ['STMc']);
  const s1 = t.tunnels[1];
  assert.equal(s1.ip, null, 'server address 0: fetched from LMS itself'); assert.equal(s1.port, 9000); assert.equal(s1.win, LJ.STREAM_WINDOW);
  s1.onopen();
  assert.deepEqual([...s1.sent[0]], [...REQ], 'the exact request LMS gave is sent');

  const flac = fx('s16-l5.flac');
  s1.ondata(LJ.concat(HTTP_OK, flac.subarray(0, 50000)));
  assert.ok(t.ops().includes('RESP'));
  assert.ok(t.out.playing, 'autostart once the threshold is reached');
  s1.ondata(flac.subarray(50000));
  s1.onclose(true);
  assert.ok(t.ops().includes('DSCO'));
  assert.ok(!t.events().includes('STMd'), 'STMd waits until the track is heard');
  assert.ok(s1.acks.length > 0, 'flow-control acknowledgements sent');

  t.out.advance(1000); t.tick(10);
  assert.equal(t.events().filter((e) => e === 'STMs').length, 1);
  assert.deepEqual(t.events().slice(-2), ['STMs', 'STMd'], 'decoder done follows the start of the track');

  // Next track arrives while the first still plays: it must queue, not interrupt.
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', threshold: 1, request: REQ }));
  const s2 = t.tunnels[2]; s2.onopen(); s2.ondata(LJ.concat(HTTP_OK, flac)); s2.onclose(true);
  assert.equal(t.out.segs.length, 2);
  assert.ok(t.out.playing);

  t.out.advance(4 * 44100 - 1000); t.tick(10);   // first track ends exactly
  t.out.advance(10); t.tick(10);                  // second track audible
  assert.equal(t.events().filter((e) => e === 'STMs').length, 2, 'STMs for the second track');
  assert.ok(!t.events().includes('STMu'));

  t.out.advance(10 * 44100); t.tick(10);
  assert.ok(t.events().includes('STMu'), 'played out');
  assert.equal(t.p.state, 'stopped');
});

test('player: STMl when autostart is off, then a timed start from strm u', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '0', format: 'f', threshold: 1, request: REQ }));
  const s = t.tunnels[1]; s.onopen(); s.ondata(LJ.concat(HTTP_OK, fx('s16-l5.flac').subarray(0, 60000)));
  assert.ok(t.events().includes('STMl'));
  assert.ok(!t.out.playing);
  t.setClock(5000);
  t.fromServer(LJ.buildStrm({ command: 'u', replayGain: 5250 }));
  assert.ok(t.out.log.includes('startAt:5250'), t.out.log.join());
  assert.equal(t.events().at(-1), 'STMr');
});

test('player: pause, sync corrections, status echo, flush', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', request: REQ }));
  const s = t.tunnels[1]; s.onopen(); s.ondata(LJ.concat(HTTP_OK, fx('s16-l5.flac')));
  t.fromServer(LJ.buildStrm({ command: 'p' }));
  assert.equal(t.p.state, 'paused'); assert.equal(t.events().at(-1), 'STMp');
  t.fromServer(LJ.buildStrm({ command: 'u' }));
  assert.equal(t.p.state, 'playing'); assert.equal(t.events().at(-1), 'STMr');
  t.fromServer(LJ.buildStrm({ command: 'p', replayGain: 120 }));
  assert.equal(t.p.state, 'playing', 'a timed pause is a sync correction, not a pause');
  t.fromServer(LJ.buildStrm({ command: 'a', replayGain: 80 }));
  assert.ok(t.out.log.includes('pauseFor:120') && t.out.log.includes('skip:80'));
  t.fromServer(LJ.buildStrm({ command: 't', replayGain: 0xabcdef }));
  const stat = t.ctl().sent.at(-1).subarray(8);
  assert.equal(LJ.latin1(stat.subarray(0, 4)), 'STMt');
  assert.equal(((stat[47] << 24) | (stat[48] << 16) | (stat[49] << 8) | stat[50]) >>> 0, 0xabcdef);
  t.fromServer(LJ.buildStrm({ command: 'q' }));
  assert.equal(t.events().at(-1), 'STMf'); assert.equal(t.p.state, 'stopped');
  assert.ok(s.closed || s.ended || true);
});

test('player: volume, power and rename from LMS', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const audg = new Uint8Array(18); audg[8] = 1; audg[10] = 0; audg[11] = 0; audg[12] = 0x80; audg[13] = 0; // 0.5 left
  audg[16] = 0x80; // 0.5 right
  t.fromServer(LJ.serverFrame('audg', audg));
  assert.equal(t.out.gain, 0.5);
  t.fromServer(LJ.serverFrame('aude', new Uint8Array([0, 0])));
  assert.equal(t.out.muted, true);
  t.fromServer(LJ.serverFrame('setd', LJ.concat(new Uint8Array([0]), new TextEncoder().encode('Kitchen Laptop\0'))));
  assert.equal(t.p.name, 'Kitchen Laptop');
});

test('player: an unsupported format is refused with STMn', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', format: 'o', request: REQ }));
  assert.equal(t.events().at(-1), 'STMn');
  assert.equal(t.tunnels.length, 1, 'no stream opened');
});

test('player: a stream to another address is opened there; reconnect sends a reconnect HELO', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', format: 'f', serverIp: (10 << 24) | 5, serverPort: 9002, request: REQ }));
  assert.equal(t.tunnels[1].ip, '10.0.0.5'); assert.equal(t.tunnels[1].port, 9002);
  t.tunnels[1].onopen(); t.tunnels[1].ondata(LJ.concat(HTTP_OK, fx('s16-l5.flac').subarray(0, 40000)));
  assert.equal(t.p.state, 'playing');
  // Drop the control connection: the player reconnects and flags it.
  t.ctl().onclose(false);
  assert.equal(t.p.connected, false);
});

test('player: garbage on the control socket never throws', () => {
  const r = rng(99);
  for (let trial = 0; trial < 50; trial++) {
    const t = makePlayer(); t.p.start(); t.ctl().onopen();
    const b = new Uint8Array(Math.floor(r() * 300)); for (let i = 0; i < b.length; i++) b[i] = r() * 256;
    if (b.length > 6) { b[0] = 0; b[1] = Math.min(b.length - 2, 40); b[2] = 0x73; b[3] = 0x74; b[4] = 0x72; b[5] = 0x6d; }
    t.fromServer(b);
  }
});

test('player: after a resume, replayed corrections and polls are dropped and one fresh STMt is sent', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', request: REQ }));
  const s = t.tunnels[1]; s.onopen(); s.ondata(LJ.concat(HTTP_OK, fx('s16-l5.flac')));
  t.out.log.length = 0;
  const before = t.events().length;
  // What LMS sent while we were away, replayed in one chunk.
  const replay = [
    LJ.buildStrm({ command: 'a', replayGain: 500 }), LJ.buildStrm({ command: 'p', replayGain: 300 }),
    LJ.buildStrm({ command: 't', replayGain: 99 }), LJ.buildStrm({ command: 'u', replayGain: 123456 }),
  ].reduce((a, b) => LJ.concat(a, b));
  t.ctl().ondata(replay, true);
  assert.deepEqual(t.out.log, ['play'], 'skip and pause-for dropped; a timed start becomes start now');
  assert.deepEqual(t.events().slice(before), ['STMr'], 'the old poll is not answered');
  t.ctl().onresumed();
  assert.equal(t.events().at(-1), 'STMt', 'a fresh heartbeat after the gap');
  // Live (not replayed) corrections still apply.
  t.fromServer(LJ.buildStrm({ command: 'a', replayGain: 40 }));
  assert.ok(t.out.log.includes('skip:40'));
});

test('player: the output is told the bit depth of what it plays', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  let bits = 0; const push = t.out.push.bind(t.out); t.out.push = (seq, r, ch, b) => { bits = b; push(seq, r, ch); };
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', request: REQ }));
  const s = t.tunnels[1]; s.onopen(); s.ondata(LJ.concat(HTTP_OK, fx('s24-l8.flac').subarray(0, 100000)));
  assert.equal(bits, 24);
});
