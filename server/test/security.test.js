import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from 'jose';
import { createFirebaseVerifier } from '../src/auth.js';
import { startTestEnv, validLoad } from './helpers.js';

let env;
before(async () => { env = await startTestEnv(); await env.approvedMember('sec@test.com'); });
after(async () => { await env.close(); });

// ------------------------------------------------------------ token verification (the real verifier)
test('Firebase token verifier accepts only correctly signed, current tokens from Google / verified e-mail+password / phone sign-in', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const verify = createFirebaseVerifier({ projectId: 'sng-pro', keySet: createLocalJWKSet({ keys: [jwk] }) });

  const sign = (claims = {}, { key = privateKey, kid = 'k1', alg = 'RS256', exp = '1h', iss = 'https://securetoken.google.com/sng-pro', aud = 'sng-pro' } = {}) =>
    new SignJWT({ email: 'User@Gmail.com', email_verified: true, name: 'U', firebase: { sign_in_provider: 'google.com' }, ...claims })
      .setProtectedHeader({ alg, kid }).setSubject('uid-1').setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(key);

  const good = await verify(await sign());
  assert.equal(good.email, 'user@gmail.com', 'email lowercased');
  assert.equal(good.uid, 'uid-1');

  const rejects = async (token, why) => assert.rejects(verify(token), undefined, why);
  await rejects(await sign({}, { key: other.privateKey }), 'signed by an unknown key');
  await rejects(await sign({}, { aud: 'someone-else' }), 'wrong audience (token for another project)');
  await rejects(await sign({}, { iss: 'https://securetoken.google.com/other' }), 'wrong issuer');
  await rejects(await sign({}, { exp: Math.floor(Date.now() / 1000) - 3600 }), 'expired');
  await rejects(await sign({ email_verified: false }), 'unverified email');
  await rejects(await sign({ email: undefined }), 'no email');
  for (const provider of ['anonymous', 'custom', 'facebook.com', 'github.com']) await rejects(await sign({ firebase: { sign_in_provider: provider } }), `provider ${provider} is not offered`);

  // e-mail + password: allowed, but ONLY once the mailbox is proven (otherwise anyone could register the owner's address)
  const pw = await verify(await sign({ firebase: { sign_in_provider: 'password' } }));
  assert.equal(pw.email, 'user@gmail.com');
  assert.equal(pw.provider, 'password');
  await rejects(await sign({ firebase: { sign_in_provider: 'password' }, email_verified: false }), 'password account with an unverified e-mail');

  // phone: no e-mail on the token; identity is a synthetic key nobody can spoof with a real mailbox
  const phoneToken = await sign({ email: undefined, email_verified: undefined, phone_number: '+998901234567', firebase: { sign_in_provider: 'phone' } });
  const ph = await verify(phoneToken);
  assert.equal(ph.email, 'p998901234567@phone.sng');
  assert.equal(ph.loginEmail, '');
  assert.equal(ph.phone, '+998901234567');
  await rejects(await sign({ email: undefined, phone_number: 'not-a-phone', firebase: { sign_in_provider: 'phone' } }), 'malformed phone number');
  await rejects(await sign({ email: undefined, firebase: { sign_in_provider: 'phone' } }), 'phone token without a phone number');
  // a Google account that merely CLAIMS the synthetic domain is still just an ordinary (and unverifiable) address
  const spoof = await verify(await sign({ email: 'p998901234567@phone.sng' })).catch(() => null);
  assert.ok(!spoof || spoof.provider === 'google.com');
  // alg=none / tampered token
  const [h, p] = (await sign()).split('.');
  await rejects(`${h}.${p}.`, 'unsigned token');
  const tampered = (await sign()).split('.');
  tampered[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(tampered[1], 'base64url')), email: 'owner@test.com' })).toString('base64url');
  await rejects(tampered.join('.'), 'payload tampered after signing');
});

// ------------------------------------------------------------ HTTP hardening
test('security headers are set; Google popup sign-in is not broken by COOP', async () => {
  const res = await env.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin-allow-popups');
  assert.ok(res.headers['content-security-policy-report-only'], 'CSP ships in report-only until CSP_ENFORCE=true');
  assert.match(res.headers['content-security-policy-report-only'], /frame-ancestors 'none'/);
  assert.match(res.headers['content-security-policy-report-only'], /script-src[^;]*recaptcha/, 'phone sign-in needs reCAPTCHA');
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('CORS: closed by default, open only to configured origins', async () => {
  const closed = await env.app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' } });
  assert.equal(closed.headers['access-control-allow-origin'], undefined);
  const open = await startTestEnv({ CORS_ORIGINS: 'https://app.sng.example' });
  try {
    const ok = await open.app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://app.sng.example' } });
    assert.equal(ok.headers['access-control-allow-origin'], 'https://app.sng.example');
    const bad = await open.app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' } });
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  } finally { await open.close(); }
});

test('oversized and malformed request bodies are refused', async () => {
  const big = await env.app.inject({ method: 'POST', url: '/api/loads', headers: { authorization: 'Bearer test:sec@test.com', 'content-type': 'application/json' },
    payload: JSON.stringify({ commodity: 'x'.repeat(70_000) }) });
  assert.equal(big.statusCode, 413);
  const arr = await env.as('sec@test.com').post('/api/loads', [1, 2, 3]);
  assert.equal(arr.status, 400);
  const nul = await env.app.inject({ method: 'POST', url: '/api/loads', headers: { authorization: 'Bearer test:sec@test.com', 'content-type': 'application/json' }, payload: 'null' });
  assert.equal(nul.statusCode, 400);
});

test('rate limiting returns 429 once the per-IP budget is spent', async () => {
  const limited = await startTestEnv({ RATE_LIMIT_PER_MIN: '8' });
  try {
    const codes = [];
    for (let i = 0; i < 12; i += 1) codes.push((await limited.app.inject({ method: 'GET', url: '/api/config' })).statusCode);
    assert.ok(codes.slice(0, 8).every((c) => c === 200), 'within budget');
    assert.ok(codes.slice(8).every((c) => c === 429), `over budget -> 429, got ${codes}`);
    assert.equal((await limited.app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200, 'health checks are never throttled');
  } finally { await limited.close(); }
});

test('errors never leak internals (stack traces / SQL)', async () => {
  const r = await env.as('sec@test.com').get('/api/loads?sort=rate&cursor=' + Buffer.from(JSON.stringify(['zzz', 1])).toString('base64url'));
  assert.equal(r.status, 400);
  assert.ok(!/select|syntax|pg_|stack|at \w+ \(/i.test(JSON.stringify(r.json)), JSON.stringify(r.json));
  const missing = await env.app.inject({ method: 'GET', url: '/api/nope' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'not_found');
});

test('SQL-injection style input is treated as plain data everywhere', async () => {
  const api = env.as('sec@test.com');
  const nasty = "'; DROP TABLE members; --";
  const A = await env.cityId('Almaty, KZ'); const B = await env.cityId('Bishkek, KG');
  assert.equal((await api.post('/api/loads', validLoad(A, B, { commodity: nasty }))).status, 201);
  assert.equal((await api.get(`/api/loads?q=${encodeURIComponent(nasty)}`)).status, 200);
  assert.equal((await api.get(`/api/directory?q=${encodeURIComponent(nasty)}`)).status, 200);
  assert.equal((await api.get(`/api/cities?q=${encodeURIComponent(nasty)}`)).status, 200);
  assert.equal((await api.patch('/api/me/profile', { fleet: nasty })).status, 200);
  assert.ok((await env.pool.query('SELECT count(*)::int n FROM members')).rows[0].n > 0);
  assert.equal((await api.get('/api/loads/mine')).json.items[0].commodity, nasty, 'stored and returned verbatim');
});

// ------------------------------------------------------------ caching must never weaken access control
test('with caches ON, revoking a member takes effect on their very next request', async () => {
  const cached = await startTestEnv({ MEMBER_CACHE_MS: '60000', COUNT_CACHE_MS: '60000' });
  try {
    const m = await cached.approvedMember('cached@test.com', 'Cached Co');
    const api = cached.as('cached@test.com');
    assert.equal((await api.get('/api/loads')).status, 200);            // member is now cached as approved
    assert.equal((await api.get('/api/loads')).status, 200);
    const owner = cached.as('owner@test.com');
    assert.equal((await owner.post(`/api/admin/members/${m.id}/reject`)).status, 200);
    assert.equal((await api.get('/api/loads')).status, 403, 'revocation is immediate, not after the cache TTL');
    assert.equal((await owner.post(`/api/admin/members/${m.id}/approve`)).status, 200);
    assert.equal((await api.get('/api/loads')).status, 200, 'and so is re-approval');

    // a cross-instance style change: only the NOTIFY reaches this process, not our local invalidation call
    await cached.pool.query("UPDATE members SET status = 'rejected' WHERE id = $1", [m.id]);
    await cached.pool.query("SELECT pg_notify('sng_events', $1)", [JSON.stringify({ entity: 'me', email: 'cached@test.com' })]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await api.get('/api/loads')).status, 403, 'NOTIFY from another instance invalidates this instance\'s cache');
  } finally { await cached.close(); }
});

test('with caches ON, totals are shared + cached but never block fresh data on later pages', async () => {
  const cached = await startTestEnv({ COUNT_CACHE_MS: '60000' });
  try {
    await cached.approvedMember('cnt@test.com');
    const api = cached.as('cnt@test.com');
    const A = await cached.cityId('Almaty, KZ'); const B = await cached.cityId('Bishkek, KG');
    await api.post('/api/loads', validLoad(A, B));
    const first = (await api.get('/api/loads')).json;
    assert.equal(first.total, 1);
    await api.post('/api/loads', validLoad(A, B));
    const second = (await api.get('/api/loads')).json;
    assert.equal(second.items.length, 2, 'the list itself is always fresh');
    assert.equal(second.total, 1, 'the informational total may lag within its TTL');
  } finally { await cached.close(); }
});

test('with the result cache ON: pages are shared across members, `mine` stays per-viewer, access control is not bypassed, new posts show up promptly', async () => {
  const cached = await startTestEnv({ SEARCH_CACHE_MS: '60000', MEMBER_CACHE_MS: '0' });
  try {
    await cached.approvedMember('a@cache.com', 'A Co'); await cached.approvedMember('b@cache.com', 'B Co');
    const a = cached.as('a@cache.com'); const b = cached.as('b@cache.com');
    const A = await cached.cityId('Almaty, KZ'); const B = await cached.cityId('Bishkek, KG');
    await a.post('/api/loads', validLoad(A, B));
    await new Promise((r) => setTimeout(r, 700)); // let the throttled invalidation window pass

    const seenByA = (await a.get('/api/loads')).json.items[0];
    const seenByB = (await b.get('/api/loads')).json.items[0];     // served from the shared cache entry
    assert.equal(seenByA.mine, true);
    assert.equal(seenByB.mine, false, '`mine` is computed per viewer, never leaked from the cached page');

    assert.equal((await cached.as('nobody@cache.com').get('/api/loads')).status, 403, 'cache sits behind the approval guard');

    await a.post('/api/loads', validLoad(B, A));
    let n = 0;
    for (let i = 0; i < 20 && n < 2; i++) { await new Promise((r) => setTimeout(r, 100)); n = (await b.get('/api/loads')).json.items.length; }
    assert.equal(n, 2, 'a new post invalidates cached pages within a moment, even with a 60 s TTL');
  } finally { await cached.close(); }
});

test('overload: a long database queue sheds new API calls with 503 + Retry-After, and recovers by itself', async () => {
  const busy = await startTestEnv({ DB_POOL_MAX: '1', DB_MAX_QUEUE: '2', MEMBER_CACHE_MS: '60000' });
  try {
    await busy.approvedMember('shed@test.com', 'Shed Co');
    const api = busy.as('shed@test.com');
    assert.equal((await api.get('/api/stats')).status, 200, 'warm the member cache');
    const hold = await busy.pool.connect(); // the whole pool is now in use
    const calls = [];
    for (let i = 0; i < 8; i++) { calls.push(api.get('/api/loads')); await new Promise((r) => setTimeout(r, 40)); } // staggered, like real arrivals
    await new Promise((r) => setTimeout(r, 200));
    hold.release();
    const results = await Promise.all(calls);
    const shed = results.filter((r) => r.status === 503);
    assert.ok(shed.length >= 4, `most of the overflow was shed, got ${results.map((r) => r.status)}`);
    assert.equal(shed[0].json.error.code, 'busy');
    assert.equal(shed[0].headers['retry-after'], '3');
    assert.ok(results.some((r) => r.status === 200), 'the calls inside the queue limit still succeeded');
    assert.equal((await api.get('/api/loads')).status, 200, 'normal service resumes');
  } finally { await busy.close(); }
});
