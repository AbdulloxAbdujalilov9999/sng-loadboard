// Owner-only: who joined (new members are announced here), block / unblock / remove members, display-currency rates.
// Sign-up is open: nobody waits for approval. "Blocked" (status 'rejected') is the owner's moderation tool.
const Admin = (() => {
  const { $, esc } = U;
  const SEEN_KEY = 'sng.membersSeenAt';
  let status = 'all';
  let items = [];
  let subOn = false;       // subscriptions switched on (shows each member's trial / paid time and the activate buttons)
  let counts = { pending: 0, approved: 0, rejected: 0 };
  let newSince = '';          // members who joined after this moment get a NEW tag (the previous visit)
  let entered = false;
  let loading = false;

  const seenAt = () => U.store.get(SEEN_KEY) || '';
  const total = () => counts.pending + counts.approved + counts.rejected;
  const isNew = (m) => Boolean(newSince) && m.requestedAt > newSince;

  async function load() {
    loading = true;
    renderList();
    try {
      const res = await API.get('/api/admin/members', { status });
      items = res.items;
      counts = res.counts;
      subOn = Boolean(res.subscriptionEnabled);
    } catch (err) {
      items = [];
      U.toast(err.message, 'error');
    }
    loading = false;
    renderCounts();
    renderList();
  }

  /** Cheap badge refresh that doesn't touch the visible list: how many joined since the owner last looked. */
  async function refreshCounts() {
    try {
      const res = await API.get('/api/admin/members', { status: 'all' });
      counts = res.counts;
      // First visit ever: count members who joined after the owner's own account was created (not the whole history).
      const since = seenAt() || Session.me?.profile?.requestedAt || new Date().toISOString();
      newCount = res.items.filter((m) => m.requestedAt > since).length;
      latest = res.items[0] || null;
    } catch { return; }
    renderCounts();
  }
  let newCount = 0;
  let latest = null;

  function renderCounts() {
    $('cnt-all').textContent = total();
    $('cnt-rejected').textContent = counts.rejected;
    const badge = $('badge-approvals');
    const shown = App.view === 'approvals' ? 0 : newCount;
    badge.textContent = shown;
    badge.classList.toggle('hidden', shown === 0);
    document.querySelectorAll('#approvals-tabs [data-status]').forEach((b) => {
      const on = b.dataset.status === status;
      b.className = `px-3 py-1.5 rounded-t ${on ? 'bg-white border border-b-0 border-slate-200 text-blue-700' : 'bg-slate-200 text-slate-600'}`;
      b.setAttribute('aria-selected', String(on));
    });
  }

  function card(m) {
    const when = U.ageText(m.requestedAt);
    const blocked = m.status === 'rejected';
    const badge = blocked ? ['bg-slate-100 text-slate-500 border-slate-200', 'st_blocked'] : ['bg-emerald-50 text-emerald-700 border-emerald-200', 'st_active'];
    const reset = m.loginPhone ? `<button type="button" data-act="resetpin" data-id="${m.id}" class="justify-center bg-amber-50 hover:bg-amber-100 text-amber-800 font-bold py-1.5 px-3 rounded border border-amber-200 transition">${esc(t('btn_reset_pin'))}</button>` : '';
    const actions = blocked
      ? `<button type="button" data-act="approve" data-id="${m.id}" class="justify-center bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold py-1.5 px-3 rounded border border-emerald-200 transition">${esc(t('btn_unblock'))}</button>
         ${reset}<button type="button" data-act="remove" data-id="${m.id}" class="text-slate-400 hover:text-rose-600 px-2" title="${esc(t('btn_remove'))}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`
      : `<button type="button" data-act="reject" data-id="${m.id}" class="justify-center bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold py-1.5 px-3 rounded border border-rose-200 transition">${esc(t('btn_block'))}</button>
         ${reset}<button type="button" data-act="remove" data-id="${m.id}" class="text-slate-400 hover:text-rose-600 px-2" title="${esc(t('btn_remove'))}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`;
    const name = m.company && m.company !== m.contactName ? `${m.company} <span class="font-normal text-slate-500">· ${esc(m.contactName)}</span>` : esc(m.contactName || m.company);
    const sameNumber = !m.email && String(m.phone || '').replace(/\D/g, '') === String(m.login).replace(/\D/g, ''); // phone sign-in: do not print the number twice
    const login = sameNumber ? '' : m.email ? `<a href="mailto:${esc(m.email)}" class="text-blue-600 hover:underline">${esc(m.email)}</a>` : `<a href="tel:${esc(m.login)}" class="text-blue-600 hover:underline">${esc(m.login)}</a>`;
    const contacts = [m.phone && `<a href="tel:${esc(String(m.phone).replace(/[^\d+]/g, ''))}" class="hover:underline">${esc(m.phone)}</a>`, m.telegram && `<a href="https://t.me/${esc(m.telegram.replace('@', ''))}" target="_blank" rel="noopener noreferrer" class="hover:underline">${esc(m.telegram)}</a>`].filter(Boolean).join(' • ');
    const subState = m.subscription || { state: 'off' };
    const subBlock = subOn && subState.state !== 'off' ? `<div class="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
        <span class="font-semibold ${subState.state === 'expired' ? 'text-rose-600' : subState.state === 'paid' ? 'text-emerald-700' : 'text-sky-700'}">${esc(t(`sub_member_${subState.state}`, { days: subState.daysLeft, date: subState.until ? new Date(subState.until).toLocaleDateString() : '' }))}</span>
        <span class="flex-1"></span>
        <select data-sub-days="${m.id}" class="border border-slate-300 rounded p-1.5 bg-white">${[30, 90, 180, 365].map((n) => `<option value="${n}">${esc(t('opt_days', { n }))}</option>`).join('')}</select>
        <button type="button" data-act="activate" data-id="${m.id}" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-1.5 px-3 rounded">${esc(t('btn_activate'))}</button>
        <button type="button" data-act="endaccess" data-id="${m.id}" class="text-slate-400 hover:text-rose-600 px-1" title="${esc(t('btn_end_access'))}"><i data-lucide="calendar-x" class="w-3.5 h-3.5"></i></button>
      </div>` : '';
    return `<div class="bg-white border ${isNew(m) ? 'border-emerald-300 ring-1 ring-emerald-200' : 'border-slate-200'} rounded-lg p-4 shadow-sm">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-bold text-slate-900 break-words">${name} ${isNew(m) ? `<span class="ml-1 text-[9px] bg-emerald-500 text-white px-1.5 py-0.5 rounded font-bold align-middle">${esc(t('badge_new'))}</span>` : ''}</p>
          ${login ? `<p class="text-slate-500 break-words">${login}</p>` : ''}
          <p class="text-slate-500 break-words">${contacts}</p>
          <p class="text-[10px] text-slate-400 mt-1">${esc(when === t('age_now') ? t('joined_now') : t('joined_ago', { age: when }))}</p>
        </div>
        <span class="${badge[0]} border text-[10px] font-bold px-2 py-0.5 rounded flex-shrink-0">${esc(t(badge[1]))}</span>
      </div>
      <div class="flex gap-2 mt-3">${actions}</div>
      ${subBlock}
    </div>`;
  }

  function renderList() {
    const el = $('approvals-list');
    if (loading && !items.length) el.innerHTML = `<div class="bg-white border border-slate-200 rounded-lg p-4 text-center text-slate-400">${esc(t('loading'))}</div>`;
    else if (!items.length) el.innerHTML = `<div class="bg-white border border-slate-200 rounded-lg p-4 text-center text-slate-400">${esc(t(`approvals_empty_${status}`))}</div>`;
    else el.innerHTML = items.map(card).join('');
    lucide.createIcons();
  }

  async function act(kind, id) {
    const m = items.find((x) => x.id === id);
    if (!m) return;
    const label = m.company || m.contactName;
    try {
      if (kind === 'approve') await API.post(`/api/admin/members/${id}/approve`);
      else if (kind === 'reject') {
        const ok = await U.confirmDialog({ title: t('confirm_block_title'), message: t('confirm_block', { company: label }), confirmText: t('btn_block') });
        if (!ok) return;
        await API.post(`/api/admin/members/${id}/reject`);
      } else if (kind === 'activate') {
        const days = Number(document.querySelector(`[data-sub-days="${id}"]`)?.value || 30);
        await API.post(`/api/admin/members/${id}/subscription`, { days });
        U.toast(t('toast_sub_activated', { days }), 'success');
        load();
        return;
      } else if (kind === 'endaccess') {
        const ok = await U.confirmDialog({ title: t('btn_end_access'), message: t('confirm_end_access', { company: label }), confirmText: t('btn_end_access') });
        if (!ok) return;
        await API.del(`/api/admin/members/${id}/subscription`);
        load();
        return;
      } else if (kind === 'resetpin') {
        const ok = await U.confirmDialog({ title: t('btn_reset_pin'), message: t('confirm_reset_pin', { company: label }), confirmText: t('btn_reset_pin') });
        if (!ok) return;
        const r = await API.post(`/api/admin/members/${id}/reset-pin`);
        // shown once: the owner passes it to the member (call / Telegram); the member can change it in Settings
        await U.confirmDialog({ title: t('reset_pin_title'), message: t('reset_pin_msg', { phone: r.phone, pin: r.pin }), confirmText: 'OK', danger: false });
        return;
      } else if (kind === 'remove') {
        const ok = await U.confirmDialog({ title: t('confirm_delete_member_title'), message: t('confirm_delete_member', { company: label }), confirmText: t('btn_remove') });
        if (!ok) return;
        await API.del(`/api/admin/members/${id}`);
      }
      U.toast(t('toast_done'), 'success');
      load();
    } catch (err) {
      U.toast(err.message, 'error');
    }
  }

  // ---- subscription settings ----
  async function loadSub() {
    try {
      const c = await API.get('/api/admin/subscription');
      $('sub-enabled').checked = Boolean(c.enabled);
      $('sub-trial-days').value = c.trialDays;
      $('sub-price-text').value = c.priceText || '';
      $('sub-pay-text').value = c.payText || '';
    } catch { /* the form keeps its defaults */ }
  }

  async function saveSub(e) {
    e.preventDefault();
    const form = e.currentTarget;
    U.setBusy(form, true);
    try {
      await API.put('/api/admin/subscription', { enabled: $('sub-enabled').checked, trialDays: Number($('sub-trial-days').value) || 14, priceText: $('sub-price-text').value, payText: $('sub-pay-text').value });
      U.toast(t('toast_sub_saved'), 'success');
      load();
    } catch (err) { U.toast(err.message, 'error'); } finally { U.setBusy(form, false); }
  }

  // ---- automatic removal of loads ----
  async function loadExp() {
    try {
      const c = await API.get('/api/admin/load-expiry');
      $('exp-enabled').checked = Boolean(c.enabled);
      $('exp-days').value = Math.max(1, Math.round(c.hours / 24));
    } catch { /* the form keeps its defaults */ }
  }

  async function saveExp(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const days = Math.round(Number($('exp-days').value));
    if (!(days >= 1 && days <= 30)) { $('exp-days').focus(); U.toast(t('exp_invalid'), 'error'); return; }
    U.setBusy(form, true);
    try {
      const r = await API.put('/api/admin/load-expiry', { enabled: $('exp-enabled').checked, hours: days * 24 });
      U.toast(t('toast_exp_saved', { n: r.removed }), 'success');
    } catch (err) { U.toast(err.message, 'error'); } finally { U.setBusy(form, false); }
  }

  // ---- display currency rates ----
  async function loadFx() {
    const cfg = await (await fetch(`${window.APP_CONFIG.apiBase || ''}/api/config`, { cache: 'no-store' })).json();
    $('fx-grid').innerHTML = Object.entries(cfg.currencies).filter(([code]) => code !== 'USD').map(([code, c]) => `<label class="block text-[11px] font-semibold text-slate-600">${esc(code)} ${esc(c.symbol)}<input data-fx="${esc(code)}" type="number" step="any" min="0" value="${esc(c.rate)}" class="mt-0.5 w-full border border-slate-300 rounded p-1.5 text-xs font-mono"></label>`).join('');
  }

  async function saveFx(e) {
    e.preventDefault();
    const form = e.currentTarget; // currentTarget is cleared once the handler awaits
    const rates = {};
    let invalid = null;
    form.querySelectorAll('[data-fx]').forEach((i) => {
      const v = Number(i.value);
      if (i.value !== '' && v > 0 && Number.isFinite(v)) rates[i.dataset.fx] = v; else invalid = invalid || i;
    });
    if (invalid) { invalid.focus(); U.toast(t('toast_rates_invalid'), 'error'); return; }
    U.setBusy(form, true);
    try {
      await API.put('/api/admin/fx', { rates });
      U.toast(t('toast_rates_saved'), 'success');
      App.refreshConfig();
    } catch (err) { U.toast(err.message, 'error'); } finally { U.setBusy(form, false); }
  }

  function init() {
    document.querySelectorAll('#approvals-tabs [data-status]').forEach((b) => b.addEventListener('click', () => { status = b.dataset.status; load(); }));
    $('approvals-list').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act, Number(b.dataset.id)); });
    $('fx-form').addEventListener('submit', saveFx);
    $('sub-form').addEventListener('submit', saveSub);
    $('exp-form').addEventListener('submit', saveExp);
    Live.on(async (evt) => {
      if (!entered || !Session.me?.isOwner) return;
      if (evt.entity === 'members' && evt.op === 'insert') {
        // someone just signed up: tell the owner, whatever they are looking at
        const before = newCount;
        if (App.view === 'approvals') await load(); else await refreshCounts();
        const who = latest ? (latest.company && latest.company !== latest.contactName ? `${latest.company} (${latest.contactName})` : latest.contactName || latest.company) : '';
        U.toast(t('toast_new_member', { name: who }), 'success', 7000);
        if (newCount === before && App.view !== 'approvals') newCount += 1; // the list may not have caught up yet
        renderCounts();
      } else if (evt.entity === 'members' || evt.entity === 'resync') { if (App.view === 'approvals') load(); else refreshCounts(); }
    });
  }
  function enter() { entered = Boolean(Session.me?.isOwner); if (entered) refreshCounts(); }
  function leave() { entered = false; items = []; counts = { pending: 0, approved: 0, rejected: 0 }; newCount = 0; latest = null; renderCounts(); }
  function onShow() {
    newSince = seenAt() || Session.me?.profile?.requestedAt || ''; // NEW tags are relative to the previous visit...
    U.store.set(SEEN_KEY, new Date().toISOString());      // ...and this visit counts as "seen"
    newCount = 0;
    load(); loadFx(); loadSub(); loadExp();
  }

  return { init, enter, leave, onShow, render: () => { renderCounts(); renderList(); } };
})();

window.Admin = Admin;
