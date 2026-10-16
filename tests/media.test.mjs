// The media-element output's muxer: PCM -> FLAC verbatim frames -> fragmented MP4. ffmpeg must
// decode what we write back to exactly the samples we started from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require(path.join(here, '..', 'src', 'core.js'));
require(path.join(here, '..', 'src', 'media.js'));
const LJ = globalThis.LJ;
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', n)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrionjs-media-'));

function decodeFlac(name) {
  const d = new LJ.FlacDecoder(); const blocks = [];
  d.onBlock = (rate, data) => blocks.push({ rate, data });
  d.feed(fx(name)); d.end(); while (d.pump(64) !== 'done');
  return { blocks, bits: d.info.bits, rate: d.info.rate };
}

function ffmpegRaw(file, fmt) {
  return new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', fmt, '-'], { maxBuffer: 1 << 28 }));
}

for (const [name, fmt] of [['s16-l5', 's16le'], ['s24-l8', 's24le'], ['mono', 's16le']]) {
  test(`fMP4 FLAC of ${name} decodes bit-exactly with ffmpeg`, () => {
    const { blocks, bits, rate } = decodeFlac(name + '.flac');
    const w = new LJ.Fmp4Writer({ block: 4096, fragmentFrames: 5 });
    const parts = [];
    for (const b of blocks) for (const s of w.push(rate, b.data, bits)) parts.push(s);
    for (const s of w.flush()) parts.push(s);
    assert.equal(parts.filter((p) => p.init).length, 1, 'one init segment');
    assert.ok(parts.length > 3, 'several fragments');
    // Fragments are contiguous on the timeline.
    const frags = parts.filter((p) => p.data);
    for (let i = 1; i < frags.length; i++) assert.ok(Math.abs(frags[i].start - frags[i - 1].end) < 1e-9, 'contiguous');
    const total = parts.reduce((a, p) => a + (p.init || p.data).length, 0);
    const file = new Uint8Array(total); let o = 0;
    for (const p of parts) { file.set(p.init || p.data, o); o += (p.init || p.data).length; }
    const f = path.join(tmp, name + '.mp4'); fs.writeFileSync(f, file);
    const got = ffmpegRaw(f, fmt), want = fx(name + '.raw');
    assert.equal(got.length, want.length, 'same length');
    assert.ok(Buffer.from(got).equals(Buffer.from(want)), 'identical samples');
  });
}

test('a new sample rate starts a new init segment on a continuous timeline', () => {
  const w = new LJ.Fmp4Writer({ block: 1024, fragmentFrames: 2 });
  const sec = (r) => [new Float32Array(r), new Float32Array(r)];
  const a = [...w.push(44100, sec(44100), 16), ...w.flush()];
  const b = [...w.push(48000, sec(48000), 24), ...w.flush()];
  assert.equal(b[0].init !== undefined, true, 'init first');
  const lastA = a.filter((p) => p.data).at(-1), firstB = b.find((p) => p.data);
  assert.ok(Math.abs(lastA.end - 1) < 1e-9, 'first second ends at 1 s');
  assert.ok(Math.abs(firstB.start - 1) < 1 / 48000, 'second format continues at 1 s');
  assert.ok(Math.abs(w.end - 2) < 1 / 48000);
});

test('float to int conversion is exact for decoded integers and clamps the rest', () => {
  const ints = LJ.toInts([new Float32Array([0, -1, 0.5, 32767 / 32768, 1.5, -2])], 16)[0];
  assert.deepEqual(Array.from(ints), [0, -32768, 16384, 32767, 32767, -32768]);
});

test('FLAC frame header coding of large sample numbers', () => {
  const ch = [new Int32Array(16), new Int32Array(16)];
  for (const n of [0, 127, 128, 2047, 2048, 65535, 2 ** 31, 2 ** 35]) {
    const f = LJ.flacFrame(ch, 0, 16, 16, n);
    // A stream header first (the frame takes its sample rate from it), then the frame. Our own
    // decoder checks both CRCs, so it accepts the frame only if the header coding is right.
    const head = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34, ...LJ.streamInfo(44100, 2, 16, 4096)]);
    const d = new LJ.FlacDecoder(); let r = 0; d.onBlock = () => r++;
    d.feed(head); d.feed(f); d.end(); while (d.pump() !== 'done');
    assert.equal(r, 1, `frame for sample ${n} decodes`);
  }
});

test('the sample entry declares the same bit depth as STREAMINFO (browsers reject a mismatch)', () => {
  for (const bits of [16, 24]) {
    const init = LJ.Mp4.init(96000, 2, bits, 4096);
    const i = Buffer.from(init).indexOf('fLaC');
    // SampleEntry (6 reserved + 2 index) + 8 reserved + channelcount(2): samplesize follows.
    const at = i + 4 + 8 + 8 + 2;
    assert.equal((init[at] << 8) | init[at + 1], bits);
  }
});
