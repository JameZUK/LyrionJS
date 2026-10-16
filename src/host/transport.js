/* LyrionJS host: the connections the Slimproto player uses (core/player.js).
 *
 *   controlSocket()  Slimproto over the plugin's WebSocket, which pipes it to LMS's own port
 *                    and holds it for a short while across dropouts (docs/ARCHITECTURE.md).
 *   openStream()     an audio stream LMS asked for, fetched over HTTP with flow control.
 *
 * Browser APIs are passed in (env), so both run under Node in the tests. */
'use strict';
(function (G) {
  const LJ = G.LJ;

  const DEAD_MS = 20000;          // LMS talks to every player at least every 5 s
  const CONNECT_MS = 6000;        // a socket must open and say hello within this
  const STREAM_IDLE_MS = 30000;   // a stream with room to send that sends nothing is dead
  /** Close codes after which a session can't be resumed (docs/ARCHITECTURE.md). */
  const NO_RESUME = [1001, 1008, 1011, 1013, 4000, 4403, 4404];
  const BACKOFF = [250, 600, 1200, 2500];

  const isHeartbeat = (u8) => u8.length >= 12 && LJ.latin1(u8.subarray(0, 4)) === 'STAT' && LJ.latin1(u8.subarray(8, 12)) === 'STMt';

  function browserEnv() {
    return {
      WebSocket: G.WebSocket, fetch: (...a) => G.fetch(...a), now: () => G.performance.now(),
      setTimeout: (f, ms) => G.setTimeout(f, ms), clearTimeout: (t) => G.clearTimeout(t),
      setInterval: (f, ms) => G.setInterval(f, ms), clearInterval: (t) => G.clearInterval(t),
      document: G.document, origin: G.location && G.location.origin,
    };
  }

  /**
   * The Slimproto connection. A dropout that ends within the plugin's hold is invisible to the
   * player: the session resumes and what LMS sent meanwhile is replayed (marked as replayed).
   * Interface: { send(u8), close(), onopen, onresumed, ondata(u8, replayed), onclose(code) }.
   */
  function controlSocket(url, env = browserEnv(), diag = () => {}) {
    const c = { onopen: null, onresumed: null, ondata: null, onclose: null };
    let ws = null, session = null, received = 0, attached = false, closed = false;
    let outbox = [], lastRx = 0, gapSince = null, hold = 10, tries = 0, timer = null, connectTimer = null, replayLeft = 0;

    c.send = (u8) => {
      if (attached && ws && ws.readyState === 1) { ws.send(u8); return; }
      // Away: keep what LMS must hear (track started, decoder done…); never heartbeats.
      if (session && !isHeartbeat(u8)) { outbox.push(u8); if (outbox.length > 500) outbox.shift(); }
    };
    c.close = () => { if (closed) return; closed = true; teardown(); if (ws) { const w = ws; ws = null; try { w.close(1000); } catch (e) { /* closed */ } } };

    function teardown() {
      env.clearTimeout(timer); env.clearTimeout(connectTimer); env.clearInterval(watch);
      if (env.document) env.document.removeEventListener('visibilitychange', onVisible);
    }

    function open() {
      if (closed) return;
      attached = false;
      const me = ws = new env.WebSocket(url);
      me.binaryType = 'arraybuffer';
      // A socket that never opens, or opens and never says hello (a phone changing networks),
      // would otherwise wait for the OS's TCP timeout: minutes, far beyond the hold.
      env.clearTimeout(connectTimer);
      connectTimer = env.setTimeout(() => { if (me === ws && !attached) drop('no answer'); }, CONNECT_MS);
      me.onopen = () => me.send(JSON.stringify(session
        ? { resume: { session: session.session, secret: session.secret, received } } : { hello: 1 }));
      me.onmessage = (e) => {
        if (me !== ws) return;
        lastRx = env.now();
        if (typeof e.data === 'string') return greeting(e.data);
        let u8 = new Uint8Array(e.data);
        received += u8.length;
        if (replayLeft > 0) {
          const n = Math.min(replayLeft, u8.length);
          replayLeft -= n;
          if (c.ondata) c.ondata(u8.subarray(0, n), true);
          u8 = u8.subarray(n);
          if (replayLeft === 0 && c.onresumed) c.onresumed();
          if (!u8.length) return;
        }
        if (c.ondata) c.ondata(u8, false);
      };
      me.onclose = (e) => { if (me === ws) gone(e.code); };
      me.onerror = () => {};
    }

    function greeting(text) {
      let m; try { m = JSON.parse(text); } catch (e) { return; }
      if (!m || !m.session) return;
      env.clearTimeout(connectTimer);
      const resumed = !!m.resumed && !!session && m.session === session.session;
      session = m; hold = +m.hold || 10; attached = true; tries = 0; gapSince = null;
      if (resumed) {
        const q = outbox; outbox = [];
        for (const f of q) ws.send(f);
        replayLeft = +m.replay || 0;
        diag('socket', `resumed: ${replayLeft} bytes replayed, ${q.length} held frames sent`);
        if (!replayLeft && c.onresumed) c.onresumed();
      } else {
        received = 0; outbox = []; replayLeft = 0;
        if (c.onopen) c.onopen();
      }
    }

    function gone(code) {
      attached = false; ws = null;
      env.clearTimeout(connectTimer);
      if (closed) return;
      if (gapSince == null) gapSince = env.now();
      const within = env.now() - gapSince < (hold - 1.5) * 1000;
      if (session && within && !NO_RESUME.includes(code)) {
        const wait = BACKOFF[Math.min(tries++, BACKOFF.length - 1)];
        diag('socket', `dropped (${code}); resuming in ${wait} ms`);
        env.clearTimeout(timer);
        timer = env.setTimeout(open, wait);
        return;
      }
      diag('socket', `session over (${code})`);
      session = null; outbox = []; closed = true;
      teardown();
      if (c.onclose) c.onclose(code);
    }

    // A socket that has heard nothing for 20 s is dead even if nobody said so: abandon it.
    function drop(why) {
      if (!ws) return;
      const w = ws; ws = null;
      w.onclose = null; w.onmessage = null; w.onopen = null;
      try { w.close(); } catch (e) { /* closed */ }
      diag('socket', 'dropping the socket: ' + why);
      gone(1006);
    }
    const watch = env.setInterval(() => { if (attached && env.now() - lastRx > DEAD_MS) drop('silent'); }, 2000);
    const onVisible = () => { if (env.document && !env.document.hidden && attached && env.now() - lastRx > DEAD_MS) drop('silent while hidden'); };
    if (env.document) env.document.addEventListener('visibilitychange', onVisible);
    open();
    return c;
  }

  /**
   * An audio stream LMS asked the player to fetch. With no server address (LMS itself, which
   * is always the case for proxied streams) it is fetched from this origin; otherwise the
   * browser tries that address, which works only where the server allows cross-site requests.
   * Reading pauses while `win` bytes are delivered but not yet acknowledged as consumed.
   * Interface: { send(requestBytes), ack(n), close(), onopen, ondata(u8), onclose(clean) }.
   */
  function openStream({ ip, port, win }, env = browserEnv(), diag = () => {}) {
    const s = { onopen: null, ondata: null, onclose: null };
    const ctrl = new AbortController();
    let delivered = 0, acked = 0, wake = null, done = false;
    const kick = () => { if (wake) { const w = wake; wake = null; w(); } };
    s.ack = (n) => { acked = Math.max(acked, n); if (delivered - acked < win) kick(); };
    s.close = () => { if (done) return; done = true; ctrl.abort(); kick(); };
    s.send = (req) => { run(LJ.latin1(req)).catch((e) => { diag('stream', 'failed: ' + (e && e.message || e)); end(false); }); };
    const end = (clean) => { if (!done) { done = true; ctrl.abort(); kick(); if (s.onclose) s.onclose(clean); } };

    async function run(text) {
      const lines = text.split('\r\n');
      const m = lines[0].match(/^(GET|POST)\s+(\S+)\s+HTTP/i);
      if (!m) return end(false);
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim(), kl = k.toLowerCase();
        // Browsers set these themselves; a cross-site request carries only what's allowed.
        if (['host', 'connection', 'user-agent', 'accept-encoding', 'cache-control', 'referer'].includes(kl)) continue;
        if (ip && kl !== 'range') continue;
        headers[k] = line.slice(i + 1).trim();
      }
      const url = ip ? `http://${ip}:${port}${m[2]}` : new URL(m[2], env.origin).href;
      let res;
      try {
        res = await env.fetch(url, { method: m[1].toUpperCase(), headers, signal: ctrl.signal, cache: 'no-store',
          credentials: ip ? 'omit' : 'same-origin', mode: ip ? 'cors' : 'same-origin' });
      } catch (e) {
        if (!done) diag('stream', `${ip ? 'direct stream ' + ip + ':' + port : 'stream'} failed: ${e.message}`);
        return end(false);
      }
      if (done) return;
      // The response head, as a player would have read it off the socket (for RESP).
      let head = `HTTP/1.1 ${res.status} ${res.statusText || 'OK'}\r\n`;
      res.headers.forEach((v, k) => { head += `${k}: ${v}\r\n`; });
      const hb = new TextEncoder().encode(head + '\r\n');
      delivered += hb.length;
      s.ondata(hb);
      if (!res.body) return end(true);
      const reader = res.body.getReader();
      let lastByte = env.now();
      const idle = env.setInterval(() => {
        // Room to send but nothing arrives: the connection died without telling us.
        if (!done && delivered - acked < win && env.now() - lastByte > STREAM_IDLE_MS) { diag('stream', 'stalled; giving up'); end(false); }
      }, 5000);
      try {
        for (;;) {
          while (!done && delivered - acked >= win) { await new Promise((r) => { wake = r; }); lastByte = env.now(); }
          if (done) { reader.cancel().catch(() => {}); return; }
          let r;
          try { r = await reader.read(); } catch (e) { return end(false); }
          if (r.done) return end(true);
          lastByte = env.now();
          delivered += r.value.length;
          if (!done) s.ondata(r.value);
        }
      } finally {
        env.clearInterval(idle);
      }
    }
    env.setTimeout(() => { if (!done && s.onopen) s.onopen(); }, 0);   // the core sets its handlers first
    return s;
  }

  Object.assign(LJ, { controlSocket, openStream, browserEnv, NO_RESUME });
})(typeof globalThis !== 'undefined' ? globalThis : this);
