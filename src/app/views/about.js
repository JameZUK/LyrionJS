  // -- About (and what happens when you open LyrionJS inside LyrionJS) -----------
  // LMS lists LyrionJS among its apps, so the page can find itself there. Opening it here would
  // show this page's own address; it shows this instead.
  const RECURSION_QUIPS = [
    N_('Nice try.'),
    N_('Still no. One of us is enough.'),
    N_('Every time you do that, a call stack loses its wings.'),
    N_('The browser has started muttering about “maximum call stack size”.'),
    N_('We’ve told LMS. It isn’t angry, just disappointed.'),
    N_('RangeError: Maximum call stack size exceeded. Happy now?'),
    N_('OK, you win: you are now listening to LyrionJS inside LyrionJS inside LyrionJS. (You aren’t.)'),
    N_('Achievement unlocked: Ouroboros. Now go and play some music.'),
  ];

  /** p.recursion: arrived by opening the LyrionJS app from inside LyrionJS. */
  VIEWS.about = (p = {}) => {
    let tries = 0;
    const quip = h('p', { class: 'about-quip', 'aria-live': 'polite' });
    // An infinite mirror: the logo inside the logo inside the logo…
    let mirror = null;
    for (let i = 0; i < 7; i++) mirror = h('div', { class: 'mirror-frame' }, logo('mirror-logo'), mirror);
    const box = h('button', { class: 'mirror', type: 'button', 'aria-label': tr('Open LyrionJS inside LyrionJS (please don’t)') }, mirror);
    box.addEventListener('click', () => {
      quip.textContent = tr(RECURSION_QUIPS[Math.min(tries++, RECURSION_QUIPS.length - 1)]);
      box.classList.remove('wobble'); void box.offsetWidth; box.classList.add('wobble');
    });

    const facts = h('div', { class: 'kv' },
      kv(tr('Version'), 'LyrionJS ' + VERSION),
      kv(tr('What it is'), tr('A Slimproto player and a remote for Lyrion Music Server, running entirely in this page.')),
      kv('GitHub', null, h('a', { href: 'https://github.com/JameZUK/LyrionJS', target: '_blank', rel: 'noopener', text: 'JameZUK/LyrionJS' })),
      kv(tr('Server'), S.server ? `${S.server.name} (Lyrion ${S.server.version})` : '—'),
      kv(tr('This browser'), S.local ? `${S.local.name} · ${S.localId}` : tr('A remote control (not a player)')),
      kv(tr('Audio'), S.output ? (S.output.engine || tr('Web Audio, opens when music starts')) : '—'),
      kv(tr('Recursion depth'), tr('1, and we’d like to keep it that way')));

    const el = h('div', { class: 'about-page' },
      box,
      h('h2', { class: 'about-title', text: p.recursion ? tr('Whoa there. You’re already in LyrionJS.') : 'LyrionJS' }),
      h('p', { class: 'about-lead', text: p.recursion
        ? tr('Opening LyrionJS inside LyrionJS would open LyrionJS inside LyrionJS inside LyrionJS… and so on, until your browser runs out of patience, memory, or both. Please stop trying to cause a recursion loop.')
        : tr('Your browser, as a real Lyrion player. Tap the mirror if you must.') }),
      quip,
      h('section', { class: 'about-facts' }, h('h3', { text: tr('About') }), facts),
      h('div', { class: 'row-btns about-btns' },
        h('button', { class: 'btn', onclick: () => root('now') }, icon('note'), tr('Take me back to the music')),
        h('button', { class: 'btn ghost', onclick: () => root('settings') }, icon('settings'), tr('Settings')),
        document.documentElement.dataset.host ? h('button', { class: 'btn ghost', onclick: () => leaveOwn() }, icon('back'), tr('Back to {skin}', { skin: hostName() })) : null));
    return { title: tr('About LyrionJS'), el };
  };

  /** Is this LMS command (or app) LyrionJS itself? */
  const isLyrionJSApp = (cmd) => (Array.isArray(cmd) ? cmd[0] : cmd) === 'lyrionjs';
