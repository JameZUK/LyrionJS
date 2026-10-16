/* LyrionJS core: transitions between tracks (crossfade, fade in, fade out), as squeezelite does
 * them. It sits between the decoders and the output, so both outputs get them.
 *
 * LMS gives each stream its own transition (strm type and period). For a crossfade, the end of
 * the playing track has to wait for the start of the next, which LMS sends only once this one
 * has finished decoding: so the end of a track whose own transition is a crossfade is held back
 * (a rolling window of `period` seconds). When the next track arrives with a crossfade too, the
 * two are mixed, and the mix belongs to the new track (its start is heard at the start of the
 * crossfade, as with squeezelite). Otherwise, or if the output runs low first, it is played as it is.
 * Fade in ramps the start of a track, fade out the end; "fade in and out" does both, each over
 * half the period. Crossfades need the same sample rate on both sides (as squeezelite). */
'use strict';
(function (G) {
  const LJ = G.LJ;

  const MODE = { NONE: 0, CROSSFADE: 1, FADE_IN: 2, FADE_OUT: 3, FADE_INOUT: 4, CROSSFADE_IMMEDIATE: 5 };
  const RELEASE_S = 3;   // play a held track end as it is once the output has less than this queued

  const isCross = (m) => m === MODE.CROSSFADE || m === MODE.CROSSFADE_IMMEDIATE;
  const frames = (blocks) => blocks.reduce((a, b) => a + b[0].length, 0);

  /** Join blocks of channel arrays into one array per channel. */
  function join(blocks, nch) {
    const n = frames(blocks), out = [];
    for (let c = 0; c < nch; c++) {
      const a = new Float32Array(n);
      let o = 0;
      for (const b of blocks) { a.set(b[Math.min(c, b.length - 1)], o); o += b[0].length; }
      out.push(a);
    }
    return out;
  }
  /** Frames [from, to) of one block. */
  const slice = (chans, from, to) => chans.map((a) => a.subarray(from, to));

  class Transitions {
    /** out: the output ({push(seq, rate, chans, bits), endSeq(seq), queuedSeconds()}). */
    constructor(out) { this.out = out; this.tracks = new Map(); this.mix = null; }

    /** A new stream: its transition, from its strm (type '0'..'5', period in seconds). */
    begin(seq, type, period) {
      const mode = +type || 0, secs = Math.max(0, +period || 0);
      const t = { seq, mode: secs > 0 ? mode : MODE.NONE, secs, rate: 0, bits: 16, nch: 0, seen: 0,
        hold: [], ended: false, endSent: false };
      // The track before it, if its end is waiting for a crossfade that isn't coming.
      if (!isCross(t.mode)) for (const p of this.tracks.values()) if (p.ended) this._release(p);
      this.tracks.set(seq, t);
    }

    _fadeInFrames(t) { return t.mode === MODE.FADE_IN ? t.secs * t.rate : t.mode === MODE.FADE_INOUT ? t.secs * t.rate / 2 : 0; }
    _holdFrames(t) {
      if (isCross(t.mode)) return t.secs * t.rate;
      if (t.mode === MODE.FADE_OUT) return t.secs * t.rate;
      if (t.mode === MODE.FADE_INOUT) return t.secs * t.rate / 2;
      return 0;
    }

    /** Decoded audio of track `seq` (gain already applied). */
    push(seq, rate, chans, bits) {
      const t = this.tracks.get(seq);
      if (!t) { this.out.push(seq, rate, chans, bits); return; }
      if (!chans[0].length) return;
      if (t.rate !== rate) { if (t.rate) this._flushHold(t); t.rate = rate; }
      t.bits = bits; t.nch = chans.length;
      // Fade in: a ramp over the first frames (the decoder's arrays are ours to change).
      const fin = Math.round(this._fadeInFrames(t));
      if (t.seen < fin) {
        const n = chans[0].length;
        for (let i = 0; i < n && t.seen + i < fin; i++) {
          const g = (t.seen + i + 0.5) / fin;
          for (const c of chans) c[i] *= g;
        }
      }
      const first = t.seen === 0;
      t.seen += chans[0].length;
      // The first audio of a track crossfading in from the one before.
      if (first) this._startMix(t);
      if (this.mix && this.mix.into === t) chans = this._mixIn(chans);
      if (!chans) return;
      const max = Math.round(this._holdFrames(t));
      if (!max) { this.out.push(seq, rate, chans, bits); return; }
      // Keep the last `max` frames back; anything older goes now.
      t.hold.push(chans);
      let extra = frames(t.hold) - max;
      while (extra > 0) {
        const b = t.hold[0], k = Math.min(extra, b[0].length);
        this.out.push(seq, rate, k === b[0].length ? b : slice(b, 0, k), bits);
        if (k === b[0].length) t.hold.shift(); else t.hold[0] = slice(b, k, b[0].length);
        extra -= k;
      }
    }

    /** The decoder has finished track `seq`: nothing more of it will come. */
    end(seq) {
      const t = this.tracks.get(seq);
      if (!t) { this.out.endSeq(seq); return; }
      t.ended = true;
      if (this.mix && this.mix.into === t) {
        // It ended inside its own crossfade (a very short track): what it has goes first, then
        // the rest of the track before, fading out alone. Nothing crossfades out of it.
        this._flushHold(t); this._finishMix(); this._sendEnd(t); this.check(); return;
      }
      if (t.mode === MODE.FADE_OUT || t.mode === MODE.FADE_INOUT) {
        // Fade out over what was held back (all of it: it was kept to exactly this length).
        const all = t.hold.length ? join(t.hold, t.nch) : null;
        t.hold = [];
        if (all) {
          const n = all[0].length;
          for (const c of all) for (let i = 0; i < n; i++) c[i] *= (n - i - 0.5) / n;
          this.out.push(t.seq, t.rate, all, t.bits);
        }
        this._sendEnd(t);
      } else if (!isCross(t.mode) || !t.hold.length) {
        this._flushHold(t); this._sendEnd(t);
      }
      // A crossfading track keeps its end until the next track (or the output running low).
      this.check();
    }

    /** Called often: let a held end go once the output is about to run out without it. */
    check() {
      for (const t of this.tracks.values()) {
        if (t.ended && !t.endSent && t.hold.length && this.out.queuedSeconds() < RELEASE_S) this._release(t);
      }
      for (const [seq, t] of this.tracks) if (t.endSent && !t.hold.length && !(this.mix && this.mix.into === t)) this.tracks.delete(seq);
    }

    /** Seconds held back here, not yet at the output. */
    heldSeconds() {
      let s = 0;
      for (const t of this.tracks.values()) if (t.rate) s += frames(t.hold) / t.rate;
      if (this.mix) s += (this.mix.a[0].length - this.mix.pos) / this.mix.rate;
      return s;
    }

    /** Track `seq` was dropped, but what it decoded still plays (a stream replaced by another). */
    stop(seq) {
      const t = this.tracks.get(seq);
      if (!t) { this.out.endSeq(seq); return; }
      if (this.mix && this.mix.into === t) { this._flushHold(t); this._finishMix(); }
      t.ended = true; this._release(t);
    }
    /** Everything after track `keep` was dropped from the output. */
    trim(keep) {
      if (this.mix && this.mix.into.seq > keep) {
        // The rest of the track it was crossfading out of plays as it is.
        const m = this.mix; this.mix = null;
        const rest = slice(m.a, m.pos, m.a[0].length);
        if (rest[0].length) this.out.push(m.from.seq, m.rate, rest, m.from.bits);
        this.out.endSeq(m.from.seq);
      }
      for (const seq of [...this.tracks.keys()]) if (seq > keep) this.tracks.delete(seq);
    }
    /** Everything was flushed. */
    clear() { this.tracks.clear(); this.mix = null; }

    // -- internals --------------------------------------------------------------

    _sendEnd(t) { if (!t.endSent) { t.endSent = true; this.out.endSeq(t.seq); } }
    _flushHold(t) {
      for (const b of t.hold) this.out.push(t.seq, t.rate, b, t.bits);
      t.hold = [];
    }
    _release(t) { this._flushHold(t); if (t.ended) this._sendEnd(t); }

    /** Track `t` has its first audio: crossfade from the track before, if both want it. */
    _startMix(t) {
      if (!isCross(t.mode)) return;
      let from = null;
      for (const p of this.tracks.values()) if (p !== t && p.ended && !p.endSent && p.hold.length) from = p;
      if (!from) return;
      if (from.rate !== t.rate) { this._release(from); return; }
      const held = join(from.hold, Math.max(from.nch, t.nch)); from.hold = [];
      const n = held[0].length, d = Math.min(n, Math.round(t.secs * t.rate));
      // Any of the held end beyond the crossfade length plays first, as it is.
      if (n > d) this.out.push(from.seq, from.rate, slice(held, 0, n - d), from.bits);
      this._sendEnd(from);
      this.mix = { from, into: t, a: slice(held, n - d, n), pos: 0, rate: t.rate };
    }

    /** Mix the start of the incoming track over the end of the outgoing one. */
    _mixIn(chans) {
      const m = this.mix, d = m.a[0].length, n = chans[0].length, k = Math.min(n, d - m.pos);
      for (let c = 0; c < chans.length; c++) {
        const a = m.a[Math.min(c, m.a.length - 1)], b = chans[c];
        for (let i = 0; i < k; i++) {
          const g = (m.pos + i + 0.5) / d;   // linear, as squeezelite: never louder than either side
          b[i] = a[m.pos + i] * (1 - g) + b[i] * g;
        }
      }
      m.pos += k;
      if (m.pos >= d) this.mix = null;
      return chans;
    }

    /** The incoming track ended inside the crossfade: the rest of the outgoing one fades out alone. */
    _finishMix() {
      const m = this.mix; this.mix = null;
      const d = m.a[0].length, rest = slice(m.a, m.pos, d);
      if (!rest[0].length) return;
      const n = rest[0].length, out = rest.map((a) => Float32Array.from(a));
      for (const c of out) for (let i = 0; i < n; i++) c[i] *= 1 - (m.pos + i + 0.5) / d;
      this.out.push(m.into.seq, m.rate, out, m.into.bits);
    }
  }

  Object.assign(LJ, { Transitions, TRANSITION: MODE, TRANSITION_RELEASE_S: RELEASE_S });
})(typeof globalThis !== 'undefined' ? globalThis : this);
