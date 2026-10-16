/* LyrionJS core: PCM as LMS sends it for format 'p': raw, WAV or AIFF/AIFC. */
'use strict';
(function (G) {
  const LJ = G.LJ;
  const { be16, be32, le32, latin1, Skipper } = LJ;
  /** The tail of the KSDATAFORMAT_SUBTYPE GUIDs (WAVE_FORMAT_EXTENSIBLE); the first two bytes are the format. */
  const GUID_TAIL = '\0\0\0\0\x10\0\x80\0\0\xaa\0\x38\x9b\x71';

  const RATES = { '0': 11025, '1': 22050, '2': 32000, '3': 44100, '4': 48000, '5': 8000, '6': 12000, '7': 16000,
    '8': 24000, '9': 96000, ':': 88200, ';': 176400, '<': 192000, '=': 352800, '>': 384000 };
  const SIZES = { '0': 8, '1': 16, '2': 24, '3': 32 };
  const BLOCK = 16384;    // frames per decoded block

  class PcmDecoder extends LJ.Decoder {
    /** strm: the strm command, whose PCM fields describe raw data (a header, if any, wins). */
    constructor(strm) {
      super();
      this.bits = SIZES[strm.pcmSize] || 16; this.rate = RATES[strm.pcmRate] || 44100;
      this.channels = strm.pcmChannels === '1' ? 1 : 2; this.little = strm.pcmEndian !== '0';
      this.signed8 = false; this.float = false; this.dataLeft = Infinity; this.state = 'start'; this.kind = 'raw';
      this.skip = new Skipper();
    }
    get outBits() { return Math.min(this.bits, 24); }
    set outBits(v) { /* derived from bits */ }

    /** Walks the WAV/AIFF header. Chunks other than the format are skipped as they arrive. */
    _header() {
      for (;;) {
        if (this.skip.active) { this.skip.run(this.q); if (this.skip.active) return this.ended ? 'eof' : 'need'; }
        if (this.state === 'skipToData') { this.state = 'data'; return 'ok'; }
        const v = this.q.view();
        if (this.state === 'start') {
          if (v.length < 12) { if (!this.ended) return 'need'; this.state = 'data'; return 'ok'; }
          const tag = latin1(v.subarray(0, 4)), kind = latin1(v.subarray(8, 12));
          if (tag === 'RIFF' && kind === 'WAVE') this.kind = 'wav';
          else if (tag === 'FORM' && (kind === 'AIFF' || kind === 'AIFC')) { this.kind = kind === 'AIFC' ? 'aifc' : 'aiff'; this.little = false; this.signed8 = true; }
          else { this.state = 'data'; return 'ok'; }
          this.q.consume(12); this.state = 'chunks'; continue;
        }
        if (v.length < 8) return this.ended ? 'eof' : 'need';
        const id = latin1(v.subarray(0, 4));
        const wav = this.kind === 'wav';
        const len = wav ? le32(v, 4) : be32(v, 4);
        const padded = len + (len & 1);
        if (wav && id === 'fmt ') {
          if (v.length < 8 + Math.max(16, Math.min(len, 40))) return this.ended ? 'eof' : 'need';
          let tag = v[8] | (v[9] << 8);
          if (tag === 0xfffe && len >= 40 && latin1(v.subarray(34, 48)) === GUID_TAIL) tag = v[32] | (v[33] << 8);
          if (tag !== 1 && tag !== 3) throw new Error('Unsupported WAV format 0x' + tag.toString(16));
          this.float = tag === 3;
          this.channels = v[10] | (v[11] << 8);
          this.rate = le32(v, 12);
          this.bits = v[22] | (v[23] << 8);
          this.little = true;
        } else if (!wav && id === 'COMM') {
          if (v.length < 8 + 18 + (this.kind === 'aifc' ? 4 : 0)) return this.ended ? 'eof' : 'need';
          this.channels = be16(v, 8); this.bits = be16(v, 14);
          const exp = (be16(v, 16) & 0x7fff) - 16383, mant = be32(v, 18);   // 80-bit extended float
          this.rate = Math.round(mant * 2 ** (exp - 31));
          if (this.kind === 'aifc') {
            const type = latin1(v.subarray(26, 30));
            if (!/^(NONE|twos|sowt|fl32|FL32|fl64|FL64)$/.test(type)) throw new Error('Unsupported AIFC compression ' + type);
            this.little = type === 'sowt'; this.float = /^fl/i.test(type);
          }
        } else if (wav && id === 'data') {
          this.q.consume(8);
          this.dataLeft = len && len !== 0xffffffff ? len : Infinity;
          this.state = 'data'; return 'ok';
        } else if (!wav && id === 'SSND') {
          if (v.length < 16) return this.ended ? 'eof' : 'need';
          const offset = be32(v, 8);
          this.q.consume(16); this.skip.start(offset);
          this.dataLeft = len > 8 + offset ? len - 8 - offset : Infinity;
          this.state = 'skipToData'; continue;
        }
        this.q.consume(8); this.skip.start(padded);
      }
    }

    pump(maxBlocks = 16) {
      if (this.state === 'done' || this.aborted) return 'done';
      if (this.state !== 'data') {
        const h = this._header();
        if (h === 'need') return 'need';
        if (h === 'eof') { this.state = 'done'; return 'done'; }
      }
      // Samples of 12 or 20 bits sit left-justified in whole bytes, so read them as 16 or 24.
      if (this.bits % 8) this.bits += 8 - this.bits % 8;
      const bytesPer = this.bits / 8, frameBytes = bytesPer * this.channels;
      if (!frameBytes || (this.float ? bytesPer !== 4 && bytesPer !== 8 : bytesPer > 4)) {
        throw new Error(`Unsupported PCM: ${this.bits}-bit${this.float ? ' float' : ''}, ${this.channels} channels`);
      }
      for (let b = 0; b < maxBlocks; b++) {
        const avail = Math.min(this.q.length, this.dataLeft);
        let frames = Math.floor(avail / frameBytes);
        if (frames < 4096 && !this.ended && this.dataLeft > frames * frameBytes) return 'need';
        frames = Math.min(frames, BLOCK);
        if (frames === 0) {
          if (this.ended || this.dataLeft === 0) { this.state = 'done'; return 'done'; }
          return 'need';
        }
        this._emit(this.rate, this._convert(this.q.view(), frames));
        this.q.consume(frames * frameBytes);
        if (this.dataLeft !== Infinity) this.dataLeft -= frames * frameBytes;
      }
      return 'more';
    }

    _convert(v, frames) {
      const out = [];
      for (let c = 0; c < this.channels; c++) out.push(new Float32Array(frames));
      const scale = 1 / 2 ** (this.bits - 1), lit = this.little, bits = this.bits, bytesPer = bits / 8, s8 = this.signed8;
      let i = 0;
      if (this.float) {
        const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
        for (let f = 0; f < frames; f++) {
          for (let c = 0; c < this.channels; c++) { out[c][f] = bits === 32 ? dv.getFloat32(i, lit) : dv.getFloat64(i, lit); i += bytesPer; }
        }
        return out;
      }
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < this.channels; c++) {
          let s;
          if (bits === 16) s = lit ? (v[i] | (v[i + 1] << 8)) << 16 >> 16 : (v[i + 1] | (v[i] << 8)) << 16 >> 16;
          else if (bits === 24) s = lit ? (v[i] | (v[i + 1] << 8) | (v[i + 2] << 16)) << 8 >> 8 : (v[i + 2] | (v[i + 1] << 8) | (v[i] << 16)) << 8 >> 8;
          else if (bits === 32) s = lit ? (v[i] | (v[i + 1] << 8) | (v[i + 2] << 16) | (v[i + 3] << 24)) : (v[i + 3] | (v[i + 2] << 8) | (v[i + 1] << 16) | (v[i] << 24));
          else s = s8 ? (v[i] << 24 >> 24) : v[i] - 128;   // 8-bit: signed in AIFF, unsigned in WAV
          out[c][f] = s * scale; i += bytesPer;
        }
      }
      return out;
    }

    describe() { return this.state === 'data' ? `PCM ${this.bits}-bit${this.float ? ' float' : ''} ${this.rate / 1000} kHz` : ''; }
  }

  Object.assign(LJ, { PcmDecoder });
})(typeof globalThis !== 'undefined' ? globalThis : this);
