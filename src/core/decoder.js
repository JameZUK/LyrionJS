/* LyrionJS core: what every decoder offers the player.
 *
 *   feed(u8)       compressed bytes as they arrive
 *   end()          no more bytes will come
 *   pump(n)        decode up to about n units: 'more' (call again), 'need' (wants bytes, or is
 *                  waiting for an asynchronous decoder) or 'done' (all audio delivered)
 *   abort()        stop for good (flushed or replaced): no more output, ever
 *   consumed       bytes the decoder has finished with: the player acknowledges these, which is
 *                  what keeps the stream flowing (bytes held for later don't count)
 *   outBits        bit depth of the audio delivered (for lossless re-wrapping)
 *   describe()     e.g. "FLAC 24-bit 96 kHz", or '' until known
 *   onBlock(rate, channels: Float32Array[])   decoded audio
 *   onFinished()   an asynchronous decoder has more to give: pump again
 *   onError(msg)   decoding failed for good
 */
'use strict';
(function (G) {
  const LJ = G.LJ;

  class Decoder {
    constructor(queueSize = 1 << 18) {
      this.q = new LJ.ByteQueue(queueSize);
      this.fed = 0; this.ended = false; this.aborted = false; this.outBits = 16;
      this.onBlock = null; this.onFinished = null; this.onError = null;
    }
    get buffered() { return this.q.length; }
    get consumed() { return this.fed - this.q.length; }
    feed(u8) { if (this.aborted) return; this.fed += u8.length; this.q.push(u8); }
    end() { this.ended = true; }
    abort() { this.aborted = true; this.q.clear(); }
    describe() { return ''; }
    _emit(rate, chans) { if (!this.aborted && this.onBlock) this.onBlock(rate, chans); }
  }

  LJ.Decoder = Decoder;
})(typeof globalThis !== 'undefined' ? globalThis : this);
