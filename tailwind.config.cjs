/** Tailwind is compiled at build time (no CDN script in production). Class names must appear literally
 *  in these files - never build them with string concatenation or they will be purged. */
module.exports = {
  content: ['./web/index.html', './web/js/**/*.js'],
  // "md" (desktop layout: sidebar + table) starts at 1200px: tablets and narrow windows get the phone layout (cards + drawer menu)
  theme: { screens: { sm: '640px', md: '1200px', xl: '1280px' }, extend: {} },
  plugins: [],
};
