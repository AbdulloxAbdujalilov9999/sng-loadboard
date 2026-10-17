// Telegram Mini App bootstrap. When this page is opened inside Telegram, Telegram hands it a signed
// `initData` string proving who the user is; we trade that for a session token (see
// server/src/routes/telegramAuth.js) and store it exactly like a phone+PIN session (sng.pinSession),
// so the existing sign-in gate in session.js sees it and skips straight past the login screen.
// Outside Telegram (the regular website) this file does nothing.
window.TelegramMiniApp = (() => {
  const tg = window.Telegram?.WebApp;
  // The Telegram Web App SDK script defines window.Telegram.WebApp as a stub in ANY browser that
  // merely loads it - not only inside real Telegram - so tg's mere existence is not a valid signal
  // (this cost the main site its own layout for a while: every ordinary visit got treated as a Mini
  // App). tg.platform is Telegram's own documented way to tell them apart: a real client reports its
  // actual platform ("ios", "tdesktop", "web", ...); the stub reports "unknown".
  if (!tg || tg.platform === 'unknown') return { active: false, ready: Promise.resolve(false) };

  // Being genuinely inside Telegram, the Mini App layout (tg-miniapp class, bottom tabs, Home
  // landing) always applies, regardless of initData below. initData is a separate, narrower concern:
  // whether there's a signed session to auto sign in with. If it's ever empty (a client quirk, a
  // launch path that omits it), the person still gets the right Mini App UI, just with the normal
  // sign-in screen inside it.
  tg.ready();
  tg.expand();
  document.documentElement.classList.add('tg-miniapp');

  const initData = tg.initData || '';
  if (!initData) return { active: true, ready: Promise.resolve(false) };

  // Display hints only (never trusted for auth): prefilled into the "complete your profile" form if a
  // brand-new Telegram user has to sign up. The server verifies the real identity from initData itself.
  const tgUser = tg.initDataUnsafe?.user;
  if (tgUser) {
    U.store.set('sng.tgProfile', {
      name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '),
      username: tgUser.username || '',
    });
  }

  const ready = fetch(`${window.APP_CONFIG.apiBase || ''}/api/auth/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ initData }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((session) => {
      if (session?.token) U.store.set('sng.pinSession', JSON.stringify({ token: session.token, expiresAt: session.expiresAt, phone: '' }));
    })
    .catch(() => { /* the normal sign-in gate still works as a fallback */ })
    .then(() => true);

  return { active: true, ready };
})();
