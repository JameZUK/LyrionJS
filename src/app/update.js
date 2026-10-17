  // ---------------------------------------------------------------------------
  // A new version of the page: an open tab keeps running the code it started with, even across an
  // LMS restart. config.json says when the page file last changed; when that's no longer what it
  // was at boot, the page reloads itself, or offers to while this browser is playing.
  // ---------------------------------------------------------------------------
  const UPDATE_EVERY_MS = 10 * 60 * 1000;
  let pageAtBoot = null, pageNow = null, checking = false;

  /**
   * What to do about the page on the server: 'none', 'reload' now, or 'wait' (offer it, and
   * reload once this browser's player stops). Busy: anything but stopped, since a reload ends the
   * stream and loses a paused place. In use: a sheet open or something being typed, on a shown page.
   */
  function updateAction(atBoot, now, localState, inUse) {
    if (!atBoot || !now || now === atBoot) return 'none';
    return (localState && localState !== 'stopped') || inUse ? 'wait' : 'reload';
  }

  function pageInUse() {
    if (document.hidden) return false;
    const a = document.activeElement;
    return !document.getElementById('sheet').hidden || !!(a && a.matches && a.matches('input:not([type="range"]), textarea, select'));
  }

  /** The page stamp at boot, from the config.json read then (an older plugin has none). */
  function notePage(config) { pageAtBoot = (config && config.page) || null; }

  async function checkUpdate() {
    if (!pageAtBoot || checking) return;
    checking = true;
    try {
      const c = await (await fetch('/plugins/LyrionJS/config.json', { cache: 'no-store' })).json();
      if (c.page) pageNow = c.page;
      applyUpdate();
    } catch (e) { /* the server is away: next time */ }
    finally { checking = false; }
  }

  function applyUpdate() {
    const act = updateAction(pageAtBoot, pageNow, S.local && S.local.state, pageInUse());
    if (act === 'reload') { diag('update', 'new page: reloading'); flushDiag(true); location.reload(); }
    else document.getElementById('update').hidden = act === 'none';
  }

  document.getElementById('update').onclick = () => location.reload();
  // Back after a while away, or the server back after a restart: look then, and now and then too.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
  setInterval(checkUpdate, UPDATE_EVERY_MS);
  // Waiting for this browser to stop playing: try again as things change.
  setInterval(() => { if (pageNow) applyUpdate(); }, 5000);
