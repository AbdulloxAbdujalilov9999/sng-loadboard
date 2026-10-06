import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, tokenFor, validLoad } from './helpers.js';

let env; let base;
before(async () => {
  env = await startTestEnv({ EVENT_BATCH_MS: '300' });
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${env.app.server.address().port}`;
  await env.approvedMember('viewer@test.com', 'Viewer');
  await env.approvedMember('poster@test.com', 'Poster');
});
after(async () => { await env.close(); });

async function listen(email) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${tokenFor(email)}` }, signal: ctrl.signal });
  const frames = [];
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const f = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^event: change/m.test(f)) frames.push(JSON.parse(/^data: (.*)$/m.exec(f)[1]));
        }
      }
    } catch { /* aborted */ }
  })();
  return { frames, res, close: () => ctrl.abort() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a burst of posts reaches every browser as ONE coalesced frame (no per-post fan-out)', async () => {
  const viewer = await listen('viewer@test.com');
  try {
    const o = await env.cityId('Almaty, KZ'); const d = await env.cityId('Tashkent, UZ');
    const poster = env.as('poster@test.com');
    const posted = await Promise.all(Array.from({ length: 8 }, () => poster.post('/api/loads', validLoad(o, d))));
    assert.ok(posted.every((r) => r.status === 201));
    await sleep(900);
    const loadFrames = viewer.frames.filter((f) => f.entity === 'loads');
    assert.equal(loadFrames.length, 1, `one frame, got ${JSON.stringify(loadFrames)}`);
    assert.equal(loadFrames[0].n, 8);
    assert.equal(loadFrames[0].inserts, 8);
    const me = (await poster.get('/api/me')).json.profile.id;
    assert.equal(loadFrames[0].owners[me], 8, 'frame says who posted, so the poster can discount their own');
  } finally { viewer.close(); }
});

test('a single post still arrives as a normal event, after at most one window', async () => {
  const viewer = await listen('viewer@test.com');
  try {
    const t0 = Date.now();
    const r = await env.as('poster@test.com').post('/api/loads', validLoad(await env.cityId('Moscow, RU'), await env.cityId('Almaty, KZ')));
    for (let i = 0; i < 40 && !viewer.frames.length; i++) await sleep(50);
    assert.equal(viewer.frames[0].op, 'insert');
    assert.equal(viewer.frames[0].id, r.json.id);
    assert.ok(Date.now() - t0 < 1500);
  } finally { viewer.close(); }
});

test('per-user stream cap is enforced and released when streams close', async () => {
  const open = [];
  for (let i = 0; i < 5; i++) open.push(await listen('viewer@test.com'));
  assert.ok(open.every((s) => s.res.status === 200));
  const sixth = await listen('viewer@test.com');
  assert.equal(sixth.res.status, 429);
  open[0].close();
  await sleep(300);
  const again = await listen('viewer@test.com');
  assert.equal(again.res.status, 200, 'slot freed after a stream closes');
  [...open, again].forEach((s) => s.close());
});
