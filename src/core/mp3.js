/* LyrionJS core: MP3. The framer and gapless trimming are ours; the decoding itself is the
 * browser's (WebCodecs, or decodeAudioData in chunks where WebCodecs isn't offered). */
'use strict';
(function (G) {
  const LJ = G.LJ;
  const { ByteQueue, Skipper, be32, latin1, id3Size } = LJ;

  const BITRATES = {
    '3-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '3-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  };
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  /** Samples a decoder delays its output by (the LAME convention), beyond the encoder delay. */
  const DECODER_DELAY = 529;

  function mp3Header(b, i) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
    const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
    const bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1, mode = b[i + 3] >> 6;
    if (ver === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) return null;
    const lay = 4 - layer; // 1, 2 or 3
    const br = BITRATES[(ver === 3 ? 3 : 2) + '-' + lay][bri] * 1000;
    const rate = RATES[ver][sri];
    let len, samples;
    if (lay === 1) { len = (Math.floor(12 * br / rate) + pad) * 4; samples = 384; }
    else if (lay === 2 || ver === 3) { len = Math.floor(144 * br / rate) + pad; samples = 1152; }
    else { len = Math.floor(72 * br / rate) + pad; samples = 576; }
    return { len, rate, channels: mode === 3 ? 1 : 2, samples, ver, layer: lay, bitrate: br };
  }

  /** Splits an MP3 stream into frames, skipping ID3 tags; reads the LAME tag for gapless trimming. */
  class Mp3Framer {
    constructor(q = new ByteQueue(1 << 17)) {
      this.q = q; this.ended = false; this.first = true; this.delay = 0; this.padding = 0; this.info = null;
      this.synced = false; this.skip = new Skipper();
    }
    feed(u8) { this.q.push(u8); }
    get buffered() { return this.q.length; }
    /** {frame, hdr} | 'need' | 'done'. */
    next() {
      for (;;) {
        if (this.skip.active) { this.skip.run(this.q); if (this.skip.active) return this.ended ? 'done' : 'need'; }
        const v = this.q.view();
        if (v.length < 10) { if (this.ended) { this.q.clear(); return 'done'; } return 'need'; }
        const tag = id3Size(v);
        if (tag) { this.skip.start(tag); continue; }
        const h = mp3Header(v, 0);
        if (!h) {
          this.synced = false;
          let j = 1; while (j + 1 < v.length && !(v[j] === 0xff && (v[j + 1] & 0xe0) === 0xe0)) j++;
          this.q.consume(j); continue;
        }
        if (v.length < h.len + 4 && !this.ended) return 'need';
        if (!this.synced && v.length >= h.len + 4) {
          // Out of sync (stream start, or a seek into a file): the next frame must line up and
          // agree, so a stray 0xFFE in the audio isn't taken for a frame.
          const h2 = mp3Header(v, h.len);
          if (!h2 || h2.rate !== h.rate || h2.ver !== h.ver || h2.layer !== h.layer || h2.channels !== h.channels) { this.q.consume(1); continue; }
        }
        if (h.len > v.length) { this.q.clear(); return 'done'; }
        this.synced = true;
        const frame = this.q.take(h.len);
        if (this.first) {
          this.first = false;
          if (this._lameTag(frame, h)) continue;   // the tag frame carries no audio
        }
        this.info = this.info || h;
        return { frame, hdr: h };
      }
    }
    _lameTag(frame, h) {
      const side = h.ver === 3 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
      const x = 4 + side, tag = latin1(frame.subarray(x, x + 4));
      if (tag !== 'Xing' && tag !== 'Info') return false;
      const flags = be32(frame, x + 4);
      let o = x + 8; if (flags & 1) o += 4; if (flags & 2) o += 4; if (flags & 4) o += 100; if (flags & 8) o += 4;
      if (o + 24 <= frame.length && latin1(frame.subarray(o, o + 4)) === 'LAME') {
        const d = frame.subarray(o + 21, o + 24);
        this.delay = (d[0] << 4) | (d[1] >> 4); this.padding = ((d[1] & 15) << 8) | d[2];
      }
      this.info = h;
      return true;
    }
  }

  /**
   * Gapless trimming shared by both MP3 decoders: drop the encoder + decoder delay at the start,
   * and hold the latest block back so the padding can be cut once the end is known.
   */
  class GaplessTrim {
    constructor(framer, decoderDelay) { this.framer = framer; this.decoderDelay = decoderDelay; this.skip = -1; this.held = null; }
    push(rate, chans, emit) {
      if (this.skip < 0) this.skip = this.framer.delay ? this.framer.delay + this.decoderDelay : 0;
      if (this.skip > 0) {
        const n = Math.min(this.skip, chans[0].length); this.skip -= n;
        chans = chans.map((c) => c.subarray(n));
        if (!chans[0].length) return;
      }
      if (this.held) emit(this.held.rate, this.held.chans);
      this.held = { rate, chans };
    }
    finish(emit) {
      if (!this.held) return;
      let chans = this.held.chans;
      const pad = Math.min(Math.max(0, this.framer.padding - this.decoderDelay), chans[0].length);
      if (pad) chans = chans.map((c) => c.subarray(0, c.length - pad));
      if (chans[0].length) emit(this.held.rate, chans);
      this.held = null;
    }
  }

  /** MP3 through WebCodecs AudioDecoder (Chrome, Edge, Firefox, Safari 26+, on secure pages). */
  class Mp3Decoder extends LJ.Decoder {
    static supported() { return typeof G.AudioDecoder === 'function' && typeof G.EncodedAudioChunk === 'function'; }
    constructor(opts = {}) {
      super(1 << 17);
      this.framer = new Mp3Framer(this.q);
      this.trim = new GaplessTrim(this.framer, opts.decoderDelay == null ? DECODER_DELAY : opts.decoderDelay);
      this.dec = null; this.config = null; this.ts = 0; this.outQ = []; this.busy = null; this.finished = false;
      this.errors = 0; this.failed = null; this.pending = null;
    }
    end() { super.end(); this.framer.ended = true; }
    abort() {
      super.abort(); this.finished = true; this.outQ = []; this.trim.held = null; this.pending = null;
      this._close(this.dec); this.dec = null;
    }
    _close(dec) { if (dec) { try { dec.close(); } catch (e) { /* closed */ } } }
    _wake() { if (!this.aborted && this.onFinished) this.onFinished(); }
    _open(h) {
      const dec = new G.AudioDecoder({
        output: (ad) => {
          if (this.aborted) { ad.close(); return; }
          const n = ad.numberOfFrames, ch = Math.min(ad.numberOfChannels, 2), chans = [];
          for (let c = 0; c < ch; c++) { const a = new Float32Array(n); ad.copyTo(a, { planeIndex: c, format: 'f32-planar' }); chans.push(a); }
          this.outQ.push({ rate: ad.sampleRate, chans }); ad.close();
          this._wake();
        },
        // A corrupt frame closes the decoder; pump() opens a new one and carries on.
        error: (e) => { if (dec === this.dec) { this.failed = e; this.errors++; this._wake(); } },
      });
      dec.configure({ codec: 'mp3', sampleRate: h.rate, numberOfChannels: h.channels });
      this.dec = dec; this.config = h;
    }
    _drainOut() { while (this.outQ.length) { const o = this.outQ.shift(); this.trim.push(o.rate, o.chans, (r, c) => this._emit(r, c)); } }
    /** Let the current decoder finish what it holds, then run `then`. */
    _finishDecoder(then) {
      const dec = this.dec;
      this.busy = dec.flush().catch(() => {}).then(() => {
        if (this.aborted) return;
        this._drainOut();
        this._close(dec);
        if (this.dec === dec) this.dec = null;
        this.busy = null;
        then();
        this._wake();
      });
    }
    pump(maxFrames = 64) {
      if (this.finished || this.aborted) return 'done';
      if (this.failed) {
        this.failed = null; this.dec = null; this.busy = null;
        if (this.errors > 20) { this.finished = true; if (this.onError) this.onError('MP3 decoding failed'); return 'done'; }
      }
      this._drainOut();
      if (this.busy) return 'need';
      for (let i = 0; i < maxFrames; i++) {
        if (this.dec && this.dec.decodeQueueSize > 32) return 'need';
        const r = this.pending || this.framer.next();
        this.pending = null;
        if (r === 'need') return 'need';
        if (r === 'done') {
          if (!this.ended) return 'need';
          if (!this.dec) { this.trim.finish((rt, c) => this._emit(rt, c)); this.finished = true; return 'done'; }
          this._finishDecoder(() => { this.trim.finish((rt, c) => this._emit(rt, c)); this.finished = true; });
          return 'need';
        }
        if (this.dec && (this.config.rate !== r.hdr.rate || this.config.channels !== r.hdr.channels)) {
          // A format change: finish the old decoder first, so none of its audio is lost.
          this.pending = r;
          this._finishDecoder(() => {});
          return 'need';
        }
        if (!this.dec) this._open(r.hdr);
        this.dec.decode(new G.EncodedAudioChunk({ type: 'key', timestamp: this.ts, data: r.frame }));
        this.ts += Math.round(r.hdr.samples * 1e6 / r.hdr.rate);
      }
      return 'more';
    }
    describe() { const h = this.framer.info; return h ? `MP3 ${h.rate / 1000} kHz` : ''; }
  }

  /**
   * MP3 through the browser's decodeAudioData, where WebCodecs isn't offered (Chrome and Firefox
   * on plain http pages). The stream is decoded in chunks of about 10 s. Each chunk starts with
   * the last OVERLAP frames of the one before, so the bit reservoir and the MDCT overlap are
   * primed; the last HOLD frames of each chunk's audio are held back and replaced by the properly
   * decoded overlap of the next. The join is found by matching the audio, so it doesn't depend on
   * how much delay a particular browser's decoder adds.
   * decode(Uint8Array, rate, channels) -> Promise<Float32Array[]> is supplied by the host.
   */
  class Mp3ChunkDecoder extends LJ.Decoder {
    constructor(decode, opts = {}) {
      super(1 << 17);
      this.decode = decode; this.framer = new Mp3Framer(this.q);
      this.decoderDelay = opts.decoderDelay == null ? DECODER_DELAY : opts.decoderDelay;
      this.frames = []; this.prevTail = []; this.busy = false; this.finished = false; this.first = true;
      this.chunk = opts.chunk || 384; this.ref = null;
    }
    end() { super.end(); this.framer.ended = true; }
    abort() { super.abort(); this.finished = true; this.frames = []; }
    describe() { const h = this.framer.info; return h ? `MP3 ${h.rate / 1000} kHz` : ''; }
    pump() {
      if (this.finished || this.aborted) return 'done';
      let last = false;
      const want = this.first ? Math.min(96, this.chunk) : this.chunk;   // a short first chunk starts sooner
      // Move frames out of the byte queue, so flow control keeps the stream coming.
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
      const bytes = LJ.concatAll(all.map((f) => f.frame));
      const spf = this.hdr.samples, rate = this.hdr.rate;
      const wasFirst = this.first;
      this.first = false;
      this.busy = true;
      const done = () => { this.busy = false; if (final) this.finished = true; if (!this.aborted && this.onFinished) this.onFinished(); };
      this.decode(bytes, rate, this.hdr.channels).then((chans) => {
        if (this.aborted) return;
        chans = chans.slice(0, 2);
        const start = wasFirst
          ? (this.framer.delay ? this.framer.delay + this.decoderDelay : 0)
          : this._align(chans[0], (overlapFrames - HOLD) * spf, spf);   // where the new audio continues the old
        let end = chans[0].length;
        if (!final) end -= HOLD * spf;
        else if (this.framer.padding) end -= Math.max(0, this.framer.padding - this.decoderDelay);
        if (end > start) {
          const out = chans.map((c) => c.slice(start, end));
          this.ref = out[0].slice(Math.max(0, out[0].length - 512));
          this._emit(rate, out);
        }
        done();
      }, () => { this.ref = null; done(); });   // a chunk the browser can't decode: skip it
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

  Object.assign(LJ, { mp3Header, Mp3Framer, Mp3Decoder, Mp3ChunkDecoder, DECODER_DELAY });
})(typeof globalThis !== 'undefined' ? globalThis : this);
