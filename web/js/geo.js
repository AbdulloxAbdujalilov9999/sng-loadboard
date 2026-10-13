// "Near me": the person's own position, asked for politely and used only to filter the boards (loads that start / trucks that are within a
// radius around them - like DAT). The position stays in THIS browser: it is sent with a search (rounded to ~1 km by the server) and never
// stored on the server. Consent is remembered, the person can forget it any time (Settings), and the browser's own permission always has the last word.
const Geo = (() => {
  const { $ } = U;
  const KEY = 'sng.geo';            // 'granted' | 'denied' | 'later:<timestamp>'
  const POS = 'sng.geoPos';         // { lat, lng, at }
  const MILES = 'sng.nearMiles';
  const MI_KM = 1.609344;
  const FRESH_MS = 10 * 60_000;     // a position this young is reused without asking the device again
  const LATER_MS = 7 * 86_400_000;  // "Not now" is respected for a week

  const miToKm = (mi) => Math.max(1, Math.round(mi * MI_KM));
  const kmToMi = (km) => Math.round(km / MI_KM);
  const miles = () => Number(U.store.get(MILES, 100)) || 100;
  const km = () => miToKm(miles());
  const supported = () => 'geolocation' in navigator;

  function consent() {
    const v = String(U.store.get(KEY, '') || '');
    if (v === 'granted' || v === 'denied') return v;
    if (v.startsWith('later:') && Date.now() - Number(v.slice(6)) < LATER_MS) return 'later';
    return '';
  }
  const setConsent = (v) => U.store.set(KEY, v);
  const cached = () => { const p = U.store.get(POS); return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? p : null; };
  const remember = (p) => U.store.set(POS, { lat: p.lat, lng: p.lng, at: Date.now() });

  /** What the browser itself says: 'granted' | 'denied' | 'prompt' | '' (unknown). */
  async function browserState() {
    try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return ''; }
  }

  function read({ maxAge = FRESH_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (!supported()) { reject(Object.assign(new Error('unsupported'), { kind: 'unsupported' })); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => { const p = { lat: Math.round(pos.coords.latitude * 1e4) / 1e4, lng: Math.round(pos.coords.longitude * 1e4) / 1e4 }; remember(p); resolve(p); },
        (err) => reject(Object.assign(new Error(err.message), { kind: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable' })),
        { enableHighAccuracy: false, timeout: 12_000, maximumAge: maxAge },
      );
    });
  }

  function fail(kind) {
    if (kind === 'denied') setConsent('denied');
    U.toast(t({ denied: 'geo_denied', timeout: 'geo_timeout', unsupported: 'geo_unsupported' }[kind] || 'geo_unavailable'), 'error', 8000);
  }

  /**
   * The person's position, or null. Asks first (once): our own explanation, then the browser's permission box. A position that is
   * a few minutes old is reused. Never throws.
   */
  async function locate({ ask = true } = {}) {
    const c = cached();
    if (c && Date.now() - c.at < FRESH_MS && consent() === 'granted') return { lat: c.lat, lng: c.lng };
    if (!supported()) { fail('unsupported'); return null; }
    const browser = await browserState();
    if (browser === 'denied') { setConsent('denied'); fail('denied'); return null; }
    if (browser !== 'granted' && consent() !== 'granted') {
      if (!ask) return null;
      const ok = await U.confirmDialog({ title: t('geo_confirm_title'), message: t('geo_confirm_msg'), confirmText: t('geo_allow'), danger: false });
      if (!ok) { setConsent(`later:${Date.now()}`); return null; }
    }
    try {
      const p = await read();
      setConsent('granted');
      renderSettings();
      return p;
    } catch (err) { fail(err.kind); renderSettings(); return null; }
  }

  /** Quietly refresh a stored position (a search that was left "near me" yesterday must not use yesterday's place). */
  async function refresh() {
    if (consent() !== 'granted') return cached() ? { lat: cached().lat, lng: cached().lng } : null;
    try { return await read({ maxAge: FRESH_MS }); } catch { const c = cached(); return c ? { lat: c.lat, lng: c.lng } : null; }
  }

  function forget() {
    U.store.remove(POS);
    setConsent('later:0');
    renderSettings();
    U.toast(t('geo_forgot'), 'success');
  }

  // ---- the one-time question at the top of the search pages ----
  let bannerUse = null;
  async function maybeBanner(use) {
    const el = $('geo-banner');
    if (!el) return;
    bannerUse = use;
    const browser = await browserState();
    const show = supported() && !consent() && browser !== 'denied' && Boolean(Session.me?.profile);
    el.classList.toggle('hidden', !show);
  }
  function wireBanner() {
    $('geo-banner-allow')?.addEventListener('click', async () => {
      $('geo-banner').classList.add('hidden');
      const ok = bannerUse && await bannerUse();
      if (!ok && !consent()) setConsent(`later:${Date.now()}`);
    });
    $('geo-banner-later')?.addEventListener('click', () => { setConsent(`later:${Date.now()}`); $('geo-banner').classList.add('hidden'); });
  }

  // ---- the "Near me" button + chip that sits under a search's origin / location field ----
  /** `p` = element id prefix ('loads' | 'trucks'); `onUse()` starts near-me, `onMiles(mi)` changes the radius, `onClear()` ends it. */
  function nearBar(p, { onUse, onMiles, onClear }) {
    $(`${p}-near-btn`).addEventListener('click', () => onUse());
    $(`${p}-near-miles`).addEventListener('change', (e) => onMiles(Number(e.target.value)));
    $(`${p}-near-clear`).addEventListener('click', () => onClear());
    return {
      show(radiusKm) {
        $(`${p}-near-btn`).classList.add('hidden');
        $(`${p}-near-chip`).classList.remove('hidden');
        const mi = kmToMi(radiusKm);
        const sel = $(`${p}-near-miles`);
        if (![...sel.options].some((o) => Number(o.value) === mi)) sel.add(new Option(`${mi} ${t('geo_mi')}`, String(mi)));
        sel.value = String(mi);
      },
      hide() { $(`${p}-near-btn`).classList.remove('hidden'); $(`${p}-near-chip`).classList.add('hidden'); },
    };
  }

  // ---- Settings card ----
  async function renderSettings() {
    const card = $('geo-card');
    if (!card) return;
    const browser = await browserState();
    const on = consent() === 'granted' && browser !== 'denied';
    $('geo-status').textContent = t(browser === 'denied' ? 'geo_status_blocked' : on ? 'geo_status_on' : 'geo_status_off');
    $('geo-status-dot').className = `w-2 h-2 rounded-full ${browser === 'denied' ? 'bg-rose-500' : on ? 'bg-emerald-500' : 'bg-slate-300'}`;
    $('geo-allow-btn').classList.toggle('hidden', on || browser === 'denied');
    $('geo-forget-btn').classList.toggle('hidden', !on && !cached());
    $('geo-miles').value = String(miles());
  }
  function wireSettings() {
    $('geo-allow-btn')?.addEventListener('click', async () => { if (await locate()) U.toast(t('geo_on_toast'), 'success'); });
    $('geo-forget-btn')?.addEventListener('click', forget);
    $('geo-miles')?.addEventListener('change', (e) => U.store.set(MILES, Number(e.target.value) || 100));
  }

  function init() { wireBanner(); wireSettings(); I18N.onChange(renderSettings); }
  return { init, locate, refresh, forget, consent, miles, km, miToKm, kmToMi, nearBar, maybeBanner, renderSettings };
})();
window.Geo = Geo;
