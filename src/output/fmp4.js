/* LyrionJS output: PCM -> FLAC "verbatim" frames (uncompressed, bit-exact) -> fragmented MP4,
 * for the media-element output (output/media.js). No DOM; tested under Node against ffmpeg. */
'use strict';
(function (G) {
  const LJ = G.LJ || (G.LJ = {});

  // ---------------------------------------------------------------------------
  // FLAC verbatim frames
  // ---------------------------------------------------------------------------
  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i; for (let j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; CRC8[i] = c;
    let d = i << 8; for (let j = 0; j < 8; j++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; CRC16[i] = d;
  }
  const SIZE_CODE = { 8: 1, 12: 2, 16: 4, 20: 5, 24: 6 };

  class BitWriter {
    constructor(n) { this.b = new Uint8Array(n); this.pos = 0; this.acc = 0; this.nacc = 0; }
    bits(v, n) { // n <= 24
      this.acc = (this.acc * (1 << n)) + (v & ((1 << n) - 1)); this.nacc += n;
      while (this.nacc >= 8) { this.nacc -= 8; this.b[this.pos++] = Math.floor(this.acc / (1 << this.nacc)) & 0xff; this.acc %= (1 << this.nacc); }
    }
    align() { if (this.nacc) this.bits(0, 8 - this.nacc); }
    byte(v) { this.b[this.pos++] = v; }
  }

  /** Encode one frame of `n` samples per channel from int arrays, starting at `sample`. */
  function flacVerbatimFrame(chans, off, n, bits, sample) {
    const w = new BitWriter(32 + Math.ceil(n * chans.length * bits / 8) + chans.length + 4);
    // Variable block size, so the sample number (not a frame number) is coded.
    w.byte(0xff); w.byte(0xf9);
    w.bits(7, 4);                          // block size: 16 bits at the end of the header
    w.bits(0, 4);                          // sample rate: from STREAMINFO
    w.bits(chans.length - 1, 4);           // independent channels
    w.bits(SIZE_CODE[bits], 3); w.bits(0, 1);
    // UTF-8-style coded sample number (up to 36 bits).
    if (sample < 0x80) w.byte(sample);
    else {
      let len = 2; while (sample >= 2 ** (5 * len + 1)) len++;
      const lead = (0xff00 >> len) & 0xff;
      w.byte(lead | Math.floor(sample / 2 ** (6 * (len - 1))));
      for (let i = len - 2; i >= 0; i--) w.byte(0x80 | (Math.floor(sample / 2 ** (6 * i)) & 0x3f));
    }
    w.byte((n - 1) >> 8); w.byte((n - 1) & 0xff);
    let c8 = 0; for (let i = 0; i < w.pos; i++) c8 = CRC8[c8 ^ w.b[i]];
    w.byte(c8);
    for (const ch of chans) {
      w.byte(0x02);                        // verbatim subframe, no wasted bits
      if (bits === 16) for (let i = 0; i < n; i++) { const v = ch[off + i]; w.byte((v >> 8) & 0xff); w.byte(v & 0xff); }
      else if (bits === 24) for (let i = 0; i < n; i++) { const v = ch[off + i]; w.byte((v >> 16) & 0xff); w.byte((v >> 8) & 0xff); w.byte(v & 0xff); }
      else for (let i = 0; i < n; i++) w.bits(ch[off + i], bits);
    }
    w.align();
    let c16 = 0; for (let i = 0; i < w.pos; i++) c16 = ((c16 << 8) ^ CRC16[(c16 >> 8) ^ w.b[i]]) & 0xffff;
    w.byte(c16 >> 8); w.byte(c16 & 0xff);
    return w.b.slice(0, w.pos);
  }

  function streamInfo(rate, channels, bits, maxBlock) {
    const b = new Uint8Array(34);
    b[0] = 0; b[1] = 16;                                  // min block size
    b[2] = maxBlock >> 8; b[3] = maxBlock & 0xff;         // max block size
    // min/max frame size unknown (0); total samples unknown (0); MD5 unset (0).
    b[10] = (rate >> 12) & 0xff; b[11] = (rate >> 4) & 0xff;
    b[12] = ((rate & 0x0f) << 4) | ((channels - 1) << 1) | ((bits - 1) >> 4);
    b[13] = ((bits - 1) & 0x0f) << 4;
    return b;
  }

  // ---------------------------------------------------------------------------
  // Fragmented MP4 (ISO BMFF) with one FLAC track
  // ---------------------------------------------------------------------------
  const enc = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = (v) => [(v >> 8) & 255, v & 255];
  const u64 = (v) => u32(Math.floor(v / 4294967296)).concat(u32(v >>> 0));
  function box(type, ...parts) {
    let len = 8; for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    out.set(u32(len), 0); out.set(enc(type), 4);
    let o = 8; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const full = (type, version, flags, ...parts) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
  const MATRIX = [].concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

  const Mp4 = {
    init(rate, channels, bits, maxBlock) {
      const dfla = full('dfLa', 0, 0, [0x80, 0, 0, 34], streamInfo(rate, channels, bits, maxBlock));
      const entry = box('fLaC', [0, 0, 0, 0, 0, 0], u16(1), new Array(8).fill(0), u16(channels), u16(bits), u16(0), u16(0),
        u32(rate <= 65535 ? rate * 65536 : 0), dfla);
      const stbl = box('stbl', full('stsd', 0, 0, u32(1), entry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
        full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
      const minf = box('minf', full('smhd', 0, 0, u16(0), u16(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
      const mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(rate), u32(0), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), enc('soun'), u32(0), u32(0), u32(0), enc('LyrionJS\0')), minf);
      const trak = box('trak', full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0)), mdia);
      const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(2));
      const mvex = box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
      const ftyp = box('ftyp', enc('isom'), u32(0), enc('isom'), enc('iso6'), enc('mp41'));
      const moov = box('moov', mvhd, trak, mvex);
      const out = new Uint8Array(ftyp.length + moov.length); out.set(ftyp); out.set(moov, ftyp.length);
      return out;
    },
    /** One moof + mdat. frames: [{data: Uint8Array, samples}]; baseTime in samples. */
    fragment(seqNo, baseTime, frames) {
      let dataLen = 0; for (const f of frames) dataLen += f.data.length;
      const entries = []; for (const f of frames) entries.push(...u32(f.samples), ...u32(f.data.length));
      const mk = (offset) => box('moof', full('mfhd', 0, 0, u32(seqNo)),
        box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u64(baseTime)),
          full('trun', 0, 0x000301, u32(frames.length), u32(offset), entries)));
      const moofLen = mk(0).length;
      const moof = mk(moofLen + 8);
      const out = new Uint8Array(moof.length + 8 + dataLen);
      out.set(moof); out.set(u32(8 + dataLen), moof.length); out.set(enc('mdat'), moof.length + 4);
      let o = moof.length + 8; for (const f of frames) { out.set(f.data, o); o += f.data.length; }
      return out;
    },
  };

  /** Float samples to ints of `bits`: exact for audio decoded from integers of that size. */
  function toInts(chans, bits) {
    const scale = 2 ** (bits - 1), max = scale - 1, min = -scale;
    return chans.map((c) => {
      const o = new Int32Array(c.length);
      for (let i = 0; i < c.length; i++) { const v = Math.round(c[i] * scale); o[i] = v > max ? max : v < min ? min : v; }
      return o;
    });
  }

  /**
   * Turns PCM into appendable MP4: an init segment whenever the format changes, then fragments.
   * Keeps its own sample clock so the timeline is continuous across tracks.
   */
  class Fmp4Writer {
    constructor({ block = 4096, fragmentFrames = 12 } = {}) {
      this.block = block; this.fragmentFrames = fragmentFrames;
      this.fmt = null; this.pending = null; this.frames = []; this.sample = 0; this.base = 0; this.seqNo = 0;
    }
    /** Seconds of audio written (appended or pending) on this writer's timeline. */
    get end() { return this.fmt ? (this.base + this.sample + this._pendingFrames()) / this.fmt.rate : this.startAt || 0; }
    _pendingFrames() { return this.pending ? this.pending.len : 0; }
    /** Start writing at `t` seconds on the media timeline (after a flush or a new format). */
    restart(t) { this.fmt = null; this.pending = null; this.frames = []; this.startAt = t; }
    /** Add PCM; returns segments ready to append ({init} or {data, start, end}). */
    push(rate, chans, bits) {
      const out = [];
      bits = SIZE_CODE[bits] ? bits : (bits > 16 ? 24 : 16);
      const channels = chans.length === 1 ? 1 : 2;
      if (!this.fmt || this.fmt.rate !== rate || this.fmt.bits !== bits || this.fmt.channels !== channels) {
        const t = this.end;
        out.push(...this.flush());
        this.fmt = { rate, bits, channels };
        this.base = Math.round(t * rate); this.sample = 0;
        out.push({ init: Mp4.init(rate, channels, bits, this.block), rate });
      }
      const ints = toInts(chans.slice(0, channels), bits);
      // Join onto the partial block left from last time.
      let src = ints, n = ints[0].length;
      if (this.pending) {
        src = ints.map((c, i) => { const o = new Int32Array(this.pending.len + n); o.set(this.pending.chans[i].subarray(0, this.pending.len)); o.set(c, this.pending.len); return o; });
        n += this.pending.len; this.pending = null;
      }
      let off = 0;
      while (n - off >= this.block) { this._frame(src, off, this.block); off += this.block; }
      if (off < n) this.pending = { chans: src.map((c) => c.slice(off)), len: n - off };
      if (this.frames.length >= this.fragmentFrames) out.push(this._fragment());
      return out;
    }
    /** Write out everything, including a partial last block. */
    flush() {
      const out = [];
      if (this.pending && this.pending.len) { this._frame(this.pending.chans, 0, this.pending.len); }
      this.pending = null;
      if (this.frames.length) out.push(this._fragment());
      return out;
    }
    _frame(chans, off, n) {
      const f = this.fmt;
      this.frames.push({ data: flacVerbatimFrame(chans, off, n, f.bits, this.sample + this.frames.reduce((a, x) => a + x.samples, 0)), samples: n });
    }
    _fragment() {
      const start = this.base + this.sample;
      let count = 0; for (const f of this.frames) count += f.samples;
      const data = Mp4.fragment(++this.seqNo, start, this.frames);
      this.frames = []; this.sample += count;
      return { data, start: start / this.fmt.rate, end: (start + count) / this.fmt.rate };
    }
  }

  Object.assign(LJ, { flacVerbatimFrame, streamInfo, Mp4, Fmp4Writer, toInts });
})(typeof globalThis !== 'undefined' ? globalThis : this);
