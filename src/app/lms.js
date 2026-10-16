  // ---------------------------------------------------------------------------
  // LMS JSON-RPC, same-origin (the page is served by LMS, or by the dev relay that proxies it)
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
      if (/^\/\//.test(src)) src = 'http:' + src;   // protocol-relative: another host
      // Images from other hosts go through LMS's image proxy: the page never loads them itself.
      if (/^https?:\/\//i.test(src)) return this.base + 'imageproxy/' + encodeURIComponent(src) + `/image_${size}x${size}_f`;
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;   // data:, javascript: and the like
      src = src.replace(/^[\\/\s]+/, '');   // a path on this server, however it starts
      if (/^music\/[^/]+\/cover$/.test(src)) src += `_${size}x${size}_f`;
      try { if (new URL(this.base + src, location.href).origin !== location.origin) return null; } catch (e) { return null; }
      return this.base + src;
    }
    cover(id, size = 300) { return id == null || id === '' ? null : this.base + `music/${encodeURIComponent(id)}/cover_${size}x${size}_f`; }
  }
