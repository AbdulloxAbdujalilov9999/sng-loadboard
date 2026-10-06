// Generates the dark-theme overrides from the colour classes the app ACTUALLY uses (scanned from the HTML and
// JavaScript at build time), so a class added later is covered automatically. Rules apply under <html class="dark">.
// Light surfaces become deep navy, text gets lighter, tinted badges become translucent; solid brand/accent
// colours (buttons, the sidebar) are left alone.
import fs from 'node:fs';
import path from 'node:path';

const SURFACE = { white: '#111a2e', 50: '#172036', 100: '#0b1220', 200: '#243049', 300: '#334155', 400: '#475569' };
const SLATE_TEXT = { 900: '#f1f5f9', 800: '#e2e8f0', 700: '#cbd5e1', 600: '#a8b5c8', 500: '#94a3b8', 400: '#7c8aa0', 300: '#64748b', 200: '#475569' };
const SLATE_BORDER = { 50: '#172036', 100: '#1c2740', 200: '#2a3750', 300: '#3a4a66', 400: '#4b5d7a' };
const TINT = {
  blue: [59, 130, 246], sky: [14, 165, 233], indigo: [99, 102, 241], emerald: [16, 185, 129], amber: [245, 158, 11],
  rose: [244, 63, 94], cyan: [6, 182, 212], red: [239, 68, 68], green: [34, 197, 94], yellow: [234, 179, 8], orange: [249, 115, 22],
};
const SOFT_TEXT = {
  blue: '#93c5fd', sky: '#7dd3fc', indigo: '#a5b4fc', emerald: '#6ee7b7', amber: '#fcd34d', rose: '#fda4af', cyan: '#67e8f9',
  red: '#fca5a5', green: '#86efac', yellow: '#fde047', orange: '#fdba74',
};
const NEUTRAL = new Set(['slate', 'gray', 'zinc', 'neutral', 'stone']);
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

export function darkCss(sources) {
  const text = sources.join('\n');
  const found = new Set(text.match(/(?:[a-z-]+:)*(?:bg|text|border|divide|from|to|via|ring)-(?:white|[a-z]+-\d{2,3}|\[#[0-9a-fA-F]{3,8}\])(?:\/\d+)?/g) ?? []);
  const rules = [];
  const esc = (cls) => cls.replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  for (const cls of [...found].sort()) {
    const parts = cls.split(':');
    const base = parts.pop();
    const variants = parts;
    if (variants.some((v) => ['sm', 'md', 'lg', 'xl', 'print'].includes(v) === false && !['hover', 'focus', 'disabled', 'group-hover', 'active'].includes(v))) continue;

    const m = /^(bg|text|border|divide|from|to|via|ring)-(.+?)(?:\/(\d+))?$/.exec(base);
    if (!m) continue;
    const [, prefix, rest, opacity] = m;
    const alpha = opacity ? Number(opacity) / 100 : 1;
    let value = null;

    const arb = /^\[(#[0-9a-fA-F]{3,8})\]$/.exec(rest);
    if (arb) {
      if (rest.toLowerCase() === '[#f8fbff]') value = '#0e1a2e'; // the expanded-row panel
      else continue; // brand blues, sidebar navy, Telegram blue ... stay as designed
    } else if (rest === 'white') {
      if (prefix === 'bg') value = alpha === 1 ? SURFACE.white : hexA(SURFACE.white, alpha);
      else continue; // text-white / border-white stay white
    } else {
      const [family, shade] = rest.split('-');
      const n = Number(shade);
      if (NEUTRAL.has(family)) {
        if (prefix === 'bg' || prefix === 'from' || prefix === 'to' || prefix === 'via') {
          if (n <= 400) { const v = SURFACE[n]; value = alpha === 1 ? v : hexA(v, alpha); } else continue;
        } else if (prefix === 'text') { if (SLATE_TEXT[n]) value = SLATE_TEXT[n]; else continue; }
        else if (prefix === 'border' || prefix === 'divide' || prefix === 'ring') { if (SLATE_BORDER[n]) value = SLATE_BORDER[n]; else continue; }
      } else if (TINT[family]) {
        const tint = TINT[family];
        if (prefix === 'bg' || prefix === 'from' || prefix === 'to' || prefix === 'via') {
          if (n <= 100) value = rgba(tint, n === 50 ? 0.12 : 0.2);
          else if (n === 200) value = rgba(tint, 0.28);
          else if (n === 950 || n >= 900) value = rgba(tint, 0.35 * alpha);
          else continue; // solid accents (400-800) are kept
        } else if (prefix === 'text') { if (n >= 600) value = SOFT_TEXT[family]; else continue; }
        else if (prefix === 'border' || prefix === 'divide' || prefix === 'ring') { if (n <= 400) value = rgba(tint, 0.4); else continue; }
      } else continue;
    }
    if (!value) continue;

    const selector = `.dark .${[...variants, base].map(esc).join('\\:')}`;
    const pseudo = variants.includes('hover') ? ':hover' : variants.includes('focus') ? ':focus' : variants.includes('disabled') ? ':disabled' : '';
    const prop = { bg: 'background-color', text: 'color', border: 'border-color', ring: '--tw-ring-color' }[prefix];
    if (prefix === 'divide') rules.push(`${selector}>:not([hidden])~:not([hidden]){border-color:${value}}`);
    else if (prefix === 'from') rules.push(`${selector}{--tw-gradient-from:${value} var(--tw-gradient-from-position);--tw-gradient-to:rgba(0,0,0,0) var(--tw-gradient-to-position);--tw-gradient-stops:var(--tw-gradient-from),var(--tw-gradient-to)}`);
    else if (prefix === 'to') rules.push(`${selector}{--tw-gradient-to:${value} var(--tw-gradient-to-position)}`);
    else if (prefix === 'via') continue;
    else rules.push(`${selector}${pseudo}{${prop}:${value}}`);
  }
  return rules.join('\n');
}

export function readSources(root) {
  const web = path.join(root, 'web');
  return [path.join(web, 'index.html'), ...fs.readdirSync(path.join(web, 'js')).map((f) => path.join(web, 'js', f))].map((f) => fs.readFileSync(f, 'utf8'));
}
