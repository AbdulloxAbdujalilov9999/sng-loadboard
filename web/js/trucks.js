// Truck board: search (radius, destination text, trailer), infinite scroll, post, my trucks.
const Trucks = (() => {
  const { $, esc } = U;
  const PAGE = window.APP_CONFIG.pageSize;
  const CAP = window.APP_CONFIG.maxRenderedRows;
  const list = { items: [], cursor: null, total: null, capped: false, loading: false, done: false, error: null, ctrl: null };
  let filters = { loc: null, radius: 150, dest: '', equip: '' };
  let mine = [];
  let observer = null;
  // On phones the whole search page scrolls (see styles.css); on desktop only the results box does.
  const mobileMq = window.matchMedia('(max-width: 767px)');
  const pageBottom = () => (mobileMq.matches ? $('view-search-trucks') : $('trucks-scroll')).getBoundingClientRect().bottom;
  function scrollListToStart() {
    if (!mobileMq.matches) { $('trucks-scroll').scrollTop = 0; return; }
    if ($('view-search-trucks').getBoundingClientRect().top > $('trucks-scroll').getBoundingClientRect().top) $('trucks-scroll').scrollIntoView({ block: 'start' });
  }
  let entered = false;
  let stale = false;

  function buildQuery() {
    return { loc: filters.loc?.id, locRadius: filters.loc ? filters.radius : undefined, dest: filters.dest || undefined, equip: filters.equip || undefined, limit: PAGE };
  }

  async function readFilters() {
    const input = $('search-truck-loc');
    const loc = input.value.trim() ? await Cities.resolve(input) : null;
    input.classList.toggle('field-invalid', Boolean(input.value.trim()) && !loc);
    if (input.value.trim() && !loc) { U.toast(t('err_pick_city'), 'error'); return false; }
    filters = { loc, radius: Math.min(2000, Math.max(0, Math.round(Number($('search-truck-radius').value)) || 0)), dest: $('search-truck-dest').value.trim(), equip: $('search-truck-equip').value };
    return true;
  }

  async function search() { if (await readFilters()) reload(); }
  const searchSoon = U.debounce(search, 250);

  async function reload({ silent = false } = {}) {
    list.ctrl?.abort();
    const ctrl = new AbortController();
    list.ctrl = ctrl;
    if (!silent) { Object.assign(list, { items: [], cursor: null, total: null, capped: false, done: false, error: null, loading: true }); render(); scrollListToStart(); }
    stale = false;
    try {
      const res = await API.get('/api/trucks', buildQuery(), ctrl.signal);
      if (list.ctrl !== ctrl) return;
      Object.assign(list, { items: res.items, cursor: res.nextCursor, total: res.total ?? list.total, capped: Boolean(res.totalCapped), done: !res.nextCursor, error: null });
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!silent) list.error = err;
    }
    if (list.ctrl === ctrl) list.loading = false;
    render();
    checkSentinel();
  }

  async function loadMore() {
    if (!entered || list.loading || list.done || list.error || !list.cursor || list.items.length >= CAP) return;
    const ctrl = list.ctrl;
    list.loading = true;
    renderFooter();
    try {
      const res = await API.get('/api/trucks', { ...buildQuery(), cursor: list.cursor }, ctrl.signal);
      if (list.ctrl !== ctrl) return;
      const fresh = res.items.slice(0, CAP - list.items.length);
      list.items.push(...fresh);
      list.cursor = res.nextCursor;
      list.done = !res.nextCursor;
      $('trucks-tbody').insertAdjacentHTML('beforeend', fresh.map(rowHtml).join(''));
    } catch (err) {
      if (err.name === 'AbortError') return;
      list.error = err;
    }
    if (list.ctrl === ctrl) list.loading = false;
    renderFooter();
    checkSentinel();
  }

  function checkSentinel() {
    requestAnimationFrame(() => {
      if (!$('view-search-trucks').offsetParent) return; // screen not shown: a hidden box measures 0, which would look like "end is visible" and fetch every page
      const s = $('trucks-sentinel').getBoundingClientRect();
      if (s.top < pageBottom() + 400 && !list.loading && !list.done) loadMore();
    });
  }

  const features = (x) => [x.hasTir && 'TIR', x.hasAdr && 'ADR', x.hasGps && 'GPS', x.sideLoading && t('feat_side_short')].filter(Boolean).join(' • ') || t('feat_standard');
  const avail = (x) => `${esc(x.availableFrom)}${x.availableTo ? ` <span class="text-slate-400 font-normal">→ ${esc(x.availableTo)}</span>` : ''}`;
  const contactUrl = (x) => `https://t.me/${esc(x.contactTelegram.replace('@', ''))}`;

  function rowHtml(x) {
    const dh = x.dho === null ? '' : ` <span class="text-[10px] ${x.dho > 0 ? 'text-blue-600 font-bold' : 'text-slate-400 font-normal'}">(${x.dho}km)</span>`;
    return `<tr class="data-row hover:bg-slate-50 transition border-b border-slate-200">
      <td data-label="${esc(t('th_available'))}" class="p-2.5 font-bold text-slate-800">${avail(x)}</td>
      <td class="cell-heading p-2.5 font-bold text-blue-700">${esc(x.locCity)}${dh}</td>
      <td data-label="${esc(t('th_pref_dest'))}" class="p-2.5 text-slate-700">${esc(x.destPref)}</td>
      <td data-label="${esc(t('th_equipment'))}" class="p-2.5 text-center"><span class="bg-blue-50 text-blue-800 font-bold px-1.5 py-0.5 rounded border border-blue-200 text-xs">${esc(x.equip)}</span></td>
      <td data-label="${esc(t('th_capacity'))}" class="p-2.5 text-slate-700"><div>${esc(x.capacityT)}t${x.volumeM3 ? ` / ${esc(x.volumeM3)}m³` : ''}</div><div class="text-[10px] text-slate-500">${esc(features(x))}</div></td>
      <td data-label="${esc(t('th_min_rate'))}" class="p-2.5 font-bold text-emerald-600">${x.minRateUsd ? esc(U.money(x.minRateUsd)) : esc(t('negotiable'))}</td>
      <td data-label="${esc(t('th_carrier'))}" class="p-2.5 font-semibold text-slate-900">${esc(x.company)}${x.mine ? ` <span class="text-[9px] bg-amber-100 text-amber-800 px-1 rounded font-bold">${esc(t('badge_yours'))}</span>` : ''}</td>
      <td class="p-2.5 text-center"><div class="flex items-center justify-center space-x-1.5">
        <a href="${contactUrl(x)}" target="_blank" rel="noopener noreferrer" class="flex-1 md:flex-none text-center bg-[#229ED9] text-white hover:bg-blue-600 px-2 py-1.5 md:py-1 rounded text-[10px] font-bold">Telegram</a>
        <a href="tel:${esc(String(x.contactPhone).replace(/[^\d+]/g, ''))}" class="flex-1 md:flex-none text-center bg-slate-200 text-slate-700 hover:bg-slate-300 px-2 py-1.5 md:py-1 rounded text-[10px] font-bold">${esc(t('lbl_call'))}</a>
      </div></td>
    </tr>`;
  }

  function render() {
    const tbody = $('trucks-tbody');
    if (list.loading && !list.items.length) tbody.innerHTML = Array.from({ length: 6 }, () => `<tr class="status-row"><td colspan="8" class="py-3 px-3"><div class="skeleton-bar w-full"></div></td></tr>`).join('');
    else if (!list.items.length) tbody.innerHTML = `<tr class="status-row"><td colspan="8" class="p-8 text-center text-slate-400 font-sans">${esc(list.error ? list.error.message : t('trucks_none'))}</td></tr>`;
    else tbody.innerHTML = list.items.map(rowHtml).join('');
    $('truck-count').textContent = list.loading && list.total === null ? '…' : U.fmtCount(list.total, list.capped);
    renderFooter();
  }

  function renderFooter() {
    const f = $('trucks-footer');
    if (list.error) f.innerHTML = `${esc(list.error.message)} <button type="button" data-action="retry" class="text-blue-600 font-bold underline ml-1">${esc(t('btn_retry'))}</button>`;
    else if (list.loading && list.items.length) f.textContent = t('loading');
    else if (!list.done && list.items.length >= CAP) f.textContent = t('list_capped', { n: CAP.toLocaleString() });
    else if (list.done && list.items.length > PAGE) f.textContent = t('list_end', { n: list.items.length.toLocaleString() });
    else f.textContent = '';
  }

  // ---------------------------------------------------------------- mine / post
  async function loadMine() {
    try { mine = (await API.get('/api/trucks/mine')).items; } catch { return; }
    renderMine();
  }

  function renderMine() {
    $('my-trucks-count').textContent = mine.length;
    const tbody = $('my-trucks-tbody');
    if (!mine.length) { tbody.innerHTML = `<tr class="status-row"><td colspan="5" class="p-4 text-center text-slate-400 font-sans">${esc(t('my_trucks_empty'))}</td></tr>`; return; }
    tbody.innerHTML = mine.map((x) => `<tr class="data-row hover:bg-slate-50 transition border-b border-slate-200">
      <td class="cell-heading p-2.5 font-bold text-slate-900">${esc(x.locCity)} → ${esc(x.destPref)}</td>
      <td data-label="${esc(t('th_available'))}" class="p-2.5 text-slate-600">${avail(x)}</td>
      <td data-label="${esc(t('th_equipment'))}" class="p-2.5"><span class="bg-blue-50 text-blue-700 font-bold px-1.5 py-0.5 rounded border border-blue-200">${esc(x.equip)}</span> ${esc(x.capacityT)}t</td>
      <td data-label="${esc(t('th_min_rate'))}" class="p-2.5 font-bold text-emerald-600">${x.minRateUsd ? esc(U.money(x.minRateUsd)) : esc(t('negotiable'))}</td>
      <td class="p-2.5 text-center"><button type="button" data-action="remove" data-id="${x.id}" class="w-full md:w-auto justify-center bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold px-2 py-1.5 md:py-1 rounded text-[10px] border border-rose-200 inline-flex items-center space-x-1 transition"><i data-lucide="trash-2" class="w-3 h-3"></i><span>${esc(t('btn_remove'))}</span></button></td>
    </tr>`).join('');
    lucide.createIcons();
  }

  async function removeMine(id) {
    const x = mine.find((m) => m.id === id);
    if (!x) return;
    const ok = await U.confirmDialog({ title: t('confirm_remove_truck_title'), message: t('confirm_remove_truck', { where: x.locCity }), confirmText: t('btn_remove') });
    if (!ok) return;
    try { await API.del(`/api/trucks/${id}`); U.toast(t('toast_truck_removed'), 'success'); loadMine(); stale = true; } catch (err) { U.toast(err.message, 'error'); }
  }

  async function submitPost(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = await Cities.readForm(form);
    if (!body) return;
    U.setBusy(form, true);
    try {
      await API.post('/api/trucks', body);
      U.toast(t('toast_truck_published'), 'success');
      form.reset();
      Cities.clear($('truck-post-loc'));
      Account.prefillContacts();
      // Clear the search filters so the truck just posted can't be hidden by an old search.
      filters = { loc: null, radius: 150, dest: '', equip: '' };
      Cities.clear($('search-truck-loc')); $('search-truck-dest').value = ''; $('search-truck-equip').value = ''; $('search-truck-radius').value = 150;
      loadMine();
      stale = true;
    } catch (err) {
      U.applyFormErrors(form, err);
    } finally {
      U.setBusy(form, false);
    }
  }

  function onLive(evt) {
    if (!entered || (evt.entity !== 'trucks' && evt.entity !== 'resync')) return;
    if (App.view === 'post-trucks' || evt.entity === 'resync') loadMine();
    if (App.view === 'search-trucks') refreshFromLive(); else stale = true;
  }
  const refreshFromLive = U.liveThrottle(() => reload({ silent: true }));

  function init() {
    Cities.attach($('search-truck-loc'), { onPick: searchSoon });
    Cities.attach($('truck-post-loc'));
    $('truck-filter-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
    $('search-truck-equip').addEventListener('change', searchSoon);
    $('search-truck-radius').addEventListener('change', searchSoon);
    $('search-truck-dest').addEventListener('input', U.debounce(search, 400));
    $('reset-truck-filters-btn').addEventListener('click', () => {
      filters = { loc: null, radius: 150, dest: '', equip: '' };
      Cities.clear($('search-truck-loc')); $('search-truck-dest').value = ''; $('search-truck-equip').value = ''; $('search-truck-radius').value = 150;
      reload();
    });
    $('trucks-footer').addEventListener('click', (e) => { if (e.target.closest('[data-action="retry"]')) { list.error = null; list.items.length ? loadMore() : reload(); } });
    $('post-truck-form').addEventListener('submit', submitPost);
    $('my-trucks-tbody').addEventListener('click', (e) => { const b = e.target.closest('[data-action="remove"]'); if (b) removeMine(Number(b.dataset.id)); });
    // Desktop: the results box is the scroller. Phone: the whole page is (root null = the visible screen).
    const watchSentinel = () => {
      observer?.disconnect();
      observer = new IntersectionObserver((entries) => { if (entries.some((en) => en.isIntersecting)) loadMore(); }, { root: mobileMq.matches ? null : $('trucks-scroll'), rootMargin: '400px' });
      observer.observe($('trucks-sentinel'));
    };
    watchSentinel();
    mobileMq.addEventListener('change', watchSentinel);
    let scrollTick = null; // plain scroll listener as a second trigger (see loads.js)
    const loadIfNearEnd = () => {
      if (scrollTick) return;
      scrollTick = setTimeout(() => { scrollTick = null; if (!list.loading && !list.done && $('trucks-sentinel').getBoundingClientRect().top < pageBottom() + 400) loadMore(); }, 120);
    };
    $('trucks-scroll').addEventListener('scroll', loadIfNearEnd, { passive: true });
    $('view-search-trucks').addEventListener('scroll', loadIfNearEnd, { passive: true });
    for (const id of ['truck-post-date', 'truck-post-date-end']) $(id).min = U.todayIso();
    Live.on(onLive);
  }

  function enter() { entered = true; reload(); loadMine(); }
  function leave() {
    entered = false;
    list.ctrl?.abort();
    Object.assign(list, { items: [], cursor: null, total: null, done: false, error: null, loading: false });
    mine = [];
    filters = { loc: null, radius: 150, dest: '', equip: '' };
    $('trucks-tbody').innerHTML = '';
    $('my-trucks-tbody').innerHTML = '';
  }
  function onShow() { if (stale) reload({ silent: true }); }

  return { init, enter, leave, onShow, render, renderMine, loadMine };
})();

window.Trucks = Trucks;
