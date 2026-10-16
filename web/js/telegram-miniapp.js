// Telegram Mini App bootstrap. When this page is opened inside Telegram, Telegram hands it a signed
// `initData` string proving who the user is; we trade that for a session token (see
// server/src/routes/telegramAuth.js) and store it exactly like a phone+PIN session (sng.pinSession),
// so the existing sign-in gate in session.js sees it and skips straight past the login screen.
// Outside Telegram (the regular website, window.Telegram is absent) this file does nothing.
window.TelegramMiniApp = (() => {
  const tg = window.Telegram?.WebApp;
  const initData = tg?.initData || '';
  if (!tg || !initData) return { active: false, ready: Promise.resolve(false) };

  tg.ready();
  tg.expand();
  document.documentElement.classList.add('tg-miniapp');

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
