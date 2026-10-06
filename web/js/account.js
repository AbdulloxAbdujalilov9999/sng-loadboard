// The signed-in member's profile: shown, edited, and used to prefill contact fields on new posts.
const Account = (() => {
  const { $ } = U;

  const initials = (name) => (name || '?').trim().slice(0, 2).toUpperCase();

  function populate() {
    const me = Session.me;
    if (!me?.profile) return;
    const p = me.profile;
    const set = (id, v) => { $(id).value = v || ''; };
    set('setting-company-name', p.company);
    set('setting-dispatcher-name', p.contactName);
    set('setting-phone', p.phone);
    set('setting-tg', p.telegram);
    set('setting-email', p.login);
    set('setting-contact-email', p.contactEmail);
    set('setting-location', p.location);
    set('setting-tir', p.tirCarnet);
    set('setting-fleet', p.fleet);
    set('setting-routes', p.routes);
    set('setting-default-dh', U.store.get('sng.defaultDh', 100));

    $('acc-big-avatar').textContent = me.isOwner ? '★' : initials(p.company);
    $('acc-title-name').textContent = p.company;
    $('acc-status-badge').textContent = me.isOwner ? t('role_owner') : t('role_member');
    $('acc-sub-details').textContent = [p.tirCarnet ? `TIR ${p.tirCarnet}` : t('no_tir'), p.location || t('no_location')].join(' • ');
    $('posting-as-company').textContent = p.company;
    prefillContacts();
    renderSecurity();
    Prefs.syncLanguage(); Prefs.syncCurrency();
    App.renderSidebarUser();
  }

  /** New posts default to the profile's contact details (still editable per post). */
  function prefillContacts() {
    const p = Session.me?.profile;
    if (!p) return;
    // Only overwrite fields that are empty or still hold what we auto-filled earlier - never text the user typed.
    const fill = (id, v) => {
      const el = $(id);
      if (!el || (el.value && el.value !== el.dataset.auto)) return;
      el.value = v || '';
      el.dataset.auto = el.value;
    };
    fill('post-contact-name', p.contactName); fill('post-phone', p.phone); fill('post-email', p.contactEmail || p.email); // phone sign-ins have no login e-mail: stays blank until they set one fill('post-tg', p.telegram);
    fill('truck-post-phone', p.phone); fill('truck-post-tg', p.telegram);
    $('contact-incomplete').classList.toggle('hidden', Boolean(p.phone && p.telegram));
  }

  async function save(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    const body = {};
    for (const el of form.querySelectorAll('[name]')) body[el.name] = el.value.trim();
    if (!body.company) { U.fieldError($('setting-company-name'), t('err_required')); return; }
    const dh = Number($('setting-default-dh').value);
    if (Number.isFinite(dh) && dh >= 0 && dh <= 2000) U.store.set('sng.defaultDh', Math.round(dh));
    U.setBusy(form, true);
    try {
      const { profile } = await API.patch('/api/me/profile', body);
      Session.me.profile = profile;
      populate();
      U.toast(t('toast_profile_saved'), 'success');
    } catch (err) {
      const mapped = { company: 'setting-company-name', contactName: 'setting-dispatcher-name', phone: 'setting-phone', telegram: 'setting-tg', contactEmail: 'setting-contact-email' };
      if (err.code === 'validation_error') for (const d of err.details || []) { const id = mapped[d.path]; if (id) U.fieldError($(id), d.message); } else U.toast(err.message, 'error');
    } finally {
      U.setBusy(form, false);
    }
  }


  // ---------------------------------------------------------------- sign-in & security
  const strongPassword = (v) => v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v);

  function renderSecurity() {
    const info = Session.authInfo();
    if (!info) return;
    const chip = (key, cls) => `<span class="px-2 py-0.5 rounded-full font-bold ${cls}">${U.esc(t(key))}</span>`;
    $('sec-methods').innerHTML = [
      info.hasGoogle && chip('method_google', 'bg-blue-50 text-blue-700 border border-blue-200'),
      info.hasPassword && chip('method_password', 'bg-emerald-50 text-emerald-700 border border-emerald-200'),
      info.phone && chip('method_phone', 'bg-amber-50 text-amber-800 border border-amber-200'),
    ].filter(Boolean).join('');
    $('password-form').classList.toggle('hidden', !info.hasPassword);
    $('sec-set-password').classList.toggle('hidden', info.hasPassword || !info.email);
    $('sec-phone-only').classList.toggle('hidden', !(info.phone && !info.email));
  }

  async function changePassword(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    const current = $('pw-current').value;
    const next = $('pw-new').value;
    let ok = true;
    if (!current) { U.fieldError($('pw-current'), t('err_required')); ok = false; }
    if (!strongPassword(next)) { U.fieldError($('pw-new'), t('pw_rules')); ok = false; } else if (next === current) { U.fieldError($('pw-new'), t('pw_same')); ok = false; }
    if (next && $('pw-new2').value !== next) { U.fieldError($('pw-new2'), t('pw_mismatch')); ok = false; }
    if (!ok) { form.querySelector('.field-invalid')?.focus(); return; }
    U.setBusy(form, true);
    try {
      await Session.changePassword(current, next);
      form.reset();
      U.toast(t('toast_password_changed'), 'success');
    } catch (err) {
      const code = String(err?.code || '');
      if (code.includes('invalid-credential') || code.includes('wrong-password')) U.fieldError($('pw-current'), t('autherr_wrong_current'));
      else U.toast(Session.mapAuthError(err, 'email'), 'error');
    } finally { U.setBusy(form, false); }
  }

  async function emailReset(button) {
    const email = Session.authInfo()?.email;
    if (!email) return;
    button.disabled = true;
    try { await Session.sendReset(email); U.toast(t('auth_reset_sent', { email }), 'success', 8000); } catch (err) { U.toast(Session.mapAuthError(err, 'email'), 'error'); } finally { button.disabled = false; }
  }

  function init() {
    $('password-form').addEventListener('submit', changePassword);
    $('sec-forgot-btn').addEventListener('click', (e) => emailReset(e.currentTarget));
    $('sec-set-password-btn').addEventListener('click', (e) => emailReset(e.currentTarget));
    $('profile-form').addEventListener('submit', save);
    document.querySelectorAll('[data-action="logout"]').forEach((b) => b.addEventListener('click', () => Session.signOut()));
  }

  return { init, populate, prefillContacts };
})();

window.Account = Account;
