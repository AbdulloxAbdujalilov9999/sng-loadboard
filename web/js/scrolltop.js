// Phones only: once a search result list has been scrolled down, show a floating "Filters" button that jumps
// back up to the filter form (the filters scroll away with the page instead of being pinned - see styles.css).
(function () {
  const SECTIONS = ['view-search-loads', 'view-search-trucks'];
  const mobile = window.matchMedia('(max-width: 767px)');
  let button;

  const active = () => SECTIONS.map((id) => document.getElementById(id)).find((el) => el && el.offsetParent !== null);

  function update() {
    const section = active();
    const show = Boolean(section) && mobile.matches && section.scrollTop > 320;
    button.classList.toggle('hidden', !show);
  }

  function init() {
    button = document.getElementById('to-filters-btn');
    if (!button) return;
    button.addEventListener('click', () => active()?.scrollTo({ top: 0, behavior: 'smooth' }));
    document.addEventListener('scroll', update, { capture: true, passive: true }); // scroll events do not bubble
    document.addEventListener('click', () => setTimeout(update, 50)); // changing view hides/shows the sections
    mobile.addEventListener('change', update);
    window.addEventListener('themechange', update);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
