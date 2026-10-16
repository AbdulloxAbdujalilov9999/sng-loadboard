// Thin fetch wrapper: bearer token, one automatic token refresh on 401, uniform errors, cancellable requests.
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// The server answers in English (other clients read it too). Members see their own language: known messages are matched here,
// by error code or by text, and anything unknown falls back to the server's wording.
const SERVER_MESSAGES = [
  [/^AI import is not set up/i, 'srv_ai_unavailable'],
  [/^AI import limit reached \((\d+) per hour\)(?:\. Try again in (\d+) min)?/i, 'srv_ai_limit', (m) => ({ n: m[1], min: m[2] ?? '' })],
  [/^The AI is busy/i, 'srv_ai_busy'],
  [/^The AI answered in an unexpected format/i, 'srv_ai_bad_output'],
  [/^Add a phone number or a Telegram username/i, 'v_contact_required'],
  [/^Available-from date is in the past/i, 'srv_available_past'],
  [/^Delivery is before pickup/i, 'srv_delivery_before_pickup'],
  [/^End date is before start/i, 'srv_end_before_start'],
  [/^Invalid cursor/i, 'err_generic'],
  [/^(Invalid or expired session|Authentication required)/i, 'err_session_expired'],
  [/^Load not found/i, 'srv_load_not_found'],
  [/^Truck not found/i, 'srv_truck_not_found'],
  [/^Member not found/i, 'srv_member_not_found'],
  [/^Not available for this account/i, 'srv_not_available'],
  [/^Telegram sign-in is not enabled/i, 'srv_telegram_disabled'],
  [/^Could not verify Telegram sign-in/i, 'srv_telegram_bad_auth'],
  [/^Nothing to update/i, 'srv_nothing_to_update'],
  [/^Origin and destination must differ/i, 'srv_same_city'],
  [/^Owner only/i, 'srv_owner_only'],
  [/(PIN|Password) sign-in is not enabled/i, 'srv_signin_disabled'],
  [/^Pickup date is in the past/i, 'srv_pickup_past'],
  [/^Pickup date is too far ahead/i, 'srv_pickup_far'],
  [/^Please check the highlighted fields/i, 'srv_check_fields'],
  [/^Posting too fast/i, 'srv_posting_fast'],
  [/^Request access first/i, 'srv_request_access'],
  [/(has no sign-in phone|has no phone sign-in)/i, 'srv_no_phone'],
  [/^Too many wrong PINs\. Try again in (\d+) min/i, 'srv_pin_locked', (m) => ({ min: m[1] })],
  [/^Unknown (\w+ )?city/i, 'srv_unknown_city'],
  [/^Wrong phone number or PIN/i, 'srv_wrong_pin'],
  [/^You already have an account/i, 'srv_have_account'],
  [/^You are doing that too fast/i, 'srv_too_fast'],
  [/^You can only (edit|remove|renew) your own/i, 'srv_own_only'],
  [/^You have reached the limit of (\d+) active loads/i, 'srv_limit_loads', (m) => ({ n: m[1] })],
  [/^You have reached the limit of (\d+) active trucks/i, 'srv_limit_trucks', (m) => ({ n: m[1] })],
  [/^You have reached the limit of (\d+) saved searches/i, 'srv_limit_saved_searches', (m) => ({ n: m[1] })],
  [/^Saved search not found/i, 'srv_saved_search_not_found'],
  [/^Your access request is/i, 'srv_blocked'],
  [/^Your free trial or subscription has ended/i, 'srv_subscription_required'],
  [/^Invalid or expired link/i, 'srv_link_invalid'],
  [/^Not allowed/i, 'srv_not_allowed'],
  [/^(Route .* not found|Not found)$/i, 'srv_not_found'],
];
const SERVER_CODES = { rate_limited: 'srv_too_fast', subscription_required: 'srv_subscription_required', ai_unavailable: 'srv_ai_unavailable', ai_busy: 'srv_ai_busy', ai_bad_output: 'srv_ai_bad_output', owner_only: 'srv_owner_only' };

function localizeServerMessage(code, message) {
  const t = window.t;
  if (typeof t !== 'function' || !message) return message;
  const tr = (key, vars) => { const s = t(key, vars); return s && s !== key ? s : null; };
  for (const [re, key, vars] of SERVER_MESSAGES) {
    const m = re.exec(message);
    if (m) return tr(key, vars?.(m)) ?? message;
  }
  if (/^not_approved_/.test(code ?? '')) return tr('srv_blocked') ?? message;
  return (SERVER_CODES[code] && tr(SERVER_CODES[code])) || message;
}

const API = (() => {
  async function request(method, path, { query, body, signal, retry = true, busyTries = 0 } = {}) {
    let url = (window.APP_CONFIG.apiBase || '') + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, v);
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const headers = { Accept: 'application/json' };
    const token = await window.Session.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ApiError(0, 'network', window.t('err_network'));
    }
    if (res.status === 401 && retry && token) {
      await window.Session.getToken(true); // force-refresh the ID token once, then retry
      return request(method, path, { query, body, signal, retry: false, busyTries });
    }
    // Overloaded server: reads are safe to repeat, so wait a randomised few seconds (so thousands of browsers do
    // not all come back in the same instant) and try again, up to 3 times.
    if (res.status === 503 && method === 'GET' && busyTries < 3) {
      const base = Number(res.headers.get('Retry-After')) || 3;
      await new Promise((r) => setTimeout(r, base * 1000 * (0.5 + Math.random()) * (busyTries + 1)));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return request(method, path, { query, body, signal, retry, busyTries: busyTries + 1 });
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const e = data?.error;
      if (res.status === 402 && e?.code === 'subscription_required') window.Session?.refresh?.();
      throw new ApiError(res.status, e?.code || `http_${res.status}`, localizeServerMessage(e?.code, e?.message || res.statusText), e?.details);
    }
    return data;
  }

  return {
    request,
    get: (path, query, signal) => request('GET', path, { query, signal }),
    post: (path, body) => request('POST', path, { body: body ?? {} }),
    patch: (path, body) => request('PATCH', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    del: (path) => request('DELETE', path),
  };
})();

window.ApiError = ApiError;
window.localizeServerMessage = localizeServerMessage; // exposed for the tests
window.API = API;
