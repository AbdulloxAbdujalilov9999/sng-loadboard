// City autocomplete. A picked city carries its id (and coordinates) on the input's dataset, so forms send
// ids, never free text - which keeps radius search and distance estimates exact.
const Cities = (() => {
  const cache = new Map();
  let seq = 0;

  async function search(q, signal) {
    const key = q.trim().toLowerCase();
    if (!key) return [];
    if (cache.has(key)) return cache.get(key);
    const { items } = await API.get('/api/cities', { q: key, limit: 8 }, signal);
    cache.set(key, items);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return items;
  }

  function set(input, city) {
    input.value = city.label;
    input.dataset.cityId = String(city.id);
    input.dataset.cityLabel = city.label;
    if (city.lat !== undefined) { input.dataset.lat = String(city.lat); input.dataset.lng = String(city.lng); } else { delete input.dataset.lat; delete input.dataset.lng; }
    input.classList.remove('field-invalid');
  }

  function clear(input) {
    input.value = '';
    delete input.dataset.cityId; delete input.dataset.cityLabel; delete input.dataset.lat; delete input.dataset.lng;
  }

  /** The currently selected city, or null if the text isn't a picked city. */
  function get(input) {
    if (!input.dataset.cityId || input.value !== input.dataset.cityLabel) return null;
    return { id: Number(input.dataset.cityId), label: input.dataset.cityLabel, lat: input.dataset.lat ? Number(input.dataset.lat) : undefined, lng: input.dataset.lng ? Number(input.dataset.lng) : undefined };
  }

  /** Like get(), but if the user typed text without picking, use the best match (e.g. "Moscow" + Search). */
  async function resolve(input) {
    const picked = get(input);
    if (picked) return picked;
    const text = input.value.trim();
    if (!text) return null;
    try {
      const [best] = await search(text);
      if (best) { set(input, best); return get(input); }
    } catch { /* network error: caller treats as unresolved */ }
    return null;
  }

  function attach(input, { onPick } = {}) {
    if (input._cityPicker) return;
    input._cityPicker = true;
    const holder = input.closest('.relative') || input.parentElement;
    const id = `city-dd-${(seq += 1)}`;
    const dd = document.createElement('div');
    dd.id = id;
    dd.className = 'city-dd hidden';
    dd.setAttribute('role', 'listbox');
    holder.appendChild(dd);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', id);
    input.setAttribute('aria-expanded', 'false');

    let items = [];
    let active = -1;
    let ctrl = null;

    const close = () => { dd.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); active = -1; };
    const highlight = (i) => {
      active = i;
      [...dd.children].forEach((c, n) => c.setAttribute('aria-selected', String(n === i)));
      if (i >= 0) dd.children[i]?.scrollIntoView({ block: 'nearest' });
    };
    const pick = (city) => { set(input, city); close(); onPick?.(city); input.dispatchEvent(new Event('change', { bubbles: true })); };

    function render() {
      if (!items.length) { dd.innerHTML = `<div class="city-dd-empty">${U.esc(t('city_none'))}</div>`; } else {
        dd.innerHTML = items.map((c, i) => `<div role="option" id="${id}-${i}" data-i="${i}" aria-selected="false">${U.esc(c.label)}${c.nameRu && c.nameRu !== c.name ? ` <span class="text-slate-400">· ${U.esc(c.nameRu)}</span>` : ''}</div>`).join('');
      }
      dd.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
    }

    const lookup = U.debounce(async () => {
      const q = input.value.trim();
      if (!q) { close(); return; }
      ctrl?.abort();
      ctrl = new AbortController();
      try { items = await search(q, ctrl.signal); render(); } catch (err) { if (err.name !== 'AbortError') close(); }
    }, 150);

    input.addEventListener('input', () => {
      if (input.dataset.cityId && input.value !== input.dataset.cityLabel) { delete input.dataset.cityId; delete input.dataset.lat; delete input.dataset.lng; }
      lookup();
    });
    input.addEventListener('keydown', (e) => {
      if (dd.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(active + 1, items.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(items[active]); }
      else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    dd.addEventListener('mousedown', (e) => { // mousedown (not click) so it fires before the input's blur
      const opt = e.target.closest('[role="option"]');
      if (opt) { e.preventDefault(); pick(items[Number(opt.dataset.i)]); }
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  const NUMERIC = new Set(['weightT', 'volumeM3', 'rateUsd', 'minRateUsd', 'capacityT']);
  const NULLABLE = new Set(['volumeM3', 'deliveryDate', 'minRateUsd', 'availableTo']);

  /**
   * Collect a form's [name] controls into an API body: city pickers become ids, numbers become numbers,
   * optional empties become null, checkboxes become booleans. Returns null (after marking the offending
   * fields) when a city text could not be resolved to a real city.
   */
  async function readForm(form) {
    U.clearFormErrors(form);
    const body = {};
    let ok = true;
    for (const el of form.querySelectorAll('[name]')) {
      const name = el.name;
      if (el.hasAttribute('data-city-picker')) {
        const city = el.value.trim() ? await resolve(el) : null;
        if (!city) { U.fieldError(el, t(el.value.trim() ? 'err_pick_city' : 'err_required')); ok = false; } else body[name] = city.id;
      } else if (el.type === 'checkbox') {
        body[name] = el.checked;
      } else if (NUMERIC.has(name)) {
        body[name] = el.value === '' ? (NULLABLE.has(name) ? null : '') : Number(el.value);
      } else if (NULLABLE.has(name)) {
        body[name] = el.value === '' ? null : el.value;
      } else {
        body[name] = el.value.trim();
      }
    }
    if (!ok) form.querySelector('.field-invalid')?.focus();
    return ok ? body : null;
  }

  return { search, set, clear, get, resolve, attach, readForm };
})();

window.Cities = Cities;
