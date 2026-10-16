/* LyrionJS core: byte helpers shared by the protocol and the decoders. No DOM, no I/O. */
'use strict';
(function (G) {
  const LJ = G.LJ || (G.LJ = {});

  /** A growable byte queue with a read cursor. */
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
    consume(n) { this.start += n; if (this.start >= this.end) this.start = this.end = 0; }
    peek(i) { return this.buf[this.start + i]; }
    view() { return this.buf.subarray(this.start, this.end); }
    take(n) { const v = this.buf.slice(this.start, this.start + n); this.consume(n); return v; }
    clear() { this.start = this.end = 0; }
  }

  const be16 = (b, i) => (b[i] << 8) | b[i + 1];
  const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  function put32(b, i, v) { b[i] = v >>> 24; b[i + 1] = v >>> 16; b[i + 2] = v >>> 8; b[i + 3] = v; }
  function put16(b, i, v) { b[i] = v >>> 8; b[i + 1] = v; }
  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
  function concatAll(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const o = new Uint8Array(n); let i = 0;
    for (const p of parts) { o.set(p, i); i += p.length; }
    return o;
  }
  function indexOfSeq(u8, seq, from = 0) {
    outer: for (let i = from; i + seq.length <= u8.length; i++) {
      for (let j = 0; j < seq.length; j++) if (u8[i + j] !== seq[j]) continue outer;
      return i;
    }
    return -1;
  }
  const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };
  /** Size of an ID3v2 tag starting at v[0], or 0 if there isn't one (needs 10 bytes). */
  const id3Size = (v) => (v.length >= 10 && v[0] === 0x49 && v[1] === 0x44 && v[2] === 0x33)
    ? 10 + (((v[6] & 127) << 21) | ((v[7] & 127) << 14) | ((v[8] & 127) << 7) | (v[9] & 127)) + ((v[5] & 0x10) ? 10 : 0)
    : 0;

  /**
   * Drops `n` bytes from a queue as they arrive, so a big tag or chunk (embedded artwork) never
   * has to be held whole. Flow control counts dropped bytes as consumed.
   */
  class Skipper {
    constructor() { this.left = 0; }
    start(n) { this.left = n; }
    get active() { return this.left > 0; }
    run(q) { const n = Math.min(this.left, q.length); q.consume(n); this.left -= n; return n; }
  }

  Object.assign(LJ, { ByteQueue, Skipper, be16, be32, le32, put16, put32, concat, concatAll, indexOfSeq, latin1, id3Size });
})(typeof globalThis !== 'undefined' ? globalThis : this);
