/* LyrionJS core: a streaming FLAC decoder, written from the format specification. */
'use strict';
(function (G) {
  const LJ = G.LJ;
  const { be16, be32, id3Size, Skipper } = LJ;

  const NEED = { need: true };
  const BAD = { bad: true };

  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i; for (let j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; CRC8[i] = c;
    let d = i << 8; for (let j = 0; j < 8; j++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; CRC16[i] = d;
  }
  function crc8(b, s, e) { let c = 0; for (let i = s; i < e; i++) c = CRC8[c ^ b[i]]; return c; }
  function crc16(b, s, e) { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) ^ CRC16[(c >> 8) ^ b[i]]) & 0xffff; return c; }

  /** Big-endian bit reader over b[start..end); reading past the end throws NEED. */
  class BitReader {
    constructor(b, start, end) { this.b = b; this.pos = start * 8; this.endBits = end * 8; }
    word() { const b = this.b, i = this.pos >>> 3; return (((b[i] | 0) << 24) | ((b[i + 1] | 0) << 16) | ((b[i + 2] | 0) << 8) | (b[i + 3] | 0)) >>> 0; }
    read(n) {
      if (n === 0) return 0;
      if (n > 24) { const hi = this.read(n - 16); return hi * 65536 + this.read(16); }
      const o = this.pos & 7, w = this.word();
      this.pos += n;
      return ((w << o) >>> 0) >>> (32 - n);
    }
    signed(n) { if (n === 0) return 0; const v = this.read(n), half = 2 ** (n - 1); return v >= half ? v - 2 * half : v; }
    unary() {
      let z = 0;
      for (;;) {
        const o = this.pos & 7, w = (this.word() << o) >>> 0, avail = 32 - o;
        if (w === 0) { z += avail; this.pos += avail; if (this.pos > this.endBits) throw NEED; continue; }
        const c = Math.clz32(w); z += c; this.pos += c + 1; return z;
      }
    }
    check() { if (this.pos > this.endBits) throw NEED; }
  }

  const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
  const RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
  const SAMPLE_SIZES = [0, 8, 12, -1, 16, 20, 24, 32];

  function residual(br, n, order, out) {
    const method = br.read(2);
    if (method > 1) throw BAD;
    const pbits = method === 0 ? 4 : 5, esc = method === 0 ? 15 : 31;
    const porder = br.read(4);
    const parts = 1 << porder, psize = n >>> porder;
    if ((psize << porder) !== n || psize < order) throw BAD;
    let i = order;
    for (let p = 0; p < parts; p++) {
      const cnt = p === 0 ? psize - order : psize;
      const k = br.read(pbits);
      if (k === esc) {
        const bits = br.read(5);
        for (let j = 0; j < cnt; j++) out[i++] = br.signed(bits);
      } else {
        const pw = 2 ** k;
        for (let j = 0; j < cnt; j++) {
          const v = br.unary() * pw + (k ? br.read(k) : 0);
          out[i++] = (v % 2) ? -(v + 1) / 2 : v / 2;
        }
      }
      br.check();
    }
  }

  function subframe(br, n, bps, out) {
    if (br.read(1) !== 0) throw BAD;
    const type = br.read(6);
    let wasted = 0;
    if (br.read(1)) wasted = br.unary() + 1;
    const bits = bps - wasted;
    if (bits <= 0) throw BAD;
    if (type === 0) {                              // constant
      const v = br.signed(bits); for (let i = 0; i < n; i++) out[i] = v;
    } else if (type === 1) {                       // verbatim
      for (let i = 0; i < n; i++) out[i] = br.signed(bits);
    } else if (type >= 8 && type <= 12) {          // fixed predictor
      const order = type - 8;
      if (order > n) throw BAD;
      for (let i = 0; i < order; i++) out[i] = br.signed(bits);
      residual(br, n, order, out);
      switch (order) {
        case 1: for (let i = 1; i < n; i++) out[i] += out[i - 1]; break;
        case 2: for (let i = 2; i < n; i++) out[i] += 2 * out[i - 1] - out[i - 2]; break;
        case 3: for (let i = 3; i < n; i++) out[i] += 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3]; break;
        case 4: for (let i = 4; i < n; i++) out[i] += 4 * out[i - 1] - 6 * out[i - 2] + 4 * out[i - 3] - out[i - 4]; break;
      }
    } else if (type >= 32) {                       // LPC
      const order = type - 31;
      if (order > n) throw BAD;
      for (let i = 0; i < order; i++) out[i] = br.signed(bits);
      const prec = br.read(4) + 1;
      if (prec === 16) throw BAD;
      const shift = br.signed(5);
      if (shift < 0) throw BAD;
      const coef = new Float64Array(order);
      for (let j = 0; j < order; j++) coef[j] = br.signed(prec);
      residual(br, n, order, out);
      const div = 2 ** shift;
      for (let i = order; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < order; j++) sum += coef[j] * out[i - 1 - j];
        out[i] += Math.floor(sum / div);
      }
    } else {
      throw BAD;
    }
    if (wasted) { const m = 2 ** wasted; for (let i = 0; i < n; i++) out[i] *= m; }
  }

  /** Decode one frame at b[s..e): {len, rate, channels, bits, frames, data, ints} or NEED / BAD. */
  function flacFrame(b, s, e, info) {
    // The smallest frame (silence, mono, 8-bit) is 7 bytes; the bit reader bounds the rest.
    if (e - s < 7) return NEED;
    if (b[s] !== 0xff || (b[s + 1] & 0xfe) !== 0xf8) return BAD;
    const br = new BitReader(b, s, e);
    try {
      br.read(16);
      const bsCode = br.read(4), srCode = br.read(4), chCode = br.read(4), ssCode = br.read(3);
      if (br.read(1)) return BAD;
      const x = br.read(8);                        // UTF-8-style coded frame/sample number
      if (x >= 0x80) {
        let extra;
        if ((x & 0xe0) === 0xc0) extra = 1; else if ((x & 0xf0) === 0xe0) extra = 2;
        else if ((x & 0xf8) === 0xf0) extra = 3; else if ((x & 0xfc) === 0xf8) extra = 4;
        else if ((x & 0xfe) === 0xfc) extra = 5; else if (x === 0xfe) extra = 6; else return BAD;
        for (let i = 0; i < extra; i++) if ((br.read(8) & 0xc0) !== 0x80) return BAD;
      }
      if (bsCode === 0) return BAD;
      let n = BLOCK_SIZES[bsCode];
      if (bsCode === 6) n = br.read(8) + 1; else if (bsCode === 7) n = br.read(16) + 1;
      let rate;
      if (srCode === 0) rate = info && info.rate;
      else if (srCode < 12) rate = RATES[srCode];
      else if (srCode === 12) rate = br.read(8) * 1000;
      else if (srCode === 13) rate = br.read(16);
      else if (srCode === 14) rate = br.read(16) * 10;
      else return BAD;
      if (!rate) return BAD;
      const headEnd = br.pos >>> 3;
      if (headEnd >= e) return NEED;
      if (crc8(b, s, headEnd) !== b[headEnd]) return BAD;
      br.read(8);
      let bps = SAMPLE_SIZES[ssCode];
      if (ssCode === 0) bps = info && info.bits;
      if (!bps || bps < 0 || bps > 24) return BAD;
      let channels;
      if (chCode < 8) channels = chCode + 1; else if (chCode <= 10) channels = 2; else return BAD;
      if (info && info.maxBlock && n > Math.max(info.maxBlock, 16)) return BAD;
      const sub = [];
      for (let c = 0; c < channels; c++) {
        const side = (chCode === 8 && c === 1) || (chCode === 9 && c === 0) || (chCode === 10 && c === 1);
        const out = new Float64Array(n);
        subframe(br, n, bps + (side ? 1 : 0), out);
        br.check();
        sub.push(out);
      }
      br.pos = (br.pos + 7) & ~7;
      const end = (br.pos >>> 3) + 2;
      if (end > e) return NEED;
      if (crc16(b, s, end - 2) !== be16(b, end - 2)) return BAD;
      // Inter-channel decorrelation.
      if (chCode === 8) { const L = sub[0], S = sub[1]; for (let i = 0; i < n; i++) S[i] = L[i] - S[i]; }
      else if (chCode === 9) { const S = sub[0], R = sub[1]; for (let i = 0; i < n; i++) S[i] = S[i] + R[i]; }
      else if (chCode === 10) {
        const M = sub[0], S = sub[1];
        for (let i = 0; i < n; i++) {
          const side = S[i], mid = M[i] * 2 + (side & 1);
          M[i] = (mid + side) / 2; S[i] = (mid - side) / 2;
        }
      }
      const scale = 1 / 2 ** (bps - 1);
      const data = sub.map((ch) => { const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = ch[i] * scale; return f; });
      return { len: end - s, rate, channels, bits: bps, frames: n, data, ints: sub };
    } catch (err) {
      if (err === NEED) return NEED;
      if (err === BAD) return BAD;
      throw err;
    }
  }

  const isSync = (v, j) => v[j] === 0xff && (v[j + 1] & 0xfe) === 0xf8;

  class FlacDecoder extends LJ.Decoder {
    constructor() {
      super();
      this.state = 'start';   // start | meta | frames | done
      this.info = null; this.waitFor = 0; this.keepInts = false; this.skip = new Skipper(); this.lastMeta = false;
    }

    /** ID3 tag and metadata blocks. Only STREAMINFO is kept; the rest (artwork) is skipped as it arrives. */
    _metadata() {
      for (;;) {
        if (this.skip.active) {
          this.skip.run(this.q);
          if (this.skip.active) return this.ended ? 'done' : 'need';
          if (this.lastMeta) { this.state = 'frames'; return 'more'; }
        }
        const v = this.q.view();
        if (this.state === 'start') {
          if (v.length < 10 && !this.ended) return 'need';
          const tag = id3Size(v);
          if (tag) { this.skip.start(tag); continue; }
          if (v.length >= 4 && v[0] === 0x66 && v[1] === 0x4c && v[2] === 0x61 && v[3] === 0x43) { this.q.consume(4); this.state = 'meta'; continue; }
          this.state = 'frames'; return 'more'; // no header: frames from the start (a seek)
        }
        if (v.length < 4) return this.ended ? 'done' : 'need';
        const last = !!(v[0] & 0x80), type = v[0] & 0x7f, len = (v[1] << 16) | (v[2] << 8) | v[3];
        if (type === 0) {
          if (v.length < 4 + len) return this.ended ? 'done' : 'need';
          if (len >= 34) {
            const p = 4;
            this.info = {
              minBlock: be16(v, p), maxBlock: be16(v, p + 2),
              rate: (v[p + 10] << 12) | (v[p + 11] << 4) | (v[p + 12] >> 4),
              channels: ((v[p + 12] >> 1) & 7) + 1,
              bits: (((v[p + 12] & 1) << 4) | (v[p + 13] >> 4)) + 1,
              totalSamples: (v[p + 13] & 15) * 4294967296 + be32(v, p + 14),
            };
            this.outBits = this.info.bits;
            // Frames deeper than 24 bits aren't decoded: fail the track rather than play silence.
            if (this.info.bits > 24) throw new Error(`FLAC ${this.info.bits}-bit is not supported`);
          }
          this.q.consume(4 + len);
          if (last) { this.state = 'frames'; return 'more'; }
          continue;
        }
        this.q.consume(4);
        this.skip.start(len); this.lastMeta = last;
        if (!len && last) { this.state = 'frames'; return 'more'; }
      }
    }

    pump(maxFrames = 64) {
      if (this.state === 'done' || this.aborted) return 'done';
      if (this.state !== 'frames') {
        const r = this._metadata();
        if (r === 'done') this.state = 'done';
        if (r !== 'more') return r;
      }
      let produced = 0;
      while (produced < maxFrames) {
        const v = this.q.view();
        if (!this.ended && v.length < this.waitFor) return 'need';
        if (v.length < 2) { if (this.ended) { this.state = 'done'; return 'done'; } return 'need'; }
        if (!isSync(v, 0)) {
          let j = 1; while (j + 1 < v.length && !isSync(v, j)) j++;
          this.q.consume(j); continue;
        }
        const r = flacFrame(v, 0, v.length, this.info);
        if (r === NEED) {
          if (!this.ended) { this.waitFor = v.length + 4096; return 'need'; }
          // The stream has ended, so this was a false sync (or a cut-off frame): look for the next.
          let j = 1; while (j + 1 < v.length && !isSync(v, j)) j++;
          this.q.consume(j); continue;
        }
        this.waitFor = 0;
        if (r === BAD) { this.q.consume(1); continue; }
        this.q.consume(r.len);
        this.lastRate = r.rate; this.outBits = r.bits;
        if (!this.aborted && this.onBlock) this.onBlock(r.rate, r.data, this.keepInts ? r.ints : null);
        produced++;
      }
      return 'more';
    }

    describe() {
      const bits = (this.info && this.info.bits) || (this.lastRate && this.outBits);
      const rate = (this.info && this.info.rate) || this.lastRate;
      return bits && rate ? `FLAC ${bits}-bit ${rate / 1000} kHz` : '';
    }
  }

  Object.assign(LJ, { BitReader, flacFrame, FlacDecoder, crc8, crc16 });
})(typeof globalThis !== 'undefined' ? globalThis : this);
