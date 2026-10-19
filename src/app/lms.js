  // ---------------------------------------------------------------------------
  // LMS JSON-RPC, same-origin (the page is served by LMS, or by the dev relay that proxies it)
  // ---------------------------------------------------------------------------
  /** Does this address name an SVG picture (by its path)? */
  const isSvg = (u) => /^[^?#]*\.svg(?:[?#]|$)/i.test(u);

  class LMS {
    constructor() { this.base = '/'; }
    async rpc(player, cmd, timeout = 20000) {
      const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetch(this.base + 'jsonrpc.js', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ id: 1, method: 'slim.request', params: [player || '', cmd.map((x) => String(x))] }),
        });
        if (!r.ok) throw new Error(tr('LMS answered {status}', { status: r.status }));
        const j = await r.json();
        return j.result || {};
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(tr('LMS did not answer in time'));
        throw e;
      } finally { clearTimeout(tm); }
    }
    url(path) { return this.base + String(path).replace(/^\//, ''); }
    art(src, size = 300) {
      if (!src) return null;
      src = String(src);
      if (/^\/\//.test(src)) src = 'http:' + src;   // protocol-relative: another host
      // Images from other hosts go through LMS's image proxy: the page never loads them itself.
      // SVGs, which the proxy can't resize and so sends off-site, go through the plugin instead.
      if (/^https?:\/\//i.test(src)) {
        return isSvg(src) ? this.base + 'plugins/LyrionJS/svg?u=' + encodeURIComponent(src)
          : this.base + 'imageproxy/' + encodeURIComponent(src) + `/image_${size}x${size}_f.png`;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;   // data:, javascript: and the like
      src = src.replace(/^[\\/\s]+/, '');   // a path on this server, however it starts
      if (/^music\/[^/]+\/cover$/.test(src)) src += `_${size}x${size}_f`;
      // An SVG LMS has already put through its image proxy: through the plugin instead.
      const via = src.match(/^imageproxy\/([^/]+)\//);
      if (via) {
        let u = '';
        try { u = decodeURIComponent(via[1]); } catch (e) { /* not an address */ }
        if (/^https?:\/\//i.test(u) && isSvg(u)) return this.art(u, size);
      }
      // LMS's image proxy sends a picture itself only when asked for a size: at full size (as LMS
      // hands them out, ".../image.png") it redirects to the picture's own host, which this page
      // doesn't load from. So radio logos and the like are always asked for at a size.
      const px = src.match(/^(imageproxy\/[^/]+\/image)(\.(?:png|jpe?g|gif))?$/i);
      if (px) src = px[1] + `_${size}x${size}_f` + (/^\.jpe?g$/i.test(px[2] || '') ? '.jpg' : '.png');
      try { if (new URL(this.base + src, location.href).origin !== location.origin) return null; } catch (e) { return null; }
      return this.base + src;
    }
    cover(id, size = 300) { return id == null || id === '' ? null : this.base + `music/${encodeURIComponent(id)}/cover_${size}x${size}_f`; }
  }
