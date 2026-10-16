// Regression tests for faults found in the second review of the core. Each failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LJ = require('./load.cjs')('core');
const { makePlayer, REQ, HTTP_OK } = require('./fakes.cjs')(LJ);
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', n)));
const statsOf = (tun) => tun.sent.filter((f) => LJ.latin1(f.subarray(0, 4)) === 'STAT').map((f) => LJ.latin1(f.subarray(8, 12)));
const PCM_HDR = { format: 'p', pcmSize: '?', pcmRate: '?', pcmChannels: '?', pcmEndian: '?' };

/** Starts one track and returns its stream, opened. */
function startTrack(t, s) {
  t.fromServer(LJ.buildStrm(Object.assign({ command: 's', autostart: '1', format: 'f', threshold: 1, request: REQ }, s)));
  const st = t.tunnels[t.tunnels.length - 1]; st.onopen(); return st;
}

// -- M1: a track that yields no audio must not leave the player waiting forever ------------

test('M1: a stream of undecodable data ends with STMd, STMu and the player stopped', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t);
  s.ondata(LJ.concat(HTTP_OK, new Uint8Array(5000).fill(0x55))); s.onclose(true);
  t.tick(10);
  assert.deepEqual(t.events(), ['STMc', 'STMd', 'STMu']);
  assert.equal(t.p.state, 'stopped');
});

test('M1: a stream that fails before any response is reported STMn and the player stops', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t);
  s.onclose(false);
  assert.equal(t.events().at(-1), 'STMn');
  assert.equal(t.p.state, 'stopped');
  assert.equal(t.ops().filter((o) => o === 'DSCO').length, 1);
});

test('M1: a decoder error (onError, then done) is reported STMn', () => {
  const bad = () => { const d = new LJ.FlacDecoder(); d.pump = () => { if (d.onError) d.onError('bad data'); return 'done'; }; return d; };
  const t = makePlayer({ decoders: { f: bad } }); t.p.start(); t.ctl().onopen();
  const s = startTrack(t);
  s.ondata(LJ.concat(HTTP_OK, new Uint8Array(100)));
  assert.equal(t.events().at(-1), 'STMn');
  assert.ok(!t.events().includes('STMd'));
  assert.equal(t.p.state, 'stopped');
  assert.match(t.p.lastError, /bad data/);
});

test('M1: PCM of a bit depth that cannot be played is reported STMn', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t, { format: 'p', pcmSize: '1', pcmRate: '3', pcmChannels: '2', pcmEndian: '1' });
  const wav = fx('s16.wav').slice(); wav[34] = 40;   // 40 bits per sample
  s.ondata(LJ.concat(HTTP_OK, wav)); s.onclose(true);
  assert.equal(t.events().at(-1), 'STMn');
  assert.equal(t.p.state, 'stopped');
});

// -- L7: 32-bit FLAC -------------------------------------------------------------------

test('L7: 32-bit FLAC is reported STMn instead of being silently dropped', () => {
  const f = fx('s16-l5.flac').slice();
  // STREAMINFO bits-per-sample (minus one) is 5 bits across bytes 20 and 21: make it 31.
  f[8 + 12] = (f[8 + 12] & 0xfe) | 1; f[8 + 13] = (f[8 + 13] & 0x0f) | 0xf0;
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t);
  s.ondata(LJ.concat(HTTP_OK, f.subarray(0, 60000)));
  assert.equal(t.events().at(-1), 'STMn');
  assert.match(t.p.lastError, /32-bit/);
});

// -- M2: STATs raised while the control is down are sent once it is back -----------------

test('M2: STMs, STMd and STMu raised between sessions are sent after the new HELO', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t);
  s.ondata(LJ.concat(HTTP_OK, fx('s16-l5.flac'))); s.onclose(true);
  t.ctl().onclose();                       // the session is over
  t.out.advance(1000); t.tick(10);         // heard (STMs, STMd) while away
  t.out.advance(10 * 44100); t.tick(10);   // and played out (STMu)
  assert.equal(t.p.state, 'stopped');
  t.p._connect();                          // what the reconnect timer does
  const c2 = t.tunnels[t.tunnels.length - 1]; c2.onopen();
  assert.equal(LJ.latin1(c2.sent[0].subarray(0, 4)), 'HELO');
  assert.deepEqual(statsOf(c2), ['STMs', 'STMd', 'STMu']);
  t.tick(10);
  assert.deepEqual(statsOf(c2), ['STMs', 'STMd', 'STMu'], 'each sent once');
});

// -- M3: PCM formats that are not integer PCM ---------------------------------------------

/** A WAV file: fmt chunk body `fmt` then the samples. */
function wav(fmt, data) {
  const head = new Uint8Array(12 + 8 + fmt.length + 8);
  const dv = new DataView(head.buffer);
  head.set([0x52, 0x49, 0x46, 0x46]); dv.setUint32(4, head.length - 8 + data.length, true); head.set([0x57, 0x41, 0x56, 0x45], 8);
  head.set([0x66, 0x6d, 0x74, 0x20], 12); dv.setUint32(16, fmt.length, true); head.set(fmt, 20);
  const d = 20 + fmt.length; head.set([0x64, 0x61, 0x74, 0x61], d); dv.setUint32(d + 4, data.length, true);
  return LJ.concat(head, data);
}
function fmtChunk(tag, bits, ext) {
  const f = new Uint8Array(ext ? 40 : 16), dv = new DataView(f.buffer);
  dv.setUint16(0, tag, true); dv.setUint16(2, 1, true); dv.setUint32(4, 44100, true);
  dv.setUint32(8, 44100 * bits / 8, true); dv.setUint16(12, bits / 8, true); dv.setUint16(14, bits, true);
  if (ext) {
    dv.setUint16(16, 22, true); dv.setUint16(18, bits, true);
    f.set([ext, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 24);
  }
  return f;
}
function decodePcm(bytes) {
  const d = new LJ.PcmDecoder({ pcmSize: '?', pcmRate: '?', pcmChannels: '?', pcmEndian: '?' });
  const out = []; d.onBlock = (r, ch) => out.push(...ch[0]);
  d.feed(bytes); d.end(); for (let n = 0; n < 100 && d.pump() !== 'done'; n++);
  return out;
}
const floats = (vals, little = true, bits = 32) => {
  const b = new Uint8Array(vals.length * bits / 8), dv = new DataView(b.buffer);
  vals.forEach((v, i) => (bits === 32 ? dv.setFloat32(i * 4, v, little) : dv.setFloat64(i * 8, v, little)));
  return b;
};
const near = (got, want) => got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) < 1e-6);
const SAMPLES = [0.5, -0.25, 0.125, -1];

test('M3: 32-bit float WAV (format 3) decodes as float', () => {
  assert.ok(near(decodePcm(wav(fmtChunk(3, 32), floats(SAMPLES))), SAMPLES));
});

test('M3: 64-bit float WAV decodes as float', () => {
  assert.ok(near(decodePcm(wav(fmtChunk(3, 64), floats(SAMPLES, true, 64))), SAMPLES));
});

test('M3: WAVE_FORMAT_EXTENSIBLE with the float subformat decodes as float', () => {
  assert.ok(near(decodePcm(wav(fmtChunk(0xfffe, 32, 3), floats(SAMPLES))), SAMPLES));
});

test('M3: WAVE_FORMAT_EXTENSIBLE with the PCM subformat is still integer PCM', () => {
  const data = new Uint8Array([0, 0x40, 0, 0xc0]);
  assert.ok(near(decodePcm(wav(fmtChunk(0xfffe, 16, 1), data)), [0.5, -0.5]));
});

test('M3: a WAV that is neither PCM nor float (mu-law) fails the track with STMn', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t, PCM_HDR);
  s.ondata(LJ.concat(HTTP_OK, wav(fmtChunk(7, 8), new Uint8Array(20000).fill(0xff)))); s.onclose(true);
  assert.equal(t.out.segs.length, 0, 'nothing played');
  assert.equal(t.events().at(-1), 'STMn');
});

/** An AIFF/AIFC file of mono 44.1 kHz samples. */
function aiff(bits, data, compression) {
  const commLen = compression ? 22 + 2 : 18;
  const comm = new Uint8Array(8 + commLen), cv = new DataView(comm.buffer);
  comm.set([0x43, 0x4f, 0x4d, 0x4d]); cv.setUint32(4, commLen);
  cv.setUint16(8, 1); cv.setUint32(10, data.length / Math.ceil(bits / 8)); cv.setUint16(14, bits);
  comm.set([0x40, 0x0e, 0xac, 0x44], 16);
  if (compression) comm.set([...compression].map((c) => c.charCodeAt(0)), 26);
  const ssnd = new Uint8Array(16), sv = new DataView(ssnd.buffer);
  ssnd.set([0x53, 0x53, 0x4e, 0x44]); sv.setUint32(4, 8 + data.length);
  const form = new Uint8Array(12), fv = new DataView(form.buffer);
  form.set([0x46, 0x4f, 0x52, 0x4d]); fv.setUint32(4, 4 + comm.length + ssnd.length + data.length);
  form.set([...(compression ? 'AIFC' : 'AIFF')].map((c) => c.charCodeAt(0)), 8);
  return LJ.concatAll([form, comm, ssnd, data]);
}

test('M3: AIFC fl32 decodes as big-endian float', () => {
  assert.ok(near(decodePcm(aiff(32, floats(SAMPLES, false), 'fl32')), SAMPLES));
});

test('M3: AIFC sowt is little-endian and twos big-endian integer PCM', () => {
  assert.ok(near(decodePcm(aiff(16, new Uint8Array([0, 0x40, 0, 0xc0]), 'sowt')), [0.5, -0.5]));
  assert.ok(near(decodePcm(aiff(16, new Uint8Array([0x40, 0, 0xc0, 0]), 'twos')), [0.5, -0.5]));
});

test('M3: AIFC ulaw fails the track with STMn', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t, PCM_HDR);
  s.ondata(LJ.concat(HTTP_OK, aiff(16, new Uint8Array(20000).fill(0x7f), 'ulaw'))); s.onclose(true);
  assert.equal(t.out.segs.length, 0, 'nothing played');
  assert.equal(t.events().at(-1), 'STMn');
});

test('M3: 20-bit AIFF is read from 24-bit containers, left-justified', () => {
  // 0x400000 in 3 bytes = 0.5; the low 4 bits are padding.
  assert.ok(near(decodePcm(aiff(20, new Uint8Array([0x40, 0, 0, 0xc0, 0, 0]))), [0.5, -0.5]));
});

// -- L8: PCM data that ends before the stream does ----------------------------------------

test('L8: bytes after a WAV data chunk are acknowledged, so the stream can finish', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t, PCM_HDR);
  const w = fx('s16.wav');
  s.ondata(LJ.concat(HTTP_OK, w));
  const trailer = new Uint8Array(100000);   // e.g. a LIST or id3 chunk after the data
  s.ondata(trailer);
  const all = HTTP_OK.length + w.length + trailer.length;
  assert.equal(s.acks.at(-1), all, 'everything delivered acknowledged');
});

// -- M4: WebCodecs MP3 errors ---------------------------------------------------------------

test('M4: occasional MP3 decoder errors over a long stream do not stop decoding', async () => {
  let calls = 0, errors = 0;
  class FakeAudioDecoder {
    constructor({ output, error }) { this.output = output; this.error = error; this.closed = false; this.decodeQueueSize = 0; }
    configure() {}
    decode() {
      if (this.closed) return;
      if (++calls % 5 === 0) { this.closed = true; errors++; this.error(new Error('corrupt')); return; }
      const n = 1152;
      this.output({ numberOfFrames: n, numberOfChannels: 2, sampleRate: 44100, copyTo() {}, close() {} });
    }
    flush() { return Promise.resolve(); }
    close() { this.closed = true; }
  }
  const saved = [globalThis.AudioDecoder, globalThis.EncodedAudioChunk];
  globalThis.AudioDecoder = FakeAudioDecoder; globalThis.EncodedAudioChunk = class { constructor(o) { Object.assign(this, o); } };
  try {
    const d = new LJ.Mp3Decoder();
    let err = null, frames = 0;
    d.onError = (m) => { err = m; }; d.onBlock = (r, ch) => { frames += ch[0].length; }; d.onFinished = () => {};
    const file = fx('s16.mp3');
    for (let k = 0; k < 3; k++) d.feed(file);   // 12 s
    d.end();
    for (let k = 0; k < 2000 && d.pump(4) !== 'done'; k++) await new Promise((r) => setTimeout(r, 0));
    assert.ok(errors > 30, errors + ' errors in all');
    assert.equal(err, null, 'no fatal error');
    assert.ok(d.finished && frames > calls * 0.7 * 1152, 'decoded to the end');
  } finally { [globalThis.AudioDecoder, globalThis.EncodedAudioChunk] = saved; }
});

// -- L5: gapless info written by FFmpeg -----------------------------------------------------

test('L5: the gapless tag written by FFmpeg (Lavf/Lavc) is read like LAME\'s', () => {
  const lame = new LJ.Mp3Framer(); lame.feed(fx('s16.mp3')); lame.ended = true; lame.next();
  for (const name of ['Lavf', 'Lavc']) {
    const f = fx('s16.mp3').slice();
    const at = Buffer.from(f).indexOf('LAME');
    f.set([...name].map((c) => c.charCodeAt(0)), at);
    const g = new LJ.Mp3Framer(); g.feed(f); g.ended = true; g.next();
    assert.ok(lame.delay > 0);
    assert.equal(g.delay, lame.delay, name + ' delay'); assert.equal(g.padding, lame.padding, name + ' padding');
  }
});

// -- L6: timed start precision ---------------------------------------------------------------

test('L6: a timed start lands exactly on the jiffy LMS asked for', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  const s = startTrack(t, { autostart: '0' });
  s.ondata(LJ.concat(HTTP_OK, fx('s16-l5.flac').subarray(0, 60000)));
  t.setClock(5000.75);
  t.fromServer(LJ.buildStrm({ command: 'u', replayGain: 5250 }));
  assert.ok(t.out.log.includes('startAt:5250'), t.out.log.join());
});

// -- start() twice ------------------------------------------------------------------------------

test('start() called twice opens one control connection', () => {
  const t = makePlayer(); t.p.start(); t.p.start();
  assert.equal(t.tunnels.length, 1);
  t.p.stop(); t.p.start();
  assert.equal(t.tunnels.length, 2, 'a stopped player can start again');
});

// -- the plugin's close codes that end the player here ---------------------------------------

test('closed as replaced (4000) or switched off (4403): no reconnect, and the host is told', async () => {
  for (const [code, event] of [[4000, 'replaced'], [4403, 'disabled']]) {
    const t = makePlayer(); const seen = [];
    t.p.on((what) => seen.push(what));
    t.p.start(); t.ctl().onopen();
    t.ctl().onclose(code);
    await new Promise((r) => setTimeout(r, 1300));   // longer than the first reconnect wait
    assert.equal(t.tunnels.filter((x) => x.ip === 'control').length, 1, `no second control after ${code}`);
    assert.ok(seen.includes(event), `${event} emitted`);
    assert.equal(t.p.stopped, true);
  }
  // A plain drop still reconnects.
  const t = makePlayer(); t.p.start(); t.ctl().onopen(); t.ctl().onclose(1006);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(t.tunnels.filter((x) => x.ip === 'control').length, 2, 'a drop reconnects');
  t.p.stop();
});
