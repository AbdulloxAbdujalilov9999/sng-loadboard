import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// util.js is a plain browser script: run it in a sandbox with a minimal fake browser.
function loadUtil({ ua = '', platform = 'Win32', touch = 0 } = {}) {
  const sandbox = {
    navigator: { userAgent: ua, platform, maxTouchPoints: touch },
    document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: '' },
    URLSearchParams, encodeURIComponent, Date, Math, Number, String, Object, Array, JSON, console, setTimeout,
  };
  sandbox.window = sandbox;
  sandbox.window.location = sandbox.location;
  vm.runInNewContext(fs.readFileSync(new URL('../../web/js/util.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36';

test('route links: names are encoded, and each platform gets a link that opens the Maps app', () => {
  const { U } = loadUtil();
  const urls = U.routeUrls('Tomsk, RU', 'Tashkent, UZ');
  assert.equal(urls.web, 'https://www.google.com/maps/dir/?api=1&origin=Tomsk%2C%20RU&destination=Tashkent%2C%20UZ&travelmode=driving');
  assert.match(urls.android, /^intent:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=Tomsk%2C%20RU&destination=Tashkent%2C%20UZ&travelmode=driving#Intent;scheme=https;package=com\.google\.android\.apps\.maps;S\.browser_fallback_url=https%3A%2F%2Fwww\.google\.com%2Fmaps/);
  assert.ok(urls.android.endsWith(';end'));
  assert.equal(urls.apple, 'https://maps.apple.com/?saddr=Tomsk%2C%20RU&daddr=Tashkent%2C%20UZ&dirflg=d');
  // user-controlled text cannot break out of the URL
  assert.ok(!U.routeUrls('a&b=c#x', 'd').web.includes('a&b'));
});

test('platform detection: Android, iPhone, iPad-as-Mac, desktop', () => {
  assert.equal(loadUtil({ ua: ANDROID }).U.platform(), 'android');
  assert.equal(loadUtil({ ua: IPHONE, platform: 'iPhone' }).U.platform(), 'ios');
  assert.equal(loadUtil({ ua: DESKTOP, platform: 'MacIntel', touch: 5 }).U.platform(), 'ios', 'iPadOS reports itself as a Mac with touch');
  assert.equal(loadUtil({ ua: DESKTOP, platform: 'MacIntel', touch: 0 }).U.platform(), 'desktop');
});

test('openRoute: desktop keeps the normal new-tab link; Android uses the Maps intent; iPhone opens Apple Maps in a NEW window', () => {
  const link = { dataset: { from: 'Tomsk, RU', to: 'Tashkent, UZ' } };
  const run = (env) => {
    const sb = loadUtil(env); const calls = { prevented: false, opened: null };
    sb.window.open = (url, target, features) => { calls.opened = { url, target, features }; return {}; };
    sb.U.openRoute({ preventDefault() { calls.prevented = true; } }, link);
    return { sb, calls };
  };
  const desktop = run({ ua: DESKTOP });
  assert.equal(desktop.calls.prevented, false, 'desktop: let target=_blank open a new tab');
  const android = run({ ua: ANDROID });
  assert.equal(android.calls.prevented, true);
  assert.match(android.sb.window.location.href, /^intent:\/\/www\.google\.com\/maps\/dir/);
  const ios = run({ ua: IPHONE, platform: 'iPhone' });
  assert.equal(ios.calls.prevented, true);
  assert.equal(ios.calls.opened.target, '_blank', 'never replaces the app window');
  assert.match(ios.calls.opened.url, /^https:\/\/maps\.apple\.com\//);
});
