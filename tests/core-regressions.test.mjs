// Regression tests for faults found in the v0.1 review of the core. Each failed before its fix.
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

/** Feeds `bytes` to a stream the way a real network does: never more than the window ahead of the acks. */
function deliverWithWindow(stream, bytes, win = LJ.STREAM_WINDOW, chunk = 65536) {
  let sent = 0;
  for (let stuck = 0; sent < bytes.length && stuck < 3;) {
    const acked = stream.acks.length ? stream.acks[stream.acks.length - 1] : 0;
    const room = win - (sent - acked);
    if (room <= 0) { stuck++; continue; }
    const n = Math.min(chunk, room, bytes.length - sent);
    stream.ondata(bytes.subarray(sent, sent + n)); sent += n; stuck = 0;
  }
  return sent;
}

/** A FLAC file with a big PICTURE block (cover art) right after STREAMINFO. */
function flacWithPicture(size) {
  const f = fx('s16-l5.flac');
  const siLen = (f[5] << 16) | (f[6] << 8) | f[7];
  const at = 4 + 4 + siLen;
  const pic = new Uint8Array(4 + size);
  pic[0] = 6; pic[1] = size >> 16; pic[2] = (size >> 8) & 255; pic[3] = size & 255;
  return LJ.concatAll([f.subarray(0, at), pic, f.subarray(at)]);
}

test('H2: a FLAC file with 3 MiB of cover art plays through a flow-controlled stream', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', threshold: 1, request: REQ }));
  const s = t.tunnels[1]; s.onopen();
  const body = LJ.concat(HTTP_OK, flacWithPicture(3 * 1024 * 1024));
  const sent = deliverWithWindow(s, body);
  assert.equal(sent, body.length, 'the whole file got through the window');
  s.onclose(true);
  assert.ok(t.out.segs[0] && t.out.segs[0].frames === 4 * 44100, 'every sample decoded');
});

test('H2: an MP3 with a big ID3 tag is skipped as it arrives', () => {
  const f = new LJ.Mp3Framer();
  const size = 3 * 1024 * 1024;
  const id3 = new Uint8Array(10 + size);
  id3.set([0x49, 0x44, 0x33, 4, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  const all = LJ.concat(id3, fx('s16.mp3'));
  let frames = 0;
  for (let i = 0; i < all.length; i += 65536) {
    f.feed(all.subarray(i, i + 65536));
    for (let r = f.next(); r !== 'need'; r = f.next()) { if (r === 'done') break; frames++; }
    assert.ok(f.buffered < 200000, 'the tag is never held whole');
  }
  f.ended = true;
  for (let r = f.next(); r !== 'done'; r = f.next()) frames++;
  assert.ok(frames > 100);
});

test('H1: a new session after a mid-frame drop starts with clean framing', () => {
  const t = makePlayer(); t.p.start(); const c = t.ctl(); c.onopen();
  const audg = new Uint8Array(18); audg[8] = 1; audg[12] = 0x80; audg[16] = 0x80;
  const frame = LJ.serverFrame('audg', audg);
  c.ondata(frame.subarray(0, 5));        // the old socket died here
  c.onopen();                            // resume refused: a new session on the same control
  c.ondata(frame);
  assert.equal(t.out.gain, 0.5, 'the frame of the new session is understood');
});

test('M1: a stream replaced mid-flight is aborted and never reported', () => {
  let aborted = 0;
  const flac = () => { const d = new LJ.FlacDecoder(); const a = d.abort.bind(d); d.abort = () => { aborted++; a(); }; return d; };
  const t = makePlayer({ decoders: { f: flac } }); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', request: REQ }));
  t.tunnels[1].onopen();                 // A: connected, nothing arrives yet
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', request: REQ }));
  const b = t.tunnels[2]; b.onopen(); b.ondata(LJ.concat(HTTP_OK, fx('s16-l5.flac').subarray(0, 120000)));
  t.out.advance(100); t.tick(10);        // B is heard
  assert.equal(aborted, 1, 'A\'s decoder aborted');
  assert.ok(t.tunnels[1].closed);
  assert.ok(!t.events().includes('STMd'), 'no STMd for A while B still streams');
});

test('M2: a decoder that throws fails the track cleanly (STMn) instead of jamming the player', () => {
  const bad = () => { const d = new LJ.FlacDecoder(); d.pump = () => { throw new Error('boom'); }; return d; };
  const t = makePlayer({ decoders: { f: bad } }); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', request: REQ }));
  const s = t.tunnels[1]; s.onopen();
  assert.doesNotThrow(() => s.ondata(LJ.concat(HTTP_OK, new Uint8Array(1000))));
  assert.equal(t.events().at(-1), 'STMn');
  assert.ok(s.closed);
  assert.match(t.p.lastError, /boom/);
});

test('M3: an HTTP error page is not played as audio', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'p', pcmSize: '1', pcmRate: '3', pcmChannels: '2', pcmEndian: '1', request: REQ }));
  const s = t.tunnels[1]; s.onopen();
  const page = new TextEncoder().encode('HTTP/1.0 404 Not Found\r\n\r\n' + '<html>'.repeat(20000));
  s.ondata(page);
  assert.equal(t.out.segs.length, 0, 'nothing reached the output');
  assert.notEqual(t.p.state, 'playing');
  assert.ok(t.ops().includes('DSCO') && t.events().at(-1) === 'STMn');
});

/** Byte offsets of every frame in a FLAC file: walk the metadata blocks, then frame by frame. */
function frameOffsets(f) {
  let i = 4, last = false;
  while (!last) { last = !!(f[i] & 0x80); i += 4 + ((f[i + 1] << 16) | (f[i + 2] << 8) | f[i + 3]); }
  const info = { rate: 0, bits: 0 };
  const offs = [];
  while (i < f.length) { const r = LJ.flacFrame(f, i, f.length, info); if (!r || !r.len) break; offs.push(i); i += r.len; }
  return offs;
}

test('M4: a stream that ends in a short silent frame keeps that frame', () => {
  const f = fx('silence.flac');
  const offs = frameOffsets(f);
  const cut = f.subarray(0, offs[offs.length - 1]);           // drop the last frame: a 14-byte silent one ends it
  const d = new LJ.FlacDecoder(); let frames = 0;
  d.onBlock = (r, ch) => { frames += ch[0].length; };
  d.feed(cut); d.end(); while (d.pump() !== 'done');
  assert.equal(frames, 4096 * (offs.length - 1), 'every frame decoded, including the short last one');
});

test('M4: a cut-off frame before the real last frame does not lose it', () => {
  const f = fx('s16-l5.flac');
  const offs = frameOffsets(f);
  const first = f.subarray(offs[0], offs[1]), last = offs[offs.length - 1];
  const good = (() => { const d = new LJ.FlacDecoder(); let n = 0; d.onBlock = (r, c) => { n += c[0].length; }; d.feed(f); d.end(); while (d.pump() !== 'done'); return n; })();
  // Half of a full frame (as after a cut) just before the final frame.
  const bogus = LJ.concatAll([f.subarray(0, last), first.subarray(0, first.length >> 1), f.subarray(last)]);
  const d = new LJ.FlacDecoder(); let n = 0; d.onBlock = (r, c) => { n += c[0].length; };
  d.feed(bogus); d.end(); while (d.pump() !== 'done');
  assert.equal(n, good, 'the real last frame still decodes');
});

test('M5: a correction split across the end of the replay is still treated as replayed', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', request: REQ }));
  const s = t.tunnels[1]; s.onopen(); s.ondata(LJ.concat(HTTP_OK, fx('s16-l5.flac')));
  t.out.log.length = 0;
  const skip = LJ.buildStrm({ command: 'a', replayGain: 700 });
  t.ctl().ondata(skip.subarray(0, 10), true);     // the replay ends mid-frame…
  t.ctl().ondata(skip.subarray(10), false);       // …and live data completes it
  assert.ok(!t.out.log.some((x) => x.startsWith('skip')), 'the stale skip is not applied');
});

test('L1: a truncated WAV header still finishes when the stream ends', () => {
  const d = new LJ.PcmDecoder({ pcmSize: '?', pcmRate: '?', pcmChannels: '?', pcmEndian: '?' });
  d.feed(fx('s16.wav').subarray(0, 30)); d.end();
  let r, n = 0; do { r = d.pump(); } while (r !== 'done' && ++n < 10);
  assert.equal(r, 'done');
});

test('L2: 8-bit AIFF is signed', () => {
  const comm = new Uint8Array(26); comm.set([0x43, 0x4f, 0x4d, 0x4d, 0, 0, 0, 18, 0, 1, 0, 0, 0, 2, 0, 8, 0x40, 0x0e, 0xac, 0x44]);
  const ssnd = new Uint8Array(16 + 2); ssnd.set([0x53, 0x53, 0x4e, 0x44, 0, 0, 0, 10]); ssnd[16] = 0x7f; ssnd[17] = 0x80;
  const form = LJ.concatAll([new Uint8Array([0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, 52, 0x41, 0x49, 0x46, 0x46]), comm, ssnd]);
  const d = new LJ.PcmDecoder({ pcmSize: '?', pcmRate: '?', pcmChannels: '?', pcmEndian: '?' });
  let out; d.onBlock = (r, ch) => { out = ch[0]; };
  d.feed(form); d.end(); while (d.pump() !== 'done');
  assert.ok(Math.abs(out[0] - 127 / 128) < 1e-9 && out[1] === -1);
});

test('L3: strm u with nothing loaded does not claim to be playing', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  t.fromServer(LJ.buildStrm({ command: 'u' }));
  t.tick(10);
  assert.equal(t.p.state, 'stopped');
  assert.ok(!t.events().includes('STMu'));
});

test('L11: the set of started tracks does not grow without bound', () => {
  const t = makePlayer(); t.p.start(); t.ctl().onopen();
  for (let i = 0; i < 30; i++) {
    t.fromServer(LJ.buildStrm({ command: 's', autostart: '1', format: 'f', request: REQ }));
    const s = t.tunnels[t.tunnels.length - 1]; s.onopen(); s.ondata(LJ.concat(HTTP_OK, fx('silence.flac'))); s.onclose(true);
    t.out.advance(48000); t.tick(10);
  }
  assert.ok(t.p.stmsSent.size <= 2, 'size ' + t.p.stmsSent.size);
});
