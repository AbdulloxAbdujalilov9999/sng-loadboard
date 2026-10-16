// Minimal stand-in for the main site's Session module (web/js/session.js), which api.js expects as
// window.Session.getToken(). The Mini App only ever authenticates via Telegram (telegram-miniapp.js
// stores the result under the same sng.pinSession key the main site's phone+PIN flow uses) - no
// Google/email provider, no sign-in panes, so the rest of session.js does not apply here.
window.Session = (() => {
  const KEY = 'sng.pinSession';
  const get = () => { try { return JSON.parse(U.store.get(KEY) || 'null'); } catch { return null; } };
  const active = () => { const v = get(); return v && v.token && Date.parse(v.expiresAt) > Date.now() ? v : null; };

  let refreshing = null;
  function maybeRenew(v) {
    if (refreshing || Date.parse(v.expiresAt) - Date.now() > 7 * 86400000) return;
    refreshing = fetch(`${window.APP_CONFIG.apiBase || ''}/api/auth/refresh`, {
      method: 'POST', headers: { Authorization: `Bearer ${v.token}`, 'Content-Type': 'application/json' }, body: '{}',
    }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.token) U.store.set(KEY, JSON.stringify({ ...v, token: j.token, expiresAt: j.expiresAt })); })
      .catch(() => {}).finally(() => { refreshing = null; });
  }

  async function getToken() {
    const v = active();
    if (!v) return null;
    maybeRenew(v);
    return v.token;
  }

  return { getToken, active, clear: () => U.store.remove(KEY) };
})();
