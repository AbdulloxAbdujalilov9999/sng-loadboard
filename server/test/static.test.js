import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestEnv } from './helpers.js';

let env; let webRoot;
before(async () => {
  webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sng-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>SNG</title><body>app shell</body>');
  fs.mkdirSync(path.join(webRoot, 'js'));
  fs.writeFileSync(path.join(webRoot, 'js', 'app.js'), 'console.log(1)');
  env = await startTestEnv({ WEB_ROOT: webRoot });
});
after(async () => { await env.close(); fs.rmSync(webRoot, { recursive: true, force: true }); });

test('serves the built web app: GET and HEAD, with sane cache headers (this crashed the server once)', async () => {
  const html = await env.app.inject({ method: 'GET', url: '/' });
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /app shell/);
  assert.equal(html.headers['cache-control'], 'no-cache', 'the HTML shell always revalidates');

  const head = await env.app.inject({ method: 'HEAD', url: '/' });
  assert.equal(head.statusCode, 200);

  const js = await env.app.inject({ method: 'GET', url: '/js/app.js?v=abc123' });
  assert.equal(js.statusCode, 200);
  assert.equal(js.headers['cache-control'], 'public, max-age=86400');
});

test('unknown paths fall back to the app shell, but never for /api, and path traversal is blocked', async () => {
  const deep = await env.app.inject({ method: 'GET', url: '/some/client/route' });
  assert.equal(deep.statusCode, 200);
  assert.match(deep.body, /app shell/);

  const api = await env.app.inject({ method: 'GET', url: '/api/does-not-exist' });
  assert.equal(api.statusCode, 404);
  assert.equal(api.json().error.code, 'not_found');

  const post = await env.app.inject({ method: 'POST', url: '/nope', payload: {} });
  assert.equal(post.statusCode, 404);

  for (const url of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/js/../../package.json']) {
    const r = await env.app.inject({ method: 'GET', url });
    assert.ok(![200].includes(r.statusCode) || /app shell/.test(r.body), `${url} must not expose files outside the web root`);
    assert.ok(!/"name":\s*"sng-one"/.test(r.body), `${url} leaked package.json`);
  }
});
