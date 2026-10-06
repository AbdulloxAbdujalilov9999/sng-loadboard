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
    set('setting-email', p.email);
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
    fill('post-contact-name', p.contactName); fill('post-phone', p.phone); fill('post-email', p.contactEmail || p.email); fill('post-tg', p.telegram);
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

  function init() {
    $('profile-form').addEventListener('submit', save);
    document.querySelectorAll('[data-action="logout"]').forEach((b) => b.addEventListener('click', () => Session.signOut()));
  }

  return { init, populate, prefillContacts };
})();

window.Account = Account;
