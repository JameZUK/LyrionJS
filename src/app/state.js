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

  /** iPhone, iPad or iPod (iPadOS Safari claims to be a Mac; touch support gives it away). */
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

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
