// Load board: saved multi-tab searches, server-side filter/sort, infinite scroll, my loads, post & edit.
const Loads = (() => {
  const { $, esc } = U;
  const tabsKey = () => `sng.searchTabs.v2:${Session.me?.login || ''}`; // per user: shared computers don't leak searches
  const MAX_TABS = 9;
  const PAGE = window.APP_CONFIG.pageSize;
  const CAP = window.APP_CONFIG.maxRenderedRows;
  // First click on a column sorts the way users expect for that column.
  const DEFAULT_DIR = { created: 'desc', pickup: 'asc', origin: 'asc', dest: 'asc', equip: 'asc', weight: 'desc', distance: 'asc', rate: 'desc', company: 'asc' };
  const SORT_KEYS = Object.keys(DEFAULT_DIR);

  let tabs = [];
  let activeId = null;
  let mine = [];
  let datePicker = null;
  let observer = null;
  let entered = false;
  let stale = false;
  let pendingNew = 0;
  // On phones the whole search page scrolls (see styles.css); on desktop only the results box does.
  const mobileMq = window.matchMedia('(max-width: 767px)');
  const pageBottom = () => (mobileMq.matches ? $('view-search-loads') : $('loads-scroll')).getBoundingClientRect().bottom;
  /** How far the results have scrolled up (0 = the first row is at the top / still below the filters). */
  const listScrolledPx = () => (mobileMq.matches
    ? Math.max(0, $('view-search-loads').getBoundingClientRect().top - $('loads-scroll').getBoundingClientRect().top)
    : $('loads-scroll').scrollTop);
  function scrollListToStart() {
    if (mobileMq.matches) { if (listScrolledPx() > 0) $('loads-scroll').scrollIntoView({ block: 'start' }); } else $('loads-scroll').scrollTop = 0;
  }
  let deepLinked = null; // the load currently shown in the preview popup, for its own Copy button
  let previewTrigger = null; // the row that opened the popup, so focus can return to it
  const list = { items: [], cursor: null, total: null, capped: false, loading: false, done: false, error: null, ctrl: null };

  // ---------------------------------------------------------------- tabs
  const defaultRadius = () => Number(U.store.get('sng.defaultDh', 100)) || 100;
  const newTab = (n) => ({ id: Date.now() + Math.floor(Math.random() * 1000), n, origin: null, dho: defaultRadius(), dest: null, dhd: defaultRadius(), equip: '', fp: '', dateRange: '', sort: 'created', dir: 'desc' });
  const active = () => tabs.find((tb) => tb.id === activeId) || tabs[0];
  const saveTabs = () => U.store.set(tabsKey(), { tabs, activeId });

  function loadTabs() {
    const saved = U.store.get(tabsKey());
    const valid = saved && Array.isArray(saved.tabs) && saved.tabs.length && saved.tabs.every((tb) => tb && SORT_KEYS.includes(tb.sort) && ['asc', 'desc'].includes(tb.dir));
    tabs = valid ? saved.tabs.slice(0, MAX_TABS) : [newTab(1)];
    activeId = valid && tabs.some((tb) => tb.id === saved.activeId) ? saved.activeId : tabs[0].id;
  }

  const shortName = (c) => c.label.split(',')[0];
  function tabTitle(tab) {
    if (tab.origin && tab.dest) return `${shortName(tab.origin)} → ${shortName(tab.dest)}`;
    if (tab.origin) return `${shortName(tab.origin)} →`;
    if (tab.dest) return `→ ${shortName(tab.dest)}`;
    return `${t('search_n')} ${tab.n}`;
  }

  function renderTabs() {
    const bar = $('multi-search-tabs-bar');
    bar.innerHTML = tabs.map((tab) => {
      const on = tab.id === activeId;
      return `<div role="tab" aria-selected="${on}" tabindex="0" data-tab="${tab.id}" class="flex items-center space-x-1.5 px-3 py-1 rounded-t text-xs cursor-pointer transition border-t border-l border-r border-slate-300 ${on ? 'search-tab-active shadow-sm' : 'search-tab-inactive'}">
        <i data-lucide="search" class="w-3 h-3 ${on ? 'text-blue-600' : 'text-slate-400'}"></i>
        <span class="max-w-[120px] truncate">${esc(tabTitle(tab))}</span>
        ${tabs.length > 1 ? `<button type="button" data-close="${tab.id}" class="ml-1 text-slate-400 hover:text-rose-600 rounded-full p-1" aria-label="${esc(t('btn_close_tab'))}"><i data-lucide="x" class="w-2.5 h-2.5"></i></button>` : ''}
      </div>`;
    }).join('') + (tabs.length < MAX_TABS ? `<button type="button" data-add="1" class="px-2 py-1 bg-slate-300 hover:bg-slate-400 text-slate-700 rounded-t text-xs font-bold transition" title="${esc(t('btn_add_search'))} (${tabs.length}/${MAX_TABS})" aria-label="${esc(t('btn_add_search'))}"><i data-lucide="plus" class="w-3.5 h-3.5"></i></button>` : '');
    lucide.createIcons();
  }

  function fillForm(tab) {
    const set = (id, city) => (city ? Cities.set($(id), city) : Cities.clear($(id)));
    set('filter-origin', tab.origin);
    set('filter-dest', tab.dest);
    $('filter-dho').value = tab.dho;
    $('filter-dhd').value = tab.dhd;
    $('filter-equip').value = tab.equip;
    $('filter-fp').value = tab.fp;
    if (datePicker) datePicker.setDate(tab.dateRange ? tab.dateRange.split(' to ') : [], false);
    $('filter-date-range').value = tab.dateRange;
    $('filter-origin').classList.remove('field-invalid');
    $('filter-dest').classList.remove('field-invalid');
  }

  const radius = (v) => Math.min(2000, Math.max(0, Math.round(Number(v)) || 0));

  /** Read the form into the active tab. Returns false (and flags the field) if a typed city is unknown. */
  async function applyForm() {
    const tab = active();
    const originInput = $('filter-origin');
    const destInput = $('filter-dest');
    const origin = originInput.value.trim() ? await Cities.resolve(originInput) : null;
    const dest = destInput.value.trim() ? await Cities.resolve(destInput) : null;
    let ok = true;
    for (const [input, city] of [[originInput, origin], [destInput, dest]]) {
      input.classList.toggle('field-invalid', Boolean(input.value.trim()) && !city);
      if (input.value.trim() && !city) ok = false;
    }
    if (!ok) { U.toast(t('err_pick_city'), 'error'); return false; }
    Object.assign(tab, {
      origin: origin && { id: origin.id, label: origin.label, lat: origin.lat, lng: origin.lng },
      dest: dest && { id: dest.id, label: dest.label, lat: dest.lat, lng: dest.lng },
      dho: radius($('filter-dho').value), dhd: radius($('filter-dhd').value),
      equip: $('filter-equip').value, fp: $('filter-fp').value, dateRange: $('filter-date-range').value,
    });
    saveTabs();
    renderTabs();
    return true;
  }

  async function search() { if (await applyForm()) reload(); }
  const searchSoon = U.debounce(search, 250);

  function switchTab(id) {
    if (id === activeId) return;
    activeId = id;
    saveTabs();
    renderTabs();
    fillForm(active());
    updateSortIcons();
    reload();
  }

  function closeTab(id) {
    if (tabs.length <= 1) return;
    const i = tabs.findIndex((tb) => tb.id === id);
    tabs = tabs.filter((tb) => tb.id !== id);
    if (activeId === id) { activeId = tabs[Math.max(0, i - 1)].id; saveTabs(); renderTabs(); fillForm(active()); updateSortIcons(); reload(); } else { saveTabs(); renderTabs(); }
  }

  function addTab() {
    if (tabs.length >= MAX_TABS) return;
    const n = Math.max(0, ...tabs.map((tb) => tb.n)) + 1;
    const tab = newTab(n);
    tabs.push(tab);
    activeId = tab.id;
    saveTabs();
    renderTabs();
    fillForm(tab);
    updateSortIcons();
    reload();
  }

  // ---------------------------------------------------------------- querying
  function buildQuery(tab) {
    const [dateFrom, dateTo] = tab.dateRange ? tab.dateRange.split(' to ') : [];
    return {
      origin: tab.origin?.id, originRadius: tab.origin ? tab.dho : undefined,
      dest: tab.dest?.id, destRadius: tab.dest ? tab.dhd : undefined,
      equip: tab.equip || undefined, fp: tab.fp || undefined,
      dateFrom, dateTo: dateTo || dateFrom,
      sort: tab.sort, dir: tab.dir, limit: PAGE,
    };
  }

  async function reload({ silent = false } = {}) {
    list.ctrl?.abort();
    const ctrl = new AbortController();
    list.ctrl = ctrl;
    if (!silent) {
      Object.assign(list, { items: [], cursor: null, total: null, capped: false, done: false, error: null, loading: true });
      render();
      scrollListToStart();
    }
    hideBanner();
    stale = false;
    try {
      const res = await API.get('/api/loads', buildQuery(active()), ctrl.signal);
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
      const res = await API.get('/api/loads', { ...buildQuery(active()), cursor: list.cursor }, ctrl.signal);
      if (list.ctrl !== ctrl) return;
      const room = CAP - list.items.length;
      const fresh = res.items.slice(0, room);
      list.items.push(...fresh);
      list.cursor = res.nextCursor;
      list.done = !res.nextCursor;
      $('loads-tbody').insertAdjacentHTML('beforeend', fresh.map(rowHtml).join(''));
    } catch (err) {
      if (err.name === 'AbortError') return;
      list.error = err;
    }
    if (list.ctrl === ctrl) list.loading = false;
    renderFooter();
    checkSentinel();
  }

  /** If the end-of-list marker is already on screen (short pages / tall screens), keep loading. */
  function checkSentinel() {
    requestAnimationFrame(() => {
      if (!$('view-search-loads').offsetParent) return; // screen not shown: a hidden box measures 0, which would look like "end is visible" and fetch every page
      const s = $('loads-sentinel').getBoundingClientRect();
      if (s.top < pageBottom() + 400 && !list.loading && !list.done) loadMore();
    });
  }

  // ---------------------------------------------------------------- rendering
  function skeletonRows() {
    return Array.from({ length: 8 }, () => `<tr class="status-row"><td colspan="11" class="py-3 px-3"><div class="skeleton-bar w-full"></div></td></tr>`).join('');
  }

  // Rate 0 means "not stated / negotiable" (e.g. a pasted post with no price).
  const rateText = (usd) => (usd > 0 ? U.money(usd) : t('negotiable'));

  function rowHtml(l) {
    const dh = (v) => (v === null ? '' : ` <span class="text-[10px] ${v > 0 ? 'text-blue-600 font-bold' : 'text-slate-400 font-normal'}">(${v}km)</span>`);
    return `<tr class="data-row border-b border-slate-200 transition cursor-pointer select-none hover:bg-slate-50" data-id="${l.id}" tabindex="0" aria-haspopup="dialog">
      <td class="cell-hide-mobile py-2 px-1.5 text-center text-blue-600" aria-hidden="true">›</td>
      <td data-label="${esc(t('th_age'))}" data-created="${esc(l.createdAt)}" class="py-2 px-2 text-slate-400 font-normal truncate">${esc(U.ageText(l.createdAt))}</td>
      <td data-label="${esc(t('th_date'))}" class="py-2 px-2 text-slate-600 truncate">${esc(U.shortDate(l.pickupDate))}</td>
      <td class="cell-heading py-2 px-2.5 font-bold text-slate-900 truncate" title="${esc(l.originCity)}">${esc(l.originCity)}${dh(l.dho)}</td>
      <td class="cell-heading py-2 px-2.5 font-bold text-slate-900 truncate" title="${esc(l.destCity)}">→ ${esc(l.destCity)}${dh(l.dhd)}</td>
      <td data-label="${esc(t('th_type'))}" class="py-2 px-2 text-center"><span class="bg-blue-50 text-blue-800 font-bold px-1.5 py-0.5 rounded border border-blue-200 text-[10px]">${esc(l.equip)}</span></td>
      <td data-label="F/P" class="py-2 px-2 text-slate-600 truncate">${esc(t(l.fp === 'Full' ? 'opt_full' : 'opt_partial'))}</td>
      <td data-label="${esc(t('th_weight'))}" class="py-2 px-2 text-slate-700 truncate">${esc(l.weightT)}t${l.volumeM3 ? ` / ${esc(l.volumeM3)}m³` : ''}</td>
      <td data-label="${esc(t('th_distance'))}" class="py-2 px-2 text-right text-slate-600 truncate">${esc(l.distanceKm.toLocaleString())} km</td>
      <td data-label="${esc(t('th_rate'))}" class="py-2 px-2.5 text-right font-bold text-emerald-600 truncate">${esc(rateText(l.rateUsd))}</td>
      <td data-label="${esc(t('th_company'))}" class="py-2 px-2.5 text-slate-800 font-medium truncate" title="${esc(l.company)}">${esc(l.company)}${l.mine ? ` <span class="text-[9px] bg-amber-100 text-amber-800 px-1 rounded font-bold">${esc(t('badge_yours'))}</span>` : ''}</td>
    </tr>`;
  }

  function detailHtml(l) {
    const tel = String(l.contactPhone).replace(/[^\d+]/g, '');
    const maps = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(l.originCity)}&destination=${encodeURIComponent(l.destCity)}&travelmode=driving`;
    return `<tr class="detail-row font-sans" data-detail-for="${l.id}">
      <td colspan="11" class="p-0">
        <div class="grid grid-cols-1 md:grid-cols-12 gap-4 text-xs">
          <div class="md:col-span-6 bg-white p-3 rounded border border-blue-100 shadow-sm space-y-3 flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-center border-b border-slate-100 pb-1.5">
                <span class="text-[10px] uppercase font-bold text-slate-400 tracking-wider">${esc(t('lbl_cargo_specs'))}</span>
                <span class="text-[11px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">${esc(l.equip)} • ${esc(t(l.fp === 'Full' ? 'opt_full' : 'opt_partial'))}</span>
              </div>
              <div class="grid grid-cols-2 gap-2 text-[11px] pt-2">
                <div><span class="text-slate-500">${esc(t('lbl_commodity'))}:</span> <strong class="text-slate-800 font-medium block">${esc(l.commodity)}</strong></div>
                <div><span class="text-slate-500">${esc(t('th_weight'))}:</span> <strong class="text-slate-800 font-mono block">${esc(l.weightT)} t${l.volumeM3 ? ` / ${esc(l.volumeM3)} m³` : ''}</strong></div>
                <div><span class="text-slate-500">${esc(t('lbl_pickup_date'))}:</span> <strong class="text-slate-800 font-mono block">${esc(l.pickupDate)}</strong></div>
                <div><span class="text-slate-500">${esc(t('lbl_delivery_date'))}:</span> <strong class="text-slate-800 font-mono block">${esc(l.deliveryDate || '--')}</strong></div>
                <div class="col-span-2 pt-1 border-t border-slate-100"><span class="text-slate-500">${esc(t('th_distance'))}:</span> <strong class="text-blue-700 font-mono">${esc(l.distanceKm.toLocaleString())} km (${esc(t('lbl_estimated_route'))})</strong></div>
              </div>
            </div>
            ${l.notes ? `<div class="text-[11px] bg-amber-50 border border-amber-200 rounded p-2 text-slate-800"><span class="text-[10px] uppercase font-bold text-amber-700 tracking-wider block mb-0.5">${esc(t('lbl_notes'))}</span><span class="whitespace-pre-line break-words">${esc(l.notes)}</span></div>` : ''}
            <div class="pt-2 border-t border-slate-100">
              <a href="${maps}" target="_blank" rel="noopener noreferrer" class="w-full bg-[#1a73e8] hover:bg-blue-600 text-white font-bold py-2 px-3 rounded flex items-center justify-center space-x-2 shadow-sm transition">
                <i data-lucide="map-pin" class="w-4 h-4 text-amber-300"></i><span>${esc(t('lbl_maps_btn'))}</span><i data-lucide="external-link" class="w-3.5 h-3.5 text-blue-200"></i>
              </a>
            </div>
          </div>
          <div class="md:col-span-6 bg-white p-3 rounded border border-blue-100 shadow-sm space-y-2">
            <div class="flex justify-between items-center border-b border-slate-100 pb-1.5">
              <span class="text-[10px] uppercase font-bold text-slate-400 tracking-wider">${esc(t('lbl_direct_contacts'))}</span>
              <span class="text-sm font-black text-emerald-600 font-mono">${esc(rateText(l.rateUsd))}</span>
            </div>
            <div class="space-y-2 text-slate-700 text-[11px] pt-1">
              <div class="flex items-center justify-between"><div class="flex items-center space-x-1.5"><i data-lucide="building" class="w-3.5 h-3.5 text-slate-400"></i><strong class="text-slate-900">${esc(l.company)}</strong></div><span class="text-slate-500 font-medium">${esc(l.contactName)}</span></div>
              <div class="flex items-center justify-between bg-slate-50 p-1.5 rounded border border-slate-100"><div class="flex items-center space-x-2"><i data-lucide="phone" class="w-3.5 h-3.5 text-blue-600"></i><a href="tel:${esc(tel)}" class="font-bold text-blue-700 hover:underline">${esc(l.contactPhone)}</a></div><a href="tel:${esc(tel)}" class="text-[10px] bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-semibold hover:bg-blue-200">${esc(t('lbl_call'))}</a></div>
              <div class="flex items-center justify-between bg-slate-50 p-1.5 rounded border border-slate-100"><div class="flex items-center space-x-2 truncate"><i data-lucide="mail" class="w-3.5 h-3.5 text-amber-600"></i><a href="mailto:${esc(l.contactEmail)}" class="text-slate-800 hover:underline truncate">${esc(l.contactEmail)}</a></div><a href="mailto:${esc(l.contactEmail)}" class="text-[10px] bg-slate-200 text-slate-800 px-2 py-0.5 rounded font-semibold hover:bg-slate-300">${esc(t('lbl_email_btn'))}</a></div>
              <div class="grid grid-cols-2 gap-2 pt-1">
                <a href="https://t.me/${esc(l.contactTelegram.replace('@', ''))}" target="_blank" rel="noopener noreferrer" class="bg-[#229ED9] hover:bg-[#1e8bc0] text-white font-bold py-1.5 px-2 rounded flex items-center justify-center space-x-1.5 transition text-xs"><i data-lucide="send" class="w-3 h-3"></i><span>${esc(l.contactTelegram)}</span></a>
                <button type="button" data-action="copy" data-id="${l.id}" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-1.5 px-2 rounded border border-slate-300 flex items-center justify-center space-x-1 transition text-xs"><i data-lucide="copy" class="w-3 h-3"></i><span>${esc(t('lbl_copy'))}</span></button>
              </div>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
  }

  function render() {
    const tbody = $('loads-tbody');
    if (list.loading && !list.items.length) tbody.innerHTML = skeletonRows();
    else if (!list.items.length) tbody.innerHTML = `<tr class="status-row"><td colspan="11" class="p-8 text-center text-slate-400 font-sans">${esc(list.error ? list.error.message : t('loads_none'))}</td></tr>`;
    else {
      tbody.innerHTML = list.items.map(rowHtml).join('');
    }
    $('filtered-count').textContent = list.loading && list.total === null ? '…' : U.fmtCount(list.total, list.capped);
    renderFooter();
    updateSortIcons();
    lucide.createIcons();
  }

  function renderFooter() {
    const f = $('loads-footer');
    if (list.error && list.items.length) f.innerHTML = `${esc(list.error.message)} <button type="button" data-action="retry" class="text-blue-600 font-bold underline ml-1">${esc(t('btn_retry'))}</button>`;
    else if (list.error) f.innerHTML = `<button type="button" data-action="retry" class="text-blue-600 font-bold underline">${esc(t('btn_retry'))}</button>`;
    else if (list.loading && list.items.length) f.textContent = t('loading');
    else if (!list.done && list.items.length >= CAP) f.textContent = t('list_capped', { n: CAP.toLocaleString() });
    else if (list.done && list.items.length > PAGE) f.textContent = t('list_end', { n: list.items.length.toLocaleString() });
    else f.textContent = '';
  }

  function updateSortIcons() {
    const tab = active();
    if (!tab) return;
    for (const key of SORT_KEYS) {
      const icon = $(`sort-icon-${key}`);
      if (!icon) continue;
      const on = tab.sort === key;
      icon.textContent = on ? (tab.dir === 'asc' ? '▲' : '▼') : '⇅';
      icon.classList.toggle('text-sky-300', on);
      icon.classList.toggle('text-slate-400', !on);
    }
    const sel = $('mobile-sort-select');
    const combo = `${tab.sort}-${tab.dir}`;
    if ([...sel.options].some((o) => o.value === combo)) sel.value = combo;
  }

  function setSort(sort, dir) {
    const tab = active();
    tab.sort = sort;
    tab.dir = dir;
    saveTabs();
    reload();
  }

  // ---------------------------------------------------------------- load preview (popup) & actions
  // Clicking a load opens its full details in a popup instead of unfolding a row inside the list, so the list
  // never jumps around and phones get a proper full-width view.
  function showLoadPreview(l, trigger = null) {
    deepLinked = l;
    previewTrigger = trigger;
    $('view-load-title').lastElementChild.textContent = `${l.originCity} → ${l.destCity}`;
    $('view-load-sub').innerHTML = `${esc(l.company)} · ${esc(U.ageText(l.createdAt))}${l.mine ? ` <span class="text-[9px] bg-amber-100 text-amber-800 px-1 rounded font-bold">${esc(t('badge_yours'))}</span>` : ''}`;
    $('view-load-tbody').innerHTML = detailHtml(l);
    $('modal-view-load').classList.remove('hidden');
    lucide.createIcons();
    $('view-load-close').focus();
  }

  function openLoadPreview(id) {
    const l = list.items.find((x) => x.id === id);
    if (l) showLoadPreview(l, $('loads-tbody').querySelector(`tr[data-id="${id}"]`));
  }

  async function copyContact(id) {
    const l = list.items.find((x) => x.id === id) || (deepLinked?.id === id ? deepLinked : null);
    if (!l) return;
    const text = `${t('th_company')}: ${l.company}\n${t('lbl_disp_name')}: ${l.contactName}\n${t('lbl_phone')}: ${l.contactPhone}\n${t('lbl_email')}: ${l.contactEmail}\nTelegram: ${l.contactTelegram}`;
    try { await navigator.clipboard.writeText(text); U.toast(t('toast_copied'), 'success'); } catch { U.toast(text, 'info', 9000); }
  }

  // ---------------------------------------------------------------- live updates
  function showBanner() {
    $('live-banner-text').textContent = pendingNew > 0 ? t('live_new_n', { n: pendingNew }) : t('live_changed');
    $('live-banner').classList.remove('hidden');
  }
  function hideBanner() { pendingNew = 0; $('live-banner').classList.add('hidden'); }

  const refreshFromLive = U.liveThrottle(() => {
    const tab = active();
    const atTop = listScrolledPx() < 60;
    if (atTop && tab.sort === 'created' && tab.dir === 'desc') reload({ silent: true });
    else showBanner();
  });

  // How many brand-new loads from OTHER members an event announces (events can cover a whole batch).
  function newFromOthers(evt) {
    const me = Session.me?.profile?.id;
    if (evt.owners) return Math.max(0, (evt.inserts || 0) - (evt.owners[me] || 0));
    if (evt.op === 'insert') return evt.ownerId === me ? 0 : (evt.n || 1);
    return 0;
  }

  function onLive(evt) {
    if (!entered || (evt.entity !== 'loads' && evt.entity !== 'resync')) return;
    if (evt.entity === 'loads') pendingNew += newFromOthers(evt);
    if (App.view === 'post-loads' || evt.entity === 'resync') loadMine();
    if (App.view !== 'search-loads') { stale = true; return; }
    refreshFromLive();
  }

  // ---------------------------------------------------------------- my loads
  async function loadMine() {
    try { mine = (await API.get('/api/loads/mine')).items; } catch { return; }
    renderMine();
  }

  function renderMine() {
    $('my-loads-count').textContent = mine.length;
    const tbody = $('my-loads-tbody');
    if (!mine.length) { tbody.innerHTML = `<tr class="status-row"><td colspan="7" class="p-4 text-center text-slate-400 font-sans">${esc(t('my_loads_empty'))}</td></tr>`; return; }
    tbody.innerHTML = mine.map((l) => `<tr class="data-row hover:bg-slate-50 transition border-b border-slate-200">
      <td class="cell-heading p-2.5 font-bold text-slate-900">${esc(l.originCity)} → ${esc(l.destCity)}</td>
      <td data-label="${esc(t('th_pickup_delivery'))}" class="p-2.5 text-slate-600">${esc(l.pickupDate)} <span class="text-slate-400">/</span> ${esc(l.deliveryDate || '--')}</td>
      <td data-label="${esc(t('th_type_weight'))}" class="p-2.5"><span class="bg-blue-50 text-blue-700 font-bold px-1.5 py-0.5 rounded border border-blue-200">${esc(l.equip)}</span> ${esc(l.weightT)}t</td>
      <td data-label="${esc(t('th_distance'))}" class="p-2.5 text-slate-600">${esc(l.distanceKm.toLocaleString())} km</td>
      <td data-label="${esc(t('th_rate'))}" class="p-2.5 font-bold text-emerald-600">${esc(rateText(l.rateUsd))}</td>
      <td data-label="${esc(t('lbl_commodity_short'))}" class="p-2.5 text-slate-700 truncate max-w-[150px]" title="${esc(l.commodity)}">${esc(l.commodity)}</td>
      <td class="p-2.5 text-center"><div class="flex items-center justify-center space-x-1">
        <button type="button" data-action="edit" data-id="${l.id}" class="flex-1 md:flex-none justify-center bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold px-2 py-1.5 md:py-1 rounded text-[10px] border border-blue-200 flex items-center space-x-1 transition"><i data-lucide="edit-2" class="w-3 h-3"></i><span>${esc(t('btn_edit'))}</span></button>
        <button type="button" data-action="remove" data-id="${l.id}" class="flex-1 md:flex-none justify-center bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold px-2 py-1.5 md:py-1 rounded text-[10px] border border-rose-200 flex items-center space-x-1 transition"><i data-lucide="trash-2" class="w-3 h-3"></i><span>${esc(t('btn_remove'))}</span></button>
      </div></td>
    </tr>`).join('');
    lucide.createIcons();
  }

  async function removeMine(id) {
    const l = mine.find((x) => x.id === id);
    if (!l) return;
    const ok = await U.confirmDialog({ title: t('confirm_remove_load_title'), message: t('confirm_remove_load', { route: `${l.originCity} → ${l.destCity}` }), confirmText: t('btn_remove') });
    if (!ok) return;
    try { await API.del(`/api/loads/${id}`); U.toast(t('toast_load_removed'), 'success'); loadMine(); stale = true; } catch (err) { U.toast(err.message, 'error'); }
  }

  // ---------------------------------------------------------------- post form
  function distancePreview(origId, destId, outId) {
    const a = Cities.get($(origId));
    const b = Cities.get($(destId));
    const out = $(outId);
    if (a?.lat !== undefined && b?.lat !== undefined && a.id !== b.id) out.value = `≈ ${Math.max(1, Math.round(U.haversineKm(a, b) * (App.config?.roadFactor || 1.2))).toLocaleString()} km`;
    else if (outId === 'post-dist') out.value = '';
  }

  async function submitPost(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = await Cities.readForm(form);
    if (!body) return;
    U.setBusy(form, true);
    try {
      await API.post('/api/loads', body);
      U.toast(t('toast_load_published'), 'success');
      form.reset();
      $('post-dist').value = '';
      for (const id of ['post-orig', 'post-dest']) Cities.clear($(id));
      Account.prefillContacts();
      loadMine();
      stale = true;
    } catch (err) {
      U.applyFormErrors(form, err);
    } finally {
      U.setBusy(form, false);
    }
  }

  // ---------------------------------------------------------------- edit modal
  function openEdit(id) {
    const l = mine.find((x) => x.id === id);
    if (!l) return;
    U.clearFormErrors($('edit-load-form'));
    $('edit-load-id').value = l.id;
    Cities.set($('edit-orig'), { id: l.originCityId, label: l.originCity });
    Cities.set($('edit-dest'), { id: l.destCityId, label: l.destCity });
    $('edit-equip').value = l.equip;
    $('edit-fp').value = l.fp;
    $('edit-weight').value = l.weightT;
    $('edit-rate').value = l.rateUsd;
    $('edit-date').value = l.pickupDate;
    $('edit-delivery-date').value = l.deliveryDate || '';
    $('edit-dist').value = `${l.distanceKm.toLocaleString()} km`;
    $('edit-commodity').value = l.commodity;
    $('edit-notes').value = l.notes || '';
    $('edit-contact-name').value = l.contactName;
    $('edit-phone').value = l.contactPhone;
    $('edit-email').value = l.contactEmail;
    $('edit-tg').value = l.contactTelegram;
    $('modal-edit-load').classList.remove('hidden');
    $('edit-orig').focus();
  }

  function closeEdit() { $('modal-edit-load').classList.add('hidden'); }

  // ---------------------------------------------------------------- deep-linked view (?load=<id>)
  // Used when a link (e.g. from the Telegram bot's broadcast) should open one specific load,
  // regardless of the viewer's current filters/pagination - so it reuses detailHtml() as a
  // standalone card rather than needing that load to be present in the current search results.
  async function openDeepLinkedLoad(id) {
    let l;
    try { l = await API.get(`/api/loads/${id}`); } catch (err) {
      U.toast(err.status === 404 ? t('toast_load_not_found') : err.message, 'error');
      return;
    }
    showLoadPreview(l);
  }

  function closeViewLoad() {
    $('modal-view-load').classList.add('hidden');
    deepLinked = null;
    if (previewTrigger?.isConnected) previewTrigger.focus({ preventScroll: true }); // keyboard users land back on their row
    previewTrigger = null;
  }

  async function submitEdit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = await Cities.readForm(form);
    if (!body) return;
    U.setBusy(form, true);
    try {
      await API.patch(`/api/loads/${$('edit-load-id').value}`, body);
      U.toast(t('toast_load_updated'), 'success');
      closeEdit();
      loadMine();
      stale = true;
    } catch (err) {
      U.applyFormErrors(form, err);
    } finally {
      U.setBusy(form, false);
    }
  }

  // ---------------------------------------------------------------- lifecycle
  function init() {
    for (const id of ['filter-origin', 'filter-dest']) Cities.attach($(id), { onPick: searchSoon });
    for (const id of ['post-orig', 'post-dest']) Cities.attach($(id), { onPick: () => distancePreview('post-orig', 'post-dest', 'post-dist') });
    for (const id of ['edit-orig', 'edit-dest']) Cities.attach($(id), { onPick: () => distancePreview('edit-orig', 'edit-dest', 'edit-dist') });

    datePicker = flatpickr('#filter-date-range', { mode: 'range', dateFormat: 'Y-m-d', allowInput: false, locale: I18N.flatpickrLocale(), onClose: searchSoon });
    I18N.onChange(() => { datePicker.set('locale', I18N.flatpickrLocale()); });

    $('load-filter-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
    for (const id of ['filter-equip', 'filter-fp']) $(id).addEventListener('change', searchSoon);
    for (const id of ['filter-dho', 'filter-dhd']) $(id).addEventListener('change', searchSoon);
    $('reset-filters-btn').addEventListener('click', () => {
      Object.assign(active(), { origin: null, dest: null, dho: defaultRadius(), dhd: defaultRadius(), equip: '', fp: '', dateRange: '', sort: 'created', dir: 'desc' });
      saveTabs(); renderTabs(); fillForm(active()); reload();
    });

    $('multi-search-tabs-bar').addEventListener('click', (e) => {
      const close = e.target.closest('[data-close]');
      if (close) { e.stopPropagation(); closeTab(Number(close.dataset.close)); return; }
      if (e.target.closest('[data-add]')) { addTab(); return; }
      const tab = e.target.closest('[data-tab]');
      if (tab) switchTab(Number(tab.dataset.tab));
    });
    $('multi-search-tabs-bar').addEventListener('keydown', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchTab(Number(tab.dataset.tab)); }
    });

    document.querySelectorAll('#view-search-loads [data-sort]').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const tab = active();
      setSort(key, tab.sort === key ? (tab.dir === 'asc' ? 'desc' : 'asc') : DEFAULT_DIR[key]);
    }));
    $('mobile-sort-select').addEventListener('change', (e) => { const [s, d] = e.target.value.split('-'); setSort(s, d); });

    const tbody = $('loads-tbody');
    tbody.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]');
      if (action?.dataset.action === 'copy') { copyContact(Number(action.dataset.id)); return; }
      if (e.target.closest('a, button')) return;
      const tr = e.target.closest('tr.data-row');
      if (tr) openLoadPreview(Number(tr.dataset.id));
    });
    tbody.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr.data-row');
      if (tr && e.target === tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLoadPreview(Number(tr.dataset.id)); }
    });
    $('loads-footer').addEventListener('click', (e) => {
      if (e.target.closest('[data-action="retry"]')) { list.error = null; list.items.length ? loadMore() : reload(); }
    });
    $('live-banner-btn').addEventListener('click', () => reload());

    // Desktop: the results box is the scroller. Phone: the page is (root null = the visible screen, still clipped by it).
    const watchSentinel = () => {
      observer?.disconnect();
      observer = new IntersectionObserver((entries) => { if (entries.some((en) => en.isIntersecting)) loadMore(); }, { root: mobileMq.matches ? null : $('loads-scroll'), rootMargin: '400px' });
      observer.observe($('loads-sentinel'));
    };
    watchSentinel();
    mobileMq.addEventListener('change', watchSentinel); // rotating a tablet / resizing a window
    // Belt and braces: a plain scroll listener also loads the next page near the end (IntersectionObserver
    // callbacks can be delayed or skipped by some browsers, e.g. in background tabs).
    let scrollTick = null;
    const loadIfNearEnd = () => {
      if (scrollTick) return;
      scrollTick = setTimeout(() => { scrollTick = null; if (!list.loading && !list.done && $('loads-sentinel').getBoundingClientRect().top < pageBottom() + 400) loadMore(); }, 120);
    };
    $('loads-scroll').addEventListener('scroll', loadIfNearEnd, { passive: true });
    $('view-search-loads').addEventListener('scroll', loadIfNearEnd, { passive: true });

    $('post-load-form').addEventListener('submit', submitPost);
    $('my-loads-tbody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const id = Number(b.dataset.id);
      if (b.dataset.action === 'edit') openEdit(id); else if (b.dataset.action === 'remove') removeMine(id);
    });
    $('edit-load-form').addEventListener('submit', submitEdit);
    $('edit-cancel').addEventListener('click', closeEdit);
    $('edit-close').addEventListener('click', closeEdit);
    $('modal-edit-load').addEventListener('mousedown', (e) => { if (e.target === $('modal-edit-load')) closeEdit(); });

    $('view-load-close').addEventListener('click', closeViewLoad);
    $('modal-view-load').addEventListener('mousedown', (e) => { if (e.target === $('modal-view-load')) closeViewLoad(); });
    $('view-load-tbody').addEventListener('click', (e) => {
      const action = e.target.closest('[data-action="copy"]');
      if (action) copyContact(Number(action.dataset.id));
    });

    for (const id of ['post-date', 'post-delivery-date', 'edit-date', 'edit-delivery-date']) $(id).min = U.todayIso();

    Live.on(onLive);
    // Keep "posted 5m ago" honest without refetching anything.
    setInterval(() => {
      document.querySelectorAll('#loads-tbody td[data-created]').forEach((td) => { td.textContent = U.ageText(td.dataset.created); });
    }, 60000);
  }

  function enter() {
    entered = true;
    loadTabs();
    $('posting-as-company').textContent = Session.me?.profile?.company || '';
    renderTabs();
    fillForm(active());
    reload();
    loadMine();
  }

  function leave() {
    entered = false;
    list.ctrl?.abort();
    Object.assign(list, { items: [], cursor: null, total: null, done: false, error: null, loading: false });
    mine = [];
    tabs = [];
    activeId = null;
    pendingNew = 0;
    $('loads-tbody').innerHTML = '';
    $('my-loads-tbody').innerHTML = '';
  }

  /** Called when the user navigates back to the Search tab. */
  function onShow() { if (stale) reload({ silent: true }); }

  return {
    init, enter, leave, onShow, render, renderTabs, renderMine, loadMine, closeEdit,
    openDeepLinkedLoad, closeViewLoad, markStale() { stale = true; }, get stale() { return stale; },
  };
})();

window.Loads = Loads;
