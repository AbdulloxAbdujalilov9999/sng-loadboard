// "Paste trucks, let AI fill them in": the member pastes "truck available" posts from Telegram/WhatsApp, the server
// (Gemini, or the basic reader) turns them into one draft per truck, and the member reviews/edits the drafts before ONE
// click posts them all. Mirrors the loads importer (aiimport.js). Nothing is posted without the review step.
const AiTrucks = (() => {
  const { $, esc } = U;
  const AMBER = ['border-amber-400', 'bg-amber-50'];
  const FIELD_FOR_FLAG = { location: 'locCityId', location_check: 'locCityId', date: 'availableFrom', capacity: 'capacityT' };
  let drafts = [];

  const input = 'w-full border border-slate-300 rounded p-1.5 text-xs focus:border-blue-500';

  function profileContacts() {
    const p = Session.me?.profile || {};
    return { phone: p.phone || '', tg: p.telegram || '' };
  }

  function cardHtml(d, i) {
    const eq = ['T', 'R', 'F', 'V', 'AC'].map((c) => `<option value="${c}" ${d.equip === c ? 'selected' : ''}>${esc(t(`eq_${c}`))}</option>`).join('');
    const feat = (name, key, on) => `<label class="flex items-center space-x-1.5 cursor-pointer"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} class="rounded text-blue-600"><span>${esc(t(key))}</span></label>`;
    return `<form class="ai-card bg-white border border-slate-200 rounded-lg p-3 space-y-2.5 text-xs shadow-sm" data-i="${i}" novalidate>
      <div class="flex items-center justify-between gap-2">
        <label class="flex items-center gap-2 font-bold text-slate-800 min-w-0"><input type="checkbox" class="ai-include" checked> <span>#${i + 1}</span>
          <span class="text-[10px] text-slate-400 font-normal truncate" title="${esc(d.locText)}">${esc(t('ai_from_text'))}: ${esc(d.locText)}</span></label>
        <button type="button" data-skip class="text-slate-400 hover:text-rose-600 flex-shrink-0" aria-label="${esc(t('btn_remove'))}"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div class="relative"><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_truck_loc_full'))}</label><input type="text" name="locCityId" data-city-picker autocomplete="off" placeholder="${esc(t('ph_city'))}" class="${input}"></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_truck_dest'))}</label><input type="text" name="destPref" maxlength="120" value="${esc(d.destPref)}" class="${input}"></div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div class="col-span-2 sm:col-span-1"><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('filter_type'))}</label><select name="equip" class="${input}">${eq}</select></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_max_payload'))}</label><input type="number" name="capacityT" step="0.1" min="0.1" max="100" value="${esc(d.capacityT)}" class="${input}"></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_vol_cube'))}</label><input type="number" name="volumeM3" min="1" max="200" value="${esc(d.volumeM3 ?? '')}" class="${input}"></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_min_target_rate'))}</label><input type="number" name="minRateUsd" min="0" step="1" value="${esc(d.minRateUsd ?? '')}" class="${input}"></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_avail_from'))}</label><input type="date" name="availableFrom" value="${esc(d.availableFrom)}" class="${input}"></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_avail_until'))}</label><input type="date" name="availableTo" value="${esc(d.availableTo ?? '')}" class="${input}"></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_phone'))}</label><input type="tel" name="contactPhone" value="${esc(d.contactPhone)}" placeholder="${esc(profileContacts().phone)}" class="${input}"></div>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded p-2">
        ${feat('hasTir', 'feat_tir', d.hasTir)}${feat('hasAdr', 'feat_adr', d.hasAdr)}${feat('hasGps', 'feat_gps', d.hasGps)}${feat('sideLoading', 'feat_side', d.sideLoading)}
      </div>
      <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_notes'))}</label><textarea name="notes" rows="2" maxlength="500" class="${input}">${esc(d.notes)}</textarea></div>
    </form>`;
  }

  function render() {
    const root = $('ai-t-review');
    if (!drafts.length) { root.classList.add('hidden'); root.innerHTML = ''; return; }
    const c = profileContacts();
    root.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm font-bold text-slate-800">${esc(t('ai_trucks_found', { n: drafts.length }))}</p>
        <p class="text-[11px] text-amber-700 flex items-center gap-1"><span class="inline-block w-3 h-3 rounded border border-amber-400 bg-amber-50"></span>${esc(t('ai_legend'))}</p>
      </div>
      <div id="ai-t-cards" class="space-y-3">${drafts.map(cardHtml).join('')}</div>
      <div class="bg-white border border-slate-200 rounded-lg p-3 space-y-2 text-xs">
        <p class="font-semibold text-slate-700">${esc(t('ai_shared_contacts'))}</p>
        <div class="relative max-w-xs"><label class="block text-slate-600 mb-0.5" for="ai-t-tg">${esc(t('lbl_telegram'))}</label><input id="ai-t-tg" type="text" value="${esc(c.tg)}" class="${input}"></div>
        <p class="text-[10px] text-slate-400">${esc(t('ai_shared_hint'))}</p>
      </div>
      <div class="flex flex-wrap gap-2 justify-end">
        <button type="button" id="ai-t-clear" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2 px-4 rounded text-xs">${esc(t('ai_clear'))}</button>
        <button type="button" id="ai-t-post" class="bg-[#0066cc] hover:bg-blue-700 disabled:opacity-60 text-white font-bold py-2 px-5 rounded text-xs shadow flex items-center space-x-2"><i data-lucide="upload-cloud" class="w-4 h-4"></i><span id="ai-t-post-label"></span></button>
      </div>`;
    root.classList.remove('hidden');

    root.querySelectorAll('.ai-card').forEach((form, i) => {
      const d = drafts[i];
      const el = form.elements.locCityId;
      Cities.attach(el, { onPick: () => unflag(el) });
      if (d.locCityId) Cities.set(el, { id: d.locCityId, label: d.locCity });
      for (const flag of d.flags) { const f = form.elements[FIELD_FOR_FLAG[flag]]; if (f) f.classList.add(...AMBER); }
      form.addEventListener('input', (e) => unflag(e.target));
      form.addEventListener('change', (e) => { unflag(e.target); updatePostLabel(); });
    });
    lucide.createIcons();
    updatePostLabel();
  }

  function unflag(el) { el?.classList?.remove(...AMBER, 'field-invalid'); }
  function selectedForms() { return [...document.querySelectorAll('#ai-t-cards .ai-card')].filter((f) => f.querySelector('.ai-include').checked); }

  function updatePostLabel() {
    const label = $('ai-t-post-label');
    if (!label) return;
    const n = selectedForms().length;
    label.textContent = t('ai_trucks_post_n', { n });
    $('ai-t-post').disabled = n === 0;
  }

  function reset() {
    drafts = [];
    $('ai-t-text').value = '';
    $('ai-t-count').textContent = '0';
    render();
  }

  // ---------------------------------------------------------------- reading
  async function read(e) {
    e.preventDefault();
    const text = $('ai-t-text').value.trim();
    if (text.length < 8) { $('ai-t-text').focus(); return; }
    const btn = $('ai-t-read-btn');
    btn.disabled = true;
    const label = btn.querySelector('span');
    label.textContent = t('ai_reading');
    try {
      const res = await API.post('/api/ai/parse-trucks', { text });
      drafts = res.trucks;
      if (!drafts.length) U.toast(t('ai_trucks_none'), 'info');
      else if (res.truncated) U.toast(t('ai_truncated'), 'info');
      render();
      if (drafts.length) $('ai-t-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (err.code === 'ai_unavailable') showUnavailable(true);
      U.toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      label.textContent = t('ai_btn_read');
    }
  }

  // ---------------------------------------------------------------- posting
  async function post() {
    const forms = selectedForms();
    if (!forms.length) return;
    const tgEl = $('ai-t-tg');
    tgEl.classList.remove('field-invalid'); tgEl.parentElement.querySelector('.field-error')?.remove();
    const telegram = tgEl.value.trim();
    let ok = true;
    if (!telegram) { U.fieldError(tgEl, t('err_required')); ok = false; }

    const trucks = [];
    for (const form of forms) {
      const body = await Cities.readForm(form); // validates the city picker and clears old errors
      if (!body) { ok = false; continue; }
      body.contactPhone = body.contactPhone || profileContacts().phone;
      if (!body.contactPhone) { U.fieldError(form.elements.contactPhone, t('err_required')); ok = false; }
      if (!body.destPref) body.destPref = 'Anywhere';
      trucks.push({ ...body, contactTelegram: telegram });
    }
    if (!ok) { document.querySelector('#ai-t-review .field-invalid')?.focus(); return; }

    const btn = $('ai-t-post');
    btn.disabled = true;
    try {
      const res = await API.post('/api/trucks/bulk', { trucks });
      U.toast(t('ai_trucks_posted_n', { n: res.items.length }), 'success');
      reset();
      Trucks.markStale();
      Trucks.loadMine();
    } catch (err) {
      showPostErrors(err, forms, tgEl);
    } finally {
      btn.disabled = false;
      updatePostLabel();
    }
  }

  function showPostErrors(err, forms, tgEl) {
    let shown = 0;
    for (const d of err.details || []) {
      const m = /^trucks\.(\d+)\.(.+)$/.exec(d.path);
      if (!m) continue;
      const [, k, field] = m;
      const el = field === 'contactTelegram' ? tgEl : forms[Number(k)]?.elements[field];
      if (el) { U.fieldError(el, U.detailText(d)); shown += 1; }
    }
    document.querySelector('#ai-t-review .field-invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!shown) U.toast(err.message, 'error');
  }

  // ---------------------------------------------------------------- lifecycle
  function showUnavailable(on) {
    $('ai-t-unavailable').classList.toggle('hidden', !on);
    $('ai-t-read-btn').disabled = on;
    $('ai-t-text').disabled = on;
  }

  const ACTIVE = ['bg-indigo-600', 'text-white', 'border-indigo-600', 'shadow'];
  const IDLE = ['bg-white', 'text-slate-600', 'border-slate-300', 'hover:bg-slate-50'];
  function setTab(name) {
    const tab = name === 'manual' ? 'manual' : 'ai';
    $('ai-t-import').classList.toggle('hidden', tab !== 'ai');
    $('post-truck-card').classList.toggle('hidden', tab !== 'manual');
    document.querySelectorAll('#post-trucks-tabs [data-post-tab]').forEach((b) => {
      const on = b.dataset.postTab === tab;
      b.classList.remove(...(on ? IDLE : ACTIVE));
      b.classList.add(...(on ? ACTIVE : IDLE));
      b.setAttribute('aria-selected', String(on));
    });
    U.store.set('sng.postTruckTab', tab);
  }

  function enter() {
    const mode = App.config?.aiImport;
    showUnavailable(mode === false);
    $('ai-t-basic').classList.toggle('hidden', mode !== 'basic');
    setTab(U.store.get('sng.postTruckTab', 'ai'));
  }
  function leave() { reset(); }

  function init() {
    document.querySelectorAll('#post-trucks-tabs [data-post-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.postTab)));
    $('ai-t-form').addEventListener('submit', read);
    $('ai-t-text').addEventListener('input', () => { $('ai-t-count').textContent = $('ai-t-text').value.length; });
    $('ai-t-review').addEventListener('click', (e) => {
      if (e.target.closest('#ai-t-post')) { post(); return; }
      if (e.target.closest('#ai-t-clear')) { reset(); return; }
      const skip = e.target.closest('[data-skip]');
      if (skip) {
        const form = skip.closest('.ai-card');
        const box = form.querySelector('.ai-include');
        box.checked = !box.checked;
        form.classList.toggle('opacity-40', !box.checked);
        updatePostLabel();
      }
    });
  }

  return { init, enter, leave, setTab };
})();

window.AiTrucks = AiTrucks;
