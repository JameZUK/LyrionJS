  // -- About (and what happens when you open LyrionJS inside LyrionJS) -----------
  // LMS lists LyrionJS among its apps, so the page can find itself there. Opening it here would
  // show this page's own address; it shows this instead.
  const RECURSION_QUIPS = [
    'Nice try.',
    'Still no. One of us is enough.',
    'Every time you do that, a call stack loses its wings.',
    'The browser has started muttering about “maximum call stack size”.',
    'We’ve told LMS. It isn’t angry, just disappointed.',
    'RangeError: Maximum call stack size exceeded. Happy now?',
    'OK, you win: you are now listening to LyrionJS inside LyrionJS inside LyrionJS. (You aren’t.)',
    'Achievement unlocked: Ouroboros. Now go and play some music.',
  ];

  /** p.recursion: arrived by opening the LyrionJS app from inside LyrionJS. */
  VIEWS.about = (p = {}) => {
    let tries = 0;
    const quip = h('p', { class: 'about-quip', 'aria-live': 'polite' });
    // An infinite mirror: the logo inside the logo inside the logo…
    let mirror = null;
    for (let i = 0; i < 7; i++) mirror = h('div', { class: 'mirror-frame' }, logo('mirror-logo'), mirror);
    const box = h('button', { class: 'mirror', type: 'button', 'aria-label': 'Open LyrionJS inside LyrionJS (please don’t)' }, mirror);
    box.addEventListener('click', () => {
      quip.textContent = RECURSION_QUIPS[Math.min(tries++, RECURSION_QUIPS.length - 1)];
      box.classList.remove('wobble'); void box.offsetWidth; box.classList.add('wobble');
    });

    const facts = h('div', { class: 'kv' },
      kv('Version', 'LyrionJS ' + VERSION),
      kv('What it is', 'A Slimproto player and a remote for Lyrion Music Server, running entirely in this page.'),
      kv('GitHub', null, h('a', { href: 'https://github.com/JameZUK/LyrionJS', target: '_blank', rel: 'noopener', text: 'JameZUK/LyrionJS' })),
      kv('Server', S.server ? `${S.server.name} (Lyrion ${S.server.version})` : '—'),
      kv('This browser', S.local ? `${S.local.name} · ${S.localId}` : 'A remote control (not a player)'),
      kv('Audio', S.output ? (S.output.engine || 'Web Audio, opens when music starts') : '—'),
      kv('Recursion depth', '1, and we’d like to keep it that way'));

    const el = h('div', { class: 'about-page' },
      box,
      h('h2', { class: 'about-title', text: p.recursion ? 'Whoa there. You’re already in LyrionJS.' : 'LyrionJS' }),
      h('p', { class: 'about-lead', text: p.recursion
        ? 'Opening LyrionJS inside LyrionJS would open LyrionJS inside LyrionJS inside LyrionJS… and so on, until your browser runs out of patience, memory, or both. Please stop trying to cause a recursion loop.'
        : 'Your browser, as a real Lyrion player. Tap the mirror if you must.' }),
      quip,
      h('section', { class: 'about-facts' }, h('h3', { text: 'About' }), facts),
      h('div', { class: 'row-btns about-btns' },
        h('button', { class: 'btn', onclick: () => root('now') }, icon('note'), 'Take me back to the music'),
        h('button', { class: 'btn ghost', onclick: () => root('settings') }, icon('settings'), 'Settings'),
        document.documentElement.dataset.host ? h('button', { class: 'btn ghost', onclick: () => leaveOwn() }, icon('back'), 'Back to ' + hostName()) : null));
    return { title: 'About LyrionJS', el };
  };

  /** Is this LMS command (or app) LyrionJS itself? */
  const isLyrionJSApp = (cmd) => (Array.isArray(cmd) ? cmd[0] : cmd) === 'lyrionjs';
