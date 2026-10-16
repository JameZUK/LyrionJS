/* LyrionJS output stage. Plays queued PCM chunks in order and reports what it has rendered,
 * so the main thread can tell LMS exactly what is being heard. The same class runs inside an
 * AudioWorklet (HTTPS / localhost pages) or on the main thread under a ScriptProcessorNode
 * (plain http pages, where browsers don't offer AudioWorklet).
 * Messages in:  push {id, seq, l, r}, flush {epoch}, trim {keep}, play, pause,
 *               startAt {frame}, pauseFor {frames}, skip {frames}, gain {g, now}
 * Messages out (all carry the epoch of the last flush):
 *   seg {seq, frame}   the first sample of a track was rendered at this context frame
 *   pos {frame, seq, pos, queued, playing, under, lastId, event}  state after a quantum */
class LyrionOutputCore {
  /** port: {postMessage, onmessage}; clock(): the context frame of the next sample rendered. */
  constructor(port, clock) {
    this.port = port; this.clock = clock;
    this.q = []; this.qi = 0; this.queued = 0; this.lastId = 0; this.epoch = 0;
    this.playing = false; this.startAt = -1; this.silence = 0;
    this.g = 1; this.gt = 1; this.seq = null; this.pos = 0; this.under = false; this.n = 0;
    port.onmessage = (e) => this.msg(e.data);
  }
  msg(m) {
    switch (m.t) {
      case 'push': this.q.push(m); this.queued += m.l.length; this.lastId = m.id; break;
      case 'flush':
        this.q = []; this.qi = 0; this.queued = 0; this.seq = null; this.pos = 0;
        this.startAt = -1; this.silence = 0; this.playing = false; this.under = false; this.epoch = m.epoch;
        this.report(this.clock(), true); break;
      case 'trim': {
        const head = this.q[0];
        this.q = this.q.filter((c) => c.seq <= m.keep);
        if (this.q[0] !== head) this.qi = 0;
        this.queued = this.q.reduce((a, c, i) => a + c.l.length - (i === 0 ? this.qi : 0), 0);
        this.report(this.clock(), true); break;
      }
      case 'play': this.playing = true; this.startAt = -1; this.report(this.clock(), true); break;
      case 'pause': this.playing = false; this.report(this.clock(), true); break;
      case 'startAt': this.playing = true; this.startAt = m.frame; break;
      case 'pauseFor': this.silence += Math.max(0, m.frames | 0); break;
      case 'skip': {
        let n = m.frames | 0;
        while (n > 0 && this.q.length) {
          const c = this.q[0], k = Math.min(n, c.l.length - this.qi);
          if (c.seq !== this.seq) { this.seq = c.seq; this.pos = 0; this.port.postMessage({ t: 'seg', seq: c.seq, frame: this.clock(), epoch: this.epoch }); }
          this.qi += k; this.pos += k; this.queued -= k; n -= k;
          if (this.qi >= c.l.length) { this.q.shift(); this.qi = 0; }
        }
        this.report(this.clock(), true); break;
      }
      case 'gain': this.gt = m.g; if (m.now) this.g = m.g; break;
    }
  }
  report(frame, event) {
    this.port.postMessage({
      t: 'pos', frame, seq: this.seq, pos: this.pos, queued: this.queued, lastId: this.lastId,
      playing: this.playing && this.startAt < 0, under: this.under, epoch: this.epoch, event: !!event,
    });
  }
  process(_inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || null, n = L.length, base = this.clock();
    let event = false;
    for (let i = 0; i < n; i++) {
      let l = 0, r = 0;
      if (this.playing && (this.startAt < 0 || base + i >= this.startAt)) {
        if (this.startAt >= 0) { this.startAt = -1; event = true; }
        if (this.silence > 0) {
          this.silence--;
        } else {
          while (this.q.length && this.qi >= this.q[0].l.length) { this.q.shift(); this.qi = 0; }
          if (this.q.length) {
            const c = this.q[0];
            if (c.seq !== this.seq) {
              this.seq = c.seq; this.pos = 0; event = true;
              this.port.postMessage({ t: 'seg', seq: c.seq, frame: base + i, epoch: this.epoch });
            }
            l = c.l[this.qi]; r = c.r ? c.r[this.qi] : l;
            this.qi++; this.pos++; this.queued--;
            if (this.under) { this.under = false; event = true; }
          } else if (!this.under) { this.under = true; event = true; }
        }
      }
      // ~10 ms exponential ramp (at 48 kHz) so volume changes never click.
      this.g += (this.gt - this.g) * 0.002;
      L[i] = l * this.g; if (R) R[i] = r * this.g;
    }
    // Report every ~1000 frames: 8 worklet quanta, or every main-thread buffer.
    this.n += n;
    if (event || this.n >= 1024) { this.n = 0; this.report(base + n, event); }
    return true;
  }
}

if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function') {
  registerProcessor('lyrionjs-output', class extends AudioWorkletProcessor {
    constructor() { super(); this.core = new LyrionOutputCore(this.port, () => currentFrame); }
    process(inputs, outputs) { return this.core.process(inputs, outputs); }
  });
} else {
  (globalThis.LJ || (globalThis.LJ = {})).LyrionOutputCore = LyrionOutputCore;
}
