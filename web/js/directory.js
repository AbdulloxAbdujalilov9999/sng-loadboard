// Carrier directory: approved members, searchable, paginated.
const Directory = (() => {
  const { $, esc } = U;
  const s = { items: [], cursor: null, total: null, loading: false, error: null, ctrl: null, q: '' };
  let entered = false;
  let stale = false;

  async function load({ reset = false } = {}) {
    if (s.loading && !reset) return;
    if (reset) { s.ctrl?.abort(); Object.assign(s, { items: [], cursor: null, total: null, error: null }); }
    const ctrl = new AbortController();
    s.ctrl = ctrl;
    s.loading = true;
    stale = false;
    render();
    try {
      const res = await API.get('/api/directory', { q: s.q || undefined, limit: 60, cursor: s.cursor || undefined }, ctrl.signal);
      if (s.ctrl !== ctrl) return;
      s.items.push(...res.items);
      s.cursor = res.nextCursor;
      if (res.total !== undefined) s.total = res.total;
      s.error = null;
    } catch (err) {
      if (err.name === 'AbortError') return;
      s.error = err;
    }
    if (s.ctrl === ctrl) s.loading = false;
    render();
  }

  function card(c) {
    const sub = [c.location && esc(c.location), c.tirCarnet && `<span class="text-blue-700 font-mono font-semibold">${esc(c.tirCarnet)}</span>`].filter(Boolean).join(' • ');
    return `<div class="bg-white p-4 rounded-lg border border-slate-200 shadow-sm space-y-2.5">
      <div class="flex justify-between items-start border-b border-slate-100 pb-2">
        <div class="min-w-0"><h3 class="font-bold text-slate-900 text-sm">${esc(c.company)}</h3>${sub ? `<p class="text-[11px] text-slate-500">${sub}</p>` : ''}</div>
        <span class="bg-emerald-50 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded border border-emerald-200">${esc(t('badge_verified'))}</span>
      </div>
      <div class="space-y-1 text-[11px] text-slate-600">
        ${c.fleet ? `<div><strong class="text-slate-700">${esc(t('lbl_fleet'))}:</strong> ${esc(c.fleet)}</div>` : ''}
        ${c.routes ? `<div><strong class="text-slate-700">${esc(t('lbl_routes'))}:</strong> ${esc(c.routes)}</div>` : ''}
        <div><strong class="text-slate-700">${esc(t('lbl_lead_dispatcher'))}:</strong> ${esc(c.contactName)}</div>
      </div>
      <div class="pt-2 border-t border-slate-100 grid grid-cols-3 gap-2 text-[10px]">
        <a href="tel:${esc(String(c.phone).replace(/[^\d+]/g, ''))}" class="bg-blue-50 text-blue-700 font-bold py-1.5 px-2 rounded text-center hover:bg-blue-100 transition flex items-center justify-center space-x-1"><i data-lucide="phone" class="w-3 h-3"></i><span class="truncate">${esc(c.phone)}</span></a>
        <a href="mailto:${esc(c.email)}" class="bg-slate-100 text-slate-700 font-semibold py-1.5 px-2 rounded text-center hover:bg-slate-200 transition flex items-center justify-center space-x-1"><i data-lucide="mail" class="w-3 h-3"></i><span>${esc(t('lbl_email_btn'))}</span></a>
        <a href="https://t.me/${esc(c.telegram.replace('@', ''))}" target="_blank" rel="noopener noreferrer" class="bg-[#229ED9] text-white font-bold py-1.5 px-2 rounded text-center hover:bg-[#1e8bc0] transition flex items-center justify-center space-x-1"><i data-lucide="send" class="w-3 h-3"></i><span class="truncate">${esc(c.telegram)}</span></a>
      </div>
    </div>`;
  }

  function render() {
    const grid = $('directory-grid');
    if (s.loading && !s.items.length) grid.innerHTML = Array.from({ length: 4 }, () => `<div class="bg-white p-4 rounded-lg border border-slate-200 space-y-3"><div class="skeleton-bar w-2/3"></div><div class="skeleton-bar w-full"></div><div class="skeleton-bar w-1/2"></div></div>`).join('');
    else if (s.error && !s.items.length) grid.innerHTML = `<div class="col-span-full bg-white border border-slate-200 rounded-lg p-6 text-center text-rose-600">${esc(s.error.message)}</div>`;
    else if (!s.items.length) grid.innerHTML = `<div class="col-span-full bg-white border border-slate-200 rounded-lg p-6 text-center text-slate-400">${esc(s.q ? t('dir_no_match') : t('dir_empty'))}</div>`;
    else grid.innerHTML = s.items.map(card).join('');
    $('dir-count').textContent = U.fmtCount(s.total);
    const more = $('directory-more');
    more.classList.toggle('hidden', !s.cursor);
    more.disabled = s.loading;
    lucide.createIcons();
  }

  function init() {
    $('directory-search').addEventListener('input', U.debounce((e) => { s.q = e.target.value.trim(); if (entered) load({ reset: true }); }, 300));
    $('directory-more').addEventListener('click', () => load());
    Live.on((evt) => { if (entered && (evt.entity === 'members' || evt.entity === 'resync')) { if (App.view === 'directory') load({ reset: true }); else stale = true; } });
  }
  function enter() { entered = true; load({ reset: true }); }
  function leave() { entered = false; s.ctrl?.abort(); Object.assign(s, { items: [], cursor: null, total: null, loading: false, error: null, q: '' }); $('directory-grid').innerHTML = ''; $('directory-search').value = ''; }
  function onShow() { if (stale) load({ reset: true }); }

  return { init, enter, leave, onShow, render };
})();

window.Directory = Directory;
