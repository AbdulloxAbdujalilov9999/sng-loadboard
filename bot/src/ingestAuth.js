// Keeps ONE Firebase ID token fresh for the ingestion service account (contrast with tokens.js,
// which does this per-Telegram-user for /link'd members) - every auto-posted load is attributed to
// this single, owner-approved member, so there is only ever one token to manage here.
// A phone account signs in with the server's own phone + password door (server/src/routes/pin.js)
// and renews that session before it runs out, the same way tokens.js does for linked members.
export function makePhoneServiceAuth({ apiClient, phone, password }) {
  let cached = null; // { token, renewAt }

  async function getIdToken() {
    if (cached && Date.now() < cached.renewAt) return cached.token;
    if (cached) {
      try {
        const fresh = await apiClient.refreshSession(cached.token);
        cached = { token: fresh.token, renewAt: Date.now() + 6 * 3600_000 };
        return fresh.token;
      } catch { /* session ended (password changed, expired): sign in again below */ }
    }
    const { token } = await apiClient.pinLogin(phone, password);
    cached = { token, renewAt: Date.now() + 6 * 3600_000 };
    return token;
  }

  return { getIdToken };
}

export function makeServiceAuth({ firebaseAuth, email, password }) {
  let cached = null; // { idToken, refreshToken, expiresAt }

  async function getIdToken() {
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.idToken;
    if (cached?.refreshToken) {
      try {
        const { idToken, refreshToken, expiresInSec } = await firebaseAuth.refreshIdToken(cached.refreshToken);
        cached = { idToken, refreshToken, expiresAt: Date.now() + expiresInSec * 1000 };
        return idToken;
      } catch {
        // Refresh token may have been rotated out from under us (e.g. another process signed in with
        // the same account) - fall through to a fresh password sign-in instead of failing forever.
      }
    }
    const { idToken, refreshToken } = await firebaseAuth.signInWithPassword(email, password);
    // signInWithPassword doesn't report an expiry; Firebase ID tokens always last 1 hour.
    cached = { idToken, refreshToken, expiresAt: Date.now() + 55 * 60_000 };
    return idToken;
  }

  return { getIdToken };
}
