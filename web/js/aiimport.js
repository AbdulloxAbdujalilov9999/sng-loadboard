// "Paste loads, let AI fill them in": the member pastes Telegram/WhatsApp posts, the server (Gemini) turns them
// into one draft per load, and the member reviews/edits the drafts before ONE click posts them all.
// Nothing is ever posted without this review step - AI output is a suggestion, not a decision.
const AiImport = (() => {
  const { $, esc } = U;
  const AMBER = ['border-amber-400', 'bg-amber-50'];
  const FIELD_FOR_FLAG = { origin: 'originCityId', dest: 'destCityId', same_city: 'destCityId', weight: 'weightT', date: 'pickupDate', rate: 'rateUsd' };
  const SHARED = { contactName: 'ai-c-name', contactEmail: 'ai-c-email', contactTelegram: 'ai-c-tg' };
  let drafts = [];

  const input = 'w-full border border-slate-300 rounded p-1.5 text-xs focus:border-blue-500';

  function profileContacts() {
    const p = Session.me?.profile || {};
    return { name: p.contactName || '', phone: p.phone || '', email: p.contactEmail || p.email || '', tg: p.telegram || '' };
  }

  function cardHtml(d, i) {
    const eq = ['T', 'R', 'F', 'V', 'AC'].map((c) => `<option value="${c}" ${d.equip === c ? 'selected' : ''}>${esc(t(`eq_${c}`))}</option>`).join('');
    const fp = ['Full', 'Partial'].map((c) => `<option value="${c}" ${d.fp === c ? 'selected' : ''}>${esc(t(c === 'Full' ? 'opt_full' : 'opt_partial'))}</option>`).join('');
    return `<form class="ai-card bg-white border border-slate-200 rounded-lg p-3 space-y-2.5 text-xs shadow-sm" data-i="${i}" novalidate>
      <div class="flex items-center justify-between gap-2">
        <label class="flex items-center gap-2 font-bold text-slate-800 min-w-0"><input type="checkbox" class="ai-include" checked> <span>#${i + 1}</span>
          <span class="text-[10px] text-slate-400 font-normal truncate" title="${esc(d.originText)} → ${esc(d.destText)}">${esc(t('ai_from_text'))}: ${esc(d.originText)} → ${esc(d.destText)}</span></label>
        <button type="button" data-skip class="text-slate-400 hover:text-rose-600 flex-shrink-0" aria-label="${esc(t('btn_remove'))}"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div class="relative"><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_origin_city'))}</label><input type="text" name="originCityId" data-city-picker autocomplete="off" placeholder="${esc(t('ph_city'))}" class="${input}"></div>
        <div class="relative"><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_dest_city'))}</label><input type="text" name="destCityId" data-city-picker autocomplete="off" placeholder="${esc(t('ph_city'))}" class="${input}"></div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('filter_type'))}</label><select name="equip" class="${input}">${eq}</select></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_load_type'))}</label><select name="fp" class="${input}">${fp}</select></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_weight_tons'))}</label><input type="number" name="weightT" step="0.1" min="0.1" max="100" value="${esc(d.weightT)}" class="${input}"></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_target_rate'))}</label><input type="number" name="rateUsd" min="0" step="1" value="${esc(d.rateUsd)}" class="${input}"></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_pickup_date'))}</label><input type="date" name="pickupDate" value="${esc(d.pickupDate)}" class="${input}"></div>
        <div class="sm:col-span-2"><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_commodity'))}</label><input type="text" name="commodity" maxlength="200" value="${esc(d.commodity)}" class="${input}"></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <div class="sm:col-span-2"><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_notes'))}</label><textarea name="notes" rows="2" maxlength="500" class="${input}">${esc(d.notes)}</textarea></div>
        <div><label class="block font-semibold text-slate-600 mb-0.5">${esc(t('lbl_phone'))}</label><input type="tel" name="contactPhone" value="${esc(d.contactPhone)}" placeholder="${esc(profileContacts().phone)}" class="${input}"></div>
      </div>
    </form>`;
  }

  function render() {
    const root = $('ai-review');
    if (!drafts.length) { root.classList.add('hidden'); root.innerHTML = ''; return; }
    const c = profileContacts();
    root.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm font-bold text-slate-800">${esc(t('ai_found', { n: drafts.length }))}</p>
        <p class="text-[11px] text-amber-700 flex items-center gap-1"><span class="inline-block w-3 h-3 rounded border border-amber-400 bg-amber-50"></span>${esc(t('ai_legend'))}</p>
      </div>
      <div id="ai-cards" class="space-y-3">${drafts.map(cardHtml).join('')}</div>
      <div class="bg-white border border-slate-200 rounded-lg p-3 space-y-2 text-xs">
        <p class="font-semibold text-slate-700">${esc(t('ai_shared_contacts'))}</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <div class="relative"><label class="block text-slate-600 mb-0.5" for="ai-c-name">${esc(t('lbl_disp_name'))}</label><input id="ai-c-name" type="text" maxlength="120" value="${esc(c.name)}" class="${input}"></div>
          <div class="relative"><label class="block text-slate-600 mb-0.5" for="ai-c-email">${esc(t('lbl_email'))}</label><input id="ai-c-email" type="email" value="${esc(c.email)}" class="${input}"></div>
          <div class="relative"><label class="block text-slate-600 mb-0.5" for="ai-c-tg">${esc(t('lbl_telegram'))}</label><input id="ai-c-tg" type="text" value="${esc(c.tg)}" class="${input}"></div>
        </div>
        <p class="text-[10px] text-slate-400">${esc(t('ai_shared_hint'))}</p>
      </div>
      <div class="flex flex-wrap gap-2 justify-end">
        <button type="button" id="ai-clear" class="bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-2 px-4 rounded text-xs">${esc(t('ai_clear'))}</button>
        <button type="button" id="ai-post" class="bg-[#0066cc] hover:bg-blue-700 disabled:opacity-60 text-white font-bold py-2 px-5 rounded text-xs shadow flex items-center space-x-2"><i data-lucide="upload-cloud" class="w-4 h-4"></i><span id="ai-post-label"></span></button>
      </div>`;
    root.classList.remove('hidden');

    root.querySelectorAll('.ai-card').forEach((form, i) => {
      const d = drafts[i];
      for (const name of ['originCityId', 'destCityId']) {
        const el = form.elements[name];
        Cities.attach(el, { onPick: () => unflag(el) });
        const id = name === 'originCityId' ? d.originCityId : d.destCityId;
        const label = name === 'originCityId' ? d.originCity : d.destCity;
        if (id) Cities.set(el, { id, label });
      }
      for (const flag of d.flags) { const el = form.elements[FIELD_FOR_FLAG[flag]]; if (el) el.classList.add(...AMBER); }
      form.addEventListener('input', (e) => unflag(e.target));
      form.addEventListener('change', (e) => { unflag(e.target); updatePostLabel(); });
    });
    root.querySelectorAll('#ai-cards input, #ai-cards select, #ai-cards textarea').forEach(() => {});
    lucide.createIcons();
    updatePostLabel();
  }

  function unflag(el) { el?.classList?.remove(...AMBER, 'field-invalid'); }

  function selectedForms() { return [...document.querySelectorAll('#ai-cards .ai-card')].filter((f) => f.querySelector('.ai-include').checked); }

  function updatePostLabel() {
    const label = $('ai-post-label');
    if (!label) return;
    const n = selectedForms().length;
    label.textContent = t('ai_post_n', { n });
    $('ai-post').disabled = n === 0;
  }

  function reset() {
    drafts = [];
    $('ai-text').value = '';
    $('ai-count').textContent = '0';
    render();
  }

  // ---------------------------------------------------------------- reading
  async function read(e) {
    e.preventDefault();
    const text = $('ai-text').value.trim();
    if (text.length < 8) { $('ai-text').focus(); return; }
    const btn = $('ai-read-btn');
    btn.disabled = true;
    const label = btn.querySelector('span');
    label.textContent = t('ai_reading');
    try {
      const res = await API.post('/api/ai/parse-loads', { text });
      drafts = res.loads;
      if (!drafts.length) U.toast(t('ai_none_found'), 'info');
      else if (res.truncated) U.toast(t('ai_truncated'), 'info');
      render();
      if (drafts.length) $('ai-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    for (const id of Object.values(SHARED)) { $(id).classList.remove('field-invalid'); $(id).parentElement.querySelector('.field-error')?.remove(); }
    const shared = { contactName: $('ai-c-name').value.trim(), contactEmail: $('ai-c-email').value.trim(), contactTelegram: $('ai-c-tg').value.trim() };
    let ok = true;
    for (const [key, id] of Object.entries(SHARED)) if (!shared[key]) { U.fieldError($(id), t('err_required')); ok = false; }

    const loads = [];
    for (const form of forms) {
      const body = await Cities.readForm(form); // validates the city pickers and clears old errors
      if (!body) { ok = false; continue; }
      body.contactPhone = body.contactPhone || profileContacts().phone;
      if (!body.contactPhone) { U.fieldError(form.elements.contactPhone, t('err_required')); ok = false; }
      loads.push({ ...body, ...shared, deliveryDate: null, volumeM3: null });
    }
    if (!ok) { (document.querySelector('#ai-review .field-invalid'))?.focus(); return; }

    const btn = $('ai-post');
    btn.disabled = true;
    try {
      const res = await API.post('/api/loads/bulk', { loads });
      U.toast(t('ai_posted_n', { n: res.items.length }), 'success');
      reset();
      Loads.markStale();
      Loads.loadMine();
    } catch (err) {
      showPostErrors(err, forms);
    } finally {
      btn.disabled = false;
      updatePostLabel();
    }
  }

  function showPostErrors(err, forms) {
    let shown = 0;
    for (const d of err.details || []) {
      const m = /^loads\.(\d+)\.(.+)$/.exec(d.path);
      if (!m) continue;
      const [, k, field] = m;
      const el = SHARED[field] ? $(SHARED[field]) : forms[Number(k)]?.elements[field];
      if (el) { U.fieldError(el, U.detailText(d)); shown += 1; }
    }
    document.querySelector('#ai-review .field-invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!shown) U.toast(err.message, 'error');
  }

  // ---------------------------------------------------------------- lifecycle
  function showUnavailable(on) {
    $('ai-unavailable').classList.toggle('hidden', !on);
    $('ai-read-btn').disabled = on;
    $('ai-text').disabled = on;
  }

  // The two ways to post a load: paste text (AI) or the manual form. The choice is remembered.
  const ACTIVE = ['bg-indigo-600', 'text-white', 'border-indigo-600', 'shadow'];
  const IDLE = ['bg-white', 'text-slate-600', 'border-slate-300', 'hover:bg-slate-50'];
  function setTab(name) {
    const tab = name === 'manual' ? 'manual' : 'ai';
    $('ai-import').classList.toggle('hidden', tab !== 'ai');
    $('post-form-card').classList.toggle('hidden', tab !== 'manual');
    document.querySelectorAll('#post-tabs [data-post-tab]').forEach((b) => {
      const on = b.dataset.postTab === tab;
      b.classList.remove(...(on ? IDLE : ACTIVE));
      b.classList.add(...(on ? ACTIVE : IDLE));
      b.setAttribute('aria-selected', String(on));
    });
    U.store.set('sng.postTab', tab);
  }

  function enter() {
    const mode = App.config?.aiImport;
    showUnavailable(mode === false);
    $('ai-basic').classList.toggle('hidden', mode !== 'basic');
    setTab(U.store.get('sng.postTab', 'ai'));
  }
  function leave() { reset(); }

  function init() {
    document.querySelectorAll('#post-tabs [data-post-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.postTab)));
    $('contact-incomplete-btn').addEventListener('click', () => App.setView('account-settings'));
    $('ai-form').addEventListener('submit', read);
    $('ai-text').addEventListener('input', () => { $('ai-count').textContent = $('ai-text').value.length; });
    $('ai-review').addEventListener('click', (e) => {
      if (e.target.closest('#ai-post')) { post(); return; }
      if (e.target.closest('#ai-clear')) { reset(); return; }
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

window.AiImport = AiImport;
