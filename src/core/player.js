/* LyrionJS core: the Slimproto player. Behaves towards LMS like squeezelite: it opens the
 * streams LMS asks for, decodes them, keeps the output fed and reports what is being heard.
 * Sans-I/O: the host supplies the control connection, streams, the output and the clock.
 *
 * Status events sent (STAT): STMc stream connecting, STMs track started (heard), STMd decoder
 * done (LMS then sends the next track), STMu played out, STMo output underrun, STMl loaded
 * (autostart off), STMp paused, STMr resumed, STMf flushed, STMt heartbeat, STMn can't play. */
'use strict';
(function (G) {
  const LJ = G.LJ;
  const { ByteQueue, concat, latin1, clientFrame, buildHelo, buildStat, parseStrm, parseAudg, parseHttpHead,
    nextServerFrame, ipString, IcyStripper } = LJ;
  const te = new TextEncoder();
  const td = new TextDecoder('utf-8', { fatal: false });

  const STREAM_WINDOW = 2 * 1024 * 1024;   // compressed bytes in flight per stream
  const DECODE_AHEAD_S = 10;                // seconds of PCM kept queued at the output
  const HEARTBEAT_MS = 1000;
  const MAX_HEAD = 64 * 1024;               // the HTTP response head of a stream
  const MAX_CORRECTION_MS = 10000;          // LMS sends at most 10 s pause/skip corrections
  const MAX_START_AHEAD_MS = 30000;         // a timed start further ahead isn't a real one
  const ACK_EVERY = 32 * 1024;

  /** DSCO reasons (why a stream ended). */
  const DSCO = { CLOSED: 0, RESET: 1, REMOTE_RESET: 2, UNREACHABLE: 3, TIMEOUT: 4 };

  /** One stream LMS asked for, from connecting to its last sample. */
  class Track {
    constructor(seq, s, decoder) {
      this.seq = seq; this.format = s.format; this.autostart = s.autostart;
      this.threshold = s.threshold * 1024; this.gain = s.replayGain ? s.replayGain / 65536 : 1;
      this.decoder = decoder; this.stream = null; this.icy = null;
      this.head = new Uint8Array(0); this.headBytes = 0; this.bytes = 0; this.acked = 0; this.frames = 0;
      this.streamOpen = false;    // the stream may still deliver bytes
      this.headersDone = false;
      this.decoded = false;       // every sample has gone to the output (or never will)
      this.reported = false;      // LMS has had STMd (or STMn) for it
      this.dead = false;          // dropped: nothing more is played or reported
      this.describe = '';
    }
    /** Close the stream without reporting it (we chose to). */
    closeStream() {
      if (this.stream && this.streamOpen) { this.streamOpen = false; try { this.stream.close(); } catch (e) { /* closed */ } }
      this.streamOpen = false;
    }
    /** Drop for good: network closed, decoder aborted, nothing more reported. */
    kill() {
      this.closeStream(); this.dead = true; this.decoded = true; this.reported = true;
      if (this.decoder && this.decoder.abort) this.decoder.abort();
    }
  }

  class SlimPlayer {
    /**
     * opts: {
     *   mac: Uint8Array(6), uuid?: Uint8Array(16), name: string,
     *   openControl(): control, openStream({ip, port, win}): stream, output, now(): ms,
     *   caps: string[], maxRate: number, decoders: { [format]: (strm) => decoder },
     *   decodeAhead?: s, pumpBudget?: n, noTimer?: bool, log?: fn }
     * control: { send(u8), close(), onopen (a new session: send HELO), onresumed (the same session
     *            after a gap), ondata(u8, replayed), onclose (the session is over) }
     * stream:  { send(u8), ack(n), close(), onopen, ondata(u8), onclose(clean) }
     * output:  { push(seq, rate, chans, bits), endSeq(seq), play(), pause(), startAt(ms), pauseFor(ms),
     *            skip(ms), flush(), trimAfter(seq), setGain(g), setMute(b), queuedSeconds(),
     *            audible(nowMs) -> {seq, ms} | null, underrun, rate, onReport }
     *   now() must be monotonic and the output's own clock: it is also the jiffies.
     */
    constructor(opts) {
      this.mac = opts.mac; this.uuid = opts.uuid; this.name = opts.name;
      this.openControl = opts.openControl; this.openStream = opts.openStream;
      this.output = opts.output; this.now = opts.now; this.caps = opts.caps || []; this.maxRate = opts.maxRate || 96000;
      this.decoders = opts.decoders || {}; this.decodeAhead = opts.decodeAhead || DECODE_AHEAD_S;
      this.pumpBudget = opts.pumpBudget || 12; this.noTimer = !!opts.noTimer; this.log = opts.log || (() => {});
      this.onStat = null; this.onStrm = null;

      this.state = 'stopped';   // stopped | waiting | loaded | playing | paused
      this.tracks = [];
      this.seq = 0; this.ctl = null; this.connected = false; this.everConnected = false;
      this.audibleSeq = null; this.stmsSent = new Set(); this.stmuSent = true; this.stmoSent = false;
      this.lastStat = 0; this.backoff = 1000; this.serverVersion = ''; this.gain = 1; this.enabled = true;
      this.listeners = new Set(); this.stopped = true; this.pumping = false; this.pumpQueued = false; this.lastError = '';
      this.rx = new ByteQueue(8192); this.rxIn = 0; this.rxPos = 0; this.replayEnd = 0;
      this.output.onReport = () => this.tick();
    }

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(what) { for (const fn of this.listeners) { try { fn(what, this); } catch (e) { this.log('listener', e); } } }

    start() {
      this.stopped = false; this._connect();
      if (!this.timer && G.setInterval && !this.noTimer) this.timer = G.setInterval(() => this.tick(), 100);
    }
    stop() {
      this.stopped = true; this._flush();
      if (this.ctl) { this._send(clientFrame('BYE!', new Uint8Array([0]))); try { this.ctl.close(); } catch (e) { /* closed */ } }
      this.ctl = null; this.connected = false;
      if (this.timer) { G.clearInterval(this.timer); this.timer = null; }
    }

    capabilities() {
      return ['Model=squeezelite', 'ModelName=LyrionJS', 'AccuratePlayPoints=1', 'HasDigitalOut=0',
        'HasPolarityInversion=0', 'Balance=0', 'Firmware=lyrionjs', 'MaxSampleRate=' + this.maxRate].concat(this.caps).join(',');
    }

    // -- the control connection -------------------------------------------------

    _connect() {
      const t = this.openControl();
      this.ctl = t;
      // The same session after a gap: LMS never saw us leave. Tell it where we are now (held
      // heartbeats are never sent: LMS re-bases its clock on each one).
      t.onresumed = () => { if (this.ctl === t) { this.connected = true; this._stat('STMt'); this.emit('connected'); } };
      t.onopen = () => {
        if (this.ctl !== t) return;
        // A new session: anything left of a frame from the old one is meaningless now.
        this.rx.clear(); this.rxIn = this.rxPos = this.replayEnd = 0;
        this.connected = true; this.backoff = 1000;
        const cur = this.tracks[this.tracks.length - 1];
        this._send(buildHelo({ mac: this.mac, uuid: this.uuid, reconnect: this.everConnected && this.state !== 'stopped',
          bytesReceived: cur ? cur.bytes : 0, caps: this.capabilities() }));
        this.everConnected = true; this.emit('connected');
      };
      t.ondata = (d, replayed) => {
        if (this.ctl !== t) return;
        this.rx.push(d); this.rxIn += d.length;
        if (replayed) this.replayEnd = this.rxIn;
        this._control();
      };
      t.onclose = () => {
        if (this.ctl !== t) return;
        this.connected = false; this.emit('disconnected');
        if (this.stopped) return;
        const wait = this.backoff; this.backoff = Math.min(this.backoff * 2, 15000);
        G.setTimeout(() => { if (!this.stopped && this.ctl === t) this._connect(); }, wait);
      };
    }

    _send(frame) { if (this.ctl && this.connected) this.ctl.send(frame); }

    _control() {
      for (;;) {
        const before = this.rx.length, start = this.rxPos;
        const f = nextServerFrame(this.rx);
        if (!f) return;
        this.rxPos += before - this.rx.length;
        if (!f.op) continue;   // skipped (malformed or oversize)
        // A frame that began in the replayed bytes describes the past.
        const replayed = start < this.replayEnd;
        try { this._handle(f.op, f.payload, replayed); } catch (e) { this.log('handling ' + f.op, e); }
      }
    }

    _handle(op, p, replayed) {
      switch (op) {
        case 'strm': this._strm(parseStrm(p), replayed); break;
        case 'audg': { const a = parseAudg(p); this.gain = (a.left + a.right) / 2; this.output.setGain(this.gain); this.emit('volume'); break; }
        case 'aude': this.enabled = p.length > 1 ? p[1] !== 0 : true; this.output.setMute(!this.enabled); this.emit('power'); break;
        case 'setd':
          if (p[0] === 0) {
            if (p.length === 1) this._send(clientFrame('SETD', concat(new Uint8Array([0]), te.encode(this.name + '\0'))));
            else { this.name = td.decode(p.subarray(1)).replace(/\0[\s\S]*$/, ''); this.emit('name'); }
          }
          break;
        case 'vers': this.serverVersion = latin1(p); break;
        case 'serv': break;   // stay on the server the user chose
        default: break;       // display, IR, visualiser: not for a headless player
      }
    }

    // -- status -------------------------------------------------------------

    _elapsed(now) {
      if (this.state !== 'playing' && this.state !== 'paused') return 0;
      const a = this.output.audible(now);
      return a && a.seq === this.audibleSeq ? a.ms : 0;
    }

    _stat(event, serverTs = 0) {
      const now = this.now();
      const cur = this.tracks[this.tracks.length - 1];
      const rate = this.output.rate || 44100;
      this._send(buildStat({
        event, bufSize: STREAM_WINDOW, bufFull: cur && cur.decoder ? Math.min(cur.decoder.buffered, STREAM_WINDOW) : 0,
        bytesReceived: cur ? cur.bytes : 0, jiffies: Math.floor(now),
        outSize: this.decodeAhead * rate * 8, outFull: Math.floor(this.output.queuedSeconds() * rate * 8),
        elapsedMs: this._elapsed(now), serverTs,
      }));
      this.lastStat = now;
      if (this.onStat) this.onStat(event);
    }

    // -- stream commands ----------------------------------------------------

    _strm(s, replayed) {
      if (this.onStrm) this.onStrm(s);
      if (replayed) {
        // Sent while we were away: corrections and polls describe a moment already past, and
        // applied late they would make the player jump. A timed start becomes "start now".
        if (s.command === 'a' || s.command === 't' || (s.command === 'p' && s.replayGain !== 0)) return;
        if (s.command === 'u') s = Object.assign({}, s, { replayGain: 0 });
      }
      switch (s.command) {
        case 's': this._startTrack(s); break;
        case 'p':
          if (s.replayGain === 0) {
            if (this.state !== 'stopped') { this.state = 'paused'; this.output.pause(); }
            this._stat('STMp'); this.emit('state');
          } else if (this.state === 'playing') {
            this.output.pauseFor(Math.min(s.replayGain, MAX_CORRECTION_MS));   // a sync correction
          }
          break;
        case 'u': {
          if (this.tracks.length) {
            const now = this.now();
            const ahead = (s.replayGain - Math.floor(now)) | 0;   // a time in our jiffies (wraps at 2^32)
            if (s.replayGain !== 0 && ahead > 0 && ahead <= MAX_START_AHEAD_MS) this.output.startAt(now + ahead);
            else this.output.play();
            this.state = 'playing'; this.stmuSent = false;
          }
          this._stat('STMr'); this.emit('state');
          break;
        }
        case 'q': this._flush(); this._stat('STMf'); this.emit('state'); break;
        case 'f': {
          // The next track (already streamed) was moved or deleted: drop what came after the
          // audible track, and carry on playing it.
          const keep = this.audibleSeq;
          if (keep == null) this._flush();
          else {
            for (const t of this.tracks) if (t.seq > keep) t.kill();
            this.tracks = this.tracks.filter((t) => t.seq <= keep);
            this.output.trimAfter(keep);
          }
          this._stat('STMf'); break;
        }
        case 't': this._stat('STMt', s.replayGain); break;
        case 'a': if (this.state === 'playing') this.output.skip(Math.min(s.replayGain, MAX_CORRECTION_MS)); break;
        default: break;
      }
    }

    _startTrack(s) {
      const seq = ++this.seq;
      // A new stream while one is still arriving replaces it. What it already decoded still
      // plays; it is never reported (LMS has moved on). A finished stream still decoding is the
      // previous track playing out (gapless), and carries on.
      for (const t of this.tracks) if (t.streamOpen) { t.kill(); this.output.endSeq(t.seq); }
      const make = this.decoders[s.format];
      const track = new Track(seq, s, make ? make(s) : null);
      this.tracks.push(track);
      this.stmuSent = false; this.stmoSent = false; this.lastError = '';
      if (!track.decoder) {
        track.decoded = track.reported = true;
        this.lastError = 'Unsupported format ' + s.format;
        this._stat('STMn'); return;
      }
      const dec = track.decoder;
      dec.onError = (msg) => { this.lastError = msg; };
      dec.onBlock = (rate, chans) => {
        if (track.dead) return;   // late output from an asynchronous decoder
        if (track.gain !== 1) for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= track.gain;
        track.frames += chans[0].length;
        this.output.push(seq, rate, chans, dec.outBits || 16);
      };
      dec.onFinished = () => this.pump();
      // Server address 0 means LMS itself (always the case for proxied streams).
      const st = this.openStream({ ip: s.serverIp ? ipString(s.serverIp) : null, port: s.serverPort, win: STREAM_WINDOW });
      track.stream = st; track.streamOpen = true;
      st.onopen = () => st.send(s.request);
      st.ondata = (d) => { if (!track.dead) this._streamData(track, d); };
      st.onclose = (clean) => {
        if (!track.streamOpen || track.dead) return;
        track.streamOpen = false;
        if (!track.headersDone) this.lastError = 'Stream failed';
        dec.end();
        this._send(clientFrame('DSCO', new Uint8Array([clean ? DSCO.CLOSED : DSCO.REMOTE_RESET])));
        this.pump();
      };
      this._stat('STMc');
      if (this.state === 'stopped') this.state = 'waiting';
      this.emit('track');
    }

    _streamData(track, d) {
      if (!track.headersDone) {
        track.head = concat(track.head, d);
        const h = parseHttpHead(track.head);
        if (!h) { if (track.head.length > MAX_HEAD) this._failTrack(track, 'Stream sent no HTTP response'); return; }
        track.headersDone = true;
        track.headBytes = h.headLen;   // header bytes count as consumed for flow control
        this._send(clientFrame('RESP', h.raw));
        if (h.status >= 400) { this._failTrack(track, 'Stream refused: HTTP ' + h.status); return; }
        const metaint = +(h.headers['icy-metaint'] || 0);
        if (metaint > 0) track.icy = new IcyStripper(metaint);
        d = track.head.subarray(h.headLen); track.head = null;
        if (!d.length) return;
      }
      track.bytes += d.length;
      if (track.icy) track.icy.feed(d, (a) => track.decoder.feed(a), (m) => this._send(clientFrame('META', m)));
      else track.decoder.feed(d);
      this.pump();
    }

    /** A stream or decoder that can't be played: tell LMS, as squeezelite does, so it moves on. */
    _failTrack(track, why) {
      this.lastError = why;
      const wasOpen = track.streamOpen;
      track.kill();
      this.output.endSeq(track.seq);
      if (wasOpen) this._send(clientFrame('DSCO', new Uint8Array([DSCO.REMOTE_RESET])));
      this._stat('STMn');
    }

    _ack(track) {
      if (!track.stream || !track.streamOpen) return;
      const consumed = track.headBytes + track.bytes - track.decoder.buffered;
      if (consumed - track.acked >= ACK_EVERY || (track.decoder.buffered === 0 && consumed > track.acked)) {
        track.acked = consumed; track.stream.ack(consumed);
      }
    }

    _flush() {
      for (const t of this.tracks) t.kill();
      this.tracks = []; this.output.flush(); this.state = 'stopped'; this.audibleSeq = null;
      this.stmuSent = true; this.stmoSent = false;
    }

    // -- decoding -------------------------------------------------------------

    /** Decode while the output wants audio, a bounded amount per call. */
    pump() {
      if (this.pumping) return;
      this.pumping = true;
      let again = false;
      try {
        let budget = this.pumpBudget;
        while (this.output.queuedSeconds() < this.decodeAhead) {
          if (budget-- <= 0) { again = true; break; }
          const t = this.tracks.find((x) => !x.decoded);
          if (!t) break;
          let r;
          try { r = t.decoder.pump(16); }
          catch (e) { this.log('decoder', e); this._failTrack(t, 'Decoding failed: ' + (e && e.message || e)); continue; }
          this._ack(t);
          if (!t.describe && t.decoder.describe) t.describe = t.decoder.describe() || '';
          if (r === 'done') { t.decoded = true; this.output.endSeq(t.seq); this._readyForNext(); continue; }
          if (r === 'need') break;
        }
        this._autostart();
      } finally { this.pumping = false; }
      if (again && !this.pumpQueued) { this.pumpQueued = true; G.setTimeout(() => { this.pumpQueued = false; this.pump(); }, 0); }
    }

    /**
     * STMd ("decoder done": LMS then sends the next track) goes only once the track has been
     * heard. LMS takes the next STMs to mean the newest stream started, so if a short stream
     * (the tail after a seek) finished decoding before its audio was audible, LMS would move
     * on to the next track too early. A track that produced no audio at all goes at once.
     */
    _readyForNext() {
      for (const t of this.tracks) {
        if (!t.decoded || t.reported || t.dead) continue;
        if (this.stmsSent.has(t.seq) || !t.frames) { t.reported = true; this._stat('STMd'); }
      }
    }

    _autostart() {
      if (this.state !== 'waiting') return;
      const t = this.tracks[this.tracks.length - 1];
      if (!t) return;
      const ready = (t.bytes >= t.threshold || !t.streamOpen || t.decoded) && this.output.queuedSeconds() > 0;
      if (!ready) return;
      if (t.autostart === '1' || t.autostart === '3') { this.state = 'playing'; this.output.play(); this.emit('state'); }
      else { this.state = 'loaded'; this._stat('STMl'); this.emit('state'); }
    }

    /** Runs on a timer and on every output report. */
    tick() {
      const now = this.now();
      if (this.state === 'playing' || this.state === 'paused') {
        const a = this.output.audible(now);
        if (a && a.seq != null && a.seq !== this.audibleSeq) {
          this.audibleSeq = a.seq;
          if (!this.stmsSent.has(a.seq)) { this.stmsSent.add(a.seq); this._stat('STMs'); this._readyForNext(); }
          // Tracks heard to the end are no longer of interest.
          this.tracks = this.tracks.filter((t) => t.seq >= a.seq || !t.decoded);
          for (const seq of this.stmsSent) if (seq < a.seq) this.stmsSent.delete(seq);
          this.emit('track');
        }
        if (this.state === 'playing' && this.output.underrun) {
          const allDone = this.tracks.every((t) => t.decoded);
          if (allDone && !this.stmuSent) {
            this.stmuSent = true; this.state = 'stopped'; this._stat('STMu'); this.audibleSeq = null; this.emit('state');
          } else if (!allDone && !this.stmoSent && this.audibleSeq != null) {
            this.stmoSent = true; this._stat('STMo');
          }
        } else if (!this.output.underrun) {
          this.stmoSent = false;
        }
        if (this.state === 'playing' && now - this.lastStat >= HEARTBEAT_MS) this._stat('STMt');
      }
      this.pump();
    }

    /** What the UI shows about the local player. */
    snapshot() {
      const now = this.now();
      const a = this.output.audible(now);
      const t = this.tracks.find((x) => x.seq === (a && a.seq)) || this.tracks[this.tracks.length - 1];
      return {
        state: this.state, connected: this.connected, elapsedMs: this._elapsed(now), format: t ? t.describe : '',
        queued: this.output.queuedSeconds(), gain: this.gain, enabled: this.enabled, error: this.lastError,
      };
    }
  }

  Object.assign(LJ, { SlimPlayer, Track, STREAM_WINDOW, DECODE_AHEAD_S, DSCO });
})(typeof globalThis !== 'undefined' ? globalThis : this);
