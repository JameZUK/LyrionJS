/* LyrionJS media-element output, for phones and tablets.
 *
 * Web Audio stops when an iPhone or iPad locks its screen; an <audio> element playing from a
 * (Managed) Media Source doesn't. So on those devices the decoded audio is re-wrapped,
 * losslessly, as FLAC "verbatim" frames (uncompressed, bit-exact) inside fragmented MP4 and fed
 * to an <audio> element. The output offers the same interface as the Web Audio output, so the
 * Slimproto player can't tell which one it's driving.
 *
 * The muxer half (FlacFrames, Mp4) has no DOM and is tested under Node against ffmpeg. */
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
  function flacFrame(chans, off, n, bits, sample) {
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
      this.frames.push({ data: flacFrame(chans, off, n, f.bits, this.sample + this.frames.reduce((a, x) => a + x.samples, 0)), samples: n });
    }
    _fragment() {
      const start = this.base + this.sample;
      let count = 0; for (const f of this.frames) count += f.samples;
      const data = Mp4.fragment(++this.seqNo, start, this.frames);
      this.frames = []; this.sample += count;
      return { data, start: start / this.fmt.rate, end: (start + count) / this.fmt.rate };
    }
  }

  // ---------------------------------------------------------------------------
  // The output: an <audio> element fed by (Managed) Media Source
  // ---------------------------------------------------------------------------
  const MIME = 'audio/mp4; codecs="flac"';
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

  function mediaSourceClass() { return G.ManagedMediaSource || G.MediaSource || null; }

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
      const done = (ok) => { clearTimeout(t); try { URL.revokeObjectURL(el.src); } catch (e) { /* */ } el.removeAttribute('src'); resolve(ok); };
      const t = setTimeout(() => done(false), 3000);
      ms.addEventListener('sourceopen', () => {
        try {
          const sb = ms.addSourceBuffer(MIME);
          const w = new Fmp4Writer();
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
      el.src = URL.createObjectURL(ms);
    });
  }

  class MediaOutput {
    /** el: the <audio> element (in the document, so the OS media controls attach to it). */
    constructor(el, { diag = () => {} } = {}) {
      this.el = el; this.diag = diag; this.engine = 'Media element (' + (G.ManagedMediaSource ? 'Managed Media Source' : 'Media Source') + ')';
      el.disableRemotePlayback = true; // Managed Media Source requires this (or an AirPlay source)
      el.preload = 'auto';
      this.writer = new Fmp4Writer(); this.segs = []; this.queue = []; this.playing = false; this.unlocked = false;
      this.gain = 1; this.muted = false; this.trim = 1; this.onReport = null; this.onState = null;
      this.volumeLocked = !volumeWorks(); this.rate = 0; this.timers = []; this.jumpTo = null;
      this._open();
      el.addEventListener('timeupdate', () => this.onReport && this.onReport());
      el.addEventListener('waiting', () => { this._unstick(); if (this.onReport) this.onReport(); });
      setInterval(() => { if (this.playing) this._unstick(); }, 250);
      el.addEventListener('playing', () => this.onState && this.onState());
      el.addEventListener('pause', () => this.onState && this.onState());
      el.addEventListener('error', () => this.diag('media', 'element error ' + (el.error && el.error.code)));
      // The OS can pause us (a call, another app, headphones out). Report it, so LMS knows.
      this.externalPause = null;
      // Our own pauses are counted, because the pause event arrives later, asynchronously.
      this.ownPauses = 0;
      el.addEventListener('pause', () => {
        if (this.ownPauses > 0) { this.ownPauses--; return; }
        if (this.playing && this.externalPause) this.externalPause();
      });
    }
    _open() {
      const MS = mediaSourceClass();
      this.ms = new MS(); this.sb = null; this.ready = false; this.inits = 0;
      this.ms.addEventListener('sourceopen', () => {
        try {
          this.sb = this.ms.addSourceBuffer(MIME);
          this.sb.mode = 'segments';
          this.sb.addEventListener('updateend', () => { this._unstick(); this._drain(); });
          this.sb.addEventListener('error', () => this.diag('media', 'source buffer error'));
          this.ready = true; this._drain();
        } catch (e) { this.diag('error', 'media source: ' + e.message); }
      }, { once: true });
      this.ms.addEventListener('startstreaming', () => this._drain());
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(this.ms);
      if (this.unlocked) this.el.src = this.url;
    }

    // -- unlocking (iOS: play() must first succeed inside a tap) --
    get needsGesture() { return !this.unlocked; }
    unlock() { this.prime(); }
    prime() {
      if (this.unlocked || this.unlocking) return;
      this.unlocking = true;
      const el = this.el;
      el.src = SILENT_WAV;
      const p = el.play();
      const after = () => { this.unlocking = false; this._pauseEl(); el.src = this.url; if (this.playing) this._play(); if (this.onState) this.onState(); };
      if (p && p.then) p.then(() => { this.unlocked = true; after(); }, (e) => { this.unlocking = false; this.diag('media', 'unlock refused: ' + e.message); });
      else { this.unlocked = true; after(); }
    }

    // -- data --
    push(seq, rate, chans, bits) {
      this.rate = rate;
      if (!this.segs.length || this.segs[this.segs.length - 1].seq !== seq) this.segs.push({ seq, start: this.writer.end, ended: false });
      for (const s of this.writer.push(rate, chans, bits || 16)) this.queue.push(s);
      this._drain();
    }
    endSeq(seq) {
      const s = this.segs.find((x) => x.seq === seq);
      if (s) s.ended = true;
      // Write out the partial last block so the end of the track is heard.
      if (seq === (this.segs.length && this.segs[this.segs.length - 1].seq)) { for (const x of this.writer.flush()) this.queue.push(x); this._drain(); }
    }
    _drain() {
      const sb = this.sb;
      if (!this.ready || !sb || sb.updating || !this.queue.length) return;
      if (this.ms.readyState !== 'open') return;
      const s = this.queue.shift();
      try {
        if (s.init) { if (this.inits++ && sb.changeType) sb.changeType(MIME); sb.appendBuffer(s.init); }
        else sb.appendBuffer(s.data);
      } catch (e) {
        if (e.name === 'QuotaExceededError') { this.queue.unshift(s); this._evict(true); return; }
        this.diag('error', 'append: ' + e.message);
      }
    }
    /**
     * Keep the element on the audio. After a flush, move to where the new audio starts once it
     * is buffered; and if playback is ever waiting just before buffered audio (a small gap at a
     * format change), step over it: Safari doesn't do that by itself.
     */
    _unstick() {
      const el = this.el, sb = this.sb;
      if (!sb || sb.updating) return;
      let b;
      try { b = sb.buffered; } catch (e) { return; }
      const ct = el.currentTime;
      if (this.jumpTo != null) {
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= this.jumpTo + 0.01 && this.jumpTo < b.end(i)) {
            el.currentTime = Math.max(this.jumpTo, b.start(i));
            this.jumpTo = null;
            return;
          }
        }
        return;
      }
      if (!this.playing) return;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= ct + 0.01 && ct < b.end(i) - 0.02) return; // on the audio
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) > ct && b.start(i) - ct < 1) { this.diag('media', `stepped over a ${((b.start(i) - ct) * 1000).toFixed(0)} ms gap`); el.currentTime = b.start(i); return; }
      }
    }
    _evict(force) {
      const sb = this.sb, ct = this.el.currentTime;
      if (!sb || sb.updating || !sb.buffered.length) return;
      const from = sb.buffered.start(0);
      const behind = force ? 2 : 20;
      if (ct - from > behind + 5) try { sb.remove(from, ct - behind); } catch (e) { /* busy */ }
    }

    // -- transport --
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
    flush() {
      this.playing = false; this._clearTimers(); this._pauseEl();
      this.queue = []; this.segs = [];
      const t = this.el.currentTime + 0.05;
      this.writer.restart(t);
      if (this.sb) { try { this.sb.abort(); if (this.sb.buffered.length) this.sb.remove(0, Infinity); } catch (e) { /* closed */ } }
      this.inits = this.inits ? 1 : 0; // a new init segment follows; changeType if the browser has it
      this.jumpTo = t;
    }
    trimAfter(seq) {
      const next = this.segs.find((s) => s.seq > seq);
      this.segs = this.segs.filter((s) => s.seq <= seq);
      this.queue = this.queue.filter((s) => s.init || s.start < (next ? next.start : Infinity));
      if (next) {
        this.writer.restart(next.start);
        try { if (this.sb && !this.sb.updating) this.sb.remove(next.start, Infinity); } catch (e) { /* busy */ }
      }
    }

    // -- volume (where the page may set it) --
    setGain(g) { this.gain = g; this._vol(); }
    setMute(m) { this.muted = m; this._vol(); }
    setTrim(t) { this.trim = t; this._vol(); }
    _vol() { this.el.muted = this.muted; if (!this.volumeLocked) this.el.volume = Math.max(0, Math.min(1, this.gain * this.trim)); }

    // -- what is heard --
    queuedSeconds() { return Math.max(0, this.writer.end - this.el.currentTime); }
    get underrun() {
      if (!this.playing || !this.unlocked) return false;
      return this.writer.end - this.el.currentTime < 0.05 && !this.queue.length;
    }
    audible() {
      const ct = this.el.currentTime;
      let s = null;
      for (const x of this.segs) if (x.start <= ct + 0.001) s = x;
      if (!s) return null;
      if (this.segs.indexOf(s) % 50 === 49) this._evict(false);
      return { seq: s.seq, ms: Math.max(0, (ct - s.start) * 1000) };
    }
    info() {
      const el = this.el;
      return { rate: this.rate, state: el.paused ? 'paused' : 'running', latency: 0 };
    }
  }

  Object.assign(LJ, { flacFrame, streamInfo, Mp4, Fmp4Writer, toInts, MediaOutput, mediaSupported, volumeWorks, selfTest, MEDIA_MIME: MIME });
})(typeof globalThis !== 'undefined' ? globalThis : this);
