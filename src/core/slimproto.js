/* LyrionJS core: Slimproto framing and messages, the HTTP response head and ICY metadata.
 * Server -> client: u16 length (opcode + payload), opcode, payload.
 * Client -> server: opcode, u32 payload length, payload. */
'use strict';
(function (G) {
  const LJ = G.LJ;
  const { be16, be32, put16, put32, concatAll, indexOfSeq, latin1 } = LJ;
  const te = new TextEncoder();

  const MAX_SERVER_FRAME = 32 * 1024;

  /**
   * The next whole frame in the queue: {op, payload}; null if more bytes are needed. A frame
   * longer than any LMS sends is skipped ({op: null}) rather than ending the connection.
   */
  function nextServerFrame(q) {
    if (q.length < 2) return null;
    const len = (q.peek(0) << 8) | q.peek(1);
    if (len < 4) { q.consume(Math.min(2 + len, q.length)); return { op: null }; }
    if (q.length < 2 + len) return null;
    if (len > MAX_SERVER_FRAME) { q.consume(2 + len); return { op: null }; }
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

  /** A server -> client frame (for tests and fakes). */
  function serverFrame(op, payload) {
    const f = new Uint8Array(6 + payload.length);
    put16(f, 0, 4 + payload.length);
    for (let i = 0; i < 4; i++) f[2 + i] = op.charCodeAt(i);
    f.set(payload, 6);
    return f;
  }

  const put64 = (p, i, v) => { const n = Math.max(0, Math.floor(v || 0)); put32(p, i, Math.floor(n / 4294967296)); put32(p, i + 4, n >>> 0); };

  function buildHelo({ mac, uuid, reconnect, bytesReceived, caps }) {
    const c = te.encode(caps);
    const p = new Uint8Array(36 + c.length);
    p[0] = 12;            // device id: squeezelite-class software player
    p[1] = 0;             // revision
    p.set(mac, 2);
    p.set(uuid || new Uint8Array(16), 8);
    put16(p, 24, reconnect ? 0x4000 : 0);
    put64(p, 26, bytesReceived);
    p[34] = 0x65; p[35] = 0x6e; // 'en'
    p.set(c, 36);
    return clientFrame('HELO', p);
  }

  function buildStat(s) {
    const p = new Uint8Array(53);
    for (let i = 0; i < 4; i++) p[i] = s.event.charCodeAt(i);
    p[4] = s.crlf || 0;
    put32(p, 7, s.bufSize >>> 0);
    put32(p, 11, s.bufFull >>> 0);
    put64(p, 15, s.bytesReceived);
    put16(p, 23, 0xffff); // signal strength: wired
    put32(p, 25, s.jiffies >>> 0);
    put32(p, 29, s.outSize >>> 0);
    put32(p, 33, s.outFull >>> 0);
    put32(p, 37, Math.floor((s.elapsedMs || 0) / 1000) >>> 0);
    put32(p, 43, Math.floor(s.elapsedMs || 0) >>> 0);
    put32(p, 47, s.serverTs >>> 0);
    put16(p, 51, s.error || 0);
    return clientFrame('STAT', p);
  }

  function parseStrm(p) {
    if (p.length < 24) throw new Error('strm truncated');
    const ch = (i) => String.fromCharCode(p[i]);
    return {
      command: ch(0), autostart: ch(1), format: ch(2), pcmSize: ch(3), pcmRate: ch(4),
      pcmChannels: ch(5), pcmEndian: ch(6), threshold: p[7], spdif: p[8], transPeriod: p[9],
      transType: ch(10), flags: p[11], outThreshold: p[12], replayGain: be32(p, 14),
      serverPort: be16(p, 18), serverIp: be32(p, 20), request: p.slice(24),
    };
  }

  /** A strm frame (for tests and fakes). */
  function buildStrm(o) {
    const req = o.request || new Uint8Array(0);
    const p = new Uint8Array(24 + req.length);
    const ch = (s, d) => (s || d).charCodeAt(0);
    p[0] = ch(o.command, 's'); p[1] = ch(o.autostart, '1'); p[2] = ch(o.format, 'f');
    p[3] = ch(o.pcmSize, '?'); p[4] = ch(o.pcmRate, '?'); p[5] = ch(o.pcmChannels, '?'); p[6] = ch(o.pcmEndian, '?');
    p[7] = o.threshold || 0; p[9] = o.transPeriod || 0; p[10] = ch(o.transType, '0'); p[11] = o.flags || 0;
    put32(p, 14, o.replayGain || 0); put16(p, 18, o.serverPort || 9000); put32(p, 20, o.serverIp || 0);
    p.set(req, 24);
    return serverFrame('strm', p);
  }

  function parseAudg(p) {
    if (p.length < 18) throw new Error('audg truncated');
    const adjust = p[8];
    return { adjust, left: adjust ? be32(p, 10) / 65536 : 1, right: adjust ? be32(p, 14) / 65536 : 1 };
  }

  const ipString = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

  /** The HTTP response head at the start of u8, once it is complete; null before that. */
  function parseHttpHead(u8) {
    const end = indexOfSeq(u8, [13, 10, 13, 10]);
    if (end < 0) return null;
    const lines = latin1(u8.subarray(0, end)).split('\r\n');
    const m = lines[0].match(/^(?:HTTP\/\d\.\d|ICY)\s+(\d+)/i) || [];
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { status: +(m[1] || 0), headers, headLen: end + 4, raw: u8.slice(0, end + 4) };
  }

  /** Strips ICY metadata from a stream (only present when the server was asked for it). */
  class IcyStripper {
    constructor(metaint) { this.metaint = metaint; this.left = metaint; this.metaLeft = -1; this.meta = []; }
    feed(chunk, onAudio, onMeta) {
      let i = 0;
      while (i < chunk.length) {
        if (this.metaLeft === -1) {              // audio
          const n = Math.min(this.left, chunk.length - i);
          if (n) onAudio(chunk.subarray(i, i + n));
          i += n; this.left -= n;
          if (this.left === 0) this.metaLeft = -2;
        } else if (this.metaLeft === -2) {       // the length byte
          this.metaLeft = chunk[i++] * 16; this.meta = [];
          if (this.metaLeft === 0) { this.metaLeft = -1; this.left = this.metaint; }
        } else {                                 // metadata
          const n = Math.min(this.metaLeft, chunk.length - i);
          this.meta.push(chunk.slice(i, i + n)); i += n; this.metaLeft -= n;
          if (this.metaLeft === 0) { onMeta(concatAll(this.meta)); this.metaLeft = -1; this.left = this.metaint; }
        }
      }
    }
  }

  Object.assign(LJ, {
    MAX_SERVER_FRAME, nextServerFrame, clientFrame, serverFrame, buildHelo, buildStat, parseStrm, buildStrm,
    parseAudg, ipString, parseHttpHead, IcyStripper,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
