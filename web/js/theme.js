// Light / dark / automatic appearance. Loaded in <head> (before the page paints) so there is no flash of the
// wrong theme. The choice is remembered in this browser; "auto" follows the device setting.
(function () {
  const KEY = 'sng.theme';
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const read = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
  const effective = (pref) => (pref === 'dark' || (pref === 'auto' && media && media.matches) ? 'dark' : 'light');

  function apply() {
    const mode = effective(read());
    const root = document.documentElement;
    root.classList.toggle('dark', mode === 'dark');
    root.style.colorScheme = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#020617' : '#0a192f');
    window.dispatchEvent(new CustomEvent('themechange', { detail: { pref: read(), mode } }));
  }

  window.Theme = {
    get pref() { return read(); },
    get mode() { return effective(read()); },
    set(pref) {
      const value = ['light', 'dark', 'auto'].includes(pref) ? pref : 'auto';
      try { localStorage.setItem(KEY, value); } catch { /* private mode: applies for this page only */ }
      apply();
    },
    toggle() { this.set(this.mode === 'dark' ? 'light' : 'dark'); },
  };
  if (media) (media.addEventListener ? media.addEventListener('change', apply) : media.addListener(apply));
  apply();
})();
