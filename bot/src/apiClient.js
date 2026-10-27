// Every write the bot makes goes through the real HTTP API, with the member's own ID token - the
// exact same door the web app uses. This means quotas, validation, CHECK constraints and the
// "default contact info" prefill behave identically no matter whether a load was posted from the
// browser or from Telegram, and there is only one place (server/src/routes/loads.js) that decides
// what a valid load looks like.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function makeApiClient({ baseUrl }) {
  async function request(idToken, method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      // Content-Type only when there is a body: Fastify answers 400 "Body cannot be empty" to a body-less DELETE that claims to be JSON
      // (which made the bot's Delete button fail).
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new ApiError(res.status, err.code ?? `http_${res.status}`, err.message ?? 'Request failed', err.details);
    }
    return data;
  }

  const getMe = (idToken) => request(idToken, 'GET', '/api/me');
  // Headline counts for the "Updates" menu button - same endpoint the website's dashboard badges use.
  const getStats = (idToken) => request(idToken, 'GET', '/api/stats');
  const searchCities = (idToken, q, limit = 6) =>
    request(idToken, 'GET', `/api/cities?q=${encodeURIComponent(q)}&limit=${limit}`);
  const createLoad = (idToken, body) => request(idToken, 'POST', '/api/loads', body);
  // Same endpoint the web app's "paste from Telegram/WhatsApp" screen calls - see server/src/routes/ai.js.
  // Used by the ingest bot (ingestPipeline.js) to turn a group message into structured load drafts.
  // Up to 40 at once, all-or-nothing (server/src/routes/loads.js): what pasteFlow's confirm button calls.
  const createLoadsBulk = (idToken, loads) => request(idToken, 'POST', '/api/loads/bulk', { loads });
  const parseLoads = (idToken, text) => request(idToken, 'POST', '/api/ai/parse-loads', { text });
  // Used by /myloads (bot.js): everything this member has posted, so they can delete one from the chat.
  // Searching the board from Telegram: the same endpoints the website uses, with the person's position ("near me", nearest first).
  const query = (params) => { const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v); return q.toString(); };
  const searchLoads = (idToken, params) => request(idToken, 'GET', `/api/loads?${query(params)}`);
  const searchTrucks = (idToken, params) => request(idToken, 'GET', `/api/trucks?${query(params)}`);
  const listMine = (idToken) => request(idToken, 'GET', '/api/loads/mine');
  // Soft-close (server/src/routes/loads.js DELETE route) - the same call the web app's "Remove" button
  // makes. Publishes a 'loads'/'delete' event, which broadcaster.js uses to pull the load's messages
  // back out of every group/DM it was sent to.
  const deleteLoad = (idToken, id) => request(idToken, 'DELETE', `/api/loads/${id}`);
  // Edit (PATCH: only the fields sent change) and "still available" (renew). Both are owner-only on the server.
  const updateLoad = (idToken, id, patch) => request(idToken, 'PATCH', `/api/loads/${id}`, patch);
  const renewLoad = (idToken, id) => request(idToken, 'POST', `/api/loads/${id}/renew`, {});
  // Free repost to the groups (cooldown) and TOP placement (spends a credit) - server/src/routes/loads.js.
  const repostLoad = (idToken, id) => request(idToken, 'POST', `/api/loads/${id}/repost`, {});
  const boostLoad = (idToken, id) => request(idToken, 'POST', `/api/loads/${id}/boost`, {});

  // Trucks: the same endpoints the website uses (AI reading, bulk posting, my list, edit, "still available", remove) and the saved "my truck".
  const parseTrucks = (idToken, text) => request(idToken, 'POST', '/api/ai/parse-trucks', { text });
  const createTruck = (idToken, body) => request(idToken, 'POST', '/api/trucks', body);
  const createTrucksBulk = (idToken, trucks) => request(idToken, 'POST', '/api/trucks/bulk', { trucks });
  const listMyTrucks = (idToken) => request(idToken, 'GET', '/api/trucks/mine');
  const updateTruck = (idToken, id, patch) => request(idToken, 'PATCH', `/api/trucks/${id}`, patch);
  const renewTruck = (idToken, id) => request(idToken, 'POST', `/api/trucks/${id}/renew`, {});
  const deleteTruck = (idToken, id) => request(idToken, 'DELETE', `/api/trucks/${id}`);
  const putMyTruck = (idToken, body) => request(idToken, 'PUT', '/api/me/truck', body);
  const deleteMyTruck = (idToken) => request(idToken, 'DELETE', '/api/me/truck');

  // Phone + 4-digit PIN sign-in (server/src/routes/pin.js): the same door the web app uses. Returns { token, expiresAt }.
  // Sign-up without leaving Telegram (server/src/routes/pin.js): the number + a 4-6 digit password + the name. The number is not verified by SMS.
  const phoneRegister = (body) => request(null, 'POST', '/api/auth/phone/register', body);
  const phoneCheck = (phone) => request(null, 'POST', '/api/auth/phone/check', { phone });
  // A one-time code that opens the website already signed in as this member (valid 15 minutes, works once).
  const createLoginLink = (idToken) => request(idToken, 'POST', '/api/me/login-link', {});
  const pinLogin = (phone, pin) => request(null, 'POST', '/api/auth/pin/login', { phone, pin, purpose: 'bot' });
  // Trades a still-valid PIN session for a fresh one, so a linked member never has to /link again just because time passed.
  const refreshSession = (token) => request(token, 'POST', '/api/auth/refresh', {});

  return { getMe, getStats, searchCities, createLoad, createLoadsBulk, parseLoads, listMine, deleteLoad, updateLoad, renewLoad, repostLoad, boostLoad, searchLoads, searchTrucks, parseTrucks, createTruck, createTrucksBulk, listMyTrucks, updateTruck, renewTruck, deleteTruck, putMyTruck, deleteMyTruck, phoneRegister, phoneCheck, createLoginLink, pinLogin, refreshSession };
}
