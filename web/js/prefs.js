// Preferences that exist in several places (sign-in screen, header, Account): language, theme, currency.
// Every control is kept in sync, and each change takes effect immediately.
const Prefs = (() => {
  const { $ } = U;
  const TAB_ON = ['bg-white', 'text-blue-700', 'shadow-sm'];
  const TAB_OFF = ['text-slate-500', 'hover:text-slate-700'];

  function syncLanguage() {
    for (const id of ['gate-lang', 'lang-select', 'pref-lang']) { const el = $(id); if (el) el.value = I18N.lang; }
  }

  function setLanguage(code) {
    I18N.setLang(code);
    syncLanguage();
    App.rerender();
  }

  function syncTheme() {
    document.querySelectorAll('[data-theme-choice]').forEach((b) => {
      const on = b.dataset.themeChoice === Theme.pref;
      b.classList.remove(...(on ? TAB_OFF : TAB_ON));
      b.classList.add(...(on ? TAB_ON : TAB_OFF));
      b.setAttribute('aria-checked', String(on));
    });
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.setAttribute('aria-label', t(Theme.mode === 'dark' ? 'theme_to_light' : 'theme_to_dark')));
  }

  function syncCurrency() {
    const code = U.fx.currency;
    for (const id of ['currency-select', 'pref-currency']) { const el = $(id); if (el) el.value = code; }
  }

  function setCurrency(code) {
    U.fx.currency = code;
    U.store.set('sng.currency', code);
    syncCurrency();
    App.rerender();
  }

  /** Called whenever the currency list (re)loads from the server. */
  function fillCurrencies() {
    const options = Object.entries(U.fx.rates).map(([code, c]) => `<option value="${U.esc(code)}">${U.esc(code)} (${U.esc(c.symbol)})</option>`).join('');
    for (const id of ['currency-select', 'pref-currency']) { const el = $(id); if (el) el.innerHTML = options; }
    const saved = U.store.get('sng.currency', 'USD');
    U.fx.currency = U.fx.rates[saved] ? saved : 'USD';
    syncCurrency();
  }

  function init() {
    syncLanguage();
    for (const id of ['gate-lang', 'lang-select', 'pref-lang']) $(id).addEventListener('change', (e) => setLanguage(e.target.value));
    $('currency-select').addEventListener('change', (e) => setCurrency(e.target.value));
    $('pref-currency').addEventListener('change', (e) => setCurrency(e.target.value));

    document.addEventListener('click', (e) => {
      const choice = e.target.closest('[data-theme-choice]');
      if (choice) { Theme.set(choice.dataset.themeChoice); return; }
      if (e.target.closest('[data-theme-toggle]')) Theme.toggle();
    });
    window.addEventListener('themechange', syncTheme);
    I18N.onChange(syncTheme);
    syncTheme();
  }

  return { init, fillCurrencies, syncCurrency, syncLanguage };
})();

window.Prefs = Prefs;
