/* LyrionJS output: an <audio> element fed by (Managed) Media Source, for phones and tablets.
 *
 * Web Audio stops when an iPhone or iPad locks its screen; a media element doesn't. Decoded
 * audio is re-wrapped losslessly as FLAC in fragmented MP4 (output/fmp4.js) and appended to a
 * SourceBuffer. The output offers the same interface as the Web Audio output (see
 * output/webaudio.js), so the Slimproto player can't tell which one it drives. */
'use strict';
(function (G) {
  const LJ = G.LJ;
  const MIME = 'audio/mp4; codecs="flac"';
  // 50 ms of silence (8 kHz, 8-bit). It must hold samples: Firefox refuses a WAV with none, and the
  // tap that should unlock sound then does nothing.
  const SILENT_WAV = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
  const KEEP_BEHIND_S = 10;      // played audio kept buffered (for small skips back)
  const EVICT_EVERY_MS = 5000;
  const UNLOCK_TIMEOUT_MS = 2500;
  const FAIL_LIMIT = 3, FAIL_WINDOW_MS = 10000;   // media source failures before giving up

  const mediaSourceClass = () => G.ManagedMediaSource || G.MediaSource || null;

  /** Can this browser play our FLAC-in-MP4 through a media element? */
  function mediaSupported() {
    const MS = mediaSourceClass();
    try { return !!(MS && MS.isTypeSupported && MS.isTypeSupported(MIME)); } catch (e) { return false; }
  }

  /** Does the page control an <audio> element's volume? (iOS ignores it: the device sets it.) */
  function volumeWorks() {
    try { const a = new Audio(); a.volume = 0.5; return Math.abs(a.volume - 0.5) < 0.01; } catch (e) { return false; }
  }

  /** Appends a second of silence through the real pipeline; resolves true if the browser takes it. */
  function selfTest() {
    return new Promise((resolve) => {
      const MS = mediaSourceClass();
      if (!MS || !mediaSupported()) return resolve(false);
      const el = document.createElement('audio');
      el.muted = true; el.disableRemotePlayback = true;
      const ms = new MS();
      const url = URL.createObjectURL(ms);
      let settled = false;
      const done = (ok) => {
        if (settled) return; settled = true;
        clearTimeout(t); el.removeAttribute('src'); try { el.load(); } catch (e) { /* */ } URL.revokeObjectURL(url); resolve(ok);
      };
      const t = setTimeout(() => done(false), 3000);
      ms.addEventListener('sourceopen', () => {
        try {
          const sb = ms.addSourceBuffer(MIME);
          const w = new LJ.Fmp4Writer();
          const segs = [...w.push(44100, [new Float32Array(44100), new Float32Array(44100)], 16), ...w.flush()];
          let i = 0;
          const next = () => {
            if (i >= segs.length) return done(sb.buffered.length > 0 && sb.buffered.end(0) > 0.5);
            const s = segs[i++]; sb.appendBuffer(s.init || s.data);
          };
          sb.addEventListener('updateend', next);
          sb.addEventListener('error', () => done(false));
          next();
        } catch (e) { done(false); }
      }, { once: true });
      el.src = url;
    });
  }

  /**
   * Every SourceBuffer operation, one at a time. A SourceBuffer accepts nothing while it is
   * updating, and an operation issued then is lost (or throws); queueing them all keeps appends,
   * removes and format changes in order whatever the browser's timing.
   */
  class SourceBufferQueue {
    constructor({ diag, onQuota }) { this.sb = null; this.ops = []; this.inits = 0; this.diag = diag; this.onQuota = onQuota; this.full = false; }
    attach(sb) { this.sb = sb; this.inits = 0; sb.addEventListener('updateend', () => this.run()); this.run(); }
    detach() { this.sb = null; }
    push(op) { this.ops.push(op); this.run(); }
    /** Ahead of everything queued: eviction when the buffer is full. */
    pushFront(op) { this.ops.unshift(op); this.run(); }
    /** Drop queued audio (not removes): after a flush or a trim. */
    dropAppends(pred = () => true) { this.ops = this.ops.filter((o) => o.kind === 'remove' || !pred(o)); }
    get pendingAppends() { return this.ops.some((o) => o.kind === 'append'); }
    run() {
      const sb = this.sb;
      if (!sb || sb.updating || !this.ops.length) return;
      // Full: audio waits until a remove has made room (eviction runs on a timer as playback
      // moves on), so removes go ahead of the waiting audio.
      let op;
      if (this.full) {
        const i = this.ops.findIndex((o) => o.kind === 'remove');
        if (i < 0) return;
        op = this.ops.splice(i, 1)[0];
      } else op = this.ops.shift();
      if (op.kind === 'remove') this.full = false;
      try {
        if (op.kind === 'init') { if (this.inits++ && sb.changeType) sb.changeType(MIME); sb.appendBuffer(op.data); }
        else if (op.kind === 'append') sb.appendBuffer(op.data);
        else if (op.kind === 'remove') {
          const b = sb.buffered;
          if (b.length && op.to > op.from) sb.remove(op.from, op.to);
          else this.run();   // nothing to remove: carry on
        }
      } catch (e) {
        if (e.name === 'QuotaExceededError' && op.kind === 'append') {
          this.ops.unshift(op);          // keep it; retried once there is room
          this.full = true;
          if (this.onQuota) this.onQuota();
        } else {
          this.diag('media', `${op.kind} failed: ${e.message}`);
          if (op.kind !== 'append') this.run();
        }
      }
    }
  }

  class MediaOutput {
    /** el: the <audio> element (in the document, so the OS media controls attach to it). */
    constructor(el, { diag = () => {} } = {}) {
      this.el = el; this.diag = diag;
      this.engine = 'Media element (' + (G.ManagedMediaSource ? 'Managed Media Source' : 'Media Source') + ')';
      el.disableRemotePlayback = true;   // Managed Media Source requires this (or an AirPlay source)
      el.preload = 'auto';
      this.writer = new LJ.Fmp4Writer(); this.segs = []; this.playing = false; this.unlocked = false; this.unlocking = false;
      this.gain = 1; this.muted = false; this.level = 1; this.rate = 0; this.timers = []; this.jumpTo = null;
      this.volumeLocked = !volumeWorks();
      this.onReport = null; this.onState = null; this.externalPause = null; this.onFailure = null;
      this.ownPauses = 0;   // our own pauses: their events arrive later, asynchronously
      this.sbq = new SourceBufferQueue({ diag, onQuota: () => this._evict(2, true) });
      this.listeners = [];
      const on = (target, ev, fn) => { target.addEventListener(ev, fn); this.listeners.push([target, ev, fn]); };
      on(el, 'timeupdate', () => this.onReport && this.onReport());
      on(el, 'waiting', () => { this._unstick(); if (this.onReport) this.onReport(); });
      on(el, 'playing', () => this.onState && this.onState());
      on(el, 'pause', () => {
        if (this.onState) this.onState();
        if (this.ownPauses > 0) { this.ownPauses--; return; }
        // The OS paused us (a call, another app, headphones out): report it, as a Squeezebox would.
        if (this.playing && this.externalPause) this.externalPause();
      });
      on(el, 'error', () => {
        if (this.unlocking) return;   // the unlock clip's error, not the stream's
        this._fail('element error ' + (el.error && el.error.code));
      });
      this.intervals = [
        setInterval(() => { if (this.playing) this._unstick(); }, 250),
        setInterval(() => { this._evict(KEEP_BEHIND_S); this.sbq.run(); }, EVICT_EVERY_MS),
      ];
      this._open();
    }

    _open() {
      const MS = mediaSourceClass();
      const ms = this.ms = new MS();
      this.sbq.detach();
      ms.addEventListener('sourceopen', () => {
        if (ms !== this.ms) return;
        try {
          const sb = ms.addSourceBuffer(MIME);
          sb.mode = 'segments';
          sb.addEventListener('updateend', () => this._unstick());
          sb.addEventListener('bufferedchange', () => this._unstick());   // Managed Media Source evicts by itself
          sb.addEventListener('error', () => this.diag('media', 'source buffer error'));
          this.sbq.attach(sb);
        } catch (e) { this._fail('media source: ' + e.message); }
      }, { once: true });
      ms.addEventListener('sourceended', () => { if (ms === this.ms) this._fail('media source ended'); });
      ms.addEventListener('startstreaming', () => this.sbq.run());
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(ms);
      if (this.unlocked) { this.ownPauses = 0; this.el.src = this.url; }
    }

    /**
     * The element or its source failed: start a fresh one, and tell the host (audio was lost).
     * A browser that fails every fresh source too (it can't play the format after all) would
     * loop for ever: after FAIL_LIMIT failures within FAIL_WINDOW_MS, give up and tell the host
     * it's fatal (onFailure's third argument), so it can choose another output.
     */
    _fail(why) {
      if (this.failing || this.dead) return;
      this.failing = true;
      const wasPlaying = this.playing;
      const now = Date.now();
      this.failTimes = (this.failTimes || []).filter((t) => now - t < FAIL_WINDOW_MS);
      this.failTimes.push(now);
      const fatal = this.failTimes.length >= FAIL_LIMIT;
      this.diag('media', 'failed: ' + why + (fatal ? '; giving up' : '; starting a new media source'));
      this._reset(0);
      if (fatal) this.dead = true; else this._open();
      this.failing = false;
      if (this.onFailure) this.onFailure(why, wasPlaying, fatal);
    }

    // -- unlocking (iOS: play() must first succeed inside a tap) ------------------
    get needsGesture() { return !this.unlocked; }
    unlock() { this.prime(); }
    prime() {
      if (this.unlocked || this.unlocking) return;
      this.unlocking = true;
      const el = this.el;
      const giveUp = setTimeout(() => { this.unlocking = false; }, UNLOCK_TIMEOUT_MS);   // never stuck
      el.src = SILENT_WAV;
      const after = () => {
        clearTimeout(giveUp);
        this.unlocking = false;
        el.pause();
        this.ownPauses = 0;          // changing src discards the pending pause event
        el.src = this.url;
        if (this.playing) this._play();
        if (this.onState) this.onState();
      };
      let p;
      try { p = el.play(); } catch (e) { p = Promise.reject(e); }
      // Only the browser refusing sound (NotAllowedError) keeps us locked. Any other failure is the
      // clip's, and the tap still counts: browsers allow play() for the page after a gesture.
      const refused = (e) => {
        this.diag('media', `unlock: ${e && e.name}: ${e && e.message}`);
        if (e && e.name === 'NotAllowedError') { clearTimeout(giveUp); this.unlocking = false; return; }
        this.unlocked = true; after();
      };
      if (p && p.then) p.then(() => { this.unlocked = true; after(); }, refused);
      else { this.unlocked = true; after(); }
    }

    // -- data ---------------------------------------------------------------
    push(seq, rate, chans, bits) {
      this.rate = rate;
      const last = this.segs[this.segs.length - 1];
      if (!last || last.seq !== seq) this.segs.push({ seq, start: this.writer.end });
      const at = this.writer.end;   // where an init segment (a format change) takes effect
      for (const s of this.writer.push(rate, chans, bits || 16)) this._queue(s, at);
    }
    endSeq(seq) {
      // The last track so far: write out its partial last block, so its end is heard.
      const last = this.segs[this.segs.length - 1];
      if (last && last.seq === seq) for (const s of this.writer.flush()) this._queue(s);
    }
    _queue(s, at) { this.sbq.push(s.init ? { kind: 'init', data: s.init, start: at } : { kind: 'append', data: s.data, start: s.start, end: s.end }); }

    /** Remove played audio, keeping `keep` seconds behind the playhead. */
    _evict(keep, urgent) {
      const sb = this.sbq.sb;
      if (!sb) return;
      let from;
      try { if (!sb.buffered.length) return; from = sb.buffered.start(0); } catch (e) { return; }
      const to = this.el.currentTime - keep;
      if (to - from > 1) (urgent ? this.sbq.pushFront.bind(this.sbq) : this.sbq.push.bind(this.sbq))({ kind: 'remove', from, to });
    }

    /**
     * Keep the element on the audio. After a flush, move to where the new audio starts once it
     * is buffered. If playback ever waits before buffered audio (a gap at a format change, or
     * audio the browser evicted), step to it: Safari doesn't do that by itself.
     */
    _unstick() {
      const sb = this.sbq.sb, el = this.el;
      if (!sb || sb.updating) return;
      let b;
      try { b = sb.buffered; } catch (e) { return; }
      const ct = el.currentTime;
      if (this.jumpTo != null) {
        for (let i = 0; i < b.length; i++) {
          if (b.end(i) > this.jumpTo && b.start(i) <= this.jumpTo + 0.05) { el.currentTime = Math.max(this.jumpTo, b.start(i)); this.jumpTo = null; return; }
        }
        return;
      }
      if (!this.playing) return;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= ct + 0.01 && ct < b.end(i) - 0.02) return;   // on the audio
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) > ct) { this.diag('media', `stepped over a ${((b.start(i) - ct) * 1000).toFixed(0)} ms gap`); el.currentTime = b.start(i); return; }
      }
    }

    // -- transport --------------------------------------------------------------
    _play() {
      if (!this.unlocked) return;
      const p = this.el.play();
      if (p && p.catch) p.catch((e) => this.diag('media', 'play refused: ' + e.message));
    }
    _pauseEl() { if (!this.el.paused) { this.ownPauses++; this.el.pause(); } }
    _clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers = []; }
    play() { this.playing = true; this._clearTimers(); this._play(); }
    pause() { this.playing = false; this._clearTimers(); this._pauseEl(); }
    startAt(ms) {
      this.playing = true; this._clearTimers();
      const wait = ms - performance.now();
      if (wait <= 5) this._play(); else this.timers.push(setTimeout(() => this._play(), wait));
    }
    pauseFor(ms) {
      if (!this.playing) return;
      this._pauseEl();
      this.timers.push(setTimeout(() => { if (this.playing) this._play(); }, ms));
    }
    skip(ms) { try { this.el.currentTime += ms / 1000; } catch (e) { /* not seekable yet */ } }
    _reset(t) {
      this.playing = false; this._clearTimers(); this._pauseEl();
      this.segs = [];
      this.sbq.dropAppends();
      this.sbq.push({ kind: 'remove', from: 0, to: Infinity });
      this.writer.restart(t);
      this.jumpTo = t;
    }
    flush() { this._reset(this.el.currentTime + 0.05); }
    trimAfter(seq) {
      const next = this.segs.find((s) => s.seq > seq);
      this.segs = this.segs.filter((s) => s.seq <= seq);
      if (!next) return;
      this.sbq.dropAppends((o) => o.start >= next.start - 1e-6);
      this.sbq.push({ kind: 'remove', from: next.start, to: Infinity });
      this.writer.restart(next.start);
    }

    // -- volume (where the page may set it) -------------------------------------
    setGain(g) { this.gain = g; this._vol(); }
    setMute(m) { this.muted = m; this._vol(); }
    setLevel(l) { this.level = l; this._vol(); }
    _vol() { this.el.muted = this.muted; if (!this.volumeLocked) this.el.volume = Math.max(0, Math.min(1, this.gain * this.level)); }

    // -- what is heard ----------------------------------------------------------
    queuedSeconds() { return Math.max(0, this.writer.end - this.el.currentTime); }
    get underrun() {
      if (!this.playing || !this.unlocked) return false;
      return this.writer.end - this.el.currentTime < 0.05 && !this.sbq.pendingAppends;
    }
    audible() {
      const ct = this.el.currentTime;
      let s = null;
      for (const x of this.segs) if (x.start <= ct + 0.001) s = x;
      if (!s) return null;
      // Tracks wholly in the past are no longer needed for the mapping.
      const i = this.segs.indexOf(s);
      if (i > 2) this.segs.splice(0, i - 2);
      return { seq: s.seq, ms: Math.max(0, (ct - s.start) * 1000) };
    }
    /** Where the lock screen's position comes from: the current track's own timeline. */
    trackPosition() { const a = this.audible(); return a ? a.ms / 1000 : 0; }
    info() { return { rate: this.rate, state: this.el.paused ? 'paused' : 'running', latency: 0 }; }

    dispose() {
      for (const i of this.intervals) clearInterval(i);
      for (const [t, ev, fn] of this.listeners) t.removeEventListener(ev, fn);
      this._clearTimers(); this._pauseEl();
      this.sbq.detach();
      if (this.url) URL.revokeObjectURL(this.url);
    }
  }

  Object.assign(LJ, { MediaOutput, SourceBufferQueue, mediaSupported, volumeWorks, selfTest, MEDIA_MIME: MIME });
})(typeof globalThis !== 'undefined' ? globalThis : this);
