// The signed-in member's profile: shown, edited, and used to prefill contact fields on new posts.
const Account = (() => {
  const { $ } = U;

  const initials = (name) => (name || '?').trim().slice(0, 2).toUpperCase();

  // ---------------------------------------------------------------- subscription (free trial -> paid time added by the owner)
  const SUB_STYLE = {
    trial: ['bg-sky-50', 'border-sky-200', 'text-sky-900'],
    paid: ['bg-emerald-50', 'border-emerald-200', 'text-emerald-900'],
    expired: ['bg-rose-50', 'border-rose-300', 'text-rose-900'],
  };
  const ALL_SUB_STYLES = Object.values(SUB_STYLE).flat();
  const dateText = (iso) => (iso ? new Date(iso).toLocaleDateString(I18N.lang === 'ru' ? 'ru-RU' : I18N.lang === 'uz' ? 'uz-UZ' : 'en-GB') : '');

  function renderSubscription() {
    const me = Session.me;
    const s = me?.subscription;
    const card = $('sub-card'); const chip = $('sub-chip');
    if (!s || !s.enabled || s.state === 'off') { card.classList.add('hidden'); chip.classList.add('hidden'); return; }
    const vars = { days: s.daysLeft, date: dateText(s.until) };
    $('sub-state').textContent = t(`sub_state_${s.state}`, vars);
    card.classList.remove('hidden', ...ALL_SUB_STYLES);
    card.classList.add(...SUB_STYLE[s.state]);
    $('sub-price').textContent = s.priceText ? `${t('sub_price')}: ${s.priceText}` : '';
    $('sub-price').classList.toggle('hidden', !s.priceText);
    $('sub-pay').textContent = s.payText || '';
    $('sub-pay-wrap').classList.toggle('hidden', !s.payText);
    const owner = me.ownerContact;
    $('sub-contact').textContent = owner ? t('sub_contact_owner', { contact: owner }) : '';
    $('sub-contact').classList.toggle('hidden', !owner);
    // a small reminder in the header: always while in trial / expired, and the last week of paid time
    const showChip = s.state !== 'paid' || s.daysLeft <= 7;
    chip.classList.remove('hidden', ...ALL_SUB_STYLES);
    chip.classList.toggle('hidden', !showChip);
    chip.classList.add(...SUB_STYLE[s.state]);
    chip.textContent = t(`sub_chip_${s.state}`, vars);
  }

  // Everyone is an individual until they say they work with a company: only then are the company fields asked for.
  let companyOn = false;
  function setCompanyMode(on) {
    companyOn = on;
    $('company-off').classList.toggle('hidden', on);
    $('company-on').classList.toggle('hidden', !on);
  }

  function populate() {
    const me = Session.me;
    if (!me?.profile) return;
    const p = me.profile;
    const set = (id, v) => { $(id).value = v || ''; };
    setCompanyMode(Boolean(p.worksWithCompany));
    set('setting-company-name', p.worksWithCompany ? p.company : '');
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

    $('acc-big-avatar').textContent = me.isOwner ? '★' : initials(p.company || p.contactName);
    $('acc-title-name').textContent = p.company;
    $('acc-status-badge').textContent = me.isOwner ? t('role_owner') : t('role_member');
    $('acc-sub-details').textContent = [p.tirCarnet ? `TIR ${p.tirCarnet}` : t('no_tir'), p.location || t('no_location')].join(' • ');
    $('posting-as-company').textContent = p.company;
    prefillContacts();
    renderSecurity();
    renderSubscription();
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
    fill('post-contact-name', p.contactName); fill('post-phone', p.phone); fill('post-email', p.contactEmail || p.email); // phone sign-ins have no login e-mail: stays blank until they set one
    fill('post-tg', p.telegram);
    fill('truck-post-phone', p.phone); fill('truck-post-tg', p.telegram);
    $('contact-incomplete').classList.toggle('hidden', Boolean(p.phone || p.telegram));
  }

  async function save(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    const body = {};
    for (const el of form.querySelectorAll('[name]')) body[el.name] = el.value.trim();
    body.worksWithCompany = companyOn;
    if (!companyOn) { delete body.company; delete body.fleet; delete body.routes; } // an individual: the name is shown, company details stay as they were
    else if (!body.company) { U.fieldError($('setting-company-name'), t('err_required')); return; }
    if (!body.phone && !body.telegram) { U.fieldError($('setting-phone'), t('v_contact_required')); U.fieldError($('setting-tg'), t('v_contact_required')); return; }
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
    const me = Session.me;
    const p = me?.profile;
    const pinOn = Boolean(Session.config?.pinLogin);
    const googleLike = Boolean(me) && !me.isOwner && (me.provider === 'google.com' || me.provider === 'password');
    const hasLoginPhone = Boolean(p?.loginPhone);
    // Google / e-mail members can add "phone + password" as a second way in; phone members change their password here.
    $('phone-login-card').classList.toggle('hidden', !(pinOn && googleLike && !hasLoginPhone));
    $('phone-login-on').classList.toggle('hidden', !(pinOn && googleLike && hasLoginPhone));
    $('phone-login-number').textContent = p?.loginPhone || '';
    $('pin-form').classList.toggle('hidden', !(pinOn && hasLoginPhone && !me.isOwner));
    $('pin-current-wrap').classList.toggle('hidden', me?.provider !== 'pin'); // a Google session needs no current password
  }

  async function changePin(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    const needCurrent = Session.me?.provider === 'pin';
    const cur = $('pin-current').value.trim(); const next = $('pin-new').value.trim();
    let ok = true;
    if (needCurrent && !/^\d{4,6}$/.test(cur)) { U.fieldError($('pin-current'), t('v_pin_format')); ok = false; }
    if (!/^\d{4,6}$/.test(next)) { U.fieldError($('pin-new'), t('v_pin_format')); ok = false; } else if ($('pin-new2').value.trim() !== next) { U.fieldError($('pin-new2'), t('pin_mismatch')); ok = false; }
    if (!ok) { form.querySelector('.field-invalid')?.focus(); return; }
    U.setBusy(form, true);
    try {
      const r = await API.put('/api/me/pin', { pin: next, ...(needCurrent ? { currentPin: cur } : {}) });
      if (r?.token) Session.storePinToken(r.token, r.expiresAt);
      form.reset();
      U.toast(t('toast_pin_saved'), 'success');
    } catch (err) {
      const map = { pin: 'pin-new', currentPin: 'pin-current' };
      if (err.code === 'validation_error') for (const d of err.details || []) { const el = $(map[d.path]); if (el) U.fieldError(el, U.detailText(d)); } else U.toast(err.message, 'error');
    } finally { U.setBusy(form, false); }
  }

  async function addPhoneLogin(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.clearFormErrors(form);
    const phone = Session.normalisePhone($('pl-phone').value);
    const pin = $('pl-pin').value.trim();
    let ok = true;
    if (!phone) { U.fieldError($('pl-phone'), t('autherr_bad_phone')); ok = false; }
    if (!/^\d{4,6}$/.test(pin)) { U.fieldError($('pl-pin'), t('v_pin_format')); ok = false; } else if ($('pl-pin2').value.trim() !== pin) { U.fieldError($('pl-pin2'), t('pin_mismatch')); ok = false; }
    if (!ok) { form.querySelector('.field-invalid')?.focus(); return; }
    U.setBusy(form, true);
    try {
      const { profile } = await API.post('/api/me/login-phone', { phone, pin });
      Session.me.profile = profile;
      form.reset();
      populate();
      U.toast(t('toast_phone_signin_added'), 'success');
    } catch (err) {
      const map = { phone: 'pl-phone', pin: 'pl-pin' };
      if (err.code === 'validation_error') for (const d of err.details || []) { const el = $(map[d.path]); if (el) U.fieldError(el, U.detailText(d)); } else U.toast(err.message, 'error');
    } finally { U.setBusy(form, false); }
  }

  async function removePhoneLogin() {
    const ok = await U.confirmDialog({ title: t('btn_remove_phone_signin'), message: t('confirm_remove_phone_signin'), confirmText: t('btn_remove') });
    if (!ok) return;
    try {
      const { profile } = await API.del('/api/me/login-phone').then((r) => r ?? {}).catch((err) => { throw err; });
      if (profile) Session.me.profile = profile;
      populate();
      U.toast(t('toast_phone_signin_removed'), 'success');
    } catch (err) { U.toast(err.message, 'error'); }
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
    $('pin-form').addEventListener('submit', changePin);
    $('phone-login-form').addEventListener('submit', addPhoneLogin);
    $('phone-login-remove').addEventListener('click', removePhoneLogin);
    $('sec-forgot-btn').addEventListener('click', (e) => emailReset(e.currentTarget));
    $('sec-set-password-btn').addEventListener('click', (e) => emailReset(e.currentTarget));
    $('profile-form').addEventListener('submit', save);
    $('company-on-btn').addEventListener('click', () => { setCompanyMode(true); $('setting-company-name').focus(); });
    $('company-off-btn').addEventListener('click', () => setCompanyMode(false));
    document.querySelectorAll('[data-action="logout"]').forEach((b) => b.addEventListener('click', () => Session.signOut()));
  }

  return { init, populate, prefillContacts };
})();

window.Account = Account;
