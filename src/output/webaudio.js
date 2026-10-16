/* LyrionJS output: Web Audio, for desktops. One AudioContext per sample rate where the browser
 * allows it, with the output stage (output/worklet.js) running as an AudioWorklet on secure
 * pages or on the main thread (ScriptProcessorNode) on plain http.
 *
 * The output interface, shared with output/media.js:
 *   push(seq, rate, chans, bits)  decoded audio of track `seq`
 *   endSeq(seq)                   no more audio for that track
 *   play() / pause()              start or stop rendering
 *   startAt(ms)                   start at that time on the performance.now() clock (sync)
 *   pauseFor(ms) / skip(ms)       sync corrections: insert silence / drop audio
 *   flush()                       drop everything; trimAfter(seq): drop what came after seq
 *   setGain(g), setMute(b), setLevel(l)   LMS volume, power, and the page's own level
 *   queuedSeconds(), underrun     how much is waiting; true when playing with nothing to play
 *   audible(ms) -> {seq, ms}      what is heard at that time, and how far into its track
 *   needsGesture, unlock()        browsers start audio only inside a user gesture
 *   info(), engine, dispose()
 *   onReport, onState             callbacks: position moved / output state changed */
'use strict';
(function (G) {
  const LJ = G.LJ;

  /** Streaming 4-point (Catmull-Rom) resampler; the last input samples of each chunk are
   *  carried in `st`, so chunk boundaries are seamless. Used only where the browser won't open
   *  an output at the track's own rate (iPad after the first track). */
  function resampleCubic(chans, from, to, st) {
    const TAIL = 4, ratio = from / to, n = chans[0].length;
    if (!st.tail || st.tail.length !== chans.length) { st.tail = chans.map(() => new Float32Array(TAIL)); st.pos = TAIL; }
    const maxX = n + TAIL - 3;
    const count = st.pos <= maxX ? Math.floor((maxX - st.pos) / ratio) + 1 : 0;
    const out = [];
    for (let c = 0; c < chans.length; c++) {
      const ext = new Float32Array(n + TAIL); ext.set(st.tail[c]); ext.set(chans[c], TAIL);
      const dst = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const x = st.pos + i * ratio, i0 = Math.floor(x), t = x - i0;
        const y0 = ext[i0 - 1], y1 = ext[i0], y2 = ext[i0 + 1], y3 = ext[i0 + 2];
        dst[i] = y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
      }
      st.tail[c] = ext.slice(n);
      out.push(dst);
    }
    st.pos += count * ratio - n;
    return out;
  }

  /**
   * The output stage on the main thread, driven by a ScriptProcessorNode: for plain http pages,
   * where browsers don't offer AudioWorklet. It is the same LyrionOutputCore the worklet runs,
   * with the same messages. The clock is the context frame of the next sample to render.
   */
  function mainThreadOutput(ctx, size = 8192) {
    let frame = 0;
    const mainPort = { onmessage: null, postMessage: (m) => { if (procPort.onmessage) procPort.onmessage({ data: m }); } };
    const procPort = { onmessage: null, postMessage: (m) => queueMicrotask(() => mainPort.onmessage && mainPort.onmessage({ data: m })) };
    const core = new LJ.LyrionOutputCore(procPort, () => frame);
    const sp = ctx.createScriptProcessor(size, 1, 2);
    sp.onaudioprocess = (e) => {
      const start = Math.round(e.playbackTime * ctx.sampleRate);
      frame = start;
      const ob = e.outputBuffer;
      core.process([], [[ob.getChannelData(0), ob.getChannelData(1)]]);
      frame = start + ob.length;   // between callbacks: the next sample to be rendered
    };
    sp.connect(ctx.destination);
    return { port: mainPort, sp, core, disconnect: () => { sp.onaudioprocess = null; sp.disconnect(); } };
  }

  function waitRunning(ctx, ms) {
    if (ctx.state === 'running') return Promise.resolve(true);
    return new Promise((res) => {
      const t = setTimeout(() => { ctx.onstatechange = null; res(ctx.state === 'running'); }, ms);
      ctx.onstatechange = () => { if (ctx.state === 'running') { clearTimeout(t); ctx.onstatechange = null; res(true); } };
    });
  }

  async function detectMaxRate() {
    for (const r of [192000, 96000]) {
      try { const c = new AudioContext({ sampleRate: r }); const ok = c.sampleRate === r; c.close().catch(() => {}); if (ok) return r; }
      catch (e) { /* not supported */ }
    }
    return 48000;
  }

  class WebOutput {
    /**
     * opts: { workletSource: string, diag(kind, msg), level: 0..1, preferRate: Hz, onRate(rate),
     *         singleContext: bool (start a second context only with a tap, as on iOS) }
     */
    constructor(opts = {}) {
      this.workletSource = opts.workletSource; this.diag = opts.diag || (() => {});
      this.preferRate = opts.preferRate || 44100; this.onRate = opts.onRate || null;
      this.ctx = null; this.node = null; this.rate = 0; this.srcRate = 0; this.creating = null;
      this.pending = []; this.posts = []; this.postId = 0; this.epoch = 0; this.cmds = [];
      this.rep = null; this.segStarts = []; this.gain = 1; this.muted = false; this.level = opts.level == null ? 1 : opts.level;
      this.playing = false; this.onReport = null; this.onState = null; this.url = null; this.lastTick = 0;
      this.rs = {}; this.singleContext = !!opts.singleContext; this.startFailures = 0; this.engine = '';
      this.drainedSince = 0; this.failedAt = 0;
    }
    get needsGesture() { return !!this.ctx && this.ctx.state !== 'running'; }
    unlock() { this.prime(); }

    queuedFrames() { return Math.max(0, (this.rep ? this.rep.queued : 0) + this.posts.reduce((a, p) => a + p.frames, 0)); }
    queuedSeconds() {
      let s = this.rate ? this.queuedFrames() / this.rate : 0;
      for (const p of this.pending) s += p.chans[0].length / p.rate;
      return s;
    }
    get underrun() {
      return this.playing && !this.creating && this.pending.length === 0 && this.posts.length === 0 && (!this.rep || this.rep.queued <= 0);
    }

    push(seq, rate, chans) {
      if (chans.length > 2) chans = chans.slice(0, 2);
      if (this.creating || this.pending.length || !this.ctx || rate !== this.srcRate) {
        this.pending.push({ seq, rate, chans }); this._drainPending(); return;
      }
      this._post(seq, chans);
    }
    _post(seq, chans) {
      if (this.rate !== this.srcRate) chans = resampleCubic(chans, this.srcRate, this.rate, this.rs);
      const own = (a) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice());
      const l = own(chans[0]), r = chans[1] ? own(chans[1]) : null;
      if (!l.length) return;
      const id = ++this.postId;
      this.posts.push({ id, frames: l.length, seq });
      const transfer = [l.buffer]; if (r) transfer.push(r.buffer);
      this.node.port.postMessage({ t: 'push', id, seq, l, r }, transfer);
    }
    _drainPending() {
      if (this.creating) return;
      if (this.failedAt && performance.now() - this.failedAt < 2900) return;
      while (this.pending.length) {
        const p = this.pending[0];
        if (this.ctx && p.rate === this.srcRate) { this.pending.shift(); this._post(p.seq, p.chans); continue; }
        if (this.ctx && this.singleContext) {
          // This browser won't start a new context without a tap: keep this one, resample.
          this.srcRate = p.rate; this.rs = {}; this.diag('output', `resampling ${p.rate} -> ${this.rate}`); continue;
        }
        // A new sample rate: let the current context play out, including what is still inside
        // its output latency, then open one at the new rate.
        if (this.ctx) {
          if (this.queuedFrames() > 0) { this.drainedSince = 0; return; }
          const tail = ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000 + 30;
          if (!this.drainedSince) this.drainedSince = performance.now();
          const left = tail - (performance.now() - this.drainedSince);
          if (left > 0) { clearTimeout(this.tailTimer); this.tailTimer = setTimeout(() => this._drainPending(), left); return; }
        }
        this.drainedSince = 0;
        this._create(p.rate); return;
      }
    }

    /** Called from a user gesture: open (or resume) the output now, while the browser allows it. */
    prime() {
      if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume().then(() => this.onState && this.onState(), () => {}); return; }
      if (!this.creating) this._create(this.preferRate, true);
    }

    async _create(rate, priming) {
      let done, ctx = null;
      this.creating = new Promise((r) => { done = r; });
      try {
        try { ctx = new AudioContext({ sampleRate: rate, latencyHint: 'playback' }); }
        catch (e) { ctx = new AudioContext({ latencyHint: 'playback' }); }
        ctx.resume().catch(() => {});   // inside a tap, this is what lets Safari start it
        const old = this.ctx;
        if (old && old.state === 'running' && !(await waitRunning(ctx, 800))) {
          // A second context needs another tap here: keep the running one and resample into it.
          ctx.close().catch(() => {}); ctx = null;
          this.startFailures++;
          if (this.startFailures >= 2) this.singleContext = true;
          this.srcRate = rate; this.rs = {};
          this.diag('output', `a ${rate} Hz context would not start; resampling into ${this.rate} Hz`);
          return;
        }
        let node;
        if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
          if (!this.url) this.url = URL.createObjectURL(new Blob([this.workletSource], { type: 'application/javascript' }));
          await ctx.audioWorklet.addModule(this.url);
          node = new AudioWorkletNode(ctx, 'lyrionjs-output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          node.connect(ctx.destination);
          this.engine = 'AudioWorklet';
        } else {
          // AudioWorklet exists only on HTTPS (or localhost) pages: on plain http on the LAN the
          // same output code runs on the main thread.
          node = mainThreadOutput(ctx);
          this.engine = 'ScriptProcessor';
        }
        if (old) {
          // The old context's reports no longer mean anything.
          if (this.node) this.node.port.onmessage = null;
          if (this.node && this.node.disconnect) try { this.node.disconnect(); } catch (e) { /* gone */ }
          old.close().catch(() => {});
        }
        this.rep = null; this.segStarts = []; this.posts = []; this.rs = {};
        node.port.onmessage = (e) => { if (node === this.node) this._msg(e.data); };
        this.ctx = ctx; this.node = node; this.rate = ctx.sampleRate; this.srcRate = rate;
        node.port.postMessage({ t: 'flush', epoch: this.epoch });
        if (this.onRate) this.onRate(rate);
        this._applyGain(true);
        if (this.playing) node.port.postMessage({ t: 'play' });
        for (const c of this.cmds.splice(0)) this._command(c);   // corrections that arrived while creating
        ctx.onstatechange = () => { this.diag('output', 'context ' + ctx.state); if (this.onState) this.onState(); };
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        this.failedAt = 0;
        this.diag('output', `context open (${this.engine}): asked ${rate} Hz, got ${ctx.sampleRate} Hz, ${ctx.state}${priming ? ' (primed by a tap)' : ''}`);
      } catch (e) {
        if (ctx && ctx !== this.ctx) ctx.close().catch(() => {});
        this.failedAt = performance.now();   // never retry straight away
        this.diag('error', 'audio output: ' + (e && e.message || e));
      } finally {
        this.creating = null; done();
        if (this.failedAt) setTimeout(() => this._drainPending(), 3000);
        else this._drainPending();
        if (this.onState) this.onState();
      }
    }

    _msg(m) {
      if (m.epoch !== this.epoch) return;
      if (m.t === 'seg') { this.segStarts.push({ seq: m.seq, frame: m.frame }); if (this.segStarts.length > 24) this.segStarts.shift(); return; }
      if (m.t !== 'pos') return;
      this.rep = m;
      if (this.posts.length) this.posts = this.posts.filter((p) => p.id > m.lastId);
      if (this.pending.length && !this.creating) this._drainPending();
      const now = performance.now();
      if (this.onReport && (m.event || now - this.lastTick > 50)) { this.lastTick = now; this.onReport(); }
    }

    _ctxTimeAt(ms) {
      const c = this.ctx;
      const ts = c.getOutputTimestamp ? c.getOutputTimestamp() : null;
      if (ts && ts.performanceTime > 0 && c.state === 'running') return ts.contextTime + (ms - ts.performanceTime) / 1000;
      return c.currentTime - (c.outputLatency || 0) - (c.baseLatency || 0) + (ms - performance.now()) / 1000;
    }

    /** Commands that need the node; kept until it exists (a sync start can arrive while it opens). */
    _command(c) {
      if (!this.node) { this.cmds.push(c); return; }
      if (c.t === 'startAt') this.node.port.postMessage({ t: 'startAt', frame: Math.round(this._ctxTimeAt(c.ms) * this.rate) });
      else if (c.t === 'pauseFor') this.node.port.postMessage({ t: 'pauseFor', frames: Math.round(c.ms * this.rate / 1000) });
      else if (c.t === 'skip') this.node.port.postMessage({ t: 'skip', frames: Math.round(c.ms * this.rate / 1000) });
    }
    play() { this.playing = true; this.cmds = this.cmds.filter((c) => c.t !== 'startAt'); if (this.node) this.node.port.postMessage({ t: 'play' }); }
    pause() { this.playing = false; this.cmds = []; if (this.node) this.node.port.postMessage({ t: 'pause' }); }
    startAt(ms) { this.playing = true; this._command({ t: 'startAt', ms }); }
    pauseFor(ms) { this._command({ t: 'pauseFor', ms }); }
    skip(ms) { this._command({ t: 'skip', ms }); }
    flush() {
      this.epoch++; this.pending = []; this.posts = []; this.cmds = []; this.rep = null; this.segStarts = []; this.playing = false;
      if (this.node) this.node.port.postMessage({ t: 'flush', epoch: this.epoch });
    }
    trimAfter(seq) {
      this.pending = this.pending.filter((p) => p.seq <= seq);
      this.posts = this.posts.filter((p) => p.seq <= seq);
      if (this.node) this.node.port.postMessage({ t: 'trim', keep: seq });
    }
    endSeq() {}
    setGain(g) { this.gain = g; this._applyGain(); }
    setMute(m) { this.muted = m; this._applyGain(); }
    setLevel(l) { this.level = l; this._applyGain(); }
    _applyGain(now) { if (this.node) this.node.port.postMessage({ t: 'gain', g: this.muted ? 0 : this.gain * this.level, now: !!now }); }

    audible(nowMs) {
      if (!this.ctx || !this.rep) return null;
      const t = Math.min(this._ctxTimeAt(nowMs), this.ctx.currentTime);
      const fa = t * this.rate;
      let s = null;
      for (const x of this.segStarts) if (x.frame <= fa) s = x;
      if (!s) return null;
      const rep = this.rep;
      const frames = s.seq === rep.seq ? (rep.playing ? rep.pos - Math.max(0, rep.frame - fa) : rep.pos) : fa - s.frame;
      return { seq: s.seq, ms: Math.max(0, frames) * 1000 / this.rate };
    }
    info() {
      const c = this.ctx;
      return c ? { rate: c.sampleRate, state: c.state, latency: Math.round(((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000) } : null;
    }
    dispose() {
      clearTimeout(this.tailTimer);
      if (this.node) this.node.port.onmessage = null;
      if (this.ctx) this.ctx.close().catch(() => {});
      if (this.url) URL.revokeObjectURL(this.url);
      this.ctx = this.node = null;
    }
  }

  Object.assign(LJ, { WebOutput, resampleCubic, mainThreadOutput, waitRunning, detectMaxRate });
})(typeof globalThis !== 'undefined' ? globalThis : this);
