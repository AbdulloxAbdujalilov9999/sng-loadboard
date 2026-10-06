// Who is signed in, and what may they see? Drives the gateway panes and hands approved members to App.
// Sign-in methods: Google, e-mail + password (with e-mail confirmation and "forgot password"), phone (SMS code).
const Session = (() => {
  const { $ } = U;
  const PANES = ['start', 'verify-email', 'complete-profile', 'pending', 'rejected', 'error'];
  const RESEND_SECONDS = 60;
  let provider = null;
  let cfg = null;
  let me = null;
  let emailMode = 'signin'; // or 'signup'
  let phoneNumber = '';
  let ready = false;

  function showPane(name) {
    $('auth-lockout-screen').classList.remove('hidden');
    $('app-workspace').classList.add('hidden');
    PANES.forEach((p) => $(`auth-pane-${p}`).classList.toggle('hidden', p !== name));
  }

  function startError(msg) {
    const el = $('auth-start-error');
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
  }

  function setReady(isReady) {
    ready = isReady;
    $('google-signin-btn').disabled = !ready;
    $('google-signin-btn-label').textContent = ready ? t('btn_google_continue') : t('auth_checking');
    for (const id of ['email-submit-btn', 'reset-submit-btn', 'phone-send-btn', 'phone-verify-btn']) $(id).disabled = !ready;
  }

  const MESSAGES = {
    'popup-closed-by-user': 'autherr_cancelled', 'cancelled-popup-request': 'autherr_cancelled', 'popup-blocked': 'autherr_popup_blocked',
    'unauthorized-domain': 'autherr_domain', 'network-request-failed': 'err_network',
    'invalid-credential': 'autherr_bad_login', 'wrong-password': 'autherr_bad_login', 'user-not-found': 'autherr_bad_login', 'invalid-login-credentials': 'autherr_bad_login',
    'email-already-in-use': 'autherr_email_in_use', 'weak-password': 'autherr_weak_password', 'invalid-email': 'autherr_invalid_email', 'missing-email': 'autherr_invalid_email',
    'too-many-requests': 'autherr_too_many', 'user-disabled': 'autherr_disabled',
    'invalid-phone-number': 'autherr_bad_phone', 'missing-phone-number': 'autherr_bad_phone',
    'invalid-verification-code': 'autherr_bad_code', 'missing-verification-code': 'autherr_bad_code', 'code-expired': 'autherr_code_expired', 'session-expired': 'autherr_code_expired',
    'quota-exceeded': 'autherr_sms_quota', 'captcha-check-failed': 'autherr_captcha', 'requires-recent-login': 'autherr_recent_login',
  };
  function mapAuthError(err, method) {
    const code = String(err?.code || '').replace('auth/', '');
    if (code === 'operation-not-allowed') return t(method === 'phone' ? 'autherr_phone_not_enabled' : method === 'email' ? 'autherr_email_not_enabled' : 'autherr_not_enabled');
    if (MESSAGES[code]) return t(MESSAGES[code]);
    return `${t('autherr_generic')} ${code}`.trim();
  }

  // ---- local development provider (only used when the server advertises devAuth) ----
  // Emulates every Firebase flow offline: any e-mail/password pair works, "e-mails" are confirmed on the spot,
  // and the SMS code is always 123456. It never talks to Firebase and the server refuses its tokens in production.
  const DevAuth = {
    listeners: new Set(),
    user: null,
    init() { try { this.user = JSON.parse(U.store.get('sng.devUser') || 'null'); } catch { this.user = null; } },
    persist() { if (this.user) U.store.set('sng.devUser', JSON.stringify(this.user)); else U.store.remove('sng.devUser'); },
    view() { const u = this.user; return u ? { email: u.email || '', phone: u.phone || '', providers: u.providers, hasPassword: u.providers.includes('password'), hasGoogle: false, needsVerification: Boolean(u.unverified) } : null; },
    emit() { this.persist(); this.listeners.forEach((cb) => cb(this.view())); },
    onChange(cb) { this.listeners.add(cb); queueMicrotask(() => cb(this.view())); return () => this.listeners.delete(cb); },
    info() { return this.view(); },
    setLanguage() {},
    async signInDev(email) { this.user = { email, providers: ['google.com'] }; this.emit(); },
    async signInEmail(email) { this.user = { email, providers: ['password'], password: true }; this.emit(); },
    async signUpEmail(email) { this.user = { email, providers: ['password'], unverified: true }; this.emit(); },
    async resendVerification() {},
    async reload() { if (this.user) { this.user.unverified = false; this.emit(); } return this.view(); },
    async sendReset() {},
    async phoneStart(phone) { this.pendingPhone = phone; },
    async phoneConfirm(code) {
      if (code !== '123456') throw Object.assign(new Error('bad'), { code: 'auth/invalid-verification-code' });
      this.user = { phone: this.pendingPhone, providers: ['phone'] };
      this.emit();
    },
    phoneReset() { this.pendingPhone = null; },
    async changePassword(current, next) { if (!current || next.length < 8) throw Object.assign(new Error('bad'), { code: 'auth/invalid-credential' }); },
    async signOut() { this.user = null; this.emit(); },
    async getToken() {
      const u = this.user;
      if (!u) return null;
      return u.phone ? `devphone:${u.phone}` : `dev:${u.email}:${u.email.split('@')[0]}`;
    },
  };

  async function loadConfig() {
    const res = await fetch(`${window.APP_CONFIG.apiBase || ''}/api/config`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`config ${res.status}`);
    return res.json();
  }

  function waitForFirebase(ms = 10000) {
    if (window.FirebaseAuth) return Promise.resolve(window.FirebaseAuth);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      window.addEventListener('firebase-ready', () => { clearTimeout(timer); resolve(window.FirebaseAuth); }, { once: true });
    });
  }

  function showError(message) {
    $('auth-error-msg').textContent = message;
    showPane('error');
  }

  async function start() {
    showPane('start');
    setReady(false);
    startError('');
    try { cfg = await loadConfig(); } catch { showError(t('err_server_down')); return; }
    App.applyConfig(cfg);
    if (cfg.devAuth) { DevAuth.init(); provider = DevAuth; $('dev-signin').classList.remove('hidden'); } else { provider = await waitForFirebase(); }
    if (!provider) { showError(t('err_auth_unavailable')); return; }
    provider.setLanguage?.(I18N.lang);
    provider.onChange(handleUser);
  }

  function clearSecrets() {
    for (const id of ['auth-password', 'auth-password2', 'auth-code']) $(id).value = '';
  }

  async function handleUser(user) {
    if (!user) {
      me = null;
      Live.stop();
      App.leave();
      clearSecrets();
      showPane('start');
      setReady(true);
      return;
    }
    if (user.needsVerification) {
      // The API refuses unconfirmed e-mail accounts, so don't even ask it.
      Live.stop();
      App.leave();
      clearSecrets();
      $('verify-target-email').textContent = user.email;
      setVerifyMsg('');
      showPane('verify-email');
      return;
    }
    clearSecrets();
    await refresh();
  }

  /** Re-ask the server who we are and route accordingly. Called after sign-in and on 'me' live events. */
  async function refresh() {
    let fresh;
    try {
      fresh = await API.get('/api/me');
    } catch (err) {
      if (err.status === 401) { await signOut(); startError(t('err_session_expired')); return; }
      showError(err.message || t('err_server_down'));
      return;
    }
    me = fresh;
    route();
  }

  function route() {
    Live.start(); // pending/declined users also listen, so approval takes effect without reloading
    if (me.status === 'approved') {
      $('auth-lockout-screen').classList.add('hidden');
      App.enter(me);
      return;
    }
    App.leave();
    if (me.status === 'none') {
      $('gate-request-name').value = me.name || '';
      $('gate-request-email').value = me.login;
      $('gate-contact-email-wrap').classList.toggle('hidden', me.provider !== 'phone');
      if ($('auth-pane-complete-profile').classList.contains('hidden')) {
        ['company', 'phone', 'tg', 'contact-email'].forEach((k) => { $(`gate-request-${k}`).value = ''; });
        if (me.provider === 'phone') $('gate-request-phone').value = me.login; // they just proved this number
        $('request-error').classList.add('hidden');
      }
      showPane('complete-profile');
    } else if (me.status === 'pending') {
      $('pending-target-email').textContent = me.login;
      showPane('pending');
    } else {
      const link = $('owner-contact-link');
      link.textContent = me.ownerContact || cfg?.ownerContact || '';
      link.href = `mailto:${me.ownerContact || cfg?.ownerContact || ''}`;
      showPane('rejected');
    }
  }

  async function signOut() {
    Live.stop();
    try { await provider?.signOut(); } catch { /* already signed out */ }
  }

  // ---------------------------------------------------------------- method tabs
  const TAB_ON = ['bg-white', 'text-blue-700', 'shadow-sm'];
  const TAB_OFF = ['text-slate-500', 'hover:text-slate-700'];
  function setMethod(name) {
    const method = ['google', 'email', 'phone'].includes(name) ? name : 'google';
    document.querySelectorAll('#auth-methods [data-method]').forEach((b) => {
      const on = b.dataset.method === method;
      b.classList.remove(...(on ? TAB_OFF : TAB_ON));
      b.classList.add(...(on ? TAB_ON : TAB_OFF));
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('[data-method-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.methodPane !== method));
    startError('');
    U.store.set('sng.authMethod', method);
  }

  // ---------------------------------------------------------------- e-mail + password
  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  const strongPassword = (v) => v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v);

  function setEmailMode(mode) {
    emailMode = mode;
    const signup = mode === 'signup';
    $('email-form-title').textContent = t(signup ? 'auth_signup_title' : 'auth_signin_title');
    $('email-submit-btn').textContent = t(signup ? 'btn_create_account' : 'btn_signin');
    $('email-switch-text').textContent = t(signup ? 'auth_have_account' : 'auth_no_account');
    $('email-switch-btn').textContent = t(signup ? 'btn_signin' : 'auth_create_account');
    $('auth-confirm-wrap').classList.toggle('hidden', !signup);
    $('forgot-link').classList.toggle('hidden', signup);
    $('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
    U.clearFormErrors($('email-form'));
    startError('');
  }

  async function submitEmail(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    startError('');
    const email = $('auth-email').value.trim().toLowerCase();
    const password = $('auth-password').value;
    let ok = true;
    if (!validEmail(email)) { U.fieldError($('auth-email'), t('autherr_invalid_email')); ok = false; }
    if (!password) { U.fieldError($('auth-password'), t('err_required')); ok = false; }
    if (emailMode === 'signup') {
      if (password && !strongPassword(password)) { U.fieldError($('auth-password'), t('pw_rules')); ok = false; }
      if (password && $('auth-password2').value !== password) { U.fieldError($('auth-password2'), t('pw_mismatch')); ok = false; }
    }
    if (!ok) { form.querySelector('.field-invalid')?.focus(); return; }
    U.setBusy(form, true);
    try {
      if (emailMode === 'signup') await provider.signUpEmail(email, password);
      else await provider.signInEmail(email, password);
    } catch (err) { startError(mapAuthError(err, 'email')); } finally { U.setBusy(form, false); }
  }

  function showReset(on) {
    $('email-form').classList.toggle('hidden', on);
    $('reset-form').classList.toggle('hidden', !on);
    $('reset-ok').classList.add('hidden');
    U.clearFormErrors($('reset-form'));
    startError('');
    if (on) { $('reset-email').value = $('auth-email').value.trim(); $('reset-email').focus(); }
  }

  async function submitReset(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    const email = $('reset-email').value.trim().toLowerCase();
    if (!validEmail(email)) { U.fieldError($('reset-email'), t('autherr_invalid_email')); return; }
    U.setBusy(form, true);
    try {
      await provider.sendReset(email);
    } catch (err) {
      // "no such user" is reported as success on purpose: never reveal which e-mails have accounts.
      const code = String(err?.code || '');
      if (!code.includes('user-not-found')) { startError(mapAuthError(err, 'email')); U.setBusy(form, false); return; }
    }
    const ok = $('reset-ok');
    ok.textContent = t('auth_reset_sent', { email });
    ok.classList.remove('hidden');
    U.setBusy(form, false);
    cooldown($('reset-submit-btn'), 'auth_send_reset', 30); // gentle brake on repeat sends
  }

  // ---------------------------------------------------------------- e-mail confirmation
  function setVerifyMsg(msg, kind = 'info') {
    const el = $('verify-msg');
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
    el.className = `text-[11px] font-semibold rounded p-2 ${msg ? '' : 'hidden'} ${kind === 'error' ? 'text-rose-700 bg-rose-50 border border-rose-200' : 'text-emerald-700 bg-emerald-50 border border-emerald-200'}`;
  }

  function cooldown(btn, label, seconds = RESEND_SECONDS) {
    const base = t(label);
    let left = seconds;
    btn.disabled = true;
    const tick = () => {
      if (left <= 0) { btn.disabled = false; btn.textContent = base; return; }
      btn.textContent = `${base} (${left}s)`;
      left -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }

  async function verifyDone() {
    const btn = $('verify-done-btn');
    btn.disabled = true;
    try {
      const v = await provider.reload();
      if (v?.needsVerification) setVerifyMsg(t('verify_not_yet'), 'error');
      else await handleUser(v);
    } catch (err) { setVerifyMsg(mapAuthError(err, 'email'), 'error'); } finally { btn.disabled = false; }
  }

  async function verifyResend() {
    try { await provider.resendVerification(); setVerifyMsg(t('verify_resent')); cooldown($('verify-resend-btn'), 'verify_resend'); } catch (err) {
      setVerifyMsg(mapAuthError(err, 'email'), 'error');
    }
  }

  // ---------------------------------------------------------------- phone
  function normalisePhone(raw) {
    let v = String(raw).trim().replace(/[\s()\-.]/g, '');
    if (v.startsWith('00')) v = `+${v.slice(2)}`;
    return /^\+\d{8,15}$/.test(v) ? v : null;
  }

  async function sendCode(e) {
    e?.preventDefault();
    const form = $('phone-form');
    U.clearFormErrors(form);
    startError('');
    const phone = normalisePhone($('auth-phone').value);
    if (!phone) { U.fieldError($('auth-phone'), t('autherr_bad_phone')); return; }
    U.setBusy(form, true);
    try {
      // The invisible reCAPTCHA can stall (blocked script, flaky network); never leave the person waiting forever.
      await Promise.race([
        provider.phoneStart(phone, 'phone-send-btn'),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('captcha timeout'), { code: 'auth/captcha-check-failed' })), 30000)),
      ]);
      phoneNumber = phone;
      $('phone-code-target').textContent = phone;
      $('phone-form').classList.add('hidden');
      $('phone-code-form').classList.remove('hidden');
      $('auth-code').value = '';
      $('auth-code').focus();
      cooldown($('phone-resend-btn'), 'auth_resend_code');
    } catch (err) {
      provider.phoneReset?.();
      startError(mapAuthError(err, 'phone'));
    } finally { U.setBusy(form, false); }
  }

  async function verifyCode(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    startError('');
    const code = $('auth-code').value.trim();
    if (!/^\d{6}$/.test(code)) { U.fieldError($('auth-code'), t('autherr_bad_code')); return; }
    U.setBusy(form, true);
    try { await provider.phoneConfirm(code); } catch (err) { startError(mapAuthError(err, 'phone')); } finally { U.setBusy(form, false); }
  }

  function changeNumber() {
    provider?.phoneReset?.();
    $('phone-code-form').classList.add('hidden');
    $('phone-form').classList.remove('hidden');
    $('auth-phone').focus();
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    setMethod(U.store.get('sng.authMethod', 'google'));
    document.querySelectorAll('#auth-methods [data-method]').forEach((b) => b.addEventListener('click', () => setMethod(b.dataset.method)));

    $('google-signin-btn').addEventListener('click', async () => {
      startError('');
      const btn = $('google-signin-btn');
      btn.disabled = true;
      try { await provider.signInGoogle(); } catch (err) { startError(mapAuthError(err, 'google')); } finally { btn.disabled = false; }
    });

    $('dev-signin').addEventListener('submit', async (e) => {
      e.preventDefault();
      await provider.signInDev($('dev-email').value.trim().toLowerCase());
    });

    setEmailMode('signin');
    $('email-form').addEventListener('submit', submitEmail);
    $('email-switch-btn').addEventListener('click', () => setEmailMode(emailMode === 'signin' ? 'signup' : 'signin'));
    $('forgot-link').addEventListener('click', () => showReset(true));
    $('reset-back-btn').addEventListener('click', () => showReset(false));
    $('reset-form').addEventListener('submit', submitReset);
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-toggle-password]');
      if (!b) return;
      const input = $(b.dataset.togglePassword);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.querySelector('i')?.setAttribute('data-lucide', show ? 'eye-off' : 'eye');
      lucide.createIcons();
    });

    $('verify-done-btn').addEventListener('click', verifyDone);
    $('verify-resend-btn').addEventListener('click', verifyResend);

    $('phone-form').addEventListener('submit', sendCode);
    $('phone-code-form').addEventListener('submit', verifyCode);
    $('phone-resend-btn').addEventListener('click', () => sendCode());
    $('phone-change-btn').addEventListener('click', changeNumber);
    $('auth-phone').addEventListener('input', () => { $('auth-phone').value = $('auth-phone').value.replace(/[^\d+\s()-]/g, ''); });
    $('auth-code').addEventListener('input', () => { $('auth-code').value = $('auth-code').value.replace(/\D/g, '').slice(0, 6); });

    I18N.onChange((lang) => { provider?.setLanguage?.(lang); });

    document.querySelectorAll('[data-action="gate-signout"]').forEach((b) => b.addEventListener('click', signOut));
    $('auth-retry-btn').addEventListener('click', () => { if (provider) refresh(); else start(); });

    $('request-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      U.clearFormErrors(form);
      $('request-error').classList.add('hidden');
      const body = { company: $('gate-request-company').value, phone: $('gate-request-phone').value, telegram: $('gate-request-tg').value, contactName: $('gate-request-name').value };
      if (!$('gate-contact-email-wrap').classList.contains('hidden')) body.contactEmail = $('gate-request-contact-email').value.trim();
      U.setBusy(form, true);
      try {
        await API.post('/api/me/access-request', body);
        await refresh();
      } catch (err) {
        if (err.code === 'validation_error') {
          for (const d of err.details || []) {
            const input = { company: 'gate-request-company', phone: 'gate-request-phone', telegram: 'gate-request-tg', contactName: 'gate-request-name', contactEmail: 'gate-request-contact-email' }[d.path];
            if (input) U.fieldError($(input), U.detailText(d));
          }
        } else if (err.status === 409) {
          await refresh();
        } else {
          const el = $('request-error');
          el.textContent = err.message;
          el.classList.remove('hidden');
        }
      } finally {
        U.setBusy(form, false);
      }
    });
  }

  /** Re-translate texts that JavaScript (not data-i18n) sets, after a language change. */
  function relabel() {
    $('google-signin-btn-label').textContent = ready ? t('btn_google_continue') : t('auth_checking');
    setEmailMode(emailMode);
  }

  return {
    init, start, refresh, signOut, mapAuthError, relabel,
    getToken: (force) => (provider ? provider.getToken(force) : Promise.resolve(null)),
    authInfo: () => provider?.info?.() ?? null,
    changePassword: (current, next) => provider.changePassword(current, next),
    sendReset: (email) => provider.sendReset(email),
    get me() { return me; },
    get config() { return cfg; },
  };
})();

window.Session = Session;
