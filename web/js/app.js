// Application shell: navigation, language/currency, sidebar drawer, stats badges, and wiring everything together.
const App = (() => {
  const { $, esc } = U;
  const VIEWS = ['search-loads', 'post-loads', 'search-trucks', 'post-trucks', 'directory', 'account-settings', 'approvals'];
  const TITLES = { 'search-loads': 'nav_search_loads', 'post-loads': 'nav_post_loads', 'search-trucks': 'nav_search_trucks', 'post-trucks': 'nav_post_trucks', directory: 'nav_directory', 'account-settings': 'title_account', approvals: 'nav_approvals' };
  let view = 'search-loads';
  let entered = false;
  let config = null;
  let statsTimer = null;

  // ---------------------------------------------------------------- config / currency
  function applyConfig(cfg) {
    config = cfg;
    U.fx.rates = cfg.currencies;
    Prefs.fillCurrencies();
  }

  async function refreshConfig() {
    try {
      const res = await fetch(`${window.APP_CONFIG.apiBase || ''}/api/config`, { cache: 'no-store' });
      applyConfig(await res.json());
      rerender();
    } catch { /* keep the current rates */ }
  }

  // ---------------------------------------------------------------- chrome
  function toggleSidebar(open) {
    $('main-sidebar').classList.toggle('sidebar-open', open);
    $('sidebar-backdrop').classList.toggle('hidden', !open);
  }

  function showSyncBanner(message) {
    const el = $('sync-banner');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function renderSidebarUser() {
    const me = Session.me;
    if (!me?.profile) return;
    const owner = me.isOwner;
    $('sidebar-auth-section').innerHTML = `<button type="button" data-view="account-settings" class="flex items-center space-x-2.5 w-full text-left hover:bg-slate-800/60 p-1 rounded transition">
      <div class="w-7 h-7 rounded-full ${owner ? 'bg-amber-500' : 'bg-blue-600'} flex items-center justify-center font-bold text-white text-xs border border-blue-400">${owner ? '★' : esc(me.profile.company.slice(0, 2).toUpperCase())}</div>
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-white truncate text-[11px]">${esc(me.profile.company)}</p>
        <p class="text-[9px] ${owner ? 'text-amber-400' : 'text-emerald-400'} flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full ${owner ? 'bg-amber-400' : 'bg-emerald-400'}"></span>${esc(t(owner ? 'role_owner' : 'role_member'))}</p>
      </div>
    </button>`;
  }

  // ---------------------------------------------------------------- navigation
  function setView(name) {
    if (name === 'approvals' && !Session.me?.isOwner) name = 'search-loads';
    if (!VIEWS.includes(name)) name = 'search-loads';
    view = name;
    U.store.set('sng.view', name);
    for (const v of VIEWS) {
      $(`view-${v}`).classList.toggle('hidden', v !== name);
      const m = $(`menu-${v}`);
      m.classList.toggle('tab-active', v === name);
      m.classList.toggle('text-slate-400', v !== name);
      m.toggleAttribute('aria-current', v === name);
    }
    $('page-title').textContent = t(TITLES[name]);
    document.title = `${t(TITLES[name])} — SNG ONE`;
    toggleSidebar(false);
    if (name === 'search-loads') Loads.onShow();
    else if (name === 'post-loads') { Account.prefillContacts(); Loads.loadMine(); }
    else if (name === 'search-trucks') Trucks.onShow();
    else if (name === 'post-trucks') { Account.prefillContacts(); Trucks.loadMine(); }
    else if (name === 'directory') Directory.onShow();
    else if (name === 'account-settings') Account.populate();
    else if (name === 'approvals') Admin.onShow();
  }

  // ---------------------------------------------------------------- session hooks
  function enter(me) {
    const first = !entered;
    entered = true;
    $('app-workspace').classList.remove('hidden');
    const owner = Boolean(me.isOwner);
    $('nav-admin-section').classList.toggle('hidden', !owner);
    $('menu-approvals').classList.toggle('hidden', !owner);
    Account.populate();
    if (!first) return; // later calls are profile refreshes
    Loads.enter(); AiImport.enter(); Trucks.enter(); Directory.enter(); Admin.enter();
    setView(U.store.get('sng.view', 'search-loads'));
    setTimeout(refreshStats, 0);
    statsTimer = setInterval(refreshStats, 45000 + Math.random() * 30000);
  }

  function leave() {
    if (!entered) return;
    entered = false;
    clearInterval(statsTimer);
    Loads.leave(); AiImport.leave(); Trucks.leave(); Directory.leave(); Admin.leave();
    resetForms();
    showSyncBanner('');
    $('app-workspace').classList.add('hidden');
  }

  /** Nothing typed or selected by one user may survive into the next session on this page. */
  function resetForms() {
    for (const id of ['post-load-form', 'post-truck-form', 'edit-load-form', 'profile-form', 'load-filter-form', 'truck-filter-form', 'fx-form']) $(id).reset();
    document.querySelectorAll('[data-city-picker]').forEach((el) => Cities.clear(el));
    document.querySelectorAll('[data-auto]').forEach((el) => { delete el.dataset.auto; });
    document.querySelectorAll('.field-invalid').forEach((el) => el.classList.remove('field-invalid'));
    document.querySelectorAll('.field-error').forEach((el) => el.remove());
    $('modal-edit-load').classList.add('hidden');
    $('post-dist').value = '';
    $('fx-grid').innerHTML = '';
    $('badge-total-loads').textContent = '–';
    $('badge-total-trucks').textContent = '–';
    $('sidebar-auth-section').innerHTML = '';
  }

  async function refreshStats() {
    try {
      const s = await API.get('/api/stats');
      $('badge-total-loads').textContent = U.badgeCount(s.loads, s.loadsCapped);
      $('badge-total-trucks').textContent = U.badgeCount(s.trucks, s.trucksCapped);
      showSyncBanner('');
    } catch (err) {
      if (err.status === 0) showSyncBanner(t('err_network'));
    }
  }

  // ---------------------------------------------------------------- language / currency
  function rerender() {
    I18N.apply();
    Session.relabel();
    if (!entered) return; // on the sign-in screen only static texts need translating
    $('page-title').textContent = t(TITLES[view]);
    Loads.renderTabs(); Loads.render(); Loads.renderMine(); Trucks.render(); Trucks.renderMine(); Directory.render(); Admin.render();
    Account.populate(); renderSidebarUser();
    I18N.setHtmlLang();
  }

  function boot() {
    I18N.init();
    Account.init(); Session.init(); Loads.init(); AiImport.init(); Trucks.init(); Directory.init(); Admin.init();

    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-view]');
      if (nav) setView(nav.dataset.view);
    });
    $('sidebar-open').addEventListener('click', () => toggleSidebar(true));
    $('sidebar-close').addEventListener('click', () => toggleSidebar(false));
    $('sidebar-backdrop').addEventListener('click', () => toggleSidebar(false));
    $('logout-btn').addEventListener('click', () => Session.signOut());

    Prefs.init(); // language / theme / currency controls (header, sign-in screen, Account)

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('modal-edit-load').classList.contains('hidden')) Loads.closeEdit();
      else toggleSidebar(false);
    });
    // Nav badges refresh on a slow poll (below) rather than per event: with thousands of users online, an
    // event-driven refresh would make every browser call /api/stats after every post.
    Live.on((evt) => { if (evt.entity === 'fx') refreshConfig(); });

    lucide.createIcons();
    Session.start();
  }

  return { boot, applyConfig, refreshConfig, enter, leave, setView, renderSidebarUser, rerender, get view() { return view; }, get config() { return config; } };
})();

window.App = App;
App.boot();
