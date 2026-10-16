(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COUNTRIES = ['UZ', 'KZ', 'KG', 'TJ', 'TM', 'RU', 'BY', 'UA', 'AZ', 'AM', 'GE', 'MD', 'TR', 'IR', 'AF', 'CN', 'MN', 'PL', 'DE', 'RO', 'BG', 'LT', 'LV', 'EE'];
  const EQUIP = ['T', 'R', 'F', 'V', 'AC'];
  const EQUIP_NAME = { T: 'Tent', R: 'Reefer', F: 'Flatbed', V: 'Van', AC: 'Car carrier' };
  const telegram = window.Telegram?.WebApp ?? null;

  // ---------------------------------------------------------------- i18n / theme
  function applyI18n() {
    document.documentElement.lang = MiniI18n.lang;
    $('lang-select').value = MiniI18n.lang;
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
    document.querySelectorAll('[data-t-ph]').forEach((el) => { el.placeholder = t(el.dataset.tPh); });
    $('search-go-text').textContent = searchKind === 'trucks' ? t('btn_find_trucks') : t('btn_find_cargo');
    $('nearby-locate-text').textContent = t('nearby_locate');
    $('row-language-sub').textContent = { en: 'English', ru: 'Русский', uz: "O'zbek" }[MiniI18n.lang];
  }
  function setTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    U.store.set('sng.miniTheme', mode);
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ---------------------------------------------------------------- age/money helpers
  function ageText(iso) {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 1) return t('age_now');
    if (min < 60) return t('age_min', { n: min });
    if (min < 1440) return t('age_hour', { n: Math.floor(min / 60) });
    return t('age_day', { n: Math.floor(min / 1440) });
  }
  const money = (usd) => (usd > 0 ? `$${Number(usd).toLocaleString()}` : t('negotiable'));

  // ---------------------------------------------------------------- shared listing card (loads + trucks)
  function cardHtml(item, kind) {
    const isLoad = kind === 'loads';
    const from = isLoad ? item.originCity : item.locCity;
    const to = isLoad ? item.destCity : (item.destPref || 'Anywhere');
    const price = isLoad ? money(item.rateUsd) : (item.minRateUsd > 0 ? `$${Number(item.minRateUsd).toLocaleString()}+` : t('negotiable'));
    const weightLabel = isLoad ? `${item.weightT}t${item.volumeM3 ? ` / ${item.volumeM3}m³` : ''}` : `${item.capacityT}t${item.volumeM3 ? ` / ${item.volumeM3}m³` : ''}`;
    const tel = String(item.contactPhone || '').replace(/[^\d+]/g, '');
    const tg = item.contactTelegram ? `https://t.me/${item.contactTelegram.replace('@', '')}` : null;
    return `<div class="lcard" data-id="${item.id}" data-kind="${kind}">
      <div class="top">
        <div class="route">${esc(from)} <span style="color:var(--muted)">→</span> ${esc(to)}</div>
        <div class="age">${esc(ageText(item.createdAt))}</div>
      </div>
      <div class="meta">
        <span class="badge">${esc(item.equip)}</span>
        <span><b>${esc(weightLabel)}</b></span>
        ${isLoad && item.fp ? `<span>${esc(item.fp)}</span>` : ''}
        ${item.company ? `<span>${esc(item.company)}</span>` : ''}
      </div>
      <div class="bottom">
        <span class="price">${esc(price)}</span>
        <div class="acts">
          ${tg ? `<a class="actbtn tg" href="${tg}" target="_blank" rel="noopener" aria-label="${esc(t('btn_message'))}"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" fill="none" stroke="currentColor" stroke-width="2"/></svg></a>` : ''}
          ${tel ? `<a class="actbtn phone" href="tel:${esc(tel)}" aria-label="${esc(t('btn_call'))}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .3 2 .6 3a2 2 0 01-.5 2.1L8 10a16 16 0 006 6l1.2-1.2a2 2 0 012.1-.5c1 .3 2 .5 3 .6a2 2 0 011.7 2z"/></svg></a>` : ''}
        </div>
      </div>
      ${item.notes ? `<div class="note">${esc(item.notes)}</div>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------- navigation
  function setView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tab[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  }
  function wireNav() {
    document.querySelectorAll('.tab[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('tab-post').addEventListener('click', () => openPost());
  }

  // ---------------------------------------------------------------- Dashboard
  async function loadDashboard() {
    try {
      const stats = await API.get('/api/stats');
      $('chip-cargo-n').textContent = stats.loads;
      $('chip-truck-n').textContent = stats.trucks;
    } catch { /* counts are a nicety, feed still loads */ }
    await loadFeed();
  }
  let dashKind = 'loads';
  async function loadFeed() {
    $('dash-feed').innerHTML = `<div class="empty"><span class="spinner" style="border-color:rgba(13,142,240,.25);border-top-color:var(--blue-2);"></span></div>`;
    try {
      const calls = [];
      if (dashKind !== 'trucks') calls.push(API.get('/api/loads', { sort: 'created', dir: 'desc', limit: 20 }).then((r) => r.items.map((x) => ({ ...x, _kind: 'loads' }))));
      if (dashKind !== 'loads') calls.push(API.get('/api/trucks', { sort: 'created', dir: 'desc', limit: 20 }).then((r) => r.items.map((x) => ({ ...x, _kind: 'trucks' }))));
      const items = (await Promise.all(calls)).flat().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 25);
      $('dash-feed').innerHTML = items.length ? items.map((x) => cardHtml(x, x._kind)).join('') : `<div class="empty">${esc(t('loads_none'))}</div>`;
    } catch (err) {
      $('dash-feed').innerHTML = `<div class="empty">${esc(err.message || t('err_generic'))}</div>`;
    }
  }
  function wireDashboard() {
    document.querySelector('[data-action="tile-cargo"]').addEventListener('click', () => { setSearchKind('loads'); setView('search'); });
    document.querySelector('[data-action="tile-truck"]').addEventListener('click', () => { setSearchKind('trucks'); setView('search'); });
    document.querySelector('[data-action="tile-post"]').addEventListener('click', () => openPost());
    $('dash-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.querySelectorAll('#dash-chips .chip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      dashKind = chip.dataset.kind;
      loadFeed();
    });
    $('dash-refresh').addEventListener('click', loadFeed);
    $('dash-filter-btn').addEventListener('click', () => {
      $('search-from-city').value = $('dash-from').value;
      $('search-to-city').value = $('dash-to').value;
      setView('search');
      runSearch();
    });
  }

  // ---------------------------------------------------------------- Search
  let searchKind = 'loads';
  function fillCountrySelect(sel) {
    sel.innerHTML = `<option value="">${esc(t('opt_any'))}</option>` + COUNTRIES.map((c) => `<option value="${c}">${c}</option>`).join('');
  }
  function setSearchKind(kind) {
    searchKind = kind;
    $('search-seg-loads').classList.toggle('on', kind === 'loads');
    $('search-seg-trucks').classList.toggle('on', kind === 'trucks');
    $('search-go-text').textContent = kind === 'trucks' ? t('btn_find_trucks') : t('btn_find_cargo');
    // Trucks have no searchable "destination" (destPref is free text, not a filter field server-side).
    $('search-to-country').closest('div').style.visibility = kind === 'trucks' ? 'hidden' : '';
    $('search-to-city').style.visibility = kind === 'trucks' ? 'hidden' : '';
  }
  let geoPos = null;
  async function runSearch() {
    $('search-results').innerHTML = `<div class="empty"><span class="spinner" style="border-color:rgba(13,142,240,.25);border-top-color:var(--blue-2);"></span></div>`;
    const fromCountry = $('search-from-country').value;
    const toCountry = $('search-to-country').value;
    const fromCity = cityState.searchFrom; // a picked city (resolved via attachCityPick) overrides the country filter
    const toCity = cityState.searchTo;
    const equip = $('search-equip').value;
    try {
      let params;
      if (searchKind === 'loads') {
        params = { equip: equip || undefined, sort: 'created', dir: 'desc', limit: 30 };
        if (fromCity) params.origin = fromCity.id; else if (fromCountry) params.originCountry = fromCountry;
        if (toCity) params.dest = toCity.id; else if (toCountry) params.destCountry = toCountry;
        if (geoPos) { params.nearLat = geoPos.lat; params.nearLng = geoPos.lng; params.originRadius = Number($('search-radius').value); delete params.origin; }
      } else {
        params = { equip: equip || undefined, sort: 'created', dir: 'desc', limit: 30 };
        if (fromCity) params.loc = fromCity.id; else if (fromCountry) params.locCountry = fromCountry;
        if (geoPos) { params.nearLat = geoPos.lat; params.nearLng = geoPos.lng; params.locRadius = Number($('search-radius').value); delete params.loc; }
      }
      const res = await API.get(searchKind === 'loads' ? '/api/loads' : '/api/trucks', params);
      $('search-count').textContent = t('of_count', { shown: res.items.length, total: res.total ?? res.items.length });
      $('search-results').innerHTML = res.items.length ? res.items.map((x) => cardHtml(x, searchKind)).join('') : `<div class="empty">${esc(t('loads_none'))}</div>`;
    } catch (err) {
      $('search-results').innerHTML = `<div class="empty">${esc(err.message || t('err_generic'))}</div>`;
    }
  }
  function wireSearch() {
    fillCountrySelect($('search-from-country'));
    fillCountrySelect($('search-to-country'));
    attachCityPick('search-from-city', 'searchFrom');
    attachCityPick('search-to-city', 'searchTo');
    $('search-seg-loads').addEventListener('click', () => setSearchKind('loads'));
    $('search-seg-trucks').addEventListener('click', () => setSearchKind('trucks'));
    $('search-go').addEventListener('click', runSearch);
    $('search-clear').addEventListener('click', () => {
      $('search-from-country').value = ''; $('search-to-country').value = '';
      $('search-from-city').value = ''; $('search-to-city').value = ''; $('search-equip').value = '';
      cityState.searchFrom = null; cityState.searchTo = null;
      geoPos = null; $('search-radius').classList.add('hidden');
      $('search-results').innerHTML = ''; $('search-count').textContent = '';
    });
    $('search-nearby').addEventListener('click', async () => {
      if (!navigator.geolocation) return toast(t('nearby_denied'));
      toast(t('nearby_asking'));
      navigator.geolocation.getCurrentPosition(
        (pos) => { geoPos = { lat: pos.coords.latitude, lng: pos.coords.longitude }; $('search-radius').classList.remove('hidden'); runSearch(); },
        () => toast(t('nearby_denied')),
        { timeout: 10000 },
      );
    });
    $('search-radius').addEventListener('change', () => { if (geoPos) runSearch(); });
  }

  // ---------------------------------------------------------------- Near Me (its own tab: just loads/trucks around you)
  let nearbyKind = 'loads';
  let nearbyPos = null;
  function setNearbyKind(kind) {
    nearbyKind = kind;
    $('nearby-seg-loads').classList.toggle('on', kind === 'loads');
    $('nearby-seg-trucks').classList.toggle('on', kind === 'trucks');
    if (nearbyPos) runNearby();
  }
  async function runNearby() {
    if (!nearbyPos) return;
    $('nearby-results').innerHTML = `<div class="empty"><span class="spinner" style="border-color:rgba(13,142,240,.25);border-top-color:var(--blue-2);"></span></div>`;
    const radius = Number($('nearby-radius').value);
    const params = { sort: 'nearest', dir: 'asc', limit: 30, nearLat: nearbyPos.lat, nearLng: nearbyPos.lng };
    if (nearbyKind === 'loads') params.originRadius = radius; else params.locRadius = radius;
    try {
      const res = await API.get(nearbyKind === 'loads' ? '/api/loads' : '/api/trucks', params);
      $('nearby-count').textContent = t('of_count', { shown: res.items.length, total: res.total ?? res.items.length });
      $('nearby-results').innerHTML = res.items.length ? res.items.map((x) => cardHtml(x, nearbyKind)).join('') : `<div class="empty">${esc(t('loads_none'))}</div>`;
    } catch (err) {
      $('nearby-results').innerHTML = `<div class="empty">${esc(err.message || t('err_generic'))}</div>`;
    }
  }
  function wireNearby() {
    $('nearby-seg-loads').addEventListener('click', () => setNearbyKind('loads'));
    $('nearby-seg-trucks').addEventListener('click', () => setNearbyKind('trucks'));
    $('nearby-radius').addEventListener('change', runNearby);
    $('nearby-locate').addEventListener('click', () => {
      if (!navigator.geolocation) return toast(t('nearby_denied'));
      $('nearby-locate').disabled = true;
      $('nearby-locate-text').textContent = t('nearby_locating');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          nearbyPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          $('nearby-radius').classList.remove('hidden');
          $('nearby-locate').disabled = false;
          $('nearby-locate-text').textContent = t('nearby_locate');
          runNearby();
        },
        () => { toast(t('nearby_denied')); $('nearby-locate').disabled = false; $('nearby-locate-text').textContent = t('nearby_locate'); },
        { timeout: 10000 },
      );
    });
  }

  // ---------------------------------------------------------------- Post modal
  let postKind = 'cargo'; // which endpoint "As text" posts to - persists across tab switches
  function openPost() { $('postmodal').classList.add('open'); }
  function closePost() { $('postmodal').classList.remove('open'); }
  function setPostTab(tab) {
    document.querySelectorAll('.toggle3 .seg').forEach((b) => b.classList.toggle('on', b.dataset.postTab === tab));
    $('post-text').classList.toggle('hidden', tab !== 'text');
    $('post-cargo').classList.toggle('hidden', tab !== 'cargo');
    $('post-truck').classList.toggle('hidden', tab !== 'truck');
    if (tab === 'cargo') postKind = 'cargo'; else if (tab === 'truck') postKind = 'truck';
  }
  function dateChips(containerId, onPick) {
    const el = $(containerId);
    const days = [];
    for (let i = 0; i < 7; i += 1) { const d = new Date(); d.setDate(d.getDate() + i); days.push(d); }
    el.innerHTML = days.map((d, i) => `<div class="datechip${i === 0 ? ' on' : ''}" data-date="${d.toISOString().slice(0, 10)}">
      <div class="d">${d.toLocaleDateString(undefined, { weekday: 'short' })}</div><div class="n">${d.getDate()}</div></div>`).join('');
    el.querySelectorAll('.datechip').forEach((chip) => chip.addEventListener('click', () => {
      el.querySelectorAll('.datechip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      onPick(chip.dataset.date);
    }));
    onPick(days[0].toISOString().slice(0, 10));
  }
  let pcDate = null; let ptDate = null;

  async function submitTextPost() {
    const text = $('post-text-input').value.trim();
    if (text.length < 8) return toast(t('err_generic'));
    $('post-text-send').disabled = true;
    try {
      const res = await API.post(postKind === 'truck' ? '/api/ai/parse-trucks' : '/api/ai/parse-loads', { text });
      const items = postKind === 'truck' ? res.trucks : res.loads;
      renderReview(items);
    } catch (err) { toast(err.message || t('err_generic')); } finally { $('post-text-send').disabled = false; }
  }
  function renderReview(items) {
    if (!items?.length) { $('post-text-review').innerHTML = `<div class="empty">${esc(t('loads_none'))}</div>`; return; }
    $('post-text-review').innerHTML = `<p class="hint" style="margin-top:12px;">${esc(t('review_title'))}</p>` +
      items.map((it, i) => `<div class="card" style="margin-bottom:8px;">
        <div style="font-weight:700;">${esc(postKind === 'truck' ? (it.locCity || it.locText) : (it.originCity || it.originText))} → ${esc(postKind === 'truck' ? (it.destPref || '') : (it.destCity || it.destText))}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px;">${esc(it.equip)} · ${esc(postKind === 'truck' ? `${it.capacityT}t` : `${it.weightT}t`)} ${it.flags?.length ? `· ⚠ ${esc(it.flags.join(', '))}` : ''}</div>
      </div>`).join('') +
      `<button class="btn btn-primary" id="review-post-btn" style="margin-top:4px;">${esc(t('btn_post_all'))}</button>`;
    $('review-post-btn').addEventListener('click', async () => {
      try {
        if (postKind === 'truck') await API.post('/api/trucks/bulk', { trucks: items.map(stripFlags) });
        else await API.post('/api/loads/bulk', { loads: items.map(stripFlags) });
        toast(t('toast_posted'));
        closePost();
        $('post-text-input').value = ''; $('post-text-review').innerHTML = '';
        loadDashboard();
      } catch (err) { toast(err.message || t('err_generic')); }
    });
  }
  function stripFlags(it) { const { flags, originText, destText, locText, ...rest } = it; return rest; }

  async function submitCargoForm(e) {
    e.preventDefault();
    const from = cityState.pcFrom; const to = cityState.pcTo;
    if (!from || !to) return toast(t('err_pick_city'));
    const body = {
      originCityId: from.id, destCityId: to.id, equip: $('pc-equip').value, fp: 'Full',
      weightT: Number($('pc-weight').value || 1), volumeM3: $('pc-volume').value ? Number($('pc-volume').value) : null,
      pickupDate: pcDate, rateUsd: Number($('pc-price').value || 0),
      commodity: 'General cargo', notes: $('pc-notes').value.trim(),
      contactName: profileMe?.contactName || profileMe?.company || 'Driver',
      contactPhone: profileMe?.phone || '', contactTelegram: profileMe?.telegram || '',
    };
    try { await API.post('/api/loads', body); toast(t('toast_posted')); closePost(); loadDashboard(); }
    catch (err) { toast(err.message || t('err_generic')); }
  }
  async function submitTruckForm(e) {
    e.preventDefault();
    const from = cityState.ptFrom;
    if (!from) return toast(t('err_pick_city'));
    const body = {
      locCityId: from.id, destPref: $('pt-dest-pref').value.trim() || 'Anywhere', equip: $('pt-equip').value,
      capacityT: Number($('pt-capacity').value || 1), volumeM3: $('pt-volume').value ? Number($('pt-volume').value) : null,
      availableFrom: ptDate, notes: $('pt-notes').value.trim(),
      contactPhone: profileMe?.phone || '', contactTelegram: profileMe?.telegram || '',
    };
    try { await API.post('/api/trucks', body); toast(t('toast_posted')); closePost(); loadDashboard(); }
    catch (err) { toast(err.message || t('err_generic')); }
  }

  // minimal city-picker: type a city name, pick the first API match on blur/enter (no fancy dropdown - kept light for v1)
  const cityState = {};
  function attachCityPick(inputId, stateKey) {
    const input = $(inputId);
    let timer = null;
    input.addEventListener('input', () => {
      cityState[stateKey] = null;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) return;
        try {
          const res = await API.get('/api/cities', { q, limit: 1 });
          if (res[0] && res[0].kind !== 'country') { cityState[stateKey] = res[0]; input.value = res[0].label; input.style.borderColor = ''; }
        } catch { /* ignore */ }
      }, 500);
    });
  }

  function wirePost() {
    $('postmodal-close').addEventListener('click', closePost);
    $('postmodal-backdrop').addEventListener('click', closePost);
    document.querySelectorAll('.toggle3 .seg').forEach((b) => b.addEventListener('click', () => setPostTab(b.dataset.postTab)));
    $('post-text-send').addEventListener('click', submitTextPost);
    fillCountrySelect($('pc-from-country')); fillCountrySelect($('pc-to-country')); fillCountrySelect($('pt-from-country'));
    attachCityPick('pc-from-city', 'pcFrom'); attachCityPick('pc-to-city', 'pcTo'); attachCityPick('pt-from-city', 'ptFrom');
    dateChips('pc-date-chips', (d) => { pcDate = d; });
    dateChips('pt-date-chips', (d) => { ptDate = d; });
    document.querySelector('[data-pc-date="today"]').addEventListener('click', () => { pcDate = new Date().toISOString().slice(0, 10); });
    document.querySelector('[data-pc-date="tomorrow"]').addEventListener('click', () => { const d = new Date(); d.setDate(d.getDate() + 1); pcDate = d.toISOString().slice(0, 10); });
    document.querySelector('[data-pt-date="today"]').addEventListener('click', () => { ptDate = new Date().toISOString().slice(0, 10); });
    document.querySelector('[data-pt-date="tomorrow"]').addEventListener('click', () => { const d = new Date(); d.setDate(d.getDate() + 1); ptDate = d.toISOString().slice(0, 10); });
    $('post-cargo').addEventListener('submit', submitCargoForm);
    $('post-truck').addEventListener('submit', submitTruckForm);
  }

  // ---------------------------------------------------------------- Profile
  let profileMe = null;
  async function loadProfile() {
    try {
      const me = await API.get('/api/me');
      profileMe = me.profile;
      const name = me.profile?.company || me.profile?.contactName || '?';
      $('profile-avatar').textContent = name.slice(0, 2).toUpperCase();
      $('profile-name').textContent = name;
      $('profile-id').textContent = t('lbl_id', { id: me.profile?.id ?? '-' });
      $('row-contacts-sub').textContent = [me.profile?.phone, me.profile?.telegram].filter(Boolean).join(' · ') || '-';
    } catch { /* not signed in yet - gate handles this */ }
    try {
      const [loads, trucks] = await Promise.all([API.get('/api/loads/mine'), API.get('/api/trucks/mine').catch(() => ({ items: [] }))]);
      const n = (loads.items?.length || 0) + (trucks.items?.length || 0);
      $('row-listings-sub').textContent = n ? `${n}` : t('row_listings_empty');
    } catch { /* optional */ }
  }
  function wireProfile() {
    $('lang-select').addEventListener('change', (e) => { MiniI18n.setLang(e.target.value); applyI18n(); loadProfile(); });
    $('row-theme').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      setTheme(cur === 'dark' ? 'light' : 'dark');
    });
    $('btn-logout').addEventListener('click', () => {
      window.Session.clear();
      telegram?.close?.();
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    setTheme(U.store.get('sng.miniTheme') || (telegram?.colorScheme === 'dark' ? 'dark' : 'light'));
    applyI18n();
    wireNav(); wireDashboard(); wireSearch(); wireNearby(); wirePost(); wireProfile();
    await window.TelegramMiniApp?.ready;
    const token = await window.Session.getToken();
    if (!token) {
      $('gate-text').textContent = t('not_signed_in');
      // No session: this should only happen if someone opens the page outside Telegram, or auth
      // failed - sngonebot's /start gate is what normally guarantees a signed-in account exists.
      return;
    }
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
    setView('dashboard');
    loadDashboard();
    loadProfile();
  }
  boot();
})();
