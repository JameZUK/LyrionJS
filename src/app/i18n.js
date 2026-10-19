  // ---------------------------------------------------------------------------
  // Languages: the page's own words. What LMS sends (menus, names, its messages) comes in LMS's
  // language already; the page follows LMS's language setting unless Settings chooses another.
  // I18N (build.py, from src/i18n/<code>.json): per language, the English text -> its
  // translation, or for counted text its plural forms by Intl.PluralRules category.
  // ---------------------------------------------------------------------------
  const LANGS = {
    en: 'English', cs: 'Čeština', da: 'Dansk', de: 'Deutsch', es: 'Español', fr: 'Français', it: 'Italiano',
    hu: 'Magyar', nl: 'Nederlands', no: 'Norsk', pl: 'Polski', fi: 'Suomi', sv: 'Svenska',
  };
  let lang = 'en', dict = null, pluralRules = null;

  const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : s);
  /** The page's text in the language in use; vars fill its {name}s. */
  function tr(s, vars) {
    const r = dict && dict[s];
    return fill(typeof r === 'string' && r ? r : s, vars);
  }
  /** Marks text to translate where it's shown (lists made before the language is known). */
  const N_ = (s) => s;
  const STATE_WORDS = { playing: N_('playing'), paused: N_('paused'), stopped: N_('stopped'), waiting: N_('waiting'), loaded: N_('loaded') };
  // The browser's audio output (AudioContext.state), likewise.
  const AUDIO_WORDS = { running: N_('running'), suspended: N_('suspended'), closed: N_('closed'), interrupted: N_('interrupted') };
  /** A player's state (core/player.js), in words. */
  const stateWord = (s) => (STATE_WORDS[s] ? tr(STATE_WORDS[s]) : AUDIO_WORDS[s] ? tr(AUDIO_WORDS[s]) : s);
  /** Counted text: one and other are the English forms, {n} the count. */
  function trn(n, one, other, vars) {
    const v = Object.assign({ n: (+n).toLocaleString(lang) }, vars);
    const r = dict && dict[other];
    if (r && typeof r === 'object' && pluralRules) {
      const form = r[pluralRules.select(+n)] || r.other;
      if (form) return fill(form, v);
    }
    return fill(+n === 1 ? one : other, v);
  }

  /** LMS's language setting (EN, EN_GB, DE, NO…) as one of ours. */
  const fromLms = (code) => { const c = String(code || '').slice(0, 2).toLowerCase(); return LANGS[c] ? c : 'en'; };
  const langChoice = () => (LANGS[store.get('lang', 'auto')] ? store.get('lang', 'auto') : 'auto');
  /** The language in use: chosen in Settings, else LMS's (as last seen, until LMS says). */
  function applyLang() {
    const c = langChoice() === 'auto' ? store.get('lmsLang', 'en') : langChoice();
    lang = c !== 'en' && I18N[c] ? c : 'en';
    dict = lang === 'en' ? null : I18N[lang];
    pluralRules = new Intl.PluralRules(lang);
    document.documentElement.lang = lang;
    // Words the style sheets add (Material's "by … from …").
    document.documentElement.style.setProperty('--w-by', JSON.stringify(tr('by')));
    document.documentElement.style.setProperty('--w-from', JSON.stringify(tr('from')));
    // The page's fixed text (index.html): its English is kept in data-i18n*, to change it back.
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-label]')) { const s = tr(el.dataset.i18nLabel); el.setAttribute('aria-label', s); el.title = s; }
    for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', tr(el.dataset.i18nAria));
    for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = tr(el.dataset.i18nTitle);
  }
  /** LMS's language, from the server: true if that changed the language in use. */
  async function learnLmsLang() {
    let code = 'en';
    try { code = fromLms((await S.lms.rpc('', ['pref', 'language', '?'], 5000))._p2); } catch (e) { return false; }
    if (code === store.get('lmsLang', 'en')) return false;
    store.set('lmsLang', code);
    if (langChoice() !== 'auto') return false;
    applyLang();
    return true;
  }
