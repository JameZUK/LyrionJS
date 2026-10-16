// Fakes for driving the Slimproto player in Node tests: an output that "plays" by counting
// frames, streams and a control connection that record what the player sends.
module.exports = function fakes(LJ) {
class FakeOutput {
  constructor() { this.segs = []; this.playing = false; this.rate = 0; this.gain = 1; this.muted = false; this.log = []; this.pos = 0; this.onReport = null; }
  push(seq, rate, chans) { this.rate = rate; let s = this.segs.find((x) => x.seq === seq); if (!s) { s = { seq, frames: 0, played: 0, ended: false }; this.segs.push(s); } s.frames += chans[0].length; }
  endSeq(seq) { const s = this.segs.find((x) => x.seq === seq); if (s) s.ended = true; }
  play() { this.playing = true; this.log.push('play'); }
  pause() { this.playing = false; this.log.push('pause'); }
  startAt(ms) { this.playing = true; this.log.push('startAt:' + ms); }
  pauseFor(ms) { this.log.push('pauseFor:' + ms); }
  skip(ms) { this.log.push('skip:' + ms); }
  flush() { this.segs = []; this.playing = false; this.log.push('flush'); }
  trimAfter(seq) { this.segs = this.segs.filter((s) => s.seq <= seq); this.log.push('trim:' + seq); }
  setGain(g) { this.gain = g; }
  setMute(m) { this.muted = m; }
  queuedSeconds() { return this.rate ? this.segs.reduce((a, s) => a + s.frames - s.played, 0) / this.rate : 0; }
  get underrun() { return this.playing && this.segs.every((s) => s.played >= s.frames); }
  /** Play n frames of audio. */
  advance(n) {
    if (!this.playing) return;
    for (const s of this.segs) { const k = Math.min(n, s.frames - s.played); s.played += k; n -= k; if (!n) break; }
  }
  audible() {
    const s = this.segs.find((x) => x.played < x.frames || !x.ended) || this.segs[this.segs.length - 1];
    if (!s || (s.played === 0 && !this.playing)) return s ? { seq: s.seq, ms: 0 } : null;
    return { seq: s.seq, ms: s.played * 1000 / (this.rate || 44100) };
  }
}

class FakeTunnel {
  constructor(ip, port, win) { Object.assign(this, { ip, port, win }); this.sent = []; this.acks = []; this.closed = false; }
  send(u8) { this.sent.push(u8); } ack(n) { this.acks.push(n); } close() { this.closed = true; }
}

function makePlayer(opts = {}) {
  const tunnels = [];
  let clock = 1000;
  const out = new FakeOutput();
  const p = new LJ.SlimPlayer({
    mac: new Uint8Array([2, 0x4c, 0x4a, 0, 0, 9]), name: 'Test',
    openControl: () => { const t = new FakeTunnel('control', 0, 0); tunnels.push(t); return t; },
    openStream: ({ ip, port, win }) => { const t = new FakeTunnel(ip, port, win); tunnels.push(t); return t; },
    output: out, now: () => clock, caps: ['flc', 'pcm'], maxRate: 96000, noTimer: true,
    decoders: opts.decoders || { f: () => new LJ.FlacDecoder(), p: (s) => new LJ.PcmDecoder(s) },
  });
  const ctl = () => tunnels[0];
  const fromServer = (frame) => ctl().ondata(frame);
  const events = () => ctl().sent.filter((f) => LJ.latin1(f.subarray(0, 4)) === 'STAT').map((f) => LJ.latin1(f.subarray(8, 12)));
  const ops = () => ctl().sent.map((f) => LJ.latin1(f.subarray(0, 4)));
  return { p, out, tunnels, ctl, fromServer, events, ops, tick: (ms) => { clock += ms; p.tick(); }, setClock: (c) => { clock = c; } };
}

const REQ = new TextEncoder().encode('GET /stream.mp3?player=02:4c:4a:00:00:09 HTTP/1.0\r\n\r\n');
const HTTP_OK = new TextEncoder().encode('HTTP/1.0 200 OK\r\nContent-Type: audio/flac\r\n\r\n');

  return { FakeOutput, FakeTunnel, makePlayer, REQ, HTTP_OK };
};
