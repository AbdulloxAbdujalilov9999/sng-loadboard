// Owner-only: approve / decline / revoke members and maintain display-currency rates.
const Admin = (() => {
  const { $, esc } = U;
  let status = 'pending';
  let items = [];
  let counts = { pending: 0, approved: 0, rejected: 0 };
  let entered = false;
  let loading = false;

  async function load() {
    loading = true;
    renderList();
    try {
      const res = await API.get('/api/admin/members', { status });
      items = res.items;
      counts = res.counts;
    } catch (err) {
      items = [];
      U.toast(err.message, 'error');
    }
    loading = false;
    renderCounts();
    renderList();
  }

  /** Cheap badge refresh that doesn't touch the visible list. */
  async function refreshCounts() {
    try { counts = (await API.get('/api/admin/members', { status: 'pending' })).counts; } catch { return; }
    renderCounts();
  }

  function renderCounts() {
    for (const k of ['pending', 'approved', 'rejected']) $(`cnt-${k}`).textContent = counts[k];
    const badge = $('badge-approvals');
    badge.textContent = counts.pending;
    badge.classList.toggle('hidden', counts.pending === 0);
    document.querySelectorAll('#approvals-tabs [data-status]').forEach((b) => {
      const on = b.dataset.status === status;
      b.className = `px-3 py-1.5 rounded-t ${on ? 'bg-white border border-b-0 border-slate-200 text-blue-700' : 'bg-slate-200 text-slate-600'}`;
      b.setAttribute('aria-selected', String(on));
    });
  }

  function card(m) {
    const when = U.ageText(m.requestedAt);
    const badge = { pending: ['bg-amber-50 text-amber-700 border-amber-200', 'st_pending'], approved: ['bg-emerald-50 text-emerald-700 border-emerald-200', 'st_approved'], rejected: ['bg-slate-100 text-slate-500 border-slate-200', 'st_rejected'] }[m.status];
    const actions = m.status === 'pending'
      ? `<button type="button" data-act="approve" data-id="${m.id}" class="flex-1 justify-center bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-1.5 rounded flex items-center space-x-1.5 transition"><i data-lucide="check" class="w-3.5 h-3.5"></i><span>${esc(t('btn_approve'))}</span></button>
         <button type="button" data-act="reject" data-id="${m.id}" class="flex-1 justify-center bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold py-1.5 rounded border border-rose-200 flex items-center space-x-1.5 transition"><i data-lucide="x" class="w-3.5 h-3.5"></i><span>${esc(t('btn_decline'))}</span></button>`
      : m.status === 'rejected'
        ? `<button type="button" data-act="approve" data-id="${m.id}" class="justify-center bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold py-1.5 px-3 rounded border border-emerald-200 transition">${esc(t('btn_approve'))}</button>
           <button type="button" data-act="remove" data-id="${m.id}" class="text-slate-400 hover:text-rose-600 px-2" title="${esc(t('btn_remove'))}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`
        : `<button type="button" data-act="reject" data-id="${m.id}" class="justify-center bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold py-1.5 px-3 rounded border border-rose-200 transition">${esc(t('btn_revoke'))}</button>
           <button type="button" data-act="remove" data-id="${m.id}" class="text-slate-400 hover:text-rose-600 px-2" title="${esc(t('btn_remove'))}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`;
    return `<div class="bg-white border ${m.status === 'pending' ? 'border-amber-200' : 'border-slate-200'} rounded-lg p-4 shadow-sm">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-bold text-slate-900">${esc(m.company)}</p>
          <p class="text-slate-500">${esc(m.contactName)} • <a href="mailto:${esc(m.email)}" class="text-blue-600 hover:underline">${esc(m.email)}</a></p>
          <p class="text-slate-500">${esc(m.phone)} • ${esc(m.telegram)}</p>
          <p class="text-[10px] text-slate-400 mt-1">${esc(t('requested_ago', { age: when }))}</p>
        </div>
        <span class="${badge[0]} border text-[10px] font-bold px-2 py-0.5 rounded flex-shrink-0">${esc(t(badge[1]))}</span>
      </div>
      <div class="flex gap-2 mt-3">${actions}</div>
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
    try {
      if (kind === 'approve') await API.post(`/api/admin/members/${id}/approve`);
      else if (kind === 'reject') {
        const ok = await U.confirmDialog({ title: t(m.status === 'approved' ? 'confirm_revoke_title' : 'confirm_decline_title'), message: t(m.status === 'approved' ? 'confirm_revoke' : 'confirm_decline', { company: m.company }), confirmText: t(m.status === 'approved' ? 'btn_revoke' : 'btn_decline') });
        if (!ok) return;
        await API.post(`/api/admin/members/${id}/reject`);
      } else if (kind === 'remove') {
        const ok = await U.confirmDialog({ title: t('confirm_delete_member_title'), message: t('confirm_delete_member', { company: m.company }), confirmText: t('btn_remove') });
        if (!ok) return;
        await API.del(`/api/admin/members/${id}`);
      }
      U.toast(t('toast_done'), 'success');
      load();
    } catch (err) {
      U.toast(err.message, 'error');
    }
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
    Live.on((evt) => {
      if (!entered || !Session.me?.isOwner) return;
      if (evt.entity === 'members' || evt.entity === 'resync') { if (App.view === 'approvals') load(); else refreshCounts(); }
    });
  }
  function enter() { entered = Boolean(Session.me?.isOwner); if (entered) refreshCounts(); }
  function leave() { entered = false; items = []; counts = { pending: 0, approved: 0, rejected: 0 }; renderCounts(); }
  function onShow() { load(); loadFx(); }

  return { init, enter, leave, onShow, render: () => { renderCounts(); renderList(); } };
})();

window.Admin = Admin;
