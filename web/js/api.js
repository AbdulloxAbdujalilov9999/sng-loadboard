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
      throw new ApiError(res.status, e?.code || `http_${res.status}`, e?.message || res.statusText, e?.details);
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
window.API = API;
