/** Tailwind is compiled at build time (no CDN script in production). Class names must appear literally
 *  in these files - never build them with string concatenation or they will be purged. */
module.exports = {
  content: ['./web/index.html', './web/js/**/*.js'],
  theme: { extend: {} },
  plugins: [],
};
