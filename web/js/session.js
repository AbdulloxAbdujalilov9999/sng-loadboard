// Who is signed in, and what may they see? Drives the gateway panes and hands approved members to App.
const Session = (() => {
  const { $ } = U;
  const PANES = ['start', 'complete-profile', 'pending', 'rejected', 'error'];
  let provider = null;
  let cfg = null;
  let me = null;

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

  function setReady(ready) {
    $('google-signin-btn').disabled = !ready;
    $('google-signin-btn-label').textContent = ready ? t('btn_google_continue') : t('auth_checking');
  }

  function mapAuthError(err) {
    const code = String(err?.code || '');
    if (code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) return t('autherr_cancelled');
    if (code.includes('popup-blocked')) return t('autherr_popup_blocked');
    if (code.includes('unauthorized-domain')) return t('autherr_domain');
    if (code.includes('network-request-failed')) return t('err_network');
    if (code.includes('operation-not-allowed')) return t('autherr_not_enabled');
    return `${t('autherr_generic')} ${err?.message || ''}`.trim();
  }

  // ---- local development provider (only used when the server advertises devAuth) ----
  const DevAuth = {
    listeners: new Set(),
    user: null,
    init() { const email = U.store.get('sng.devEmail'); this.user = email ? { email } : null; },
    onChange(cb) { this.listeners.add(cb); queueMicrotask(() => cb(this.user)); return () => this.listeners.delete(cb); },
    async signIn(email) { this.user = { email }; U.store.set('sng.devEmail', email); this.listeners.forEach((cb) => cb(this.user)); },
    async signOut() { this.user = null; U.store.remove('sng.devEmail'); this.listeners.forEach((cb) => cb(null)); },
    async getToken() { return this.user ? `dev:${this.user.email}:${this.user.email.split('@')[0]}` : null; },
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
    provider.onChange(handleUser);
  }

  async function handleUser(user) {
    if (!user) {
      me = null;
      Live.stop();
      App.leave();
      showPane('start');
      setReady(true);
      return;
    }
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
      $('gate-request-email').value = me.email;
      if ($('auth-pane-complete-profile').classList.contains('hidden')) {
        ['company', 'phone', 'tg'].forEach((k) => { $(`gate-request-${k}`).value = ''; });
        $('request-error').classList.add('hidden');
      }
      showPane('complete-profile');
    } else if (me.status === 'pending') {
      $('pending-target-email').textContent = me.email;
      showPane('pending');
    } else {
      const link = $('owner-contact-link');
      link.textContent = me.ownerContact || cfg?.ownerContact || '';
      link.href = `mailto:${me.ownerContact || cfg?.ownerContact || ''}`;
      showPane('rejected');
    }
  }

  async function signIn() {
    startError('');
    const btn = $('google-signin-btn');
    btn.disabled = true;
    try { await provider.signIn(); } catch (err) { startError(mapAuthError(err)); } finally { btn.disabled = false; }
  }

  async function signOut() {
    Live.stop();
    try { await provider?.signOut(); } catch { /* already signed out */ }
  }

  function init() {
    $('google-signin-btn').addEventListener('click', signIn);
    $('dev-signin').addEventListener('submit', async (e) => {
      e.preventDefault();
      await provider.signIn($('dev-email').value.trim().toLowerCase());
    });
    document.querySelectorAll('[data-action="gate-signout"]').forEach((b) => b.addEventListener('click', signOut));
    $('auth-retry-btn').addEventListener('click', () => { if (provider) refresh(); else start(); });

    $('request-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      U.clearFormErrors(form);
      $('request-error').classList.add('hidden');
      const body = { company: $('gate-request-company').value, phone: $('gate-request-phone').value, telegram: $('gate-request-tg').value, contactName: $('gate-request-name').value };
      U.setBusy(form, true);
      try {
        await API.post('/api/me/access-request', body);
        await refresh();
      } catch (err) {
        if (err.code === 'validation_error') {
          for (const d of err.details || []) {
            const input = { company: 'gate-request-company', phone: 'gate-request-phone', telegram: 'gate-request-tg' }[d.path];
            if (input) U.fieldError($(input), d.message);
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

  return { init, start, refresh, signOut, getToken: (force) => (provider ? provider.getToken(force) : Promise.resolve(null)), get me() { return me; }, get config() { return cfg; } };
})();

window.Session = Session;
