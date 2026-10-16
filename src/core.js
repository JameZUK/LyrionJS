/* LyrionJS core: Slimproto, decoders and the player state machine. No DOM, no I/O:
 * the host supplies a network (byte tunnels), an audio output and a clock, so this file
 * runs unchanged in the browser and under Node for tests. */
'use strict';
(function (G) {
  const LJ = G.LJ || (G.LJ = {});
  const te = new TextEncoder();
  const td = new TextDecoder('utf-8', { fatal: false });
  const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };

  // ---------------------------------------------------------------------------
  // A growable byte queue with a read cursor.
  // ---------------------------------------------------------------------------
  class ByteQueue {
    constructor(cap = 65536) { this.buf = new Uint8Array(cap); this.start = 0; this.end = 0; }
    get length() { return this.end - this.start; }
    push(chunk) {
      const n = chunk.length;
      if (this.end + n > this.buf.length) {
        const live = this.end - this.start;
        if (live + n <= this.buf.length) {
          this.buf.copyWithin(0, this.start, this.end);
        } else {
          const nb = new Uint8Array(Math.max(this.buf.length * 2, live + n));
          nb.set(this.buf.subarray(this.start, this.end));
          this.buf = nb;
        }
        this.start = 0; this.end = live;
      }
      this.buf.set(chunk, this.end); this.end += n;
    }
    consume(n) { this.start += n; if (this.start >= this.end) { this.start = this.end = 0; } }
    peek(i) { return this.buf[this.start + i]; }
    view() { return this.buf.subarray(this.start, this.end); }
    take(n) { const v = this.buf.slice(this.start, this.start + n); this.consume(n); return v; }
    clear() { this.start = this.end = 0; }
  }

  const be16 = (b, i) => (b[i] << 8) | b[i + 1];
  const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  function put32(b, i, v) { b[i] = v >>> 24; b[i + 1] = v >>> 16; b[i + 2] = v >>> 8; b[i + 3] = v; }
  function put16(b, i, v) { b[i] = v >>> 8; b[i + 1] = v; }
  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
  function indexOfSeq(u8, seq, from = 0) {
    outer: for (let i = from; i + seq.length <= u8.length; i++) {
      for (let j = 0; j < seq.length; j++) if (u8[i + j] !== seq[j]) continue outer;
      return i;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Slimproto framing. Server -> client: u16 length (opcode + payload), opcode, payload.
  // Client -> server: opcode, u32 payload length, payload.
  // ---------------------------------------------------------------------------
  const MAX_SERVER_FRAME = 32 * 1024;

  function nextServerFrame(q) {
    if (q.length < 2) return null;
    const len = (q.peek(0) << 8) | q.peek(1);
    if (len > MAX_SERVER_FRAME) throw new Error('slimproto frame too large: ' + len);
    if (len < 4) { q.consume(Math.min(2 + len, q.length)); return null; }
    if (q.length < 2 + len) return null;
    const f = q.take(2 + len);
    return { op: latin1(f.subarray(2, 6)), payload: f.subarray(6) };
  }

  function clientFrame(op, payload) {
    const f = new Uint8Array(8 + payload.length);
    for (let i = 0; i < 4; i++) f[i] = op.charCodeAt(i);
    put32(f, 4, payload.length);
    f.set(payload, 8);
    return f;
  }

  function serverFrame(op, payload) { // for tests and the fake server
    const f = new Uint8Array(6 + payload.length);
    put16(f, 0, 4 + payload.length);
    for (let i = 0; i < 4; i++) f[2 + i] = op.charCodeAt(i);
    f.set(payload, 6);
    return f;
  }

  function buildHelo({ mac, uuid, reconnect, bytesReceived, caps }) {
    const c = te.encode(caps);
    const p = new Uint8Array(36 + c.length);
    p[0] = 12;            // device id: squeezelite-class software player
    p[1] = 0;             // revision
    p.set(mac, 2);
    p.set(uuid || new Uint8Array(16), 8);
    put16(p, 24, reconnect ? 0x4000 : 0);
    const br = Math.max(0, Math.floor(bytesReceived || 0));
    put32(p, 26, Math.floor(br / 4294967296)); put32(p, 30, br >>> 0);
    p[34] = 0x65; p[35] = 0x6e; // 'en'
    p.set(c, 36);
    return clientFrame('HELO', p);
  }

  function buildStat(s) {
    const p = new Uint8Array(53);
    for (let i = 0; i < 4; i++) p[i] = s.event.charCodeAt(i);
    p[4] = s.crlf || 0; p[5] = 0; p[6] = 0;
    put32(p, 7, s.bufSize >>> 0);
    put32(p, 11, s.bufFull >>> 0);
    const br = Math.max(0, Math.floor(s.bytesReceived || 0));
    put32(p, 15, Math.floor(br / 4294967296)); put32(p, 19, br >>> 0);
    put16(p, 23, 0xffff); // signal strength: wired
    put32(p, 25, s.jiffies >>> 0);
    put32(p, 29, s.outSize >>> 0);
    put32(p, 33, s.outFull >>> 0);
    put32(p, 37, Math.floor((s.elapsedMs || 0) / 1000) >>> 0);
    put16(p, 41, 0);
    put32(p, 43, Math.floor(s.elapsedMs || 0) >>> 0);
    put32(p, 47, s.serverTs >>> 0);
    put16(p, 51, s.error || 0);
    return clientFrame('STAT', p);
  }

  function parseStrm(p) {
    if (p.length < 24) throw new Error('strm truncated');
    return {
      command: String.fromCharCode(p[0]), autostart: String.fromCharCode(p[1]),
      format: String.fromCharCode(p[2]), pcmSize: String.fromCharCode(p[3]),
      pcmRate: String.fromCharCode(p[4]), pcmChannels: String.fromCharCode(p[5]),
      pcmEndian: String.fromCharCode(p[6]), threshold: p[7], spdif: p[8],
      transPeriod: p[9], transType: String.fromCharCode(p[10]), flags: p[11],
      outThreshold: p[12], replayGain: be32(p, 14), serverPort: be16(p, 18),
      serverIp: be32(p, 20), request: p.slice(24),
    };
  }

  function buildStrm(o) { // tests / fake server
    const req = o.request || new Uint8Array(0);
    const p = new Uint8Array(24 + req.length);
    const ch = (s, d) => (s || d).charCodeAt(0);
    p[0] = ch(o.command, 's'); p[1] = ch(o.autostart, '1'); p[2] = ch(o.format, 'f');
    p[3] = ch(o.pcmSize, '?'); p[4] = ch(o.pcmRate, '?'); p[5] = ch(o.pcmChannels, '?'); p[6] = ch(o.pcmEndian, '?');
    p[7] = o.threshold || 0; p[8] = 0; p[9] = 0; p[10] = ch(o.transType, '0'); p[11] = o.flags || 0; p[12] = 0; p[13] = 0;
    put32(p, 14, o.replayGain || 0); put16(p, 18, o.serverPort || 9000); put32(p, 20, o.serverIp || 0);
    p.set(req, 24);
    return serverFrame('strm', p);
  }

  function parseAudg(p) {
    if (p.length < 18) throw new Error('audg truncated');
    const adjust = p[8];
    const l = be32(p, 10), r = be32(p, 14);
    return { adjust, left: adjust ? l / 65536 : 1, right: adjust ? r / 65536 : 1 };
  }

  const ipString = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

  function parseHttpHead(u8) {
    const end = indexOfSeq(u8, [13, 10, 13, 10]);
    if (end < 0) return null;
    const text = latin1(u8.subarray(0, end));
    const lines = text.split('\r\n');
    const m = lines[0].match(/^(?:HTTP\/\d\.\d|ICY)\s+(\d+)/i) || [];
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { status: +(m[1] || 0), headers, headLen: end + 4, raw: u8.slice(0, end + 4) };
  }

  // ---------------------------------------------------------------------------
  // ICY metadata stripping (only when the stream server asked for it).
  // ---------------------------------------------------------------------------
  class IcyStripper {
    constructor(metaint) { this.metaint = metaint; this.left = metaint; this.metaLeft = -1; this.meta = []; }
    feed(chunk, onAudio, onMeta) {
      let i = 0;
      while (i < chunk.length) {
        if (this.metaLeft === -1) {
          const n = Math.min(this.left, chunk.length - i);
          if (n) onAudio(chunk.subarray(i, i + n));
          i += n; this.left -= n;
          if (this.left === 0) this.metaLeft = -2;
        } else if (this.metaLeft === -2) {
          this.metaLeft = chunk[i++] * 16; this.meta = [];
          if (this.metaLeft === 0) { this.metaLeft = -1; this.left = this.metaint; }
        } else {
          const n = Math.min(this.metaLeft, chunk.length - i);
          this.meta.push(chunk.slice(i, i + n)); i += n; this.metaLeft -= n;
          if (this.metaLeft === 0) {
            let all = new Uint8Array(0); for (const m of this.meta) all = concat(all, m);
            onMeta(all); this.metaLeft = -1; this.left = this.metaint;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // FLAC: a streaming decoder written from the format specification.
  // ---------------------------------------------------------------------------
  const NEED = { need: true };
  const BAD = { bad: true };

  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i; for (let j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; CRC8[i] = c;
    let d = i << 8; for (let j = 0; j < 8; j++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; CRC16[i] = d;
  }
  function crc8(b, s, e) { let c = 0; for (let i = s; i < e; i++) c = CRC8[c ^ b[i]]; return c; }
  function crc16(b, s, e) { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) ^ CRC16[(c >> 8) ^ b[i]]) & 0xffff; return c; }

  class BitReader {
    constructor(b, start, end) { this.b = b; this.pos = start * 8; this.endBits = end * 8; }
    word() { const b = this.b, i = this.pos >>> 3; return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
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

  const FLAC_BS = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
  const FLAC_SR = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
  const FLAC_SS = [0, 8, 12, -1, 16, 20, 24, 32];

  function flacResidual(br, n, order, out) {
    const method = br.read(2);
    if (method > 1) throw BAD;
    const pbits = method === 0 ? 4 : 5, esc = method === 0 ? 15 : 31;
    const porder = br.read(4);
    const parts = 1 << porder;
    const psize = n >>> porder;
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
          const q = br.unary();
          const v = q * pw + (k ? br.read(k) : 0);
          out[i++] = (v % 2) ? -(v + 1) / 2 : v / 2;
        }
      }
      br.check();
    }
  }

  function flacSubframe(br, n, bps, out) {
    if (br.read(1) !== 0) throw BAD;
    const type = br.read(6);
    let wasted = 0;
    if (br.read(1)) wasted = br.unary() + 1;
    const bits = bps - wasted;
    if (bits <= 0) throw BAD;
    if (type === 0) {
      const v = br.signed(bits); for (let i = 0; i < n; i++) out[i] = v;
    } else if (type === 1) {
      for (let i = 0; i < n; i++) out[i] = br.signed(bits);
    } else if (type >= 8 && type <= 12) {
      const order = type - 8;
      if (order > n) throw BAD;
      for (let i = 0; i < order; i++) out[i] = br.signed(bits);
      flacResidual(br, n, order, out);
      switch (order) {
        case 1: for (let i = 1; i < n; i++) out[i] += out[i - 1]; break;
        case 2: for (let i = 2; i < n; i++) out[i] += 2 * out[i - 1] - out[i - 2]; break;
        case 3: for (let i = 3; i < n; i++) out[i] += 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3]; break;
        case 4: for (let i = 4; i < n; i++) out[i] += 4 * out[i - 1] - 6 * out[i - 2] + 4 * out[i - 3] - out[i - 4]; break;
      }
    } else if (type >= 32) {
      const order = type - 31;
      if (order > n) throw BAD;
      for (let i = 0; i < order; i++) out[i] = br.signed(bits);
      const prec = br.read(4) + 1;
      if (prec === 16) throw BAD;
      const shift = br.signed(5);
      if (shift < 0) throw BAD;
      const coef = new Float64Array(order);
      for (let j = 0; j < order; j++) coef[j] = br.signed(prec);
      flacResidual(br, n, order, out);
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

  /** Decode one frame at b[s..e). Returns {len, rate, channels, bits, data: Float32Array[]} or NEED/BAD. */
  function flacFrame(b, s, e, info) {
    if (e - s < 16) return NEED;
    if (b[s] !== 0xff || (b[s + 1] & 0xfe) !== 0xf8) return BAD;
    const br = new BitReader(b, s, e);
    try {
      br.read(16);
      const bsCode = br.read(4), srCode = br.read(4), chCode = br.read(4), ssCode = br.read(3);
      if (br.read(1)) return BAD;
      // UTF-8-style coded frame/sample number.
      const x = br.read(8);
      if (x >= 0x80) {
        let extra = 0;
        if ((x & 0xe0) === 0xc0) extra = 1; else if ((x & 0xf0) === 0xe0) extra = 2;
        else if ((x & 0xf8) === 0xf0) extra = 3; else if ((x & 0xfc) === 0xf8) extra = 4;
        else if ((x & 0xfe) === 0xfc) extra = 5; else if (x === 0xfe) extra = 6; else return BAD;
        for (let i = 0; i < extra; i++) if ((br.read(8) & 0xc0) !== 0x80) return BAD;
      }
      let n = FLAC_BS[bsCode];
      if (bsCode === 0) return BAD;
      if (bsCode === 6) n = br.read(8) + 1; else if (bsCode === 7) n = br.read(16) + 1;
      let rate;
      if (srCode === 0) rate = info && info.rate;
      else if (srCode < 12) rate = FLAC_SR[srCode];
      else if (srCode === 12) rate = br.read(8) * 1000;
      else if (srCode === 13) rate = br.read(16);
      else if (srCode === 14) rate = br.read(16) * 10;
      else return BAD;
      if (!rate) return BAD;
      const headEnd = br.pos >>> 3;
      if (headEnd >= e) return NEED;
      if (crc8(b, s, headEnd) !== b[headEnd]) return BAD;
      br.read(8);
      let bps = FLAC_SS[ssCode];
      if (ssCode === 0) bps = info && info.bits;
      if (!bps || bps < 0 || bps > 24) return BAD;
      let channels;
      if (chCode < 8) channels = chCode + 1; else if (chCode <= 10) channels = 2; else return BAD;
      if (info && info.maxBlock && n > Math.max(info.maxBlock, 16)) return BAD;
      const sub = [];
      for (let c = 0; c < channels; c++) {
        const side = (chCode === 8 && c === 1) || (chCode === 9 && c === 0) || (chCode === 10 && c === 1);
        const out = new Float64Array(n);
        flacSubframe(br, n, bps + (side ? 1 : 0), out);
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

  /** Common decoder interface:
   *   feed(Uint8Array), end(), pump(maxFrames) -> 'need' | 'more' | 'done',
   *   buffered (bytes held), onBlock(rate, channels[Float32Array]), describe(). */
  class FlacDecoder {
    constructor() { this.q = new ByteQueue(1 << 18); this.ended = false; this.state = 'start'; this.info = null; this.waitFor = 0; this.onBlock = null; this.keepInts = false; }
    get buffered() { return this.q.length; }
    feed(u8) { this.q.push(u8); }
    end() { this.ended = true; }
    _metadata() {
      const v = this.q.view();
      if (v.length < 4) return this.ended ? 'done' : 'need';
      if (v[0] === 0x49 && v[1] === 0x44 && v[2] === 0x33) { // ID3v2 in front of fLaC
        if (v.length < 10) return 'need';
        const sz = ((v[6] & 127) << 21) | ((v[7] & 127) << 14) | ((v[8] & 127) << 7) | (v[9] & 127);
        const total = 10 + sz + ((v[5] & 0x10) ? 10 : 0);
        if (v.length < total) return this.ended ? 'done' : 'need';
        this.q.consume(total); return this._metadata();
      }
      if (v[0] !== 0x66 || v[1] !== 0x4c || v[2] !== 0x61 || v[3] !== 0x43) { this.state = 'frames'; return 'more'; }
      let i = 4;
      for (;;) {
        if (v.length < i + 4) return this.ended ? 'done' : 'need';
        const last = v[i] & 0x80, type = v[i] & 0x7f, len = (v[i + 1] << 16) | (v[i + 2] << 8) | v[i + 3];
        if (v.length < i + 4 + len) return this.ended ? 'done' : 'need';
        if (type === 0 && len >= 34) {
          const p = i + 4;
          this.info = {
            minBlock: be16(v, p), maxBlock: be16(v, p + 2),
            maxFrame: (v[p + 7] << 16) | (v[p + 8] << 8) | v[p + 9],
            rate: (v[p + 10] << 12) | (v[p + 11] << 4) | (v[p + 12] >> 4),
            channels: ((v[p + 12] >> 1) & 7) + 1,
            bits: (((v[p + 12] & 1) << 4) | (v[p + 13] >> 4)) + 1,
            totalSamples: (v[p + 13] & 15) * 4294967296 + be32(v, p + 14),
          };
        }
        i += 4 + len;
        if (last) break;
      }
      this.q.consume(i); this.state = 'frames';
      return 'more';
    }
    pump(maxFrames = 64) {
      if (this.state === 'done') return 'done';
      if (this.state === 'start') { const r = this._metadata(); if (r !== 'more') { if (r === 'done') this.state = 'done'; return r; } }
      let produced = 0;
      while (produced < maxFrames) {
        const v = this.q.view();
        if (!this.ended && v.length < this.waitFor) return 'need';
        if (v.length < 2) { if (this.ended) { this.state = 'done'; return 'done'; } return 'need'; }
        // Find a frame sync.
        if (v[0] !== 0xff || (v[1] & 0xfe) !== 0xf8) {
          let j = 1; while (j + 1 < v.length && !(v[j] === 0xff && (v[j + 1] & 0xfe) === 0xf8)) j++;
          this.q.consume(j); continue;
        }
        const r = flacFrame(v, 0, v.length, this.info);
        if (r === NEED) {
          if (this.ended) { this.state = 'done'; this.q.clear(); return 'done'; }
          this.waitFor = v.length + 4096; return 'need';
        }
        this.waitFor = 0;
        if (r === BAD) { this.q.consume(1); continue; }
        this.q.consume(r.len);
        this.lastRate = r.rate; this.lastBits = this.outBits = r.bits; this.lastChannels = r.channels;
        if (this.onBlock) this.onBlock(r.rate, r.data, this.keepInts ? r.ints : null);
        produced++;
      }
      return 'more';
    }
    describe() { const i = this.info || {}; const bits = i.bits || this.lastBits, rate = i.rate || this.lastRate; return bits && rate ? `FLAC ${bits}-bit ${rate / 1000} kHz` : 'FLAC ?'; }
  }

  // ---------------------------------------------------------------------------
  // PCM (raw, WAV or AIFF), as LMS sends for 'p'.
  // ---------------------------------------------------------------------------
  const PCM_RATES = { '0': 11025, '1': 22050, '2': 32000, '3': 44100, '4': 48000, '5': 8000, '6': 12000, '7': 16000, '8': 24000, '9': 96000, ':': 88200, ';': 176400, '<': 192000, '=': 352800, '>': 384000 };
  const PCM_SIZES = { '0': 8, '1': 16, '2': 24, '3': 32 };

  class PcmDecoder {
    constructor(strm) {
      this.q = new ByteQueue(1 << 18); this.ended = false; this.onBlock = null; this.headerChecked = false;
      this.bits = PCM_SIZES[strm.pcmSize] || 16; this.rate = PCM_RATES[strm.pcmRate] || 44100;
      this.channels = strm.pcmChannels === '1' ? 1 : 2; this.little = strm.pcmEndian !== '0';
      this.dataLeft = Infinity; this.done = false;
    }
    get outBits() { return Math.min(this.bits, 24); }
    get buffered() { return this.q.length; }
    feed(u8) { this.q.push(u8); }
    end() { this.ended = true; }
    _header() {
      const v = this.q.view();
      if (v.length < 12) return this.ended ? 'nohdr' : 'need';
      const tag = latin1(v.subarray(0, 4)), kind = latin1(v.subarray(8, 12));
      if (tag === 'RIFF' && kind === 'WAVE') {
        let i = 12;
        for (;;) {
          if (v.length < i + 8) return this.ended ? 'nohdr' : 'need';
          const id = latin1(v.subarray(i, i + 4));
          const len = (v[i + 4] | (v[i + 5] << 8) | (v[i + 6] << 16) | (v[i + 7] << 24)) >>> 0;
          if (id === 'fmt ') {
            if (v.length < i + 8 + 16) return 'need';
            const p = i + 8;
            this.channels = v[p + 2] | (v[p + 3] << 8);
            this.rate = (v[p + 4] | (v[p + 5] << 8) | (v[p + 6] << 16) | (v[p + 7] << 24)) >>> 0;
            this.bits = v[p + 14] | (v[p + 15] << 8);
            this.little = true;
          } else if (id === 'data') { this.q.consume(i + 8); this.dataLeft = len || Infinity; return 'ok'; }
          i += 8 + len + (len & 1);
        }
      }
      if (tag === 'FORM' && (kind === 'AIFF' || kind === 'AIFC')) {
        let i = 12;
        for (;;) {
          if (v.length < i + 8) return this.ended ? 'nohdr' : 'need';
          const id = latin1(v.subarray(i, i + 4));
          const len = be32(v, i + 4);
          if (id === 'COMM') {
            if (v.length < i + 8 + 18) return 'need';
            const p = i + 8;
            this.channels = be16(v, p); this.bits = be16(v, p + 6);
            // 80-bit extended float sample rate.
            const exp = (be16(v, p + 8) & 0x7fff) - 16383, mant = be32(v, p + 10);
            this.rate = Math.round(mant * 2 ** (exp - 31));
            this.little = kind === 'AIFC' && v.length >= p + 22 && latin1(v.subarray(p + 18, p + 22)) === 'sowt';
          } else if (id === 'SSND') {
            if (v.length < i + 16) return 'need';
            const offset = be32(v, i + 8);
            this.q.consume(i + 16 + offset); this.dataLeft = len ? len - 8 - offset : Infinity; return 'ok';
          }
          i += 8 + len + (len & 1);
        }
      }
      return 'nohdr';
    }
    pump(maxBlocks = 16) {
      if (this.done) return 'done';
      if (!this.headerChecked) {
        const h = this._header();
        if (h === 'need') return 'need';
        this.headerChecked = true;
      }
      const bytesPer = this.bits / 8, frameBytes = bytesPer * this.channels;
      if (!frameBytes || bytesPer !== Math.floor(bytesPer)) { this.done = true; return 'done'; }
      for (let b = 0; b < maxBlocks; b++) {
        const avail = Math.min(this.q.length, this.dataLeft);
        let frames = Math.floor(avail / frameBytes);
        if (frames < 4096 && !this.ended && this.dataLeft > frames * frameBytes) return 'need';
        frames = Math.min(frames, 16384);
        if (frames === 0) { if (this.ended || this.dataLeft === 0) { this.done = true; return 'done'; } return 'need'; }
        const v = this.q.view(), out = [];
        for (let c = 0; c < this.channels; c++) out.push(new Float32Array(frames));
        const scale = 1 / 2 ** (this.bits - 1), lit = this.little, bits = this.bits;
        let i = 0;
        for (let f = 0; f < frames; f++) {
          for (let c = 0; c < this.channels; c++) {
            let s;
            if (bits === 16) s = lit ? (v[i] | (v[i + 1] << 8)) << 16 >> 16 : (v[i + 1] | (v[i] << 8)) << 16 >> 16;
            else if (bits === 24) s = lit ? (v[i] | (v[i + 1] << 8) | (v[i + 2] << 16)) << 8 >> 8 : (v[i + 2] | (v[i + 1] << 8) | (v[i] << 16)) << 8 >> 8;
            else if (bits === 32) s = lit ? (v[i] | (v[i + 1] << 8) | (v[i + 2] << 16) | (v[i + 3] << 24)) : (v[i + 3] | (v[i + 2] << 8) | (v[i + 1] << 16) | (v[i] << 24));
            else s = (v[i] - 128) * 1; // 8-bit is unsigned
            out[c][f] = s * scale; i += bytesPer;
          }
        }
        this.q.consume(frames * frameBytes);
        if (this.dataLeft !== Infinity) this.dataLeft -= frames * frameBytes;
        if (this.onBlock) this.onBlock(this.rate, out);
      }
      return 'more';
    }
    describe() { return `PCM ${this.bits}-bit ${this.rate / 1000} kHz`; }
  }

  // ---------------------------------------------------------------------------
  // MP3 framing (decoding itself is done by the browser's WebCodecs).
  // ---------------------------------------------------------------------------
  const MP3_BR = {
    '3-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '3-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

  function mp3Header(b, i) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
    const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
    const bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1, mode = b[i + 3] >> 6;
    if (ver === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) return null;
    const lay = 4 - layer; // 1, 2 or 3
    const br = MP3_BR[(ver === 3 ? 3 : 2) + '-' + lay][bri] * 1000;
    const rate = MP3_SR[ver][sri];
    let len, samples;
    if (lay === 1) { len = (Math.floor(12 * br / rate) + pad) * 4; samples = 384; }
    else if (lay === 2 || ver === 3) { len = Math.floor(144 * br / rate) + pad; samples = 1152; }
    else { len = Math.floor(72 * br / rate) + pad; samples = 576; }
    return { len, rate, channels: mode === 3 ? 1 : 2, samples, ver, layer: lay, bitrate: br };
  }

  /** Splits an MP3 stream into frames; reads the LAME tag for gapless trimming. */
  class Mp3Framer {
    constructor() { this.q = new ByteQueue(1 << 17); this.ended = false; this.first = true; this.delay = 0; this.padding = 0; this.info = null; this.synced = false; }
    feed(u8) { this.q.push(u8); }
    get buffered() { return this.q.length; }
    /** Returns {frame, hdr} | 'need' | 'done'. */
    next() {
      for (;;) {
        const v = this.q.view();
        if (v.length < 10) { if (this.ended) { this.q.clear(); return 'done'; } return 'need'; }
        if (v[0] === 0x49 && v[1] === 0x44 && v[2] === 0x33) {
          const sz = ((v[6] & 127) << 21) | ((v[7] & 127) << 14) | ((v[8] & 127) << 7) | (v[9] & 127);
          const total = 10 + sz + ((v[5] & 0x10) ? 10 : 0);
          if (v.length < total && !this.ended) return 'need';
          this.q.consume(Math.min(total, v.length)); continue;
        }
        const h = mp3Header(v, 0);
        if (!h) {
          this.synced = false;
          let j = 1; while (j + 1 < v.length && !(v[j] === 0xff && (v[j + 1] & 0xe0) === 0xe0)) j++;
          this.q.consume(j); continue;
        }
        if (v.length < h.len + 4 && !this.ended) return 'need';
        if (!this.synced && v.length >= h.len + 4) {
          // Out of sync (stream start, or after a seek into the middle of a file): insist the
          // next frame lines up and agrees, so a stray 0xFFE in the audio isn't taken for a frame.
          const h2 = mp3Header(v, h.len);
          if (!h2 || h2.rate !== h.rate || h2.ver !== h.ver || h2.layer !== h.layer || h2.channels !== h.channels) { this.q.consume(1); continue; }
        }
        if (h.len > v.length) { this.q.clear(); return 'done'; }
        this.synced = true;
        const frame = this.q.take(h.len);
        if (this.first) {
          this.first = false;
          const side = h.ver === 3 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
          const x = 4 + side, tag = latin1(frame.subarray(x, x + 4));
          if (tag === 'Xing' || tag === 'Info') {
            const flags = be32(frame, x + 4);
            let o = x + 8; if (flags & 1) o += 4; if (flags & 2) o += 4; if (flags & 4) o += 100; if (flags & 8) o += 4;
            if (o + 24 <= frame.length && latin1(frame.subarray(o, o + 4)) === 'LAME') {
              const d = frame.subarray(o + 21, o + 24);
              this.delay = (d[0] << 4) | (d[1] >> 4); this.padding = ((d[1] & 15) << 8) | d[2];
            }
            this.info = h; continue; // the tag frame carries no audio
          }
        }
        this.info = this.info || h;
        return { frame, hdr: h };
      }
    }
  }

  /** MP3 through WebCodecs AudioDecoder (Chrome, Edge, Firefox, Safari 26+). */
  class Mp3Decoder {
    static supported() { return typeof G.AudioDecoder === 'function' && typeof G.EncodedAudioChunk === 'function'; }
    constructor(opts = {}) {
      this.framer = new Mp3Framer(); this.onBlock = null; this.ended = false; this.dec = null; this.ts = 0;
      this.outQ = []; this.flushing = null; this.finished = false; this.skip = -1; this.held = null; this.error = null;
      this.errors = 0; this.aborted = false;
      this.decoderDelay = opts.decoderDelay == null ? 529 : opts.decoderDelay;
    }
    get buffered() { return this.framer.buffered; }
    feed(u8) { this.framer.feed(u8); }
    end() { this.ended = true; this.framer.ended = true; }
    /** Stop for good: the track was flushed or replaced. */
    abort() {
      this.aborted = this.finished = true; this.outQ = []; this.held = null;
      if (this.dec) { try { this.dec.close(); } catch (e) { /* closed */ } this.dec = null; }
    }
    _open(h) {
      const dec = new G.AudioDecoder({
        output: (ad) => {
          if (this.aborted || dec !== this.dec) { ad.close(); return; }
          const n = ad.numberOfFrames, ch = Math.min(ad.numberOfChannels, 2), chans = [];
          for (let c = 0; c < ch; c++) { const a = new Float32Array(n); ad.copyTo(a, { planeIndex: c, format: 'f32-planar' }); chans.push(a); }
          this.outQ.push({ rate: ad.sampleRate, chans }); ad.close();
          if (this.onFinished) this.onFinished();
        },
        // A corrupt frame closes the decoder; pump() opens a new one and carries on.
        error: (e) => { if (dec === this.dec) { this.error = e; this.errors++; } },
      });
      dec.configure({ codec: 'mp3', sampleRate: h.rate, numberOfChannels: h.channels });
      this.dec = dec; this.config = h;
    }
    _emit(rate, chans) {
      // Gapless: drop the encoder delay (plus the decoder's own) at the start, and hold the
      // latest block back so the encoder padding can be cut from it once the end is known.
      if (this.skip < 0) this.skip = this.framer.delay ? this.framer.delay + this.decoderDelay : 0;
      if (this.skip > 0) {
        const n = Math.min(this.skip, chans[0].length); this.skip -= n;
        chans = chans.map((c) => c.subarray(n));
        if (!chans[0].length) return;
      }
      if (this.held && this.onBlock) this.onBlock(this.held.rate, this.held.chans);
      this.held = { rate, chans };
    }
    _drainOut() { while (this.outQ.length) { const o = this.outQ.shift(); this._emit(o.rate, o.chans); } }
    pump(maxFrames = 64) {
      if (this.finished) return 'done';
      if (this.error) {
        this.error = null; this.dec = null; this.flushing = null;
        if (this.errors > 20) { this.finished = true; if (this.onError) this.onError('MP3 decoding failed'); return 'done'; }
      }
      this._drainOut();
      if (this.flushing) return 'need';
      for (let i = 0; i < maxFrames; i++) {
        if (this.dec && this.dec.decodeQueueSize > 32) return 'need';
        const r = this.framer.next();
        if (r === 'need') return 'need';
        if (r === 'done') {
          if (!this.ended) return 'need';
          if (!this.dec) { this.finished = true; return 'done'; }
          this.flushing = this.dec.flush().catch(() => {}).then(() => {
            this._drainOut();
            if (this.held) {
              let chans = this.held.chans; const pad = Math.max(0, this.framer.padding - this.decoderDelay);
              if (pad && pad < chans[0].length) chans = chans.map((c) => c.subarray(0, c.length - pad));
              if (this.onBlock) this.onBlock(this.held.rate, chans);
              this.held = null;
            }
            this.finished = true; try { this.dec.close(); } catch (e) { /* closed */ }
            if (this.onFinished) this.onFinished();
          });
          return 'need';
        }
        if (!this.dec || this.config.rate !== r.hdr.rate || this.config.channels !== r.hdr.channels) {
          if (this.dec) { try { this.dec.close(); } catch (e) { /* closed */ } }
          this._open(r.hdr);
        }
        this.dec.decode(new G.EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: r.frame }));
        this.ts += Math.round(r.hdr.samples * 1e6 / r.hdr.rate);
      }
      return 'more';
    }
    describe() { const h = this.framer.info; return h ? `MP3 ${h.rate / 1000} kHz` : 'MP3 ?'; }
  }

  /**
   * MP3 through the browser's decodeAudioData, for browsers without WebCodecs (Chrome and Firefox
   * hide it on plain http pages). The stream is decoded in chunks of about 10 s. Each chunk starts
   * with the last OVERLAP frames of the one before, so the bit reservoir and the MDCT overlap are
   * primed; the last HOLD frames of each chunk's audio are held back and replaced by the properly
   * decoded overlap of the next. The join is found by matching the audio, so it doesn't depend on
   * how much delay a particular browser's decoder adds.
   * decode(Uint8Array, rate, channels) -> Promise<Float32Array[]> is supplied by the host.
   */
  class Mp3ChunkDecoder {
    constructor(decode, opts = {}) {
      this.decode = decode; this.framer = new Mp3Framer(); this.onBlock = null; this.ended = false;
      this.frames = []; this.prevTail = []; this.busy = false; this.finished = false; this.first = true;
      this.chunk = opts.chunk || 384; this.ref = null; this.skip = -1;
    }
    get buffered() { return this.framer.buffered; }
    feed(u8) { this.framer.feed(u8); }
    end() { this.ended = true; this.framer.ended = true; }
    abort() { this.finished = true; this.frames = []; }
    describe() { const h = this.framer.info; return h ? `MP3 ${h.rate / 1000} kHz` : 'MP3 ?'; }
    pump() {
      if (this.finished) return 'done';
      let last = false;
      // A short first chunk, so playback (or radio) starts quickly.
      const want = this.first ? Math.min(96, this.chunk) : this.chunk;
      // Move frames out of the byte queue (so flow control keeps the stream coming).
      while (this.frames.length < this.chunk) {
        const r = this.framer.next();
        if (r === 'need') break;
        if (r === 'done') { last = true; break; }
        this.frames.push(r); this.hdr = this.hdr || r.hdr;
      }
      if (this.busy) return 'need';
      if (this.frames.length < want && !last) return 'need';
      if (!this.frames.length) { if (last) { this.finished = true; return 'done'; } return 'need'; }
      const OVERLAP = 4, HOLD = 2;
      const take = this.frames.splice(0, want);
      const all = this.prevTail.concat(take);
      const overlapFrames = this.prevTail.length;
      this.prevTail = take.slice(-OVERLAP);
      const final = last && this.frames.length === 0;
      let size = 0; for (const f of all) size += f.frame.length;
      const bytes = new Uint8Array(size); let o = 0; for (const f of all) { bytes.set(f.frame, o); o += f.frame.length; }
      const spf = this.hdr.samples, rate = this.hdr.rate;
      this.busy = true;
      this.decode(bytes, rate, this.hdr.channels).then((chans) => {
        if (this.finished) return;
        chans = chans.slice(0, 2);
        let start = 0;
        if (this.first) {
          this.first = false;
          start = this.framer.delay ? this.framer.delay + 529 : 0;
        } else {
          // Where does the new audio continue the old? Expect about overlapFrames*spf in.
          start = this._align(chans[0], (overlapFrames - HOLD) * spf, spf);
        }
        let end = chans[0].length;
        if (!final) end -= HOLD * spf;
        else if (this.framer.padding) end -= Math.max(0, this.framer.padding - 529);
        if (end > start) {
          const out = chans.map((c) => c.slice(start, end));
          const ref = out[0];
          this.ref = ref.slice(Math.max(0, ref.length - 512));
          if (this.onBlock) this.onBlock(rate, out);
        }
        this.busy = false;
        if (final) this.finished = true;
        if (this.onFinished) this.onFinished();
      }, () => {
        // A chunk the browser can't decode: skip it rather than stop the track.
        this.busy = false; if (final) this.finished = true;
        if (this.onFinished) this.onFinished();
      });
      return 'need';
    }
    /** Offset in `x` that best continues the 512 samples emitted last (least squares). */
    _align(x, expect, spf) {
      const ref = this.ref;
      if (!ref || ref.length < 512) return Math.max(0, expect);
      const lo = Math.max(512, expect - spf), hi = Math.min(x.length - 1, expect + spf);
      let best = Math.max(0, expect), bestErr = Infinity, energy = 0;
      for (let k = 0; k < 512; k++) energy += ref[k] * ref[k];
      if (energy < 1e-6) return Math.max(0, expect); // silence: any offset is as good
      for (let o = lo; o <= hi; o++) {
        let e = 0;
        for (let k = 0; k < 512 && e < bestErr; k++) { const d = x[o - 512 + k] - ref[k]; e += d * d; }
        if (e < bestErr) { bestErr = e; best = o; }
      }
      return best;
    }
  }

  // ---------------------------------------------------------------------------
  // The Slimproto player.
  // ---------------------------------------------------------------------------
  const STREAM_WINDOW = 2 * 1024 * 1024;   // compressed bytes in flight per stream
  const DECODE_AHEAD_S = 10;                // seconds of PCM kept queued at the output
  const HEARTBEAT_MS = 1000;

  class SlimPlayer {
    /**
     * opts: { mac: Uint8Array(6), uuid, name, openControl() -> control, openStream({ip, port, win}) -> stream,
     *         output, now() -> ms (monotonic; the output's clock), caps: string[], maxRate,
     *         decoders: { f: (strm) => decoder, ... }, log }
     * control: { send(u8), close(), onopen (a new session: send HELO), onresumed (the same session
     *            after a gap), ondata(u8, replayed), onclose (the session is over) }
     * stream:  { send(u8), ack(n), close(), onopen, ondata(u8), onclose(clean) }
     * output: { push(seq, rate, chans, bits), endSeq(seq), play(), pause(), startAt(ms), pauseFor(ms),
     *           skip(ms), flush(), trimAfter(seq), setGain(g), setMute(b), queuedSeconds(),
     *           audible(nowMs) -> {seq, ms} | null, underrun, rate, onReport }
     */
    constructor(opts) {
      Object.assign(this, opts);
      this.log = opts.log || (() => {});
      this.state = 'stopped';   // stopped | waiting | loaded | playing | paused
      this.tracks = [];
      this.seq = 0; this.ctl = null; this.connected = false; this.everConnected = false;
      this.audibleSeq = null; this.stmsSent = new Set(); this.stmuSent = true; this.stmoSent = false;
      this.lastStat = 0; this.backoff = 1000; this.serverVersion = ''; this.gain = 1; this.enabled = true;
      this.listeners = new Set(); this.stopped = true; this.pumping = false; this.lastError = '';
      this.output.onReport = () => this.tick();
    }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(what) { for (const fn of this.listeners) { try { fn(what, this); } catch (e) { this.log('listener', e); } } }

    start() {
      this.stopped = false; this._connect();
      if (!this.timer && G.setInterval && !this.noTimer) this.timer = G.setInterval(() => this.tick(), 100);
    }
    stop() {
      this.stopped = true; this._flush();
      if (this.ctl) { try { this._send(clientFrame('BYE!', new Uint8Array([0]))); } catch (e) { /* closed */ } this.ctl.close(); }
      this.connected = false;
      if (this.timer) { G.clearInterval(this.timer); this.timer = null; }
    }

    _connect() {
      const t = this.openControl();
      this.ctl = t; this.rx = new ByteQueue(8192);
      // The same session after a gap: LMS never saw us leave. Tell it where we are now (held
      // heartbeats are never sent: LMS re-bases its clock on each one).
      t.onresumed = () => { if (this.ctl === t) { this.connected = true; this._stat('STMt'); this.emit('connected'); } };
      t.onopen = () => {
        if (this.ctl !== t) return;
        this.connected = true; this.backoff = 1000;
        const cur = this.tracks[this.tracks.length - 1];
        this._send(buildHelo({ mac: this.mac, uuid: this.uuid, reconnect: this.everConnected && this.state !== 'stopped', bytesReceived: cur ? cur.bytes : 0, caps: this.capabilities() }));
        this.everConnected = true; this.emit('connected');
      };
      t.ondata = (d, replayed) => {
        if (this.ctl !== t) return;
        this.rx.push(d); this.replaying = !!replayed;
        try { this._control(); } finally { this.replaying = false; }
      };
      t.onclose = () => {
        if (this.ctl !== t) return;
        this.connected = false; this.emit('disconnected');
        if (this.stopped) return;
        const wait = this.backoff; this.backoff = Math.min(this.backoff * 2, 15000);
        G.setTimeout(() => { if (!this.stopped && this.ctl === t) this._connect(); }, wait);
      };
    }

    capabilities() {
      return ['Model=squeezelite', 'ModelName=LyrionJS', 'AccuratePlayPoints=1', 'HasDigitalOut=0',
        'HasPolarityInversion=0', 'Balance=0', 'Firmware=lyrionjs-1.0', 'MaxSampleRate=' + (this.maxRate || 96000)]
        .concat(this.caps).join(',');
    }

    _send(frame) { if (this.ctl && this.connected) this.ctl.send(frame); }

    _control() {
      for (;;) {
        let f;
        try { f = nextServerFrame(this.rx); } catch (e) { this.log('bad frame', e); this.rx.clear(); this.ctl.close(); return; }
        if (!f) return;
        try { this._handle(f.op, f.payload); } catch (e) { this.log('handling ' + f.op, e); }
      }
    }

    _handle(op, p) {
      switch (op) {
        case 'strm': this._strm(parseStrm(p)); break;
        case 'audg': { const a = parseAudg(p); this.gain = (a.left + a.right) / 2; this.output.setGain(this.gain); this.emit('volume'); break; }
        case 'aude': this.enabled = p.length > 1 ? p[1] !== 0 : true; this.output.setMute(!this.enabled); this.emit('power'); break;
        case 'setd':
          if (p[0] === 0) {
            if (p.length === 1) this._send(clientFrame('SETD', concat(new Uint8Array([0]), te.encode(this.name + '\0'))));
            else { this.name = td.decode(p.subarray(1)).replace(/\0[\s\S]*$/, ''); this.emit('name'); }
          }
          break;
        case 'vers': this.serverVersion = latin1(p); break;
        case 'serv': break; // stay on the server the user chose
        default: break;     // display, IR, visualiser: not for a headless player
      }
    }

    _elapsed(now) {
      if (this.state !== 'playing' && this.state !== 'paused') return 0;
      const a = this.output.audible(now);
      return a && a.seq === this.audibleSeq ? a.ms : 0;
    }

    _stat(event, serverTs = 0) {
      const now = this.now();
      const cur = this.tracks[this.tracks.length - 1];
      const rate = this.output.rate || 44100;
      this._send(buildStat({
        event, bufSize: STREAM_WINDOW, bufFull: cur && cur.decoder ? Math.min(cur.decoder.buffered, STREAM_WINDOW) : 0,
        bytesReceived: cur ? cur.bytes : 0, jiffies: Math.floor(now),
        outSize: (this.decodeAhead || DECODE_AHEAD_S) * rate * 8, outFull: Math.floor(this.output.queuedSeconds() * rate * 8),
        elapsedMs: this._elapsed(now), serverTs,
      }));
      this.lastStat = now;
      if (this.onStat) this.onStat(event);
    }

    _strm(s) {
      if (this.onStrm) this.onStrm(s);
      if (this.replaying) {
        // Sent while we were away: corrections and polls describe a moment already past, and
        // applied late they would make the player jump. A timed start becomes "start now".
        if (s.command === 'a' || s.command === 't' || (s.command === 'p' && s.replayGain !== 0)) return;
        if (s.command === 'u') s = Object.assign({}, s, { replayGain: 0 });
      }
      switch (s.command) {
        case 's': this._startTrack(s); break;
        case 'p':
          if (s.replayGain === 0) {
            if (this.state !== 'stopped') { this.state = 'paused'; this.output.pause(); }
            this._stat('STMp'); this.emit('state');
          } else {
            this.output.pauseFor(Math.min(s.replayGain, 10000));
          }
          break;
        case 'u': {
          const now = this.now();
          const ahead = ((s.replayGain - Math.floor(now)) | 0);
          if (s.replayGain !== 0 && ahead > 0 && ahead <= 30000) this.output.startAt(now + ahead);
          else this.output.play();
          this.state = 'playing'; this.stmuSent = false;
          this._stat('STMr'); this.emit('state');
          break;
        }
        case 'q': this._flush(); this._stat('STMf'); this.emit('state'); break;
        case 'f': {
          const keep = this.audibleSeq;
          if (keep == null) this._flush();
          else {
            for (const t of this.tracks) if (t.seq > keep) this._kill(t);
            this.tracks = this.tracks.filter((t) => t.seq <= keep);
            this.output.trimAfter(keep);
          }
          this._stat('STMf'); break;
        }
        case 't': this._stat('STMt', s.replayGain); break;
        case 'a': this.output.skip(Math.min(s.replayGain, 10000)); break;
        default: break;
      }
    }

    _startTrack(s) {
      const seq = ++this.seq;
      // A new stream while the previous one is still arriving replaces it.
      for (const t of this.tracks) if (!t.streamEnded) { this._closeTrack(t); t.decodeDone = true; this.output.endSeq(t.seq); }
      const make = this.decoders[s.format];
      const decoder = make ? make(s) : null;
      const track = {
        seq, format: s.format, autostart: s.autostart, threshold: s.threshold * 1024,
        gain: s.replayGain ? s.replayGain / 65536 : 1, bytes: 0, acked: 0, headBytes: 0, head: new Uint8Array(0),
        headersDone: false, streamEnded: false, decodeDone: false, stmdSent: false, decoder, tunnel: null, icy: null, describe: '',
      };
      this.tracks.push(track);
      this.stmuSent = false; this.stmoSent = false;
      if (!decoder) {
        track.streamEnded = track.decodeDone = track.stmdSent = true;
        this.lastError = 'Unsupported format ' + s.format;
        this._stat('STMn'); return;
      }
      decoder.onError = (msg) => { this.lastError = msg; };
      decoder.onBlock = (rate, chans) => {
        if (track.dead) return; // flushed: late output from an asynchronous decoder
        if (track.gain !== 1) for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= track.gain;
        track.frames = (track.frames || 0) + chans[0].length;
        this.output.push(seq, rate, chans, decoder.outBits || 16);
      };
      decoder.onFinished = () => this.pump();
      // Server address 0 means LMS itself (always the case for proxied streams).
      const t = this.openStream({ ip: s.serverIp ? ipString(s.serverIp) : null, port: s.serverPort, win: STREAM_WINDOW });
      track.tunnel = t;
      t.onopen = () => t.send(s.request);
      t.ondata = (d) => this._streamData(track, d);
      t.onclose = (clean) => {
        if (track.closedByUs) return;
        track.streamEnded = true; decoder.end();
        if (!track.headersDone) this.lastError = 'Stream failed';
        this._send(clientFrame('DSCO', new Uint8Array([clean ? 0 : 2])));
        this.pump();
      };
      this._stat('STMc');
      if (this.state === 'stopped') this.state = 'waiting';
      this.lastError = '';
      this.emit('track');
    }

    _streamData(track, d) {
      if (track.closedByUs) return;
      if (!track.headersDone) {
        track.head = concat(track.head, d);
        const h = parseHttpHead(track.head);
        if (!h) { if (track.head.length > 65536) track.tunnel.close(); return; }
        track.headersDone = true;
        this._send(clientFrame('RESP', h.raw));
        const metaint = +(h.headers['icy-metaint'] || 0);
        if (metaint > 0) track.icy = new IcyStripper(metaint);
        if (h.status >= 400) this.lastError = 'Stream refused: HTTP ' + h.status;
        d = track.head.subarray(h.headLen); track.head = null;
        track.headBytes = h.headLen; // header bytes count as consumed for flow control
        if (!d.length) return;
      }
      track.bytes += d.length;
      if (track.icy) track.icy.feed(d, (a) => track.decoder.feed(a), (m) => this._send(clientFrame('META', m)));
      else track.decoder.feed(d);
      this.pump();
    }

    _ack(track) {
      if (!track.tunnel || track.streamEnded) return;
      const consumed = track.headBytes + track.bytes - track.decoder.buffered;
      if (consumed - track.acked >= 32768 || (track.decoder.buffered === 0 && consumed > track.acked)) {
        track.acked = consumed; track.tunnel.ack(consumed);
      }
    }

    _closeTrack(t) { if (t.tunnel && !t.streamEnded) { t.closedByUs = true; t.tunnel.close(); } t.streamEnded = true; }

    /** Drop a track entirely: no more network, decoding or output. */
    _kill(t) {
      this._closeTrack(t); t.dead = true; t.decodeDone = true;
      if (t.decoder && t.decoder.abort) t.decoder.abort();
    }

    _flush() {
      for (const t of this.tracks) this._kill(t);
      this.tracks = []; this.output.flush(); this.state = 'stopped'; this.audibleSeq = null;
      this.stmuSent = true; this.stmoSent = false;
    }

    /** Decode while the output wants audio. */
    pump() {
      if (this.pumping) return;
      this.pumping = true;
      let again = false;
      try {
        let budget = this.pumpBudget || 12; // decoder calls per pump, so one call never hogs the thread
        while (budget-- > 0 && this.output.queuedSeconds() < (this.decodeAhead || DECODE_AHEAD_S)) {
          const t = this.tracks.find((x) => !x.decodeDone);
          if (!t) break;
          const r = t.decoder.pump(16);
          this._ack(t);
          if (!t.describe && t.decoder.describe) { const d = t.decoder.describe(); if (!/\?/.test(d)) t.describe = d; }
          if (r === 'done') {
            t.decodeDone = true;
            this.output.endSeq(t.seq);
            this._readyForNext();
            continue;
          }
          if (r === 'need') break;
          if (budget === 0) again = true;
        }
        this._autostart();
      } finally { this.pumping = false; }
      if (again && !this.pumpQueued) { this.pumpQueued = true; G.setTimeout(() => { this.pumpQueued = false; this.pump(); }, 0); }
    }

    /**
     * STMd ("decoder done": LMS then sends the next track) goes only once the track has been
     * heard. LMS takes the next STMs to mean the newest stream started, so if a short stream
     * (the tail after a seek) finished decoding before its audio was audible, LMS would move
     * on to the next track too early. A track that produced no audio at all goes at once.
     */
    _readyForNext() {
      for (const t of this.tracks) {
        if (!t.decodeDone || t.stmdSent || t.dead) continue;
        if (this.stmsSent.has(t.seq) || !t.frames) { t.stmdSent = true; this._stat('STMd'); }
      }
    }

    _autostart() {
      if (this.state !== 'waiting') return;
      const t = this.tracks[this.tracks.length - 1];
      if (!t) return;
      const ready = (t.bytes >= t.threshold || t.streamEnded || t.decodeDone) && this.output.queuedSeconds() > 0;
      if (!ready) return;
      if (t.autostart === '1' || t.autostart === '3') { this.state = 'playing'; this.output.play(); this.emit('state'); }
      else { this.state = 'loaded'; this._stat('STMl'); this.emit('state'); }
    }

    /** Runs on a timer and on every output report. */
    tick() {
      const now = this.now();
      if (this.state === 'playing' || this.state === 'paused') {
        const a = this.output.audible(now);
        if (a && a.seq != null && a.seq !== this.audibleSeq) {
          this.audibleSeq = a.seq;
          if (!this.stmsSent.has(a.seq)) { this.stmsSent.add(a.seq); this._stat('STMs'); this._readyForNext(); }
          // Tracks heard to the end are no longer of interest.
          this.tracks = this.tracks.filter((t) => t.seq >= a.seq || !t.decodeDone);
          this.emit('track');
        }
        if (this.state === 'playing' && this.output.underrun) {
          const allDone = this.tracks.every((t) => t.decodeDone);
          if (allDone && !this.stmuSent) {
            this.stmuSent = true; this.state = 'stopped'; this._stat('STMu'); this.audibleSeq = null; this.emit('state');
          } else if (!allDone && !this.stmoSent && this.audibleSeq != null) {
            this.stmoSent = true; this._stat('STMo');
          }
        } else if (!this.output.underrun) {
          this.stmoSent = false;
        }
        if (this.state === 'playing' && now - this.lastStat >= HEARTBEAT_MS) this._stat('STMt');
      }
      this.pump();
    }

    /** What the UI shows about the local player. */
    snapshot() {
      const now = this.now();
      const a = this.output.audible(now);
      const t = this.tracks.find((x) => x.seq === (a && a.seq)) || this.tracks[this.tracks.length - 1];
      return {
        state: this.state, connected: this.connected, elapsedMs: this._elapsed(now), format: t ? t.describe : '',
        queued: this.output.queuedSeconds(), gain: this.gain, enabled: this.enabled, error: this.lastError,
      };
    }
  }

  Object.assign(LJ, {
    ByteQueue, nextServerFrame, clientFrame, serverFrame, buildHelo, buildStat, parseStrm, buildStrm,
    parseAudg, parseHttpHead, ipString, IcyStripper, BitReader, flacFrame, FlacDecoder, PcmDecoder,
    mp3Header, Mp3Framer, Mp3Decoder, Mp3ChunkDecoder, SlimPlayer, STREAM_WINDOW, DECODE_AHEAD_S, crc8, crc16, concat, latin1,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
