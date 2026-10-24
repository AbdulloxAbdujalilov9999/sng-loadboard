// "My truck": the vehicle a driver describes once (Settings). Searching for loads can start from it ("Loads for my truck") and
// posting a truck is filled in from it. It lives on the member's profile, so the Telegram bot uses the same one.
const MyTruck = (() => {
  const { $ } = U;
  const mine = () => Session.me?.profile?.myTruck || null;

  // ---- Settings card ----
  let dirty = false; // the person has typed in the card: a refresh from the server (live update, language change) must not wipe it
  function fillCard() {
    dirty = false;
    const m = mine();
    $('mt-equip').value = m?.equip || 'T';
    $('mt-cap').value = m?.capacityT ?? '';
    $('mt-vol').value = m?.volumeM3 ?? '';
    for (const [id, k] of [['mt-tir', 'hasTir'], ['mt-adr', 'hasAdr'], ['mt-gps', 'hasGps'], ['mt-side', 'sideLoading']]) $(id).checked = Boolean(m?.[k]);
    if (m?.locCityId) Cities.set($('mt-loc'), { id: m.locCityId, label: m.locCity }); else Cities.clear($('mt-loc'));
    $('mt-dest').value = m?.destPref || '';
    $('mt-plate').value = m?.plate || '';
    $('mt-trailer').value = m?.trailerPlate || '';
    $('mt-driver').value = m?.driverName || '';
    $('mt-driver-phone').value = m?.driverPhone || '';
    $('mt-notes').value = m?.notes || '';
    $('mt-clear-btn').classList.toggle('hidden', !m);
  }

  async function cardBody(form) {
    U.clearFormErrors(form);
    const cap = Number($('mt-cap').value);
    if (!(cap > 0)) { U.fieldError($('mt-cap'), t('mt_need_type')); return null; }
    const loc = $('mt-loc').value.trim() ? await Cities.resolve($('mt-loc')) : null;
    if ($('mt-loc').value.trim() && !loc) { U.fieldError($('mt-loc'), t('err_pick_city')); return null; }
    return {
      equip: $('mt-equip').value, capacityT: cap, volumeM3: $('mt-vol').value === '' ? null : Number($('mt-vol').value),
      hasTir: $('mt-tir').checked, hasAdr: $('mt-adr').checked, hasGps: $('mt-gps').checked, sideLoading: $('mt-side').checked,
      locCityId: loc ? loc.id : null, destPref: $('mt-dest').value.trim(), plate: $('mt-plate').value.trim(), trailerPlate: $('mt-trailer').value.trim(),
      driverName: $('mt-driver').value.trim(), driverPhone: $('mt-driver-phone').value.trim(), notes: $('mt-notes').value.trim(),
    };
  }

  async function persist(body, toastKey) {
    const { profile } = body ? await API.put('/api/me/truck', body) : await API.del('/api/me/truck');
    Session.me.profile = profile;
    U.toast(t(toastKey), 'success');
    dirty = false;
    refresh();
  }

  async function saveCard() {
    const form = $('mytruck-card');
    const body = await cardBody(form);
    if (!body) return;
    U.setBusy(form, true);
    try { await persist(body, 'mt_saved'); } catch (err) { U.applyFormErrors(form, err); } finally { U.setBusy(form, false); }
  }

  async function clearCard() {
    try { await persist(null, 'mt_cleared'); } catch (err) { U.toast(err.message, 'error'); }
  }

  // ---- "Post a truck" form: start from the saved truck ----
  function fillPostForm({ quiet = false, onlyIfEmpty = false } = {}) {
    const m = mine();
    if (!m) return false;
    if (onlyIfEmpty && ($('truck-post-cap').value || $('truck-post-loc').value.trim())) return false; // never overwrite what is being typed
    $('truck-post-equip').value = m.equip;
    $('truck-post-cap').value = m.capacityT;
    $('truck-post-vol').value = m.volumeM3 ?? '';
    $('truck-feat-tir').checked = m.hasTir; $('truck-feat-adr').checked = m.hasAdr; $('truck-feat-gps').checked = m.hasGps; $('truck-feat-side').checked = m.sideLoading;
    if (m.locCityId) Cities.set($('truck-post-loc'), { id: m.locCityId, label: m.locCity });
    if (m.destPref) $('truck-post-dest').value = m.destPref;
    if (m.notes) $('truck-post-notes').value = m.notes;
    if (!$('truck-post-date').value) $('truck-post-date').value = U.todayIso();
    if (!quiet) U.toast(t('mt_filled'), 'success', 2500);
    return true;
  }

  async function saveFromPostForm() {
    const form = $('post-truck-form');
    const cap = Number($('truck-post-cap').value);
    if (!(cap > 0)) { U.fieldError($('truck-post-cap'), t('mt_need_type')); return; }
    const loc = $('truck-post-loc').value.trim() ? await Cities.resolve($('truck-post-loc')) : null;
    const old = mine() || {};
    const body = {
      equip: $('truck-post-equip').value, capacityT: cap, volumeM3: $('truck-post-vol').value === '' ? null : Number($('truck-post-vol').value),
      hasTir: $('truck-feat-tir').checked, hasAdr: $('truck-feat-adr').checked, hasGps: $('truck-feat-gps').checked, sideLoading: $('truck-feat-side').checked,
      locCityId: loc ? loc.id : (old.locCityId ?? null), destPref: $('truck-post-dest').value.trim(), plate: old.plate || '', trailerPlate: old.trailerPlate || '',
      driverName: old.driverName || '', driverPhone: old.driverPhone || '', notes: $('truck-post-notes').value.trim().slice(0, 300),
    };
    U.setBusy(form, true);
    try { await persist(body, 'mt_saved'); } catch (err) { U.applyFormErrors(form, err); } finally { U.setBusy(form, false); }
  }

  /** Everything that depends on whether a truck is saved. */
  function refresh() {
    if (!$('mytruck-card')) return;
    if (!dirty) fillCard();
    $('mt-clear-btn').classList.toggle('hidden', !mine());
    $('truck-fill-row').classList.toggle('hidden', !mine());
    $('mytruck-bar').classList.toggle('hidden', !mine());
    Loads.syncMyTruck?.();
  }

  function init() {
    Cities.attach($('mt-loc'));
    $('mt-save-btn').addEventListener('click', saveCard);
    $('mytruck-card').addEventListener('input', () => { dirty = true; });
    $('mytruck-card').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); saveCard(); } });
    $('mt-clear-btn').addEventListener('click', clearCard);
    $('truck-fill-btn').addEventListener('click', () => fillPostForm());
    $('truck-save-mine-btn').addEventListener('click', saveFromPostForm);
  }

  return { init, refresh, mine, fillPostForm };
})();
window.MyTruck = MyTruck;
