// Small shared helpers. Everything user-controlled that reaches innerHTML MUST go through U.esc().
(function () {
  const $ = (id) => document.getElementById(id);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

  function debounce(fn, ms) {
    let timer;
    const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
  }

  // ---- localStorage that never throws (private mode, quota, disabled storage) ----
  const store = {
    get(key, fallback = null) {
      try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  // ---- toasts ----
  function toast(message, type = 'info', ms = 4500) {
    const root = $('toast-root');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), ms);
    return el;
  }

  // ---- confirm dialog (promise based, keyboard accessible) ----
  function confirmDialog({ title, message, confirmText, danger = true }) {
    return new Promise((resolve) => {
      const modal = $('confirm-modal');
      const ok = $('confirm-ok');
      const cancel = $('confirm-cancel');
      $('confirm-title').textContent = title;
      $('confirm-message').textContent = message;
      ok.textContent = confirmText || window.t('btn_confirm');
      ok.className = `px-4 py-2 rounded text-white font-bold ${danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-[#0066cc] hover:bg-blue-700'}`;
      const previouslyFocused = document.activeElement;
      modal.classList.remove('hidden');
      cancel.focus();
      const done = (value) => {
        modal.classList.add('hidden');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey, true);
        modal.removeEventListener('mousedown', onBackdrop);
        previouslyFocused?.focus?.();
        resolve(value);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onBackdrop = (e) => { if (e.target === modal) done(false); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        if (e.key === 'Tab') { // keep focus inside the dialog
          const order = [cancel, ok];
          const i = order.indexOf(document.activeElement);
          e.preventDefault();
          order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
        }
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      modal.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey, true);
    });
  }

  // ---- inline form errors driven by API validation details ----
  function clearFormErrors(form) {
    form.querySelectorAll('.field-invalid').forEach((el) => el.classList.remove('field-invalid'));
    form.querySelectorAll('.field-error').forEach((el) => el.remove());
  }

  function fieldError(input, message) {
    input.classList.add('field-invalid');
    input.setAttribute('aria-invalid', 'true');
    const holder = input.closest('.relative') || input.parentElement;
    const p = document.createElement('p');
    p.className = 'field-error';
    p.setAttribute('role', 'alert');
    p.textContent = message;
    holder.appendChild(p);
  }

  /** Show server-side validation errors next to the offending inputs; anything else becomes a toast. */
  // Server validation details carry a stable code; translate it, falling back to the English message.
  function detailText(d) {
    const key = `v_${d.code}`;
    const txt = d.code ? window.t(key, d.params) : key;
    return txt && txt !== key ? txt : d.message;
  }

  function applyFormErrors(form, err) {
    clearFormErrors(form);
    const details = err?.details;
    let shown = 0;
    if (Array.isArray(details)) {
      for (const d of details) {
        const input = form.querySelector(`[name="${CSS.escape(d.path)}"]`);
        if (input) { fieldError(input, detailText(d)); shown += 1; }
      }
      form.querySelector('.field-invalid')?.focus();
    }
    if (!shown) toast(err?.message || window.t('err_generic'), 'error');
  }

  // Run `fn` at most once per `minMs`, and always after a random 0..jitterMs delay. Live events reach every
  // open browser at the same instant; with jitter ~= minMs the refreshes spread evenly over the interval
  // (3,000 browsers -> ~200 requests/s, instead of 3,000 in the same few seconds).
  function liveThrottle(fn, { minMs = 15000, jitterMs = 15000 } = {}) {
    let timer = null;
    let last = 0;
    return () => {
      if (timer) return;
      const wait = Math.max(Math.random() * jitterMs, last + minMs - Date.now());
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(); }, wait);
    };
  }

  function setBusy(form, busy) {
    form.querySelectorAll('button[type="submit"]').forEach((b) => { b.disabled = busy; });
  }

  // ---- formatting ----
  const fx = { currency: 'USD', rates: { USD: { symbol: '$', rate: 1 } } };

  function money(usd) {
    if (usd === null || usd === undefined) return '–';
    const c = fx.rates[fx.currency] || fx.rates.USD;
    return `${c.symbol}${Math.round(usd * c.rate).toLocaleString()}`;
  }

  function ageText(iso) {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
    if (minutes < 1) return window.t('age_now');
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
  }

  /** 'YYYY-MM-DD' -> 'MM-DD' for compact table cells. */
  const shortDate = (d) => (d ? String(d).slice(5) : '');

  function fmtCount(n, capped = false) {
    if (n === null || n === undefined) return '–';
    if (capped || n >= 10000) return `${Math.min(n, 10000).toLocaleString()}+`;
    return n.toLocaleString();
  }

  /** Compact badge text: 1,234 stays, 10,000+ becomes 10k+ so it fits the sidebar pill. */
  const badgeCount = (n, capped = false) => (n === null || n === undefined ? '–' : (capped || n >= 10000 ? '10k+' : n.toLocaleString()));

  const haversineKm = (a, b) => {
    const rad = (d) => (d * Math.PI) / 180;
    const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
  };

  const todayIso = () => new Date().toISOString().slice(0, 10);

  // ---- route on a map -------------------------------------------------------------------------------
  // Desktop: a normal link that opens a NEW tab. Phones: open the Maps APP directly (Android: Google Maps via an
  // intent link that falls back to the website; iPhone: Apple Maps, which every iPhone has) instead of loading a
  // web page inside whatever window the person is in (a Telegram / in-app browser, an installed web app ...).
  function routeUrls(from, to) {
    const f = encodeURIComponent(from);
    const d = encodeURIComponent(to);
    const web = `https://www.google.com/maps/dir/?api=1&origin=${f}&destination=${d}&travelmode=driving`;
    return {
      web,
      android: `intent://www.google.com/maps/dir/?api=1&origin=${f}&destination=${d}&travelmode=driving#Intent;scheme=https;package=com.google.android.apps.maps;S.browser_fallback_url=${encodeURIComponent(web)};end`,
      apple: `https://maps.apple.com/?saddr=${f}&daddr=${d}&dirflg=d`,
    };
  }

  function platform() {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    return 'desktop';
  }

  /** Click handler for a route link: call with the click event and the link element (data-from / data-to). */
  function openRoute(e, link) {
    const urls = routeUrls(link.dataset.from, link.dataset.to);
    const os = platform();
    if (os === 'desktop') return; // the anchor's own target="_blank" opens a new tab
    e.preventDefault();
    if (os === 'android') { window.location.href = urls.android; return; }
    if (!window.open(urls.apple, '_blank', 'noopener')) window.location.href = urls.apple; // popup blocked: still reach Maps
  }

  window.U = { $, esc, debounce, liveThrottle, detailText, routeUrls, platform, openRoute, store, toast, confirmDialog, clearFormErrors, fieldError, applyFormErrors, setBusy, fx, money, ageText, shortDate, fmtCount, badgeCount, haversineKm, todayIso };
})();
