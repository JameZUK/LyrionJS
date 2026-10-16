/* LyrionJS app: the browser host for the core (byte tunnels through the relay, Web Audio
 * output) and the whole user interface. Metadata is only ever inserted as text. */
'use strict';
(function () {
  const LJ = window.LJ;
  const VERSION = '0.1.0';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('lj.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('lj.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }

  const ICONS = {
    play: 'M8 5v14l11-7z', pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z', stop: 'M6 6h12v12H6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z', prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    repeat1: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
    volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    queue: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
    search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    album: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z',
    artist: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    genre: 'M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z',
    year: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z',
    star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    playlist: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z',
    fav: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    radio: 'M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 2 2 2h16c1.11 0 2-.9 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z',
    apps: 'M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z',
    speaker: 'M17 2H7c-1.1 0-2 .9-2 2v16c0 1.1.9 1.99 2 1.99L17 22c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5 2c1.1 0 2 .9 2 2s-.9 2-2 2c-1.11 0-2-.9-2-2s.89-2 2-2zm0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
    alarm: 'M22 5.72l-4.6-3.86-1.29 1.53 4.6 3.86L22 5.72zM7.88 3.39L6.6 1.86 2 5.71l1.29 1.53 4.59-3.85zM12.5 8H11v6l4.75 2.85.75-1.23-4-2.37V8zM12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
    power: 'M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42C17.99 7.86 19 9.81 19 12c0 3.87-3.13 7-7 7s-7-3.13-7-7c0-2.19 1.01-4.14 2.58-5.42L6.17 5.17C4.23 6.82 3 9.26 3 12c0 4.97 4.03 9 9 9s9-4.03 9-9c0-2.74-1.23-5.18-3.17-6.83z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    next_up: 'M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z',
    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    drag: 'M20 9H4v2h16V9zM4 15h16v-2H4v2z',
    sync: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
    sleep: 'M12.34 2.02C6.59 1.82 2 6.42 2 12c0 5.52 4.48 10 10 10 3.71 0 6.93-2.02 8.66-5.02-7.51-.25-12.09-8.43-8.32-14.96z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    laptop: 'M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    refresh: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    save: 'M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    up: 'M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z', down: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
    note: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
    random: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM7.5 18c-.83 0-1.5-.67-1.5-1.5S6.67 15 7.5 15s1.5.67 1.5 1.5S8.33 18 7.5 18zm0-9C6.67 9 6 8.33 6 7.5S6.67 6 7.5 6 9 6.67 9 7.5 8.33 9 7.5 9zm4.5 4.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5 4.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm0-9c-.83 0-1.5-.67-1.5-1.5S15.67 6 16.5 6s1.5.67 1.5 1.5S17.33 9 16.5 9z',
    info: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  };
  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', ICONS[name] || ICONS.note);
    svg.append(p); return svg;
  }
  const btn = (name, label, onclick, cls) => h('button', { class: 'ib' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label, onclick }, icon(name));

  function fmtTime(s) {
    s = Math.max(0, Math.floor(+s || 0));
    const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  let toastTimer;
  function toast(msg, kind) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 2600);
  }
  function fail(e) { console.error(e); toast(e && e.message ? e.message : String(e), 'err'); }

  // Diagnostics: what the player does goes to the relay's log, so problems on devices without
  // developer tools (iPad, phones) can be seen. Settings › Send diagnostics turns it off.
  const diagBuf = [];
  let serverConfig = {};   // the plugin's settings (config.json), read at boot
  function diag(kind, msg) {
    if (!store.get('diag', !!serverConfig.clientDiagnostics)) return;
    diagBuf.push(`${(performance.now() / 1000).toFixed(2)} ${kind}: ${msg}`);
    if (diagBuf.length > 400) diagBuf.splice(0, diagBuf.length - 400);
  }
  function flushDiag() {
    if (!diagBuf.length) return;
    const lines = diagBuf.splice(0, diagBuf.length);
    const id = (window.LyrionJS && window.LyrionJS.S.localId) || '-';
    fetch('/plugins/LyrionJS/log', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, lines }) }).catch(() => {});
  }
  setInterval(flushDiag, 2000);
  window.addEventListener('pagehide', flushDiag);
  window.addEventListener('error', (e) => diag('error', `${e.message} @${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', (e) => diag('error', 'unhandled: ' + (e.reason && e.reason.message || e.reason)));
  for (const lvl of ['error', 'warn']) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => { diag(lvl, a.map((x) => (x && x.message) || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')); orig(...a); };
  }
  diag('boot', `${navigator.userAgent} | AudioWorklet ${typeof AudioWorkletNode} | WebCodecs ${typeof AudioDecoder} | audioSession ${navigator.audioSession ? navigator.audioSession.type : 'none'}`);

  // ---------------------------------------------------------------------------
  // Transport. LMS serves this page (through the LyrionJS plugin, or the dev relay), so
  // everything is same-origin: JSON-RPC and audio over HTTP, and Slimproto over the plugin's
  // WebSocket, which is a plain byte pipe to LMS's Slimproto port with a short hold for
  // dropouts. Protocol: docs/ARCHITECTURE.md.
  // ---------------------------------------------------------------------------
  const PLUGIN = '/plugins/LyrionJS/';
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + PLUGIN + 'ws';
  const DEAD_MS = 20000;            // LMS talks to every player at least every 5 s
  const NO_RESUME = [1001, 1008, 1011, 1013, 4000, 4403, 4404];

  const isHeartbeat = (u8) => u8.length >= 12 && LJ.latin1(u8.subarray(0, 4)) === 'STAT' && LJ.latin1(u8.subarray(8, 12)) === 'STMt';

  /** The Slimproto connection: hides dropouts that end within the plugin's hold. */
  function controlSocket() {
    const c = { onopen: null, onresumed: null, ondata: null, onclose: null };
    let ws = null, session = null, received = 0, attached = false, closed = false;
    let outbox = [], lastRx = 0, gapSince = 0, hold = 10, tries = 0, timer = null, replayLeft = 0;

    c.send = (u8) => {
      if (attached && ws && ws.readyState === 1) { ws.send(u8); return; }
      // Away: keep what LMS must hear (track started, decoder done, …); never heartbeats.
      if (session && !isHeartbeat(u8)) { outbox.push(u8); if (outbox.length > 500) outbox.shift(); }
    };
    c.close = () => {
      closed = true; clearTimeout(timer); clearInterval(watch);
      document.removeEventListener('visibilitychange', onVisible);
      if (ws) { const w = ws; ws = null; try { w.close(1000); } catch (e) { /* closed */ } }
    };

    function open() {
      if (closed) return;
      attached = false;
      const me = ws = new WebSocket(WS_URL);
      me.binaryType = 'arraybuffer';
      me.onopen = () => me.send(JSON.stringify(session
        ? { resume: { session: session.session, secret: session.secret, received } } : { hello: 1 }));
      me.onmessage = (e) => {
        if (me !== ws) return;
        lastRx = performance.now();
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
      const resumed = !!m.resumed && !!session && m.session === session.session;
      session = m; hold = +m.hold || 10; attached = true; tries = 0; gapSince = 0;
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
      if (closed) return;
      if (!gapSince) gapSince = performance.now();
      const within = performance.now() - gapSince < (hold - 1.5) * 1000;
      if (session && within && !NO_RESUME.includes(code)) {
        const wait = [250, 600, 1200, 2500][Math.min(tries++, 3)];
        diag('socket', `dropped (${code}); resuming in ${wait} ms`);
        timer = setTimeout(open, wait);
        return;
      }
      diag('socket', `session over (${code})`);
      session = null; outbox = [];
      closed = true; clearInterval(watch);
      if (c.onclose) c.onclose(code);
    }

    // A socket that has heard nothing for 20 s is dead even if nobody said so (a phone
    // changed networks, a tablet slept): abandon it and resume.
    function drop(why) {
      if (!ws) return;
      const w = ws; ws = null;
      w.onclose = null; w.onmessage = null;
      try { w.close(); } catch (e) { /* closed */ }
      diag('socket', 'dead socket: ' + why);
      gone(1006);
    }
    const watch = setInterval(() => { if (attached && performance.now() - lastRx > DEAD_MS) drop('silent'); }, 2000);
    const onVisible = () => { if (!document.hidden && attached && performance.now() - lastRx > DEAD_MS) drop('silent while hidden'); };
    document.addEventListener('visibilitychange', onVisible);
    open();
    return c;
  }

  /**
   * An audio stream LMS asked the player to fetch. With no server address (LMS itself, which
   * is always the case for proxied streams) it is fetched from this origin; otherwise the
   * browser tries the address itself, which works only where that server allows cross-site
   * requests. Reading pauses while `win` bytes are delivered but not yet decoded.
   */
  function openStream({ ip, port, win }) {
    const s = { onopen: null, ondata: null, onclose: null };
    const ctrl = new AbortController();
    let delivered = 0, acked = 0, wake = null, done = false;
    const kick = () => { if (wake) { const w = wake; wake = null; w(); } };
    s.ack = (n) => { acked = Math.max(acked, n); if (delivered - acked < win) kick(); };
    s.close = () => { done = true; ctrl.abort(); kick(); };
    s.send = (req) => { run(LJ.latin1(req)); };
    const end = (clean) => { if (!done) { done = true; if (s.onclose) s.onclose(clean); } };

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
      const url = ip ? `http://${ip}:${port}${m[2]}` : new URL(m[2], location.origin).href;
      let res;
      try {
        res = await fetch(url, { method: m[1].toUpperCase(), headers, signal: ctrl.signal, cache: 'no-store',
          credentials: ip ? 'omit' : 'same-origin', mode: ip ? 'cors' : 'same-origin' });
      } catch (e) {
        if (!done) diag('stream', `${ip ? 'direct stream ' + ip + ':' + port : 'stream'} failed: ${e.message}`);
        return end(false);
      }
      // The response head, as a player would have read it off the socket (for RESP).
      let head = `HTTP/1.1 ${res.status} ${res.statusText || 'OK'}\r\n`;
      res.headers.forEach((v, k) => { head += `${k}: ${v}\r\n`; });
      const hb = new TextEncoder().encode(head + '\r\n');
      delivered += hb.length;
      if (done) return;
      s.ondata(hb);
      const reader = res.body.getReader();
      for (;;) {
        while (!done && delivered - acked >= win) await new Promise((r) => { wake = r; });
        if (done) { reader.cancel().catch(() => {}); return; }
        let r;
        try { r = await reader.read(); } catch (e) { return end(false); }
        if (r.done) return end(true);
        delivered += r.value.length;
        if (!done) s.ondata(r.value);
      }
    }
    setTimeout(() => { if (!done && s.onopen) s.onopen(); }, 0); // the core sets its handlers first
    return s;
  }

  // ---------------------------------------------------------------------------
  // Audio output: one AudioContext per sample rate, an AudioWorklet doing the work.
  // ---------------------------------------------------------------------------
  const WORKLET_SRC = document.getElementById('lj-worklet').textContent;

  /** Streaming 4-point (Catmull-Rom) resampler. The last 4 input samples of each chunk are
   *  carried in `st`, so chunk boundaries are seamless. Only used when the browser can't open
   *  an output at the track's own rate (iPad after the first track). */
  function resampleCubic(chans, from, to, st) {
    const TAIL = 4, ratio = from / to, n = chans[0].length;
    if (!st.tail || st.tail.length !== chans.length) { st.tail = chans.map(() => new Float32Array(TAIL)); st.pos = TAIL; }
    const maxX = n + TAIL - 3; // floor(x) + 2 must stay inside the extended buffer
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
   * The output stage on the main thread, driven by a ScriptProcessorNode: for pages served over
   * plain http, where browsers don't offer AudioWorklet. It is the same LyrionOutputCore class
   * the worklet runs (the worklet script also runs as an ordinary script on this page), with the
   * same messages, so the rest of the player can't tell the difference. Each callback renders a
   * buffer that will be heard at e.playbackTime, so the frame clock is that time in frames.
   */
  function mainThreadOutput(ctx) {
    let frame = 0;
    // Two ends of a channel; output -> page is delivered asynchronously, as from a worklet.
    const mainPort = { onmessage: null, postMessage: (m) => { if (procPort.onmessage) procPort.onmessage({ data: m }); } };
    const procPort = { onmessage: null, postMessage: (m) => queueMicrotask(() => mainPort.onmessage && mainPort.onmessage({ data: m })) };
    const core = new window.LyrionOutputCore(procPort, () => frame);
    const sp = ctx.createScriptProcessor(8192, 1, 2);
    sp.onaudioprocess = (e) => {
      frame = Math.round(e.playbackTime * ctx.sampleRate);
      const ob = e.outputBuffer;
      core.process([], [[ob.getChannelData(0), ob.getChannelData(1)]]);
    };
    sp.connect(ctx.destination);
    return { port: mainPort, sp, core };
  }

  function waitRunning(ctx, ms) {
    if (ctx.state === 'running') return Promise.resolve(true);
    return new Promise((res) => {
      const t = setTimeout(() => res(ctx.state === 'running'), ms);
      ctx.onstatechange = () => { if (ctx.state === 'running') { clearTimeout(t); res(true); } };
    });
  }

  class WebOutput {
    constructor() {
      this.ctx = null; this.node = null; this.rate = 0; this.srcRate = 0; this.creating = null;
      this.pending = []; this.posts = []; this.postId = 0; this.epoch = 0;
      this.rep = null; this.segStarts = []; this.gain = 1; this.muted = false; this.trim = store.get('localTrim', 1);
      this.playing = false; this.onReport = null; this.onState = null; this.url = null; this.lastTick = 0;
      this.rs = { pos: 0, last: [] };
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
      return this.playing && !this.creating && this.pending.length === 0 && this.posts.length === 0 &&
        (!this.rep || this.rep.queued <= 0);
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
      let l = chans[0], r = chans[1] || null;
      const own = (a) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice());
      l = own(l); if (r) r = own(r);
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
        // A new sample rate: let the current context play out, then open one at the new rate.
        if (this.ctx && this.queuedFrames() > 0) return;
        if (this.ctx && this.singleContext) {
          // This browser won't start a new context without a tap (iPad): keep this one, resample.
          this.srcRate = p.rate; this.rs = {}; diag('output', `resampling ${p.rate} -> ${this.rate}`); continue;
        }
        this._create(p.rate); return;
      }
    }
    /** Called from a user gesture: open (or resume) the output now, while the browser allows it. */
    prime() {
      if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume().then(() => this.onState && this.onState(), () => {}); return; }
      if (!this.creating) this._create(store.get('outRate', 44100), true);
    }
    async _create(rate, priming) {
      let done;
      this.creating = new Promise((r) => { done = r; });
      try {
        let ctx;
        try { ctx = new AudioContext({ sampleRate: rate, latencyHint: 'playback' }); }
        catch (e) { ctx = new AudioContext({ latencyHint: 'playback' }); }
        // Resume at once: inside a tap this is what lets Safari start the context.
        ctx.resume().catch(() => {});
        const old = this.ctx;
        if (old && old.state === 'running' && !(await waitRunning(ctx, 500))) {
          // A new context needs another tap here; keep the running one and resample into it.
          ctx.close().catch(() => {});
          this.singleContext = true; this.srcRate = rate; this.rs = {};
          diag('output', `new ${rate} Hz context would not start; resampling into ${this.rate} Hz`);
          return;
        }
        if (old) { this.ctx = null; this.node = null; old.close().catch(() => {}); }
        this.rep = null; this.segStarts = []; this.posts = []; this.rs = {};
        let node;
        if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
          if (!this.url) this.url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
          await ctx.audioWorklet.addModule(this.url);
          node = new AudioWorkletNode(ctx, 'lyrionjs-output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          node.connect(ctx.destination);
          this.engine = 'AudioWorklet';
        } else {
          // AudioWorklet exists only on HTTPS (or localhost) pages. Over plain http on the LAN,
          // run the very same output code on the main thread through a ScriptProcessorNode.
          node = mainThreadOutput(ctx);
          this.engine = 'ScriptProcessor';
        }
        node.port.onmessage = (e) => this._msg(e.data);
        node.port.postMessage({ t: 'flush', epoch: this.epoch });
        this.ctx = ctx; this.node = node; this.rate = ctx.sampleRate; this.srcRate = rate;
        store.set('outRate', rate);
        this._applyGain(true);
        if (this.playing) node.port.postMessage({ t: 'play' });
        ctx.onstatechange = () => { diag('output', 'context ' + ctx.state); if (this.onState) this.onState(); };
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        this.failedAt = 0;
        diag('output', `context open (${this.engine}): asked ${rate} Hz, got ${ctx.sampleRate} Hz, ${ctx.state}${priming ? ' (primed by a tap)' : ''}`);
      } catch (e) {
        // Never retry straight away: a failure here used to recurse until the stack overflowed.
        this.failedAt = performance.now();
        diag('error', 'audio output: ' + (e && e.message || e));
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
    play() { this.playing = true; if (this.node) this.node.port.postMessage({ t: 'play' }); }
    pause() { this.playing = false; if (this.node) this.node.port.postMessage({ t: 'pause' }); }
    startAt(ms) {
      this.playing = true;
      if (!this.node) return;
      this.node.port.postMessage({ t: 'startAt', frame: Math.round(this._ctxTimeAt(ms) * this.rate) });
    }
    pauseFor(ms) { if (this.node) this.node.port.postMessage({ t: 'pauseFor', frames: Math.round(ms * this.rate / 1000) }); }
    skip(ms) { if (this.node) this.node.port.postMessage({ t: 'skip', frames: Math.round(ms * this.rate / 1000) }); }
    flush() {
      this.epoch++; this.pending = []; this.posts = []; this.rep = null; this.segStarts = []; this.playing = false;
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
    setTrim(t) { this.trim = t; store.set('localTrim', t); this._applyGain(); }
    _applyGain(now) { if (this.node) this.node.port.postMessage({ t: 'gain', g: this.muted ? 0 : this.gain * this.trim, now: !!now }); }
    audible(nowMs) {
      if (!this.ctx || !this.rep) return null;
      const t = Math.min(this._ctxTimeAt(nowMs), this.ctx.currentTime);
      const fa = t * this.rate;
      let s = null;
      for (const x of this.segStarts) if (x.frame <= fa) s = x;
      if (!s) return null;
      const rep = this.rep;
      let frames;
      if (s.seq === rep.seq) frames = rep.playing ? rep.pos - Math.max(0, rep.frame - fa) : rep.pos;
      else frames = fa - s.frame;
      return { seq: s.seq, ms: Math.max(0, frames) * 1000 / this.rate };
    }
    info() {
      const c = this.ctx;
      return c ? { rate: c.sampleRate, state: c.state, latency: Math.round(((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000) } : null;
    }
  }

  async function detectMaxRate() {
    for (const r of [192000, 96000]) {
      try { const c = new AudioContext({ sampleRate: r }); const ok = c.sampleRate === r; c.close().catch(() => {}); if (ok) return r; }
      catch (e) { /* not supported */ }
    }
    return 48000;
  }

  /** 'webcodecs' (streaming, exact), 'chunks' (decodeAudioData fallback) or '' (no MP3). */
  async function detectMp3() {
    if (LJ.Mp3Decoder.supported()) {
      try { const r = await AudioDecoder.isConfigSupported({ codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 }); if (r.supported) return 'webcodecs'; }
      catch (e) { /* fall through */ }
    }
    return typeof OfflineAudioContext === 'function' ? 'chunks' : '';
  }
  function decodeWithBrowser(bytes, rate, channels) {
    const ctx = new OfflineAudioContext(channels, 1, rate);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return ctx.decodeAudioData(buf).then((b) => { const out = []; for (let c = 0; c < b.numberOfChannels; c++) out.push(b.getChannelData(c)); return out; });
  }

  // ---------------------------------------------------------------------------
  // LMS JSON-RPC (through the relay's proxy, so same-origin)
  // ---------------------------------------------------------------------------
  class LMS {
    constructor() { this.base = '/'; }
    async rpc(player, cmd, timeout = 20000) {
      const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetch(this.base + 'jsonrpc.js', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ id: 1, method: 'slim.request', params: [player || '', cmd.map((x) => String(x))] }),
        });
        if (!r.ok) throw new Error('LMS answered ' + r.status);
        const j = await r.json();
        return j.result || {};
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('LMS did not answer in time');
        throw e;
      } finally { clearTimeout(tm); }
    }
    url(path) { return this.base + String(path).replace(/^\//, ''); }
    art(src, size = 300) {
      if (!src) return null;
      src = String(src);
      if (/^https?:\/\//i.test(src)) return this.base + 'imageproxy/' + encodeURIComponent(src) + `/image_${size}x${size}_f`;
      if (/^data:/.test(src)) return null;
      src = src.replace(/^\//, '');
      if (/^music\/[^/]+\/cover$/.test(src)) src += `_${size}x${size}_f`;
      return this.base + src;
    }
    cover(id, size = 300) { return id == null || id === '' ? null : this.base + `music/${encodeURIComponent(id)}/cover_${size}x${size}_f`; }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const S = {
    server: null, lms: null, players: [], target: store.get('target', null), status: null, statusAt: 0,
    local: null, localId: null, output: null, outputMode: '', nav: [], syncgroups: [], localStatus: null,
    serverInfo: null, polling: false, lastPlaylistTs: null, ownsPlayer: false, autoTarget: !store.get('target', null),
  };

  function macBytes() {
    let mac = store.get('mac', null);
    if (!/^02:4c:4a(:[0-9a-f]{2}){3}$/.test(mac || '')) {
      const r = crypto.getRandomValues(new Uint8Array(3));
      mac = ['02', '4c', '4a', ...[...r].map((b) => b.toString(16).padStart(2, '0'))].join(':');
      store.set('mac', mac);
    }
    return { str: mac, bytes: new Uint8Array(mac.split(':').map((x) => parseInt(x, 16))) };
  }

  function defaultName() {
    const ua = navigator.userAgent;
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    // iPadOS Safari claims to be a Mac; touch support gives it away.
    const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const os = /Android/.test(ua) ? 'Android' : ipad ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return `LyrionJS ${b}${os ? ' on ' + os : ''}`;
  }

  const rpc = (cmd, player = S.target) => S.lms.rpc(player, cmd);
  const isLocal = (id) => id && id === S.localId;
  const playerName = (id) => { const p = S.players.find((x) => x.playerid === id); return p ? p.name : (isLocal(id) ? (S.local ? S.local.name : 'This browser') : 'No player'); };

  async function act(cmd, msg, player) {
    try { await rpc(cmd, player); if (msg) toast(msg); pollSoon(); }
    catch (e) { fail(e); }
  }

  // ---------------------------------------------------------------------------
  // The local Slimproto player
  // ---------------------------------------------------------------------------
  /**
   * Which output this device should use. Phones and tablets get the media element (it keeps
   * playing with the screen locked) if a self-test shows the browser plays our FLAC-in-MP4;
   * everything else, or a failed test, gets Web Audio. Settings can force either.
   */
  async function chooseOutput() {
    const want = store.get('outputMode', (S.config && S.config.defaultOutput) || 'auto');
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const mobile = ios || /Android/.test(ua);
    let mode = 'webaudio', why = 'desktop browser';
    if (want === 'webaudio') why = 'chosen in Settings';
    else if (want === 'media' || mobile) {
      const ok = LJ.mediaSupported() && await LJ.selfTest();
      if (ok) { mode = 'media'; why = want === 'media' ? 'chosen in Settings' : (ios ? 'iPhone/iPad' : 'Android') + ': keeps playing with the screen locked'; }
      else why = 'this browser cannot play FLAC through a media element' + (ios ? ' (iOS 17.1 or later needed); keep the screen on' : '');
    }
    diag('output', `mode ${mode} (${why}); ios=${ios} mobile=${mobile} mms=${!!window.ManagedMediaSource} mse=${!!window.MediaSource}`);
    S.outputMode = mode; S.outputWhy = why;
    if (mode === 'media') {
      const o = new LJ.MediaOutput(document.getElementById('lj-audio'), { diag });
      o.trim = store.get('localTrim', 1);
      // The OS paused us (a call, another app, headphones out): tell LMS, as a Squeezebox would.
      o.externalPause = () => { if (S.local && S.local.state === 'playing') act(['pause', 1], null, S.localId); };
      return o;
    }
    return new WebOutput();
  }

  async function startLocalPlayer() {
    if (S.local || !S.server) return;
    if (!store.get('localEnabled', true)) return;
    const mac = macBytes();
    S.localId = mac.str;
    if (!S.output) S.output = await chooseOutput();
    const [maxRate, mp3] = await Promise.all([S.outputMode === 'media' ? Promise.resolve(192000) : detectMaxRate(), detectMp3()]);
    const caps = ['flc', 'pcm'].concat(mp3 ? ['mp3'] : []);
    const uuid = new Uint8Array(16); uuid.set(mac.bytes, 0);
    // Earlier versions named iPads "… on macOS" (iPadOS Safari reports a Mac).
    // Earlier test builds were misspelt "LyrianJS", and named iPads "… on macOS".
    const oldName = store.get('name', '');
    if (/^LyrianJS /.test(oldName) || (oldName === 'LyrionJS Safari on macOS' && defaultName() !== oldName)) store.set('name', defaultName());
    const p = new LJ.SlimPlayer({
      mac: mac.bytes, uuid, name: store.get('name', defaultName()),
      openControl: controlSocket, openStream, output: S.output, now: () => performance.now(), caps, maxRate,
      decoders: { f: () => new LJ.FlacDecoder(), p: (s) => new LJ.PcmDecoder(s),
        m: mp3 === 'webcodecs' ? () => new LJ.Mp3Decoder() : mp3 === 'chunks' ? () => new LJ.Mp3ChunkDecoder(decodeWithBrowser) : null },
      // Without AudioWorklet the output shares the main thread: decode in smaller slices.
      pumpBudget: window.AudioWorkletNode && window.isSecureContext ? 12 : 3,
      // A locked phone runs the page's code only now and then: keep more decoded ahead.
      decodeAhead: S.outputMode === 'media' ? 30 : 10,
      log: (...a) => console.warn('[slimproto]', ...a),
    });
    if (!mp3) delete p.decoders.m;
    p.caps = caps; p.maxRateFound = maxRate;
    p.on((what) => {
      if (what === 'name') store.set('name', p.name);
      if (what === 'state' || what === 'track' || what === 'connected') { pollSoon(150); refreshUnlock(); }
      if (what === 'connected') {
        setTimeout(pollPlayers, 400);
        if (!S.pluginMenus || !S.pluginMenus.length) setTimeout(loadPluginMenus, 800);
        // Where the page can't set the volume (iOS), the device's buttons do: hold LMS at 100 %.
        if (S.output.volumeLocked && Math.abs(p.gain - 1) > 0.01) act(['mixer', 'volume', 100], null, S.localId);
      }
      renderLocalBadge();
    });
    S.local = p;
    S.output.onState = refreshUnlock;
    p.onStat = (ev) => { if (ev !== 'STMt') diag('stat', `${ev} state=${p.state}`); };
    p.onStrm = (s) => { if (s.command !== 't') diag('strm', `${s.command} autostart=${s.autostart} format=${s.format} threshold=${s.threshold} arg=${s.replayGain}`); };
    diag('player', `${p.name} ${mac.str} caps=${caps.join(',')} mp3=${mp3 || 'none'} maxRate=${maxRate} secure=${window.isSecureContext}`);
    setInterval(() => {
      if (p.state === 'stopped') return;
      const o = S.output, t = p.tracks.find((x) => !x.decodeDone) || p.tracks[p.tracks.length - 1];
      const out = o.el ? `el ${o.el.paused ? 'paused' : 'playing'} t=${o.el.currentTime.toFixed(2)} end=${o.writer.end.toFixed(2)} q=${o.queue.length} unlocked=${o.unlocked}`
        : `ctx=${o.ctx ? o.ctx.state + '@' + o.rate : 'none'} src=${o.srcRate} rep=${o.rep ? `pos ${o.rep.pos} q ${o.rep.queued} playing ${o.rep.playing} under ${o.rep.under}` : 'none'} pending=${o.pending.length} posts=${o.posts.length}`;
      diag('snap', `state=${p.state} conn=${p.connected} queued=${o.queuedSeconds().toFixed(1)}s ${out} ` +
        `track=${t ? `#${t.seq} ${t.format} bytes ${t.bytes} buf ${t.decoder ? t.decoder.buffered : '-'} ended ${t.streamEnded} done ${t.decodeDone} ${t.describe}` : 'none'} err=${p.lastError || '-'}`);
    }, 3000);
    p.start();
    window.addEventListener('pagehide', () => { try { p.stop(); } catch (e) { /* closing */ } });
  }

  function stopLocalPlayer() {
    if (!S.local) return;
    S.local.stop(); S.local = null; renderLocalBadge();
  }

  /** Only one tab per browser may be the player: two would share a MAC and fight. */
  function claimPlayerThenStart() {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('lyrionjs-player', { ifAvailable: true }, (lock) => {
        if (!lock) { S.ownsPlayer = false; S.localId = macBytes().str; toast('Another tab is this browser\'s player; this one is a remote control.'); return null; }
        S.ownsPlayer = true;
        startLocalPlayer();
        return new Promise(() => {}); // hold the lock for the life of the tab
      });
    } else { S.ownsPlayer = true; startLocalPlayer(); }
  }

  function refreshUnlock() {
    const el = document.getElementById('unlock');
    const need = S.local && S.output && S.output.needsGesture && ['playing', 'waiting', 'loaded', 'paused'].includes(S.local.state);
    el.hidden = !need;
  }
  function renderLocalBadge() {
    const el = document.getElementById('localBadge');
    if (!el) return;
    el.textContent = '';
    if (!S.local) { el.append('Browser player off'); el.className = 'badge off'; return; }
    const snap = S.local.snapshot();
    el.className = 'badge ' + (snap.connected ? 'on' : 'warn');
    el.append(snap.connected ? `${S.local.name} · ${snap.state}` : 'Connecting to LMS…');
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------
  const STATUS_TAGS = 'tags:aAlcdejJKNoqrstuyITRx';
  let pollTimer = null, pollCount = 0;

  function pollSoon(ms = 250) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }

  async function poll() {
    clearTimeout(pollTimer);
    if (!S.lms) return;
    try {
      if (S.target) {
        const st = await rpc(['status', '-', 1, STATUS_TAGS]);
        S.status = st; S.statusAt = performance.now();
        if (st.playlist_timestamp !== S.lastPlaylistTs) { S.lastPlaylistTs = st.playlist_timestamp; emitPlaylistChanged(); }
        updateNowPlaying();
      }
      if (pollCount++ % 5 === 0) await pollPlayers();
      if (S.local && S.local.state === 'playing' && !isLocal(S.target) && pollCount % 3 === 0) {
        S.localStatus = await S.lms.rpc(S.localId, ['status', '-', 1, STATUS_TAGS]);
      } else if (isLocal(S.target)) S.localStatus = S.status;
      updateMediaSession();
      setConn(true);
    } catch (e) {
      setConn(false, e.message);
    }
    pollTimer = setTimeout(poll, document.hidden ? 5000 : 1000);
  }

  async function pollPlayers() {
    const r = await S.lms.rpc('', ['players', 0, 100]);
    S.players = (r.players_loop || []).filter((p) => +p.connected || isLocal(p.playerid) || p.playerid === S.target);
    // First run: control this browser's own player once LMS has it.
    if (S.autoTarget && S.players.some((p) => isLocal(p.playerid))) { S.autoTarget = false; if (!isLocal(S.target)) setTarget(S.localId, true); }
    if (!S.target || !S.players.some((p) => p.playerid === S.target)) {
      const want = S.players.find((p) => isLocal(p.playerid)) || S.players[0];
      if (want && want.playerid !== S.target) setTarget(want.playerid, true);
    }
    try { const sg = await S.lms.rpc('', ['syncgroups', '?']); S.syncgroups = sg.syncgroups_loop || []; } catch (e) { S.syncgroups = []; }
    renderPlayerButton();
    if (S.onPlayers) S.onPlayers();
  }

  function setConn(ok, msg) {
    const el = document.getElementById('conn');
    el.hidden = ok; if (!ok) el.textContent = 'Lost contact with the server: ' + (msg || '') + ' — retrying…';
  }

  function setTarget(id, auto) {
    if (!auto) S.autoTarget = false;
    S.target = id; store.set('target', id); S.status = null; S.lastPlaylistTs = null;
    renderPlayerButton(); updateNowPlaying(); pollSoon(10);
    loadPluginMenus();
  }

  const playlistListeners = new Set();
  function emitPlaylistChanged() { for (const f of playlistListeners) f(); }

  // ---------------------------------------------------------------------------
  // Now playing model
  // ---------------------------------------------------------------------------
  function current(st = S.status) {
    if (!st) return null;
    const t = (st.playlist_loop || [])[0] || {};
    const rm = st.remoteMeta || {};
    const remote = !!(+t.remote || +st.remote);
    const title = t.title || rm.title || st.current_title || '';
    return {
      title, artist: t.artist || t.trackartist || t.albumartist || rm.artist || '', album: t.album || rm.album || '',
      artistId: t.artist_id, albumId: t.album_id, id: t.id, url: t.url, remote,
      stationTitle: remote && st.current_title && st.current_title !== title ? st.current_title : '',
      duration: +st.duration || +t.duration || 0, type: t.type, bitrate: t.bitrate, samplerate: t.samplerate, samplesize: t.samplesize,
      year: t.year, coverid: t.coverid, artwork: t.artwork_url,
    };
  }
  function elapsedNow() {
    const st = S.status; if (!st) return 0;
    let t = +st.time || 0;
    if (st.mode === 'play') t += (performance.now() - S.statusAt) / 1000 * (+st.rate || 1);
    const d = +st.duration || 0;
    return d ? Math.min(t, d) : t;
  }
  function nowArt(size) {
    const st = S.status; if (!st || !S.target) return null;
    const c = current(st);
    if (c && c.artwork && !/^\/?music\/current/.test(c.artwork)) { const u = S.lms.art(c.artwork, size); if (u) return u; }
    if (c && c.coverid) return S.lms.cover(c.coverid, size);
    return S.lms.url(`music/current/cover_${size}x${size}_f?player=${encodeURIComponent(S.target)}&t=${encodeURIComponent(st.playlist_timestamp || '')}`);
  }
  function qualityLabel(c) {
    if (!c) return '';
    const parts = [];
    if (c.type) parts.push(String(c.type).toUpperCase());
    if (c.samplesize && c.samplerate) parts.push(`${c.samplesize}/${(c.samplerate / 1000).toFixed(c.samplerate % 1000 ? 1 : 0)}`);
    else if (c.bitrate) parts.push(String(c.bitrate).replace(/\s*kbps.*/i, ' kb/s'));
    return parts.join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Common UI pieces
  // ---------------------------------------------------------------------------
  function artEl(src, fallback = 'note', cls = '') {
    const box = h('div', { class: 'art ' + cls }, icon(fallback, 'ph'));
    if (src) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', src });
      img.onload = () => box.classList.add('loaded');
      img.onerror = () => img.remove();
      box.append(img);
    }
    return box;
  }

  function sheet(title, items, opts = {}) {
    closeSheet();
    const wrap = document.getElementById('sheet');
    const list = h('div', { class: 'sheet-list' });
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { list.append(h('div', { class: 'sheet-sep' })); continue; }
      if (it.el) { list.append(it.el); continue; }
      list.append(h('button', { class: 'sheet-item' + (it.checked ? ' checked' : '') + (it.danger ? ' danger' : ''), onclick: async () => { if (!it.keepOpen) closeSheet(); try { await it.run(); } catch (e) { fail(e); } } },
        icon(it.icon || 'play'), h('span', { text: it.label }), it.checked ? icon('check', 'tick') : null));
    }
    const panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' }, opts.art ? artEl(opts.art, opts.artIcon || 'note', 'sm') : null,
        h('div', { class: 'sheet-title' }, h('div', { class: 't1', text: title }), opts.sub ? h('div', { class: 't2', text: opts.sub }) : null),
        btn('close', 'Close', closeSheet)),
      list);
    wrap.append(h('div', { class: 'sheet-scrim', onclick: closeSheet }), panel);
    wrap.hidden = false;
    requestAnimationFrame(() => wrap.classList.add('open'));
  }
  function closeSheet() { const w = document.getElementById('sheet'); w.classList.remove('open'); w.hidden = true; w.textContent = ''; }

  function prompt2(title, { value = '', placeholder = '', ok = 'OK', type = 'text' } = {}) {
    return new Promise((resolve) => {
      closeSheet();
      const input = h('input', { class: 'field', type, value, placeholder, 'aria-label': title });
      const form = h('form', { class: 'prompt', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); closeSheet(); resolve(v || null); } },
        input, h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => { closeSheet(); resolve(null); } }, 'Cancel'), h('button', { class: 'btn', type: 'submit' }, ok)));
      sheet(title, [{ el: form }]);
      setTimeout(() => input.focus(), 50);
    });
  }
  function confirm2(title, okLabel = 'Delete') {
    return new Promise((resolve) => {
      sheet(title, [
        { label: okLabel, icon: 'delete', danger: true, run: () => resolve(true) },
        { label: 'Cancel', icon: 'close', run: () => resolve(false) },
      ]);
    });
  }

  /** A lazily loaded list or grid. fetch(start, count) -> {items, total}. */
  function lazyList({ fetch, render, grid = false, empty = 'Nothing here.', page = 100 }) {
    const box = h('div', { class: grid ? 'grid' : 'list' });
    const sentinel = h('div', { class: 'sentinel' });
    const wrap = h('div', { class: 'lazy' }, box, sentinel);
    let start = 0, total = Infinity, loading = false, idx = 0;
    async function more() {
      if (loading || start >= total) return;
      loading = true; sentinel.classList.add('busy');
      try {
        const r = await fetch(start, page);
        total = r.total == null ? (r.items.length < page ? start + r.items.length : Infinity) : r.total;
        for (const it of r.items) { const el = render(it, idx++); if (el) box.append(el); }
        start += r.items.length;
        if (!r.items.length) total = start;
        if (start === 0) box.append(h('div', { class: 'empty', text: empty }));
      } catch (e) { fail(e); total = start; }
      loading = false; sentinel.classList.remove('busy');
      if (start < total && sentinel.getBoundingClientRect().top < window.innerHeight + 600) more();
    }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { rootMargin: '600px' });
    io.observe(sentinel);
    wrap.reload = () => { box.textContent = ''; start = 0; total = Infinity; idx = 0; more(); };
    more();
    return wrap;
  }

  function row({ art, artIcon = 'note', title, sub, right, onclick, menu, cls = '', num, draggable }) {
    const r = h('div', { class: 'row ' + cls, tabindex: onclick ? 0 : null, role: onclick ? 'button' : null },
      num != null ? h('div', { class: 'num', text: num }) : (art !== undefined ? artEl(art, artIcon, 'sm') : null),
      h('div', { class: 'meta' }, h('div', { class: 't1', text: title || '' }), sub ? h('div', { class: 't2', text: sub }) : null),
      right != null ? h('div', { class: 'right', text: right }) : null,
      menu ? btn('more', 'More', (e) => { e.stopPropagation(); menu(); }, 'more') : null);
    if (onclick) {
      r.addEventListener('click', onclick);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter') onclick(e); });
    }
    if (menu) r.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(); });
    if (draggable) r.draggable = true;
    return r;
  }

  function card({ art, artIcon = 'album', title, sub, onclick, menu, round }) {
    const c = h('div', { class: 'card' + (round ? ' round' : ''), tabindex: 0, role: 'button' },
      artEl(art, artIcon, 'lg'),
      h('div', { class: 't1', text: title || '' }), sub ? h('div', { class: 't2', text: sub }) : null,
      menu ? btn('more', 'More', (e) => { e.stopPropagation(); menu(); }, 'more') : null);
    c.addEventListener('click', onclick);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') onclick(e); });
    if (menu) c.addEventListener('contextmenu', (e) => { e.preventDefault(); menu(); });
    return c;
  }

  // ---------------------------------------------------------------------------
  // Actions on library items
  // ---------------------------------------------------------------------------
  const QUAL = { artist: 'artist_id', album: 'album_id', track: 'track_id', genre: 'genre_id', playlist: 'playlist_id', folder: 'folder_id', year: 'year' };

  function pc(cmd, kind, id, extra = []) {
    const q = `${QUAL[kind]}:${id}`;
    const msgs = { load: 'Playing', insert: 'Playing next', add: 'Added to the queue' };
    return act(['playlistcontrol', 'cmd:' + cmd, q, ...extra], msgs[cmd]);
  }
  async function playShuffled(kind, id) {
    try { await rpc(['playlist', 'shuffle', 1]); await rpc(['playlistcontrol', 'cmd:load', `${QUAL[kind]}:${id}`]); toast('Playing shuffled'); pollSoon(); }
    catch (e) { fail(e); }
  }

  function libMenu(kind, it, extra = []) {
    const name = it.title || it.album || it.artist || it.playlist || it.genre || it.year || it.filename || '';
    const items = [
      { label: 'Play now', icon: 'play', run: () => pc('load', kind, it.id) },
      { label: 'Play next', icon: 'next_up', run: () => pc('insert', kind, it.id) },
      { label: 'Add to queue', icon: 'add', run: () => pc('add', kind, it.id) },
    ];
    if (kind !== 'track') items.push({ label: 'Shuffle', icon: 'shuffle', run: () => playShuffled(kind, it.id) });
    if (kind === 'track' || kind === 'album') {
      if (it.artist_id) items.push({ label: 'Go to artist', icon: 'artist', run: () => push('artist', { id: it.artist_id, name: it.artist }) });
      if (kind === 'track' && it.album_id) items.push({ label: 'Go to album', icon: 'album', run: () => push('album', { id: it.album_id, title: it.album, artist: it.artist, artist_id: it.artist_id }) });
    }
    if (kind === 'track' && it.url) items.push({ label: 'Add to playlist…', icon: 'playlist', run: () => addToPlaylist([it.url]) });
    if (it.favorites_url || (kind === 'track' && it.url)) items.push({ label: 'Add to favourites', icon: 'fav', run: () => act(['favorites', 'add', 'url:' + (it.favorites_url || it.url), 'title:' + (it.favorites_title || name)], 'Added to favourites', '') });
    if (kind === 'artist') items.push({ label: 'Start artist mix', icon: 'random', run: () => act(['playlistcontrol', 'cmd:load', 'artist_id:' + it.id], 'Playing') });
    const info = contextMenu(kind, it);
    if (info) items.push({ label: 'More…', icon: 'more', run: () => push('jive', { action: info, title: name }) });
    sheet(name, items.concat(extra), { sub: it.artist && kind !== 'artist' ? it.artist : (kind === 'track' && it.album ? it.album : null), art: it.art });
  }

  async function addToPlaylist(urls) {
    try {
      const r = await rpc(['playlists', 0, 500], '');
      const lists = r.playlists_loop || [];
      sheet('Add to playlist', [
        { label: 'New playlist…', icon: 'add', run: async () => {
          const name = await prompt2('New playlist', { placeholder: 'Name', ok: 'Create' });
          if (!name) return;
          const nr = await rpc(['playlists', 'new', 'name:' + name], '');
          const id = nr.playlist_id || nr.overwritten_playlist_id;
          for (const u of urls) await rpc(['playlists', 'edit', 'cmd:add', 'playlist_id:' + id, 'url:' + u], '');
          toast('Added to ' + name);
        } },
        { sep: true },
        ...lists.map((p) => ({ label: p.playlist, icon: 'playlist', run: async () => {
          for (const u of urls) await rpc(['playlists', 'edit', 'cmd:add', 'playlist_id:' + p.id, 'url:' + u], '');
          toast('Added to ' + p.playlist);
        } })),
      ]);
    } catch (e) { fail(e); }
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  const VIEWS = {};
  const NAV = [
    ['now', 'Now playing', 'note'], ['queue', 'Queue', 'queue'], ['search', 'Search', 'search'], null,
    ['artists', 'Artists', 'artist'], ['albums', 'Albums', 'album'], ['genres', 'Genres', 'genre'], ['years', 'Years', 'year'],
    ['newmusic', 'New music', 'star'], ['folders', 'Music folder', 'folder'], ['playlists', 'Playlists', 'playlist'], null,
    ['favourites', 'Favourites', 'fav'], ['radio', 'Radio', 'radio'], ['apps', 'Apps', 'apps'], ['random', 'Random mix', 'random'], null,
    ['players', 'Players', 'speaker'], ['alarms', 'Alarms', 'alarm'], ['settings', 'Settings', 'settings'],
  ];

  function renderNav() {
    const nav = document.getElementById('nav');
    nav.textContent = '';
    const close = () => document.body.classList.remove('nav-open');
    NAV.forEach((n, i) => {
      if (!n) {
        nav.append(h('div', { class: 'nav-sep' }));
        // After the library: what plugins add to LMS's "My Music" (AudioMuse-AI, Custom Browse…).
        if (i === 11 && S.pluginMenus && S.pluginMenus.length) {
          for (const m of S.pluginMenus) {
            const art = jiveArt(m, 48);
            nav.append(h('button', { class: 'nav-item', 'data-view': 'jive:' + m.id, title: m.text,
              onclick: () => { root('jive', { action: m.actions.go, title: m.text, navId: 'jive:' + m.id }); close(); } },
            art ? h('img', { class: 'ic nav-img', src: art, alt: '' }) : icon('apps'), h('span', { text: m.text })));
          }
          nav.append(h('div', { class: 'nav-sep' }));
        }
        return;
      }
      nav.append(h('button', { class: 'nav-item', 'data-view': n[0], onclick: () => { root(n[0]); close(); } }, icon(n[2]), h('span', { text: n[1] })));
    });
    if (S.nav[0]) markNav(navKey(S.nav[0]));
  }
  const navKey = (e) => (e.params && e.params.navId) || e.name;
  function markNav(name) { for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === name); }

  function show(entry) {
    const main = document.getElementById('view');
    for (const e of S.nav) if (e !== entry && e.page && e.page.onHide) e.page.onHide();
    main.textContent = '';
    if (!entry.page) entry.page = VIEWS[entry.name](entry.params || {});
    const p = entry.page;
    const head = h('div', { class: 'view-head' },
      S.nav.length > 1 ? btn('back', 'Back', back) : null,
      h('h1', { text: p.title || '' }),
      h('div', { class: 'view-actions' }, p.actions || []));
    main.append(head, p.el);
    if (p.onShow) p.onShow();
    main.scrollTop = entry.scroll || 0;
    markNav(S.nav[0] && navKey(S.nav[0]));
    document.title = (p.title ? p.title + ' · ' : '') + 'LyrionJS';
  }
  function saveScroll() { const top = S.nav[S.nav.length - 1]; if (top) top.scroll = document.getElementById('view').scrollTop; }
  function push(name, params) { saveScroll(); S.nav.push({ name, params }); history.pushState({ d: S.nav.length }, ''); show(S.nav[S.nav.length - 1]); }
  function root(name, params) {
    for (const e of S.nav) if (e.page && e.page.onHide) e.page.onHide();
    S.nav = [{ name, params }]; if (!params) store.set('view', name); show(S.nav[0]);
  }
  function back() { if (S.nav.length > 1) history.back(); }
  window.addEventListener('popstate', () => {
    if (S.nav.length > 1) { const e = S.nav.pop(); if (e.page && e.page.onHide) e.page.onHide(); show(S.nav[S.nav.length - 1]); }
  });

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------
  let npEls = null;

  VIEWS.now = () => {
    const art = h('div', { class: 'np-art' });
    const title = h('div', { class: 'np-title' }), artist = h('button', { class: 'np-link np-artist' }), album = h('button', { class: 'np-link np-album' });
    const station = h('div', { class: 'np-station' });
    const quality = h('div', { class: 'np-quality' });
    const seek = h('input', { type: 'range', min: 0, max: 100, step: 'any', value: 0, class: 'seek', 'aria-label': 'Position' });
    const tNow = h('span', { class: 'tm' }), tDur = h('span', { class: 'tm' });
    const playBtn = btn('play', 'Play', () => togglePlay(), 'big');
    const shuf = btn('shuffle', 'Shuffle', () => cycleShuffle()), rep = btn('repeat', 'Repeat', () => cycleRepeat());
    const vol = h('input', { type: 'range', min: 0, max: 100, step: 1, class: 'vol', 'aria-label': 'Volume' });
    const muteBtn = btn('volume', 'Mute', () => act(['mixer', 'muting', 'toggle']));
    const upNext = h('div', { class: 'np-next' });
    const empty = h('div', { class: 'np-empty' }, icon('note', 'huge'), h('p', { text: 'Nothing playing. Pick something from the library, favourites, radio or apps.' }));
    let seeking = false;
    seek.addEventListener('input', () => { seeking = true; tNow.textContent = fmtTime(seek.value); });
    seek.addEventListener('change', () => { seeking = false; act(['time', seek.value]); });
    vol.addEventListener('input', debounce(() => act(['mixer', 'volume', vol.value]), 120));
    artist.addEventListener('click', () => { const c = current(); if (c && c.artistId) push('artist', { id: c.artistId, name: c.artist }); });
    album.addEventListener('click', () => { const c = current(); if (c && c.albumId) push('album', { id: c.albumId, title: c.album, artist: c.artist, artist_id: c.artistId }); });
    const main = h('div', { class: 'np' },
      art,
      h('div', { class: 'np-info' }, title, h('div', { class: 'np-sub' }, artist, album), station, quality,
        h('div', { class: 'np-seek' }, tNow, seek, tDur),
        h('div', { class: 'np-ctrls' }, shuf, btn('prev', 'Previous', () => act(['button', 'jump_rew'])), playBtn, btn('next', 'Next', () => act(['playlist', 'index', '+1'])), rep),
        h('div', { class: 'np-vol' }, muteBtn, vol),
        upNext));
    const el = h('div', {}, empty, main);
    npEls = { art, title, artist, album, station, quality, seek, tNow, tDur, playBtn, shuf, rep, vol, muteBtn, upNext, empty, main, isSeeking: () => seeking, lastArt: null };
    const actions = [btn('fav', 'Add to favourites', () => {
      const c = current(); if (!c || !c.url) return toast('Nothing to add');
      act(['favorites', 'add', 'url:' + c.url, 'title:' + (c.stationTitle || c.title)], 'Added to favourites', '');
    }), btn('sleep', 'Sleep timer', sleepMenu), btn('more', 'More', () => {
      const c = current(); if (!c) return;
      libMenu('track', { id: c.id, title: c.title, artist: c.artist, album: c.album, artist_id: c.artistId, album_id: c.albumId, url: c.url, remote: c.remote, art: nowArt(120) });
    })];
    return { title: 'Now playing', el, actions, onShow: () => updateNowPlaying(true), onHide: () => { npEls = null; } };
  };

  function sleepMenu() {
    const st = S.status || {};
    const left = +st.will_sleep_in || 0;
    sheet('Sleep timer', [
      ...[15, 30, 45, 60, 90].map((m) => ({ label: `${m} minutes`, icon: 'sleep', run: () => act(['sleep', m * 60], `Sleeping in ${m} minutes`) })),
      { label: 'At the end of this track', icon: 'note', run: () => act(['jiveendoftracksleep'], 'Sleeping after this track') },
      left ? { label: `Cancel (${fmtTime(left)} left)`, icon: 'close', run: () => act(['sleep', 0], 'Sleep timer off') } : null,
    ], { sub: playerName(S.target) });
  }

  function togglePlay() {
    const st = S.status;
    if (S.output && S.output.needsGesture) S.output.unlock();
    if (!st) return;
    if (st.mode === 'play') act(['pause', 1]);
    else if (st.mode === 'pause') act(['pause', 0]);
    else act(['play']);
  }
  function cycleShuffle() { const v = +(S.status && S.status['playlist shuffle']) || 0; act(['playlist', 'shuffle', (v + 1) % 3], ['Shuffle off', 'Shuffle songs', 'Shuffle albums'][(v + 1) % 3]); }
  function cycleRepeat() { const v = +(S.status && S.status['playlist repeat']) || 0; act(['playlist', 'repeat', (v + 1) % 3], ['Repeat off', 'Repeat song', 'Repeat queue'][(v + 1) % 3]); }

  function setIcon(b, name, label) { b.replaceChildren(icon(name)); if (label) { b.title = label; b.setAttribute('aria-label', label); } }

  function updateNowPlaying(force) {
    updateBar();
    if (!npEls) return;
    const st = S.status, c = current(st);
    const has = !!(c && (c.title || +st.playlist_tracks));
    npEls.empty.hidden = has; npEls.main.hidden = !has;
    if (!has) return;
    const artUrl = nowArt(600);
    if (force || artUrl !== npEls.lastArt) { npEls.lastArt = artUrl; npEls.art.replaceChildren(artEl(artUrl, 'album', 'xl')); }
    npEls.title.textContent = c.title || 'Unknown';
    npEls.artist.textContent = c.artist; npEls.artist.disabled = !c.artistId;
    npEls.album.textContent = c.album; npEls.album.disabled = !c.albumId; npEls.album.hidden = !c.album;
    npEls.station.textContent = c.stationTitle; npEls.station.hidden = !c.stationTitle;
    let q = qualityLabel(c);
    if (isLocal(S.target) && S.local) { const f = S.local.snapshot().format; if (f) q = (q ? q + '  →  ' : '') + 'decoding ' + f; }
    npEls.quality.textContent = q;
    const d = c.duration, t = elapsedNow();
    npEls.seek.max = d || 1; npEls.seek.disabled = !d || st.can_seek === 0;
    if (!npEls.isSeeking()) { npEls.seek.value = t; npEls.tNow.textContent = fmtTime(t); }
    npEls.tDur.textContent = d ? fmtTime(d) : (c.remote ? 'Live' : '');
    setIcon(npEls.playBtn, st.mode === 'play' ? 'pause' : 'play', st.mode === 'play' ? 'Pause' : 'Play');
    const sh = +st['playlist shuffle'] || 0, rp = +st['playlist repeat'] || 0;
    npEls.shuf.classList.toggle('on', sh > 0); npEls.shuf.title = ['Shuffle off', 'Shuffle songs', 'Shuffle albums'][sh];
    npEls.rep.classList.toggle('on', rp > 0); setIcon(npEls.rep, rp === 1 ? 'repeat1' : 'repeat', ['Repeat off', 'Repeat song', 'Repeat queue'][rp]);
    const v = Math.abs(+st['mixer volume'] || 0), muted = (+st['mixer volume'] || 0) < 0;
    if (document.activeElement !== npEls.vol) npEls.vol.value = v;
    setIcon(npEls.muteBtn, muted ? 'mute' : 'volume', muted ? 'Unmute' : 'Mute');
    const idx = +st.playlist_cur_index, total = +st.playlist_tracks || 0;
    npEls.upNext.textContent = total ? `Track ${idx + 1} of ${total}` : '';
  }

  function updateBar() {
    const bar = document.getElementById('bar');
    const st = S.status, c = current(st);
    const has = !!(c && c.title);
    const els = bar._els || (bar._els = buildBar(bar));
    els.title.textContent = has ? c.title : (S.target ? 'Nothing playing' : 'No player');
    els.sub.textContent = has ? [c.artist, c.album].filter(Boolean).join(' · ') : playerName(S.target);
    const art = has ? nowArt(120) : null;
    if (art !== els.lastArt) { els.lastArt = art; els.art.replaceChildren(artEl(art, 'note', 'sm')); }
    setIcon(els.play, st && st.mode === 'play' ? 'pause' : 'play', st && st.mode === 'play' ? 'Pause' : 'Play');
    const d = c ? c.duration : 0, t = elapsedNow();
    els.prog.style.width = d ? Math.min(100, t / d * 100) + '%' : '0%';
    els.time.textContent = has ? (d ? `${fmtTime(t)} / ${fmtTime(d)}` : fmtTime(t)) : '';
    const v = Math.abs(+(st && st['mixer volume']) || 0);
    if (document.activeElement !== els.vol) els.vol.value = v;
  }
  function buildBar(bar) {
    const art = h('div', { class: 'bar-art' });
    const title = h('div', { class: 't1' }), sub = h('div', { class: 't2' });
    const play = btn('play', 'Play', () => togglePlay(), 'mid');
    const prog = h('div', { class: 'bar-prog-fill' });
    const time = h('div', { class: 'bar-time' });
    const vol = h('input', { type: 'range', min: 0, max: 100, step: 1, class: 'vol', 'aria-label': 'Volume' });
    vol.addEventListener('input', debounce(() => act(['mixer', 'volume', vol.value]), 120));
    const progBar = h('div', { class: 'bar-prog', title: 'Seek' }, prog);
    progBar.addEventListener('click', (e) => {
      const c = current(); if (!c || !c.duration) return;
      const r = progBar.getBoundingClientRect(); act(['time', ((e.clientX - r.left) / r.width * c.duration).toFixed(1)]);
    });
    bar.append(progBar, h('div', { class: 'bar-main' },
      h('button', { class: 'bar-np', onclick: () => root('now') }, art, h('div', { class: 'meta' }, title, sub)),
      h('div', { class: 'bar-ctrls' }, btn('prev', 'Previous', () => act(['button', 'jump_rew'])), play, btn('next', 'Next', () => act(['playlist', 'index', '+1']))),
      h('div', { class: 'bar-right' }, time, h('div', { class: 'bar-vol' }, icon('volume'), vol), btn('queue', 'Queue', () => root('queue')))));
    return { art, title, sub, play, prog, time, vol, lastArt: undefined };
  }
  setInterval(() => { if (S.status && S.status.mode === 'play') { updateBar(); if (npEls) updateNowPlaying(); } renderLocalBadge(); }, 500);

  // -- Queue -------------------------------------------------------------------
  VIEWS.queue = () => {
    const list = h('div', { class: 'list queue' });
    const info = h('div', { class: 'view-sub' });
    let dragFrom = null;
    async function load() {
      if (!S.target) { list.replaceChildren(h('div', { class: 'empty', text: 'No player selected.' })); return; }
      try {
        const r = await rpc(['status', 0, 1000, 'tags:aAlcdeKNsjJtux']);
        const cur = +r.playlist_cur_index;
        const items = r.playlist_loop || [];
        let total = 0; for (const t of items) total += +t.duration || 0;
        info.textContent = items.length ? `${plural(items.length, 'track')} · ${fmtTime(total)} · ${playerName(S.target)}` : '';
        list.replaceChildren(...(items.length ? items.map((t) => {
          const i = +t['playlist index'];
          const el = row({
            art: t.artwork_url ? S.lms.art(t.artwork_url, 96) : S.lms.cover(t.coverid, 96), title: t.title,
            sub: [t.artist, t.album].filter(Boolean).join(' · '), right: +t.duration ? fmtTime(t.duration) : '',
            cls: i === cur ? 'current' : '', draggable: true,
            onclick: () => act(['playlist', 'index', i]),
            menu: () => sheet(t.title, [
              { label: 'Play now', icon: 'play', run: () => act(['playlist', 'index', i]) },
              i !== cur ? { label: 'Play next', icon: 'next_up', run: () => act(['playlist', 'move', i, i < cur ? cur : cur + 1], 'Moved') } : null,
              i > 0 ? { label: 'Move up', icon: 'up', run: () => act(['playlist', 'move', i, i - 1]) } : null,
              i < items.length - 1 ? { label: 'Move down', icon: 'down', run: () => act(['playlist', 'move', i, i + 1]) } : null,
              { label: 'Remove from queue', icon: 'delete', run: () => act(['playlist', 'delete', i], 'Removed') },
              t.artist_id ? { label: 'Go to artist', icon: 'artist', run: () => push('artist', { id: t.artist_id, name: t.artist }) } : null,
              t.album_id ? { label: 'Go to album', icon: 'album', run: () => push('album', { id: t.album_id, title: t.album, artist: t.artist }) } : null,
              { label: 'More…', icon: 'more', run: () => push('jive', { action: { cmd: ['trackinfo', 'items'], params: { playlist_index: i, menu: 1 } }, title: t.title }) },
              t.url && !+t.remote ? { label: 'Add to playlist…', icon: 'playlist', run: () => addToPlaylist([t.url]) } : null,
            ], { sub: t.artist }),
          });
          el.addEventListener('dragstart', (e) => { dragFrom = i; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
          el.addEventListener('dragend', () => el.classList.remove('dragging'));
          el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
          el.addEventListener('dragleave', () => el.classList.remove('over'));
          el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (dragFrom != null && dragFrom !== i) act(['playlist', 'move', dragFrom, i]); dragFrom = null; });
          return el;
        }) : [h('div', { class: 'empty', text: 'The queue is empty.' })]));
        const curEl = list.querySelector('.current');
        if (curEl && !list.dataset.scrolled) { list.dataset.scrolled = '1'; curEl.scrollIntoView({ block: 'center' }); }
      } catch (e) { fail(e); }
    }
    const actions = [
      btn('shuffle', 'Shuffle', () => cycleShuffle()), btn('repeat', 'Repeat', () => cycleRepeat()),
      btn('save', 'Save as playlist', async () => { const n = await prompt2('Save queue as playlist', { placeholder: 'Playlist name', ok: 'Save' }); if (n) act(['playlist', 'save', n], 'Saved as ' + n); }),
      btn('delete', 'Clear queue', async () => { if (await confirm2('Clear the queue?', 'Clear')) act(['playlist', 'clear'], 'Queue cleared'); }),
    ];
    return { title: 'Queue', el: h('div', {}, info, list), actions, onShow: () => { playlistListeners.add(load); load(); }, onHide: () => playlistListeners.delete(load) };
  };

  // -- Library -----------------------------------------------------------------
  function albumCard(a) {
    return card({
      art: S.lms.cover(a.artwork_track_id, 300), title: a.album, sub: [a.artist, a.year && +a.year ? a.year : ''].filter(Boolean).join(' · '),
      onclick: () => push('album', { id: a.id, title: a.album, artist: a.artist, artist_id: a.artist_id, art: a.artwork_track_id, year: a.year }),
      menu: () => libMenu('album', { ...a, title: a.album, art: S.lms.cover(a.artwork_track_id, 120) }),
    });
  }
  const artistImg = (id, size = 300) => S.lms.url(`imageproxy/mai/artist/${id}/image_${size}x${size}_f`);
  function artistRow(a) {
    return row({ art: artistImg(a.id, 96), artIcon: 'artist', title: a.artist, onclick: () => push('artist', { id: a.id, name: a.artist }), menu: () => libMenu('artist', { ...a, title: a.artist }) });
  }

  VIEWS.artists = () => {
    let role = store.get('artistRole', 'ALBUMARTIST');
    const holder = h('div');
    const pick = h('select', { class: 'select', 'aria-label': 'Which artists', onchange: () => { role = pick.value; store.set('artistRole', role); build(); } },
      h('option', { value: 'ALBUMARTIST', text: 'Album artists', selected: role === 'ALBUMARTIST' }),
      h('option', { value: '', text: 'All artists', selected: role === '' }),
      h('option', { value: 'COMPOSER', text: 'Composers', selected: role === 'COMPOSER' }));
    function build() {
      holder.replaceChildren(lazyList({
        fetch: async (s, n) => { const r = await rpc(['artists', s, n, ...(role ? ['role_id:' + role] : [])], ''); return { items: r.artists_loop || [], total: +r.count || 0 }; },
        render: artistRow, page: 200,
      }));
    }
    build();
    return { title: 'Artists', el: holder, actions: [pick] };
  };

  VIEWS.albums = (p = {}) => {
    let sort = p.sort || store.get('albumSort', 'album');
    const holder = h('div');
    const pick = p.sort ? null : h('select', { class: 'select', 'aria-label': 'Sort albums', onchange: () => { sort = pick.value; store.set('albumSort', sort); build(); } },
      [['album', 'By title'], ['artistalbum', 'By artist'], ['yearalbum', 'By year'], ['new', 'Recently added'], ['random', 'Random']].map(([v, t]) => h('option', { value: v, text: t, selected: sort === v })));
    function build() {
      holder.replaceChildren(lazyList({
        grid: true, page: 120,
        fetch: async (s, n) => { const r = await rpc(['albums', s, n, 'tags:aljyS', 'sort:' + sort, ...(p.filter || [])], ''); return { items: r.albums_loop || [], total: p.sort === 'new' ? Math.min(+r.count || 0, 300) : +r.count || 0 }; },
        render: albumCard,
      }));
    }
    build();
    return { title: p.title || 'Albums', el: holder, actions: pick ? [pick] : [] };
  };
  VIEWS.newmusic = () => VIEWS.albums({ sort: 'new', title: 'New music' });

  VIEWS.artist = (p) => {
    const header = h('div', { class: 'hero' }, artEl(artistImg(p.id, 300), 'artist', 'hero-art round'),
      h('div', { class: 'hero-meta' }, h('h2', { text: p.name || '' }),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn', onclick: () => pc('load', 'artist', p.id) }, icon('play'), 'Play'),
          h('button', { class: 'btn ghost', onclick: () => playShuffled('artist', p.id) }, icon('shuffle'), 'Shuffle'),
          h('button', { class: 'btn ghost', onclick: () => pc('add', 'artist', p.id) }, icon('add'), 'Queue'))));
    const albums = lazyList({
      grid: true, page: 200, empty: 'No albums.',
      fetch: async (s, n) => { const r = await rpc(['albums', s, n, 'artist_id:' + p.id, 'tags:aljyS', 'sort:yearalbum'], ''); return { items: r.albums_loop || [], total: +r.count || 0 }; },
      render: albumCard,
    });
    return { title: p.name || 'Artist', el: h('div', {}, header, h('h3', { class: 'section', text: 'Albums' }), albums), actions: [btn('more', 'More', () => libMenu('artist', { id: p.id, title: p.name, favorites_url: 'db:contributor.name=' + encodeURIComponent(p.name || '') }))] };
  };

  VIEWS.album = (p) => {
    const list = h('div', { class: 'list' });
    const meta = h('div', { class: 't2' });
    const artist = h('button', { class: 'np-link', text: p.artist || '', onclick: () => p.artist_id && push('artist', { id: p.artist_id, name: p.artist }) });
    const header = h('div', { class: 'hero' }, artEl(p.art ? S.lms.cover(p.art, 500) : null, 'album', 'hero-art'),
      h('div', { class: 'hero-meta' }, h('h2', { text: p.title || '' }), artist, meta,
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn', onclick: () => pc('load', 'album', p.id) }, icon('play'), 'Play'),
          h('button', { class: 'btn ghost', onclick: () => playShuffled('album', p.id) }, icon('shuffle'), 'Shuffle'),
          h('button', { class: 'btn ghost', onclick: () => pc('add', 'album', p.id) }, icon('add'), 'Queue'))));
    let tracks = [];
    (async () => {
      try {
        const r = await rpc(['titles', 0, 1000, 'album_id:' + p.id, 'tags:aAdeltuyjJKsiqr', 'sort:tracknum'], '');
        tracks = r.titles_loop || [];
        let total = 0; for (const t of tracks) total += +t.duration || 0;
        const first = tracks[0] || {};
        if (!p.art && first.coverid) header.firstChild.replaceWith(artEl(S.lms.cover(first.coverid, 500), 'album', 'hero-art'));
        if (!p.artist_id && first.artist_id) { p.artist_id = first.artist_id; }
        if (!p.artist && first.artist) artist.textContent = p.artist = first.artist;
        meta.textContent = [first.year && +first.year ? first.year : '', plural(tracks.length, 'track'), fmtTime(total), qualityLabel(first)].filter(Boolean).join(' · ');
        const discs = new Set(tracks.map((t) => t.disc || 1));
        let lastDisc = null;
        const rows = [];
        tracks.forEach((t, i) => {
          if (discs.size > 1 && t.disc !== lastDisc) { lastDisc = t.disc; rows.push(h('div', { class: 'disc', text: 'Disc ' + (t.disc || 1) })); }
          rows.push(row({
            num: t.tracknum || i + 1, title: t.title, sub: t.artist && t.artist !== p.artist ? t.artist : null, right: fmtTime(t.duration),
            onclick: () => act(['playlistcontrol', 'cmd:load', 'album_id:' + p.id, 'play_index:' + i], 'Playing'),
            menu: () => libMenu('track', { ...t, art: S.lms.cover(t.coverid, 120) }),
          }));
        });
        list.replaceChildren(...rows);
      } catch (e) { fail(e); }
    })();
    return {
      title: p.title || 'Album', el: h('div', {}, header, list),
      actions: [btn('more', 'More', () => libMenu('album', { id: p.id, title: p.title, artist: p.artist, artist_id: p.artist_id, favorites_url: tracks[0] ? `db:album.title=${encodeURIComponent(p.title || '')}&contributor.name=${encodeURIComponent(p.artist || '')}` : null }, [
        tracks.length ? { label: 'Add album to playlist…', icon: 'playlist', run: () => addToPlaylist(tracks.map((t) => t.url).filter(Boolean)) } : null,
      ]))],
    };
  };

  VIEWS.genres = () => ({
    title: 'Genres',
    el: lazyList({
      page: 200, fetch: async (s, n) => { const r = await rpc(['genres', s, n], ''); return { items: r.genres_loop || [], total: +r.count || 0 }; },
      render: (g) => row({ art: null, artIcon: 'genre', title: g.genre, onclick: () => push('albums', { title: g.genre, filter: ['genre_id:' + g.id], sort: 'artistalbum' }), menu: () => libMenu('genre', { ...g, title: g.genre }) }),
    }),
  });

  VIEWS.years = () => ({
    title: 'Years',
    el: lazyList({
      page: 200, fetch: async (s, n) => { const r = await rpc(['years', s, n], ''); return { items: (r.years_loop || []).filter((y) => +y.year), total: +r.count || 0 }; },
      render: (y) => row({ art: null, artIcon: 'year', title: String(y.year), onclick: () => push('albums', { title: String(y.year), filter: ['year:' + y.year], sort: 'artistalbum' }), menu: () => libMenu('year', { id: y.year, title: String(y.year) }) }),
    }),
  });

  VIEWS.folders = (p = {}) => ({
    title: p.title || 'Music folder',
    el: lazyList({
      page: 200, empty: 'This folder is empty.',
      fetch: async (s, n) => { const r = await rpc(['musicfolder', s, n, 'tags:cdu', ...(p.id ? ['folder_id:' + p.id] : [])], ''); return { items: r.folder_loop || [], total: +r.count || 0 }; },
      render: (f) => {
        if (f.type === 'folder') return row({ art: null, artIcon: 'folder', title: f.filename, onclick: () => push('folders', { id: f.id, title: f.filename }), menu: () => libMenu('folder', { ...f, title: f.filename }) });
        if (f.type === 'track') return row({ art: S.lms.cover(f.coverid || f.id, 96), title: f.filename, right: f.duration ? fmtTime(f.duration) : '', onclick: () => pc('load', 'track', f.id), menu: () => libMenu('track', { ...f, title: f.filename }) });
        if (f.type === 'playlist') return row({ art: null, artIcon: 'playlist', title: f.filename, onclick: () => pc('load', 'playlist', f.id), menu: () => libMenu('playlist', { ...f, title: f.filename }) });
        return row({ art: null, artIcon: 'note', title: f.filename, cls: 'dim' });
      },
    }),
    actions: p.id ? [btn('play', 'Play folder', () => pc('load', 'folder', p.id)), btn('add', 'Queue folder', () => pc('add', 'folder', p.id))] : [],
  });

  // -- Playlists ---------------------------------------------------------------
  VIEWS.playlists = () => {
    const holder = h('div');
    const build = () => holder.replaceChildren(lazyList({
      page: 200, empty: 'No saved playlists.',
      fetch: async (s, n) => { const r = await rpc(['playlists', s, n, 'tags:u'], ''); return { items: r.playlists_loop || [], total: +r.count || 0 }; },
      render: (pl) => row({
        art: null, artIcon: 'playlist', title: pl.playlist, onclick: () => push('playlist', { id: pl.id, name: pl.playlist }),
        menu: () => libMenu('playlist', { ...pl, title: pl.playlist, favorites_url: pl.url }, playlistAdmin(pl, build)),
      }),
    }));
    build();
    return { title: 'Playlists', el: holder, actions: [btn('save', 'Save queue as playlist', async () => { const n = await prompt2('Save queue as playlist', { placeholder: 'Playlist name', ok: 'Save' }); if (n) { await act(['playlist', 'save', n], 'Saved as ' + n); setTimeout(build, 800); } })] };
  };
  function playlistAdmin(pl, after) {
    return [
      { sep: true },
      { label: 'Rename…', icon: 'edit', run: async () => { const n = await prompt2('Rename playlist', { value: pl.playlist, ok: 'Rename' }); if (n) { await act(['playlists', 'rename', 'playlist_id:' + pl.id, 'newname:' + n], 'Renamed', ''); after && after(); } } },
      { label: 'Delete playlist', icon: 'delete', danger: true, run: async () => { if (await confirm2(`Delete “${pl.playlist}”?`)) { await act(['playlists', 'delete', 'playlist_id:' + pl.id], 'Deleted', ''); after && after(); } } },
    ];
  }
  VIEWS.playlist = (p) => {
    const holder = h('div');
    const build = () => holder.replaceChildren(lazyList({
      page: 500, empty: 'This playlist is empty.',
      fetch: async (s, n) => { const r = await rpc(['playlists', 'tracks', s, n, 'playlist_id:' + p.id, 'tags:adlcuKs'], ''); return { items: r.playlisttracks_loop || [], total: +r.count || 0 }; },
      render: (t, i) => row({
        art: t.artwork_url ? S.lms.art(t.artwork_url, 96) : S.lms.cover(t.coverid, 96), title: t.title, sub: [t.artist, t.album].filter(Boolean).join(' · '), right: +t.duration ? fmtTime(t.duration) : '',
        onclick: () => act(['playlistcontrol', 'cmd:load', 'playlist_id:' + p.id, 'play_index:' + i], 'Playing'),
        menu: () => libMenu('track', { ...t, art: S.lms.cover(t.coverid, 120) }, [
          { sep: true },
          i > 0 ? { label: 'Move up', icon: 'up', run: async () => { await act(['playlists', 'edit', 'cmd:move', 'playlist_id:' + p.id, 'index:' + i, 'toindex:' + (i - 1)], null, ''); build(); } } : null,
          { label: 'Move down', icon: 'down', run: async () => { await act(['playlists', 'edit', 'cmd:move', 'playlist_id:' + p.id, 'index:' + i, 'toindex:' + (i + 1)], null, ''); build(); } },
          { label: 'Remove from playlist', icon: 'delete', run: async () => { await act(['playlists', 'edit', 'cmd:delete', 'playlist_id:' + p.id, 'index:' + i], 'Removed', ''); build(); } },
        ]),
      }),
    }));
    build();
    return {
      title: p.name, el: h('div', {}, h('div', { class: 'row-btns pad' },
        h('button', { class: 'btn', onclick: () => pc('load', 'playlist', p.id) }, icon('play'), 'Play'),
        h('button', { class: 'btn ghost', onclick: () => playShuffled('playlist', p.id) }, icon('shuffle'), 'Shuffle'),
        h('button', { class: 'btn ghost', onclick: () => pc('add', 'playlist', p.id) }, icon('add'), 'Queue')), holder),
      actions: [btn('more', 'More', () => sheet(p.name, playlistAdmin({ id: p.id, playlist: p.name }, () => back()).slice(1)))],
    };
  };

  // -- Search ------------------------------------------------------------------
  VIEWS.search = (p = {}) => {
    const input = h('input', { class: 'field search-field', type: 'search', placeholder: 'Artists, albums, tracks, playlists', 'aria-label': 'Search', value: p.q || store.get('lastSearch', '') });
    const results = h('div', { class: 'results' });
    let seq = 0;
    async function run() {
      const q = input.value.trim(); store.set('lastSearch', q);
      const my = ++seq;
      if (q.length < 2) { results.replaceChildren(h('div', { class: 'empty', text: 'Type at least two letters.' })); return; }
      results.replaceChildren(h('div', { class: 'empty', text: 'Searching…' }));
      try {
        const [ar, al, tr, pl] = await Promise.all([
          rpc(['artists', 0, 30, 'search:' + q], ''), rpc(['albums', 0, 40, 'search:' + q, 'tags:aljyS'], ''),
          rpc(['titles', 0, 100, 'search:' + q, 'tags:aAdeltuyjJKs'], ''), rpc(['playlists', 0, 30, 'search:' + q], ''),
        ]);
        if (my !== seq) return;
        const out = [];
        const artists = ar.artists_loop || [], albums = al.albums_loop || [], tracks = tr.titles_loop || [], lists = pl.playlists_loop || [];
        if (artists.length) out.push(h('h3', { class: 'section', text: `Artists (${ar.count})` }), h('div', { class: 'list' }, artists.map(artistRow)));
        if (albums.length) out.push(h('h3', { class: 'section', text: `Albums (${al.count})` }), h('div', { class: 'grid' }, albums.map(albumCard)));
        if (tracks.length) out.push(h('h3', { class: 'section', text: `Tracks (${tr.count})` }), h('div', { class: 'list' }, tracks.map((t) => row({
          art: S.lms.cover(t.coverid, 96), title: t.title, sub: [t.artist, t.album].filter(Boolean).join(' · '), right: fmtTime(t.duration),
          onclick: () => pc('load', 'track', t.id), menu: () => libMenu('track', { ...t, art: S.lms.cover(t.coverid, 120) }),
        }))));
        if (lists.length) out.push(h('h3', { class: 'section', text: 'Playlists' }), h('div', { class: 'list' }, lists.map((x) => row({ art: null, artIcon: 'playlist', title: x.playlist, onclick: () => push('playlist', { id: x.id, name: x.playlist }) }))));
        if (!out.length) out.push(h('div', { class: 'empty', text: `Nothing in the library matches “${q}”.` }));
        out.push(h('div', { class: 'list' }, row({ art: null, artIcon: 'search', title: `Search apps and services for “${q}”`, sub: 'Everything LMS can search: your library, radio and installed apps',
          onclick: () => push('jive', { action: { cmd: ['globalsearch', 'items'], params: { menu: 'globalsearch', search: q } }, title: 'Search: ' + q }) })));
        results.replaceChildren(...out);
      } catch (e) { fail(e); }
    }
    input.addEventListener('input', debounce(run, 350));
    if (input.value) run();
    return { title: 'Search', el: h('div', {}, h('form', { class: 'search-form', onsubmit: (e) => { e.preventDefault(); run(); } }, input), results), onShow: () => setTimeout(() => input.focus(), 30) };
  };

  // -- Favourites, radio, apps (LMS's XMLBrowser menus) ------------------------
  function xmlArt(it) { return S.lms.art(it.image || it.icon || it.cover, 120); }

  function xmlMenu(cmd, it, extra = []) {
    const items = [];
    if (+it.isaudio) {
      items.push({ label: 'Play now', icon: 'play', run: () => act([cmd, 'playlist', 'play', 'item_id:' + it.id], 'Playing') });
      items.push({ label: 'Play next', icon: 'next_up', run: () => act([cmd, 'playlist', 'insert', 'item_id:' + it.id], 'Playing next') });
      items.push({ label: 'Add to queue', icon: 'add', run: () => act([cmd, 'playlist', 'add', 'item_id:' + it.id], 'Added to the queue') });
    }
    if (cmd !== 'favorites' && it.url && +it.isaudio) items.push({ label: 'Add to favourites', icon: 'fav', run: () => act(['favorites', 'add', 'url:' + it.url, 'title:' + it.name, ...(it.image ? ['icon:' + it.image] : [])], 'Added to favourites', '') });
    sheet(it.name, items.concat(extra), { art: xmlArt(it) });
  }

  // -- LMS menus (SlimBrowse) --------------------------------------------------
  // LMS describes its menus, and everything plugins add to them, in the format its own
  // controllers use. Rendering that format means AudioMuse-AI, Custom Browse, context menus
  // and any future plugin appear here without special code.
  const STANDARD_MYMUSIC = /^(myMusicArtists|myMusicAlbums|myMusicGenres|myMusicYears|myMusicNewMusic|myMusicMusicFolder|myMusicPlaylists|myMusicSearch|randomplay$|pluginLyrionJS$)/;

  async function loadPluginMenus() {
    const player = S.target || S.localId;
    if (!player) return;
    try {
      const r = await S.lms.rpc(player, ['menu', 0, 1000, 'direct:1']);
      S.pluginMenus = (r.item_loop || [])
        .filter((i) => (i.node === 'myMusic' || i.node === 'extras') && i.id && !STANDARD_MYMUSIC.test(i.id) && i.actions && i.actions.go)
        .sort((a, b) => (+a.weight || 0) - (+b.weight || 0) || String(a.text).localeCompare(String(b.text)));
      renderNav();
    } catch (e) { /* the menu is optional */ }
  }

  /** The LMS context menu for a library item, as a SlimBrowse action. */
  function contextMenu(kind, it) {
    if (kind === 'track') {
      if (it.id && +it.id > 0 && !it.remote) return { cmd: ['trackinfo', 'items'], params: { track_id: it.id, menu: 1 } };
      if (it.url) return { cmd: ['trackinfo', 'items'], params: { url: it.url, menu: 1 } };
      return null;
    }
    const map = { album: ['albuminfo', 'album_id'], artist: ['artistinfo', 'artist_id'], genre: ['genreinfo', 'genre_id'], year: ['yearinfo', 'year'] };
    const m = map[kind];
    return m && it.id != null ? { cmd: [m[0], 'items'], params: { [m[1]]: it.id, menu: 1 } } : null;
  }

  function jiveArt(item, size) {
    const id = item['icon-id'];
    if (id != null && /^-?[0-9a-f]+$/i.test(String(id))) return S.lms.cover(id, size);
    const src = item.image || item.icon || (id != null ? String(id) : '');
    return src ? S.lms.art(src, size) : null;
  }

  /** An item's action: its own, or the window's base action with the item's parameters. */
  function jiveAction(item, base, name) {
    if (item.actions && Object.prototype.hasOwnProperty.call(item.actions, name)) {
      const a = item.actions[name];
      if (!a) return null;
      if (a.itemsParams && item[a.itemsParams]) return Object.assign({}, a, { params: Object.assign({}, a.params, item[a.itemsParams]) });
      return a;
    }
    const b = base && base.actions && base.actions[name];
    if (!b) return null;
    return Object.assign({}, b, { params: Object.assign({}, b.params, (b.itemsParams && item[b.itemsParams]) || {}) });
  }

  function jiveArgs(a, input) {
    const sub = (v) => (input != null && typeof v === 'string' ? v.replace('__TAGGEDINPUT__', input).replace('__INPUT__', input) : v);
    const cmd = (a.cmd || []).map(sub);
    const params = [];
    for (const [k, v] of Object.entries(a.params || {})) if (v != null && v !== '') params.push(k + ':' + sub(v));
    return { cmd, params };
  }

  async function jiveFetch(a, start, count, input) {
    const { cmd, params } = jiveArgs(a, input);
    if (!(a.params && 'menu' in a.params)) params.push('menu:1');
    return S.lms.rpc(S.target || S.localId || '', [...cmd, start, count, ...params]);
  }

  async function jiveDo(a, input) {
    const { cmd, params } = jiveArgs(a, input);
    return S.lms.rpc(S.target || S.localId || '', [...cmd, ...params]);
  }

  function jiveNext(where, ctx) {
    pollSoon(150);
    if (where === 'parent') back();
    else if (where === 'grandparent') { back(); setTimeout(back, 50); }
    else if (where === 'home') root('now');
    else if (where === 'nowPlaying') root('now');
    else if ((where === 'refresh' || where === 'refreshOrigin') && ctx && ctx.reload) ctx.reload();
  }

  const COMMAND_ACTIONS = ['play', 'add', 'add-hold', 'do', 'on', 'off'];

  async function jiveActivate(item, base, name, ctx) {
    try {
      if (item.weblink && !name) { window.open(item.weblink, '_blank', 'noopener'); return; }
      let act = name;
      if (!act) act = item.goAction || (jiveAction(item, base, 'go') ? 'go' : (/item_?play/.test(item.style || '') ? 'play' : (jiveAction(item, base, 'do') ? 'do' : null)));
      if (!act) return;
      const a = jiveAction(item, base, act);
      if (!a || !a.cmd) return;
      let input = null;
      if (item.input || item.type === 'entry' || item.type === 'search' || JSON.stringify(a).includes('__TAGGEDINPUT__')) {
        input = await prompt2(firstLine(item.text) || 'Search', { placeholder: (item.input && item.input.help && item.input.help.text) || '', ok: 'OK' });
        if (!input) return;
      }
      const title = firstLine(item.text);
      const next = a.nextWindow || item.nextWindow;
      const isCommand = !!next || COMMAND_ACTIONS.includes(act) || a.cmd[0] === 'playlistcontrol' || item.type === 'slideshow';
      if (!isCommand) { push('jive', { action: a, title, input }); return; }
      const r = await jiveDo(a, input);
      if (r && r.item_loop && !next) { push('jive', { action: a, title, input }); return; }
      if (act === 'play') toast('Playing'); else if (act === 'add') toast('Added to the queue'); else if (act === 'add-hold') toast('Playing next');
      jiveNext(next, ctx);
    } catch (e) { fail(e); }
  }

  const firstLine = (t) => String(t == null ? '' : t).split('\n')[0];

  function jiveRow(item, getBase, ctx) {
    const base = getBase();
    const lines = String(item.text == null ? '' : item.text).split('\n');
    const has = (n) => !!jiveAction(item, base, n);
    // Settings-style items: a switch, or one of a set.
    if (item.checkbox != null) {
      const sw = h('input', { type: 'checkbox', class: 'switch', checked: +item.checkbox === 1, 'aria-label': lines[0] });
      sw.addEventListener('change', () => jiveActivate(item, base, sw.checked ? 'on' : 'off', ctx));
      return h('label', { class: 'setting' }, h('span', { text: lines[0] }), sw);
    }
    const playable = has('play') || has('add');
    const clickable = !!item.weblink || has('go') || has('do') || !!item.goAction || /item_?play/.test(item.style || '');
    if (!clickable && !playable) return h('div', { class: 'xml-text', text: lines.join('\n') });
    const art = jiveArt(item, 96);
    const menu = playable || has('more') ? () => sheet(lines[0], [
      has('play') ? { label: 'Play now', icon: 'play', run: () => jiveActivate(item, base, 'play', ctx) } : null,
      has('add-hold') ? { label: 'Play next', icon: 'next_up', run: () => jiveActivate(item, base, 'add-hold', ctx) } : null,
      has('add') ? { label: 'Add to queue', icon: 'add', run: () => jiveActivate(item, base, 'add', ctx) } : null,
      has('more') ? { label: 'More…', icon: 'more', run: () => push('jive', { action: jiveAction(item, base, 'more'), title: lines[0] }) } : null,
    ], { art: art || undefined, sub: lines[1] }) : null;
    return row({
      art: item.radio != null ? undefined : (art || (ctx.textOnly ? undefined : null)), artIcon: playable ? 'note' : 'folder',
      title: (item.radio != null ? (+item.radio === 1 ? '● ' : '○ ') : '') + lines[0], sub: lines.slice(1).join(' · ') || null,
      onclick: () => jiveActivate(item, base, null, ctx), menu,
    });
  }

  VIEWS.jive = (p) => {
    const holder = h('div');
    let base = null;
    const page = { title: p.title || '', el: holder };
    const ctx = { textOnly: false };
    const build = () => holder.replaceChildren(lazyList({
      page: 100, empty: 'Nothing here.',
      fetch: async (s, n) => {
        const r = await jiveFetch(p.action, s, n, p.input);
        if (r.base) base = r.base;
        if (s === 0) {
          ctx.textOnly = !!(r.window && /text/.test(r.window.menustyle || r.window.windowStyle || ''));
          const t = (r.window && r.window.text) || r.title;
          if (t && !p.title) { page.title = t; const h1 = document.querySelector('.view-head h1'); if (h1) h1.textContent = t; }
        }
        return { items: r.item_loop || [], total: +r.count || 0 };
      },
      render: (it) => jiveRow(it, () => base, ctx),
    }));
    ctx.reload = build;
    build();
    return page;
  };

  VIEWS.xml = (p) => {
    const holder = h('div');
    const build = () => holder.replaceChildren(lazyList({
      page: 200, empty: 'Nothing here.',
      fetch: async (s, n) => {
        const r = await rpc([p.cmd, 'items', s, n, 'want_url:1', ...(p.item ? ['item_id:' + p.item] : []), ...(p.search ? ['search:' + p.search] : [])]);
        if (r.title && !p.title) p.title = r.title;
        return { items: r.loop_loop || [], total: +r.count || 0 };
      },
      render: (it) => {
        const name = it.name || it.title || '';
        if (it.type === 'text' || it.type === 'textarea' || (!+it.hasitems && !+it.isaudio && it.type !== 'search' && it.type !== 'link')) {
          return h('div', { class: 'xml-text', text: name });
        }
        const isSearch = it.type === 'search';
        const go = async () => {
          if (isSearch) {
            const q = await prompt2(name || 'Search', { placeholder: 'Search', ok: 'Search' });
            if (q) push('xml', { cmd: p.cmd, item: it.id, search: q, title: `${name}: ${q}` });
          } else if (+it.hasitems || it.type === 'link') push('xml', { cmd: p.cmd, item: it.id, title: name, fav: p.fav });
          else if (+it.isaudio) act([p.cmd, 'playlist', 'play', 'item_id:' + it.id], 'Playing');
        };
        const extra = p.fav ? [{ sep: true },
          { label: 'Rename…', icon: 'edit', run: async () => { const n = await prompt2('Rename favourite', { value: name, ok: 'Rename' }); if (n) { await act(['favorites', 'rename', 'item_id:' + it.id, 'title:' + n], 'Renamed', ''); build(); } } },
          { label: 'Remove from favourites', icon: 'delete', danger: true, run: async () => { if (await confirm2(`Remove “${name}” from favourites?`, 'Remove')) { await act(['favorites', 'delete', 'item_id:' + it.id], 'Removed', ''); build(); } } }] : [];
        return row({
          art: xmlArt(it), artIcon: isSearch ? 'search' : (+it.hasitems ? 'folder' : 'note'), title: name, sub: it.line2 || it.subtitle || null,
          onclick: go, menu: (+it.isaudio || p.fav) ? () => xmlMenu(p.cmd, it, extra) : null,
        });
      },
    }));
    build();
    const page = { title: p.title || '', el: holder };
    return page;
  };

  VIEWS.favourites = () => { const v = VIEWS.xml({ cmd: 'favorites', title: 'Favourites', fav: true }); return v; };

  function serviceList(kind) {
    return lazyList({
      page: 100, empty: kind === 'radios' ? 'No radio services are installed on the server.' : 'No apps are installed on the server.',
      fetch: async (s, n) => { const r = await rpc([kind, s, n], ''); return { items: (r[kind + 's_loop'] || []).filter((x) => x.cmd), total: +r.count || 0 }; },
      render: (a) => row({ art: S.lms.art(a.icon, 96), artIcon: kind === 'radios' ? 'radio' : 'apps', title: a.name, onclick: () => push('xml', { cmd: a.cmd, title: a.name }) }),
    });
  }
  VIEWS.radio = () => ({ title: 'Radio', el: serviceList('radios') });
  VIEWS.apps = () => ({ title: 'Apps', el: serviceList('apps') });

  VIEWS.random = () => {
    const kinds = [['tracks', 'Songs', 'note'], ['albums', 'Albums', 'album'], ['contributors', 'Artists', 'artist'], ['year', 'Years', 'year']];
    const el = h('div', { class: 'tiles' }, kinds.map(([k, t, i]) => h('button', { class: 'tile', onclick: () => act(['randomplay', k], `Random ${t.toLowerCase()} mix started`) }, icon(i), h('span', { text: t }))),
      h('button', { class: 'tile ghost', onclick: () => act(['randomplay', 'disable'], 'Random mix stopped') }, icon('stop'), h('span', { text: 'Stop mix' })));
    return { title: 'Random mix', el: h('div', {}, h('p', { class: 'view-sub', text: 'LMS keeps the queue topped up with random picks from your library.' }), el) };
  };

  // -- Players -----------------------------------------------------------------
  function groupOf(id) {
    for (const g of S.syncgroups) { const m = String(g.sync_members || '').split(','); if (m.includes(id)) return m; }
    return null;
  }

  VIEWS.players = () => {
    const list = h('div', { class: 'players' });
    async function render() {
      const rows = await Promise.all(S.players.map(async (p) => {
        let st = {};
        try { st = await S.lms.rpc(p.playerid, ['status', '-', 1, 'tags:al']); } catch (e) { /* offline */ }
        const t = (st.playlist_loop || [])[0] || {};
        const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.abs(+st['mixer volume'] || 0), class: 'vol', 'aria-label': 'Volume of ' + p.name });
        vol.addEventListener('input', debounce(() => act(['mixer', 'volume', vol.value], null, p.playerid), 120));
        const g = groupOf(p.playerid);
        const on = +st.power === 1 || st.power === undefined;
        return h('div', { class: 'pcard' + (p.playerid === S.target ? ' sel' : '') },
          h('div', { class: 'pcard-head' },
            icon(isLocal(p.playerid) ? 'laptop' : 'speaker'),
            h('div', { class: 'meta' }, h('div', { class: 't1', text: p.name + (isLocal(p.playerid) ? ' (this browser)' : '') }),
              h('div', { class: 't2', text: [p.modelname || p.model, !+p.connected ? 'disconnected' : (!on ? 'off' : st.mode === 'play' ? 'playing' : st.mode), g ? 'synced with ' + g.filter((x) => x !== p.playerid).map(playerName).join(', ') : ''].filter(Boolean).join(' · ') })),
            +p.canpoweroff ? btn('power', on ? 'Switch off' : 'Switch on', () => act(['power', on ? 0 : 1], null, p.playerid).then(render), on ? 'on' : '') : null),
          t.title ? h('div', { class: 'pcard-now', text: [t.title, t.artist].filter(Boolean).join(' — ') }) : null,
          h('div', { class: 'pcard-ctrls' },
            btn(st.mode === 'play' ? 'pause' : 'play', 'Play/pause', () => act(st.mode === 'play' ? ['pause', 1] : ['play'], null, p.playerid).then(render)),
            vol,
            h('button', { class: 'btn ghost sm', onclick: () => { setTarget(p.playerid); render(); } }, p.playerid === S.target ? 'Controlling' : 'Control'),
            h('button', { class: 'btn ghost sm', onclick: () => syncMenu(p.playerid, render) }, icon('sync'), 'Sync…')));
      }));
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty', text: 'No players are connected to the server.' })]));
    }
    S.onPlayers = null;
    return { title: 'Players', el: h('div', {}, h('p', { class: 'view-sub', text: 'Every player LMS knows, including this browser. Sync players to play the same music in step.' }), list), onShow: () => { pollPlayers().then(render).catch(fail); }, actions: [btn('refresh', 'Refresh', () => pollPlayers().then(render))] };
  };

  function syncMenu(id, after) {
    const g = groupOf(id) || [];
    const others = S.players.filter((p) => p.playerid !== id);
    sheet('Sync ' + playerName(id) + ' with…', [
      ...others.map((p) => ({ label: p.name, icon: isLocal(p.playerid) ? 'laptop' : 'speaker', checked: g.includes(p.playerid), run: async () => {
        if (g.includes(p.playerid)) await rpc(['sync', '-'], p.playerid);
        else await rpc(['sync', p.playerid], id);
        toast(g.includes(p.playerid) ? 'Unsynced ' + p.name : 'Synced ' + p.name); await pollPlayers(); after && after();
      } })),
      g.length ? { sep: true } : null,
      g.length ? { label: 'Leave the group', icon: 'close', run: async () => { await rpc(['sync', '-'], id); toast('Unsynced'); await pollPlayers(); after && after(); } } : null,
    ]);
  }

  function renderPlayerButton() {
    const b = document.getElementById('playerBtn');
    b.replaceChildren(icon(isLocal(S.target) ? 'laptop' : 'speaker'), h('span', { text: playerName(S.target) }), icon('down', 'caret'));
  }
  function playerPicker() {
    sheet('Choose a player', [
      ...S.players.map((p) => ({ label: p.name + (isLocal(p.playerid) ? ' (this browser)' : ''), icon: isLocal(p.playerid) ? 'laptop' : 'speaker', checked: p.playerid === S.target, run: () => setTarget(p.playerid) })),
      { sep: true },
      S.target ? { label: 'Sync this player…', icon: 'sync', run: () => syncMenu(S.target) } : null,
      S.target ? { label: 'Transfer playback here from…', icon: 'next_up', run: () => transferMenu() } : null,
      { label: 'All players', icon: 'speaker', run: () => root('players') },
    ]);
  }
  function transferMenu() {
    const to = S.target;
    sheet('Move playback to ' + playerName(to) + ' from…', S.players.filter((p) => p.playerid !== to).map((p) => ({
      label: p.name, icon: 'speaker', run: async () => {
        // Copy the queue and position, then start here and stop there.
        const st = await S.lms.rpc(p.playerid, ['status', '-', 1]);
        await S.lms.rpc(to, ['playlist', 'clear']);
        const q = await S.lms.rpc(p.playerid, ['status', 0, 2000, 'tags:u']);
        const urls = (q.playlist_loop || []).map((t) => t.url).filter(Boolean);
        if (!urls.length) return toast('Nothing playing there');
        for (const u of urls) await S.lms.rpc(to, ['playlist', 'add', u]);
        await S.lms.rpc(to, ['playlist', 'index', +st.playlist_cur_index || 0]);
        if (+st.time) await S.lms.rpc(to, ['time', st.time]);
        await S.lms.rpc(p.playerid, ['pause', 1]);
        toast('Moved playback to ' + playerName(to)); pollSoon();
      },
    })));
  }

  // -- Alarms ------------------------------------------------------------------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  VIEWS.alarms = () => {
    const list = h('div', { class: 'list' });
    const master = h('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Alarms enabled' });
    master.addEventListener('change', () => act(['playerpref', 'alarmsEnabled', master.checked ? 1 : 0], master.checked ? 'Alarms on' : 'Alarms off'));
    async function load() {
      if (!S.target) return;
      try {
        const [r, en] = await Promise.all([rpc(['alarms', 0, 100, 'filter:all']), rpc(['playerpref', 'alarmsEnabled', '?'])]);
        master.checked = +en._p2 === 1;
        const al = r.alarms_loop || [];
        list.replaceChildren(...(al.length ? al.map((a) => {
          const sw = h('input', { type: 'checkbox', class: 'switch', checked: +a.enabled === 1, 'aria-label': 'Enabled' });
          sw.addEventListener('change', () => act(['alarm', 'update', 'id:' + a.id, 'enabled:' + (sw.checked ? 1 : 0)]));
          const days = String(a.dow || '').split(',').filter((x) => x !== '').map((d) => DAYS[+d]).join(' ');
          return h('div', { class: 'row' }, icon('alarm'),
            h('div', { class: 'meta' }, h('div', { class: 't1 big', text: fmtClock(+a.time) }), h('div', { class: 't2', text: [days || 'Never', +a.repeat ? 'repeats' : 'once', 'volume ' + a.volume].join(' · ') })),
            sw, btn('delete', 'Delete alarm', async () => { if (await confirm2('Delete this alarm?')) { await act(['alarm', 'delete', 'id:' + a.id], 'Alarm deleted'); load(); } }));
        }) : [h('div', { class: 'empty', text: 'No alarms on ' + playerName(S.target) + '.' })]));
      } catch (e) { fail(e); }
    }
    async function add() {
      const time = h('input', { type: 'time', class: 'field', value: '07:00', 'aria-label': 'Time' });
      const boxes = DAYS.map((d, i) => h('label', { class: 'day' }, h('input', { type: 'checkbox', checked: i > 0 && i < 6, value: i }), d));
      const vol = h('input', { type: 'range', min: 0, max: 100, value: 40, class: 'vol', 'aria-label': 'Volume' });
      const form = h('form', { class: 'prompt', onsubmit: async (e) => {
        e.preventDefault();
        const [hh, mm] = time.value.split(':').map(Number);
        const dow = boxes.map((b) => b.firstChild).filter((c) => c.checked).map((c) => c.value).join(',');
        closeSheet();
        await act(['alarm', 'add', 'time:' + (hh * 3600 + mm * 60), 'dow:' + dow, 'enabled:1', 'repeat:1', 'volume:' + vol.value], 'Alarm set');
        load();
      } }, time, h('div', { class: 'days' }, boxes), h('label', { class: 'lbl' }, 'Volume', vol),
      h('p', { class: 't2', text: 'The alarm plays the current queue (or LMS\'s default alarm sound).' }),
      h('div', { class: 'row-btns' }, h('button', { class: 'btn', type: 'submit' }, 'Add alarm')));
      sheet('New alarm on ' + playerName(S.target), [{ el: form }]);
    }
    return { title: 'Alarms', el: h('div', {}, h('label', { class: 'setting' }, h('span', { text: 'Alarms enabled on this player' }), master), list), onShow: load, actions: [btn('add', 'Add alarm', add)] };
  };
  const fmtClock = (secs) => `${String(Math.floor(secs / 3600)).padStart(2, '0')}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}`;

  // -- Settings ----------------------------------------------------------------
  VIEWS.settings = () => {
    const el = h('div', { class: 'settings' });
    async function render() {
      const sections = [];
      // This browser as a player.
      const enabled = store.get('localEnabled', true);
      const sw = h('input', { type: 'checkbox', class: 'switch', checked: enabled, 'aria-label': 'Use this browser as a player' });
      sw.addEventListener('change', () => { store.set('localEnabled', sw.checked); if (sw.checked) claimPlayerThenStart(); else stopLocalPlayer(); setTimeout(render, 500); });
      const out = S.output ? S.output.info() : null;
      const snap = S.local ? S.local.snapshot() : null;
      const trim = h('input', { type: 'range', min: 0, max: 100, value: Math.round((S.output ? S.output.trim : 1) * 100), class: 'vol', 'aria-label': 'Output level' });
      trim.addEventListener('input', () => { store.set('localTrim', trim.value / 100); if (S.output) S.output.setTrim(trim.value / 100); });
      const mode = h('select', { class: 'select', 'aria-label': 'Audio output' },
        [['auto', 'Automatic'], ['webaudio', 'Web Audio (lowest latency)'], ['media', 'Media element (plays with the screen locked)']]
          .map(([v, t]) => h('option', { value: v, text: t, selected: store.get('outputMode', (S.config && S.config.defaultOutput) || 'auto') === v })));
      mode.addEventListener('change', () => { store.set('outputMode', mode.value); toast('Reloading to switch the output…'); setTimeout(() => location.reload(), 800); });
      sections.push(h('section', {}, h('h3', { text: 'This browser as a player' }),
        h('label', { class: 'setting' }, h('span', { text: 'Play music in this browser (a real Slimproto player in LMS)' }), sw),
        S.local ? h('div', { class: 'kv' },
          kv('Name', S.local.name, h('button', { class: 'btn ghost sm', onclick: async () => { const n = await prompt2('Name this player', { value: S.local.name, ok: 'Rename' }); if (n) { await S.lms.rpc(S.localId, ['name', n]); S.local.name = n; store.set('name', n); toast('Renamed'); pollPlayers(); render(); } } }, 'Rename')),
          kv('Player ID', S.localId), kv('Connection', snap.connected ? 'Connected (Slimproto via relay)' : 'Connecting…'),
          kv('State', snap.state + (snap.error ? ' — ' + snap.error : '')),
          kv('Audio engine', S.output ? (S.output.engine || 'Web Audio (opens when music starts)') + (S.outputMode === 'webaudio' && !window.isSecureContext ? ' (plain http page)' : '') : '—'),
          kv('Why', S.outputWhy || ''),
          S.output && S.output.volumeLocked ? kv('Volume', 'Set with this device\'s own buttons (the page can\'t set it here); LMS volume is held at 100 %') : null,
          kv('Formats', S.local.caps.map((c) => ({ flc: 'FLAC', pcm: 'PCM/WAV/AIFF', mp3: 'MP3' }[c] || c)).join(', ') + ' (LMS converts everything else to FLAC)'),
          kv('Highest sample rate', (S.local.maxRateFound / 1000) + ' kHz'),
          kv('Output', out ? `${out.rate / 1000} kHz Web Audio, ${out.state}, ~${out.latency} ms latency` : 'Opens when music starts'),
          kv('Buffered', snap.queued.toFixed(1) + ' s decoded ahead'),
          S.output && !S.output.volumeLocked ? h('label', { class: 'setting' }, h('span', { text: 'Output level in this browser (on top of the LMS volume)' }), trim) : null,
          h('label', { class: 'setting' }, h('span', { text: 'Audio output' }), mode)) : null));

      // The player being controlled.
      if (S.target) {
        const prefs = {};
        await Promise.all(['transitionType', 'transitionDuration', 'replayGainMode', 'plugin.dontstopthemusic:provider'].map(async (k) => {
          try { const r = await rpc(['playerpref', k, '?']); prefs[k] = r._p2; } catch (e) { prefs[k] = undefined; }
        }));
        const sel = (k, opts, label) => {
          const s = h('select', { class: 'select', 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v, text: t, selected: String(prefs[k]) === String(v) })));
          s.addEventListener('change', () => act(['playerpref', k, s.value], label + ' saved'));
          return h('label', { class: 'setting' }, h('span', { text: label }), s);
        };
        sections.push(h('section', {}, h('h3', { text: 'Player: ' + playerName(S.target) }),
          sel('replayGainMode', [[0, 'Off'], [1, 'Track gain'], [2, 'Album gain'], [3, 'Smart gain']], 'Volume levelling (ReplayGain)'),
          sel('transitionType', [[0, 'None (gapless)'], [1, 'Crossfade'], [2, 'Fade in'], [3, 'Fade out'], [4, 'Fade in and out']], 'Transition between tracks'),
          sel('transitionDuration', [[0, '0 s'], [1, '1 s'], [2, '2 s'], [3, '3 s'], [5, '5 s'], [8, '8 s'], [10, '10 s']], 'Transition length'),
          prefs['plugin.dontstopthemusic:provider'] !== undefined ? await dstmSetting(prefs['plugin.dontstopthemusic:provider']) : null,
          isLocal(S.target) ? h('p', { class: 't2', text: 'This browser player plays gaplessly; crossfades apply to hardware and squeezelite players.' }) : null));
      }

      // Server.
      let info = S.serverInfo;
      try { info = S.serverInfo = await S.lms.rpc('', ['serverstatus', 0, 0]); } catch (e) { /* keep last */ }
      sections.push(h('section', {}, h('h3', { text: 'Server' }),
        h('div', { class: 'kv' },
          kv('Server', `${S.server.name} (${location.host})`),
          info ? kv('Version', 'Lyrion Music Server ' + info.version) : null,
          info ? kv('Library', `${(+info['info total albums']).toLocaleString()} albums, ${(+info['info total artists']).toLocaleString()} artists, ${(+info['info total songs']).toLocaleString()} tracks`) : null,
          info && info.rescan ? kv('Scan', 'Scanning: ' + (info.progressname || '') + ' ' + (info.progressdone || '') + '/' + (info.progresstotal || '')) : null,
          info && info.lastscan ? kv('Last scan', new Date(+info.lastscan * 1000).toLocaleString()) : null),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn ghost', onclick: () => act(['rescan'], 'Library scan started', '') }, icon('refresh'), 'Scan for new music'))));

      // Appearance.
      const theme = h('select', { class: 'select', 'aria-label': 'Theme' }, [['auto', 'Match the system'], ['dark', 'Dark'], ['light', 'Light']].map(([v, t]) => h('option', { value: v, text: t, selected: store.get('theme', 'auto') === v })));
      theme.addEventListener('change', () => { store.set('theme', theme.value); applyTheme(); });
      const dg = h('input', { type: 'checkbox', class: 'switch', checked: store.get('diag', !!(S.config && S.config.clientDiagnostics)), 'aria-label': 'Send diagnostics' });
      dg.addEventListener('change', () => store.set('diag', dg.checked));
      sections.push(h('section', {}, h('h3', { text: 'Appearance' }), h('label', { class: 'setting' }, h('span', { text: 'Theme' }), theme),
        h('label', { class: 'setting' }, h('span', { text: 'Send playback diagnostics to the LMS server log (helps fix problems on phones and tablets)' }), dg)));
      sections.push(h('section', {}, h('h3', { text: 'About' }), h('p', { class: 't2', text: `LyrionJS ${VERSION}: a Slimproto player and controller for Lyrion Music Server in one page. Keyboard: Space play/pause, ←/→ previous/next, ↑/↓ volume.` })));
      el.replaceChildren(...sections);
    }
    render().catch(fail);
    return { title: 'Settings', el };
  };
  function kv(k, v, extra) { return h('div', { class: 'kv-row' }, h('div', { class: 'k', text: k }), h('div', { class: 'v' }, h('span', { text: v == null ? '' : String(v) }), extra || null)); }

  async function dstmSetting(cur) {
    // Don't Stop The Music: ask the plugin for its providers through the jive menu.
    let opts = [];
    try {
      const r = await rpc(['dontstopthemusicsetting', 0, 100, 'menu:1']);
      for (const it of r.item_loop || []) {
        const v = it.actions && it.actions.do && it.actions.do.cmd && it.actions.do.cmd[it.actions.do.cmd.length - 1];
        if (typeof v === 'string' || typeof v === 'number') opts.push([String(v), it.text]);
      }
    } catch (e) { /* plugin menu unavailable */ }
    if (!opts.length) opts.push(['0', 'Off']);
    const curStr = cur == null || cur === '' ? '0' : String(cur);
    if (!opts.some((o) => o[0] === curStr)) opts.push([curStr, curStr]);
    opts = opts.filter((o, i, a) => a.findIndex((x) => x[0] === o[0]) === i);
    const s = h('select', { class: 'select', 'aria-label': 'Don\'t Stop The Music' }, opts.map(([v, t]) => h('option', { value: v, text: t, selected: curStr === v })));
    s.addEventListener('change', () => act(['playerpref', 'plugin.dontstopthemusic:provider', s.value], 'Saved'));
    return h('label', { class: 'setting' }, h('span', { text: 'When the queue ends (Don\'t Stop The Music)' }), s);
  }

  // ---------------------------------------------------------------------------
  // Media Session (lock screen / media keys) for this browser's player
  // ---------------------------------------------------------------------------
  let lastMeta = '';
  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !S.local) return;
    const st = S.localStatus; if (!st) return;
    const c = current(st); if (!c) return;
    const key = c.title + c.artist + c.album;
    navigator.mediaSession.playbackState = st.mode === 'play' ? 'playing' : st.mode === 'pause' ? 'paused' : 'none';
    if (key === lastMeta) return;
    lastMeta = key;
    try {
      const art = S.lms.url(`music/current/cover_512x512_f?player=${encodeURIComponent(S.localId)}&t=${encodeURIComponent(st.playlist_timestamp || '')}`);
      navigator.mediaSession.metadata = new MediaMetadata({ title: c.title, artist: c.artist, album: c.album, artwork: [{ src: new URL(art, location.href).href, sizes: '512x512' }] });
      const L = (cmd) => () => act(cmd, null, S.localId);
      navigator.mediaSession.setActionHandler('play', L(['pause', 0]));
      navigator.mediaSession.setActionHandler('pause', L(['pause', 1]));
      navigator.mediaSession.setActionHandler('nexttrack', L(['playlist', 'index', '+1']));
      navigator.mediaSession.setActionHandler('previoustrack', L(['button', 'jump_rew']));
    } catch (e) { /* not all browsers support every action */ }
  }

  // ---------------------------------------------------------------------------
  // Theme, keyboard, boot
  // ---------------------------------------------------------------------------
  function applyTheme() {
    const t = store.get('theme', 'auto');
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') act(['playlist', 'index', '+1']);
    else if (e.key === 'ArrowLeft') act(['button', 'jump_rew']);
    else if (e.key === 'ArrowUp') { e.preventDefault(); act(['mixer', 'volume', '+5']); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); act(['mixer', 'volume', '-5']); }
    else if (e.key === 'Escape') closeSheet();
    else if (e.key === '/') { e.preventDefault(); root('search'); }
  });
  // Browsers only let audio start inside a user gesture. On iPad a touch counts on touchend or
  // click, not pointerdown, and the audio context must be created or resumed right there.
  const unlock = () => { if (S.output) S.output.unlock(); refreshUnlock(); };
  for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, unlock, true);
  // Safari 17+: play as media, so the silent switch and Control Centre's silent mode don't mute it.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older Safari */ }

  function unreachable(msg) {
    document.getElementById('view').replaceChildren(h('div', { class: 'discover' },
      h('div', { class: 'logo' }, icon('note', 'huge')), h('h1', { text: 'LyrionJS' }),
      h('p', { text: 'Lyrion Music Server is not answering at ' + location.host + '.' }),
      h('p', { class: 't2', text: msg || '' }),
      h('button', { class: 'btn', onclick: () => location.reload() }, icon('refresh'), 'Try again')));
  }

  async function boot() {
    applyTheme();
    renderNav();
    document.getElementById('menuBtn').onclick = () => document.body.classList.toggle('nav-open');
    document.getElementById('scrim').onclick = () => document.body.classList.remove('nav-open');
    document.getElementById('playerBtn').onclick = () => S.lms && playerPicker();
    document.getElementById('unlock').onclick = unlock;
    S.lms = new LMS();
    try {
      const v = await S.lms.rpc('', ['version', '?'], 8000);
      let name = '';
      try { name = (await S.lms.rpc('', ['pref', 'libraryname', '?'], 5000))._p2 || ''; } catch (e) { /* older LMS */ }
      S.server = { name: name || 'Lyrion Music Server', version: v._version };
    } catch (e) { unreachable(e.message); return; }
    document.getElementById('serverName').textContent = S.server.name;
    document.body.classList.add('ready');
    S.localId = macBytes().str;
    try { S.config = serverConfig = await (await fetch('/plugins/LyrionJS/config.json', { cache: 'no-store' })).json(); } catch (e) { S.config = serverConfig = {}; }
    if (S.config.enabled === 0) toast('Browser players are switched off in LMS (Settings › Plugins › LyrionJS). This page controls your other players.');
    else claimPlayerThenStart();
    root(store.get('view', 'now'));
    try { await pollPlayers(); } catch (e) { setConn(false, e.message); }
    if (S.target && S.players.some((p) => p.playerid === S.target)) loadPluginMenus();
    poll();
  }

  window.LyrionJS = { S, VERSION, WebOutput, controlSocket, openStream }; // for diagnostics from the console
  boot();
})();
