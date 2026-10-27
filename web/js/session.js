// Who is signed in, and what may they see? Drives the gateway panes and hands approved members to App.
// Sign-in methods: phone number + a 4-6 digit password (no SMS), Google, e-mail + password (with confirmation and "forgot password").
// Signing up needs only a name and a phone number or Telegram username; new members can use the platform at once.
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

  // A friend's invite link ("/?ref=<code>"): remembered on this device until the visitor signs up, then sent with the sign-up so the
  // friend earns TOP credits (server/src/lib/growth.js). U.store already shrugs off blocked storage.
  const REF_KEY = 'sng.ref';
  try {
    const ref = new URLSearchParams(location.search).get('ref');
    if (ref && /^[a-z0-9]{4,16}$/i.test(ref)) U.store.set(REF_KEY, ref.toLowerCase());
  } catch { /* no URL access: nothing to remember */ }
  const refBody = () => { const r = U.store.get(REF_KEY); return r ? { ref: r } : {}; };

  // ---- phone + PIN sessions (issued by our own server; Firebase is only used for the one-time SMS code) ----
  const PinSession = {
    KEY: 'sng.pinSession',
    get() { try { return JSON.parse(U.store.get(this.KEY) || 'null'); } catch { return null; } },
    set(v) { U.store.set(this.KEY, JSON.stringify(v)); },
    clear() { U.store.remove(this.KEY); },
    active() { const v = this.get(); return v && v.token && Date.parse(v.expiresAt) > Date.now() ? v : null; },
  };
  let refreshing = null;
  /** A PIN session lasts 30 days; swap it for a fresh one when under a week is left (best effort). */
  async function maybeRenewPin(v) {
    if (refreshing || Date.parse(v.expiresAt) - Date.now() > 7 * 86400000) return;
    refreshing = fetch(`${window.APP_CONFIG.apiBase || ''}/api/auth/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${v.token}`, 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.token) PinSession.set({ ...v, token: j.token, expiresAt: j.expiresAt }); })
      .catch(() => {}).finally(() => { refreshing = null; });
  }
  async function getToken(force) {
    const pin = PinSession.active();
    if (pin) { maybeRenewPin(pin); return pin.token; }
    return provider ? provider.getToken(force) : null;
  }

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
    for (const id of ['email-submit-btn', 'reset-submit-btn', 'google-signin-btn']) $(id).disabled = !ready;
    // phone + password does not use Firebase: it works as soon as the server answers
    for (const id of ['phone-send-btn', 'pin-submit-btn', 'reg-submit-btn']) $(id).disabled = false;
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

  // "Open the website, already signed in": the Telegram bot sends https://site/?login=<one-time code>. The code is removed from the address bar
  // at once, traded for a normal session, and any other sign-in in this browser gives way to it.
  let fromLoginLink = false;
  async function consumeLoginLink() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('login');
    if (!code) return;
    url.searchParams.delete('login');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    try {
      const r = await API.request('POST', '/api/auth/link-login', { body: { code }, retry: false });
      PinSession.set({ token: r.token, expiresAt: r.expiresAt, phone: r.phone });
      fromLoginLink = true;
    } catch (err) { startError(err.message || t('err_network')); }
  }

  async function start() {
    showPane('start');
    setReady(false);
    startError('');
    await window.TelegramMiniApp?.ready; // inside Telegram: waits for the auto sign-in attempt to land (or fail) first
    try { cfg = await loadConfig(); } catch { showError(t('err_server_down')); return; }
    App.applyConfig(cfg);
    await consumeLoginLink();
    // Phone + password does not need Firebase, so a returning member is let in (and a new one can sign up) even when Google's
    // scripts are slow or blocked on their network.
    const resumed = PinSession.active() ? refresh() : null;
    if (cfg.devAuth) { DevAuth.init(); provider = DevAuth; $('dev-signin').classList.remove('hidden'); } else { provider = await waitForFirebase(); }
    if (!provider) { startError(t('err_auth_unavailable')); await resumed; return; }
    provider.setLanguage?.(I18N.lang);
    provider.onChange(handleUser);
    await resumed;
    setTimeout(() => { fromLoginLink = false; }, 5000); // by then the browser's earlier sign-in (if any) has been dealt with
  }

  function clearSecrets() {
    for (const id of ['auth-password', 'auth-password2', 'auth-pin']) $(id).value = '';
  }

  async function handleUser(user) {
    if (user && fromLoginLink) { fromLoginLink = false; provider?.signOut?.(); return; } // the link was just used: it wins over an older sign-in in this browser
    if (user) PinSession.clear(); // a Firebase sign-in replaces any PIN session
    if (!user && PinSession.active()) return; // no Firebase user is expected while a PIN session is in use
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
  let refreshP = null;
  function refresh() { // several parallel requests can all learn at once that the subscription ended: one refresh serves them
    if (!refreshP) refreshP = refreshNow().finally(() => { refreshP = null; });
    return refreshP;
  }
  async function refreshNow() {
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
    Live.start(); // the live stream also tells a new member / a blocked member about changes at once
    if (me.status === 'approved') {
      $('auth-lockout-screen').classList.add('hidden');
      App.enter(me);
      return;
    }
    App.leave();
    if (me.status === 'none') {
      showSignup();
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

  function showSignup() {
    if ($('auth-pane-complete-profile').classList.contains('hidden')) {
      ['phone', 'tg', 'contact-email'].forEach((k) => { const el = $(`gate-request-${k}`); if (el) el.value = ''; });
      // Telegram gives us a display name + @handle straight away (see telegram-miniapp.js); a plain Google/e-mail
      // sign-up has none of this, so `me.name` (from Firebase) still wins when it is present.
      const tg = U.store.get('sng.tgProfile', null);
      $('gate-request-name').value = me.name || tg?.name || '';
      if (tg?.username) $('gate-request-tg').value = `@${tg.username}`;
      $('request-error').classList.add('hidden');
    }
    $('gate-request-email').value = me.login;
    $('gate-contact-email-wrap').classList.add('hidden');   // Google / e-mail accounts already have an address
    showPane('complete-profile');
  }

  async function signOut() {
    Live.stop();
    const hadPin = Boolean(PinSession.get());
    PinSession.clear();
    try { await provider?.signOut(); } catch { /* already signed out */ }
    if (hadPin) await handleUser(null); // a PIN session has no Firebase user whose sign-out would fire the listener
  }

  // ---------------------------------------------------------------- method tabs
  const TAB_ON = ['bg-white', 'text-blue-700', 'shadow-sm'];
  const TAB_OFF = ['text-slate-500', 'hover:text-slate-700'];
  function setMethod(name) {
    const method = ['google', 'email', 'phone'].includes(name) ? name : 'phone';
    document.querySelectorAll('#auth-methods [data-method]').forEach((b) => {
      const on = b.dataset.method === method;
      b.classList.remove(...(on ? TAB_OFF : TAB_ON));
      b.classList.add(...(on ? TAB_ON : TAB_OFF));
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('[data-method-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.methodPane !== method));
    startError('');
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

  // ---------------------------------------------------------------- phone + password (no SMS)
  /** "90 123 45 67", "998901234567", "+998 (90) 123-45-67", "00998..." -> "+998901234567" (or null). */
  function normalisePhone(raw) {
    let v = String(raw).trim().replace(/[\s()\-.]/g, '');
    if (v.startsWith('00')) v = `+${v.slice(2)}`;
    if (!v.startsWith('+')) {
      if (/^\d{9}$/.test(v)) v = `+998${v}`;            // a local Uzbek number without the country code
      else if (/^\d{10,15}$/.test(v)) v = `+${v}`;
    }
    return /^\+\d{8,15}$/.test(v) ? v : null;
  }
  const phoneSteps = ['phone-form', 'phone-pin-form', 'phone-register-form'];
  function showPhoneStep(name) {
    phoneSteps.forEach((id) => $(id).classList.toggle('hidden', id !== name));
    startError('');
  }

  /** Step 1: the number. A known number asks for its password; a new one offers to create the account. */
  async function continuePhone(e) {
    e?.preventDefault();
    const form = $('phone-form');
    U.clearFormErrors(form);
    startError('');
    const phone = normalisePhone($('auth-phone').value);
    if (!phone) { U.fieldError($('auth-phone'), t('autherr_bad_phone')); return; }
    U.setBusy(form, true);
    try {
      phoneNumber = phone;
      let exists = false;
      try { exists = (await API.request('POST', '/api/auth/phone/check', { body: { phone }, retry: false })).exists; } catch (err) { startError(err.message || t('err_network')); return; }
      if (exists) {
        $('pin-target').textContent = phone;
        const owner = cfg?.ownerContact || '';
        $('pin-owner-contact').textContent = owner;
        $('pin-owner-contact').href = owner ? `mailto:${owner}` : '#';
        $('auth-pin').value = '';
        showPhoneStep('phone-pin-form');
        $('auth-pin').focus();
      } else {
        $('reg-target').textContent = phone;
        U.clearFormErrors($('phone-register-form'));
        $('reg-error').classList.add('hidden');
        showPhoneStep('phone-register-form');
        $('reg-name').focus();
      }
    } finally { U.setBusy(form, false); }
  }

  /** Existing account: phone + password. */
  async function submitPin(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    startError('');
    const pin = $('auth-pin').value.trim();
    if (!/^\d{4,6}$/.test(pin)) { U.fieldError($('auth-pin'), t('v_pin_format')); return; }
    U.setBusy(form, true);
    try {
      const r = await API.request('POST', '/api/auth/pin/login', { body: { phone: phoneNumber, pin }, retry: false });
      PinSession.set({ token: r.token, expiresAt: r.expiresAt, phone: phoneNumber });
      $('auth-pin').value = '';
      await refresh();
    } catch (err) {
      $('auth-pin').value = '';
      if (err.code === 'pin_locked') startError(t('pin_locked', { min: err.details?.[0]?.params?.min ?? 15 }));
      else if (err.status === 401) { U.fieldError($('auth-pin'), t('pin_wrong')); }
      else startError(err.message || t('err_network'));
    } finally { U.setBusy(form, false); }
  }

  /** New number: name + password, and the account exists. */
  async function submitRegister(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    $('reg-error').classList.add('hidden');
    const name = $('reg-name').value.trim();
    let ok = true;
    if (!name) { U.fieldError($('reg-name'), t('err_required')); ok = false; }
    if (!checkPinPair($('reg-pin').value.trim(), $('reg-pin2').value.trim(), $('reg-pin'), $('reg-pin2'))) ok = false;
    if (!ok) { form.querySelector('.field-invalid')?.focus(); return; }
    U.setBusy(form, true);
    try {
      const r = await API.request('POST', '/api/auth/phone/register', { body: { phone: phoneNumber, pin: $('reg-pin').value.trim(), contactName: name, telegram: $('reg-tg').value.trim(), ...($('reg-persona').value ? { persona: $('reg-persona').value } : {}), ...refBody() }, retry: false });
      PinSession.set({ token: r.token, expiresAt: r.expiresAt, phone: phoneNumber });
      $('reg-pin').value = ''; $('reg-pin2').value = '';
      await refresh();
    } catch (err) {
      if (err.code === 'validation_error') {
        const fields = { contactName: 'reg-name', pin: 'reg-pin', telegram: 'reg-tg' };
        for (const d of err.details || []) {
          if (d.code === 'phone_taken') { // someone registered it a moment ago: go to the password step instead
            await continuePhone(); return;
          }
          const el = $(fields[d.path]);
          if (el) U.fieldError(el, U.detailText(d)); else { $('reg-error').textContent = U.detailText(d); $('reg-error').classList.remove('hidden'); }
        }
      } else { $('reg-error').textContent = err.status === 429 ? t('err_too_many_accounts') : (err.message || t('err_network')); $('reg-error').classList.remove('hidden'); }
    } finally { U.setBusy(form, false); }
  }

  function changeNumber() {
    showPhoneStep('phone-form');
    $('auth-phone').focus();
  }

  // ---------------------------------------------------------------- password rules (the same ones the server enforces)
  function checkPinPair(a, b, aEl, bEl) {
    let ok = true;
    if (!/^\d{4,6}$/.test(a)) { U.fieldError(aEl, t('v_pin_format')); ok = false; }
    else if (a !== b) { U.fieldError(bEl, t('pin_mismatch')); ok = false; }
    return ok;
  }

  // ---------------------------------------------------------------- show / hide password
  /** Every password field gets an eye button (the e-mail ones already have one in the markup). */
  function addPasswordEyes() {
    document.querySelectorAll('input[type="password"]').forEach((input) => {
      if (!input.id || input.dataset.eye || input.parentElement.querySelector('[data-toggle-password]')) return;
      const wrap = document.createElement('div');
      wrap.className = 'relative';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      input.classList.add('pr-10');
      input.dataset.eye = '1';
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.togglePassword = input.id;
      b.className = 'absolute inset-y-0 right-0 px-3 text-slate-400 hover:text-slate-600';
      b.dataset.i18nAria = 'show_password'; // re-translated whenever the language changes
      b.setAttribute('aria-label', t('show_password'));
      b.innerHTML = '<i data-lucide="eye" class="w-4 h-4"></i>';
      wrap.appendChild(b);
    });
    lucide.createIcons();
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    addPasswordEyes();
    setMethod('phone'); // phone is always the first and automatically chosen way in
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

    $('phone-form').addEventListener('submit', continuePhone);
    $('phone-pin-form').addEventListener('submit', submitPin);
    $('phone-register-form').addEventListener('submit', submitRegister);
    $('pin-change-btn').addEventListener('click', changeNumber);
    $('reg-change-btn').addEventListener('click', changeNumber);
    $('auth-phone').value = '+998 ';
    $('auth-phone').addEventListener('input', () => { $('auth-phone').value = $('auth-phone').value.replace(/[^\d+\s()-]/g, ''); });
    for (const id of ['auth-pin', 'reg-pin', 'reg-pin2']) $(id).addEventListener('input', () => { $(id).value = $(id).value.replace(/\D/g, '').slice(0, 6); });

    I18N.onChange((lang) => { provider?.setLanguage?.(lang); });

    document.querySelectorAll('[data-action="gate-signout"]').forEach((b) => b.addEventListener('click', signOut));
    $('auth-retry-btn').addEventListener('click', () => { if (provider) refresh(); else start(); });

    $('request-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      U.clearFormErrors(form);
      $('request-error').classList.add('hidden');
      const body = { contactName: $('gate-request-name').value.trim(), telegram: $('gate-request-tg').value.trim(), phone: $('gate-request-phone').value.trim() };
      if ($('gate-request-persona').value) body.persona = $('gate-request-persona').value;
      Object.assign(body, refBody());
      let ok = true;
      if (!body.contactName) { U.fieldError($('gate-request-name'), t('err_required')); ok = false; }
      if (!body.phone && !body.telegram) { U.fieldError($('gate-request-phone'), t('v_contact_required')); U.fieldError($('gate-request-tg'), t('v_contact_required')); ok = false; }
      if (!ok) { form.querySelector('.field-invalid')?.focus(); return; }
      if (body.phone) { const p = normalisePhone(body.phone); if (p) body.phone = p; }
      U.setBusy(form, true);
      try {
        await API.post('/api/me/access-request', body);
        await refresh();
      } catch (err) {
        if (err.code === 'validation_error') {
          const fields = { phone: 'gate-request-phone', telegram: 'gate-request-tg', contactName: 'gate-request-name', contactEmail: 'gate-request-contact-email' };
          for (const d of err.details || []) { const input = fields[d.path]; if (input) U.fieldError($(input), U.detailText(d)); }
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
    getToken,
    normalisePhone,
    pinSession: () => PinSession.get(),
    storePinToken: (token, expiresAt) => PinSession.set({ ...(PinSession.get() || {}), token, expiresAt }),
    authInfo: () => {
      const pin = PinSession.active();
      if (pin) return { email: '', phone: pin.phone, providers: ['pin'], hasPassword: false, hasGoogle: false, pin: true };
      return provider?.info?.() ?? null;
    },
    changePassword: (current, next) => provider.changePassword(current, next),
    sendReset: (email) => provider.sendReset(email),
    get me() { return me; },
    get config() { return cfg; },
  };
})();

window.Session = Session;
