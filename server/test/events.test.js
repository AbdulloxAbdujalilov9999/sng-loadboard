import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, tokenFor, validLoad } from './helpers.js';

let env; let base;
before(async () => {
  env = await startTestEnv();
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${env.app.server.address().port}`;
  await env.approvedMember('a@test.com', 'A Co');
  await env.approvedMember('b@test.com', 'B Co');
});
after(async () => { await env.close(); });

/** Minimal SSE client: fetch-streaming with an Authorization header (what the browser app does). */
async function openStream(email) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${tokenFor(email)}` }, signal: ctrl.signal });
  const stream = { status: res.status, events: [], waiters: [], close: () => ctrl.abort() };
  if (res.status !== 200) return stream;
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const name = /^event: (.*)$/m.exec(frame)?.[1]; const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (name) { stream.events.push({ name, data: JSON.parse(data) }); stream.waiters.splice(0).forEach((w) => w()); }
        }
      }
    } catch { /* aborted */ }
  })();
  stream.waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = stream.events.find(pred);
      if (hit) return hit;
      await new Promise((r) => { stream.waiters.push(r); setTimeout(r, 100); });
    }
    return null;
  };
  await stream.waitFor((e) => e.name === 'hello');
  return stream;
}

test('stream requires auth', async () => {
  const res = await fetch(`${base}/api/events`);
  assert.equal(res.status, 401);
});

test('approved members get a live notification when someone posts a load - ids only, no row data', async () => {
  const a = await openStream('a@test.com');
  try {
    assert.equal(a.events[0].data.status, 'approved');
    const posted = await env.as('b@test.com').post('/api/loads', validLoad(await env.cityId('Almaty, KZ'), await env.cityId('Tashkent, UZ')));
    const evt = await a.waitFor((e) => e.data.entity === 'loads' && e.data.op === 'insert');
    assert.ok(evt, 'received insert event');
    assert.equal(evt.data.id, posted.json.id);
    assert.ok(!JSON.stringify(evt.data).includes('Almaty'), 'no row data on the wire');
    await env.as('b@test.com').del(`/api/loads/${posted.json.id}`);
    assert.ok(await a.waitFor((e) => e.data.entity === 'loads' && e.data.op === 'delete'), 'delete event too');
  } finally { a.close(); }
});

test('a rolled-back transaction emits nothing (events are transactional)', async () => {
  const a = await openStream('a@test.com');
  try {
    const client = await env.pool.connect();
    await client.query('BEGIN');
    const { publish } = await import('../src/events.js');
    await publish(client, { entity: 'loads', op: 'insert', id: 999999 });
    await client.query('ROLLBACK');
    client.release();
    assert.equal(await a.waitFor((e) => e.data.id === 999999, 800), null);
  } finally { a.close(); }
});

test('pending users only hear about their own membership decision; the owner hears about requests', async () => {
  const owner = await openStream('owner@test.com');
  const newbie = await openStream('newbie@test.com');
  try {
    assert.equal(newbie.events[0].data.status, 'none');
    const req = await env.as('newbie@test.com').post('/api/me/access-request', { company: 'Newbie', phone: '+998 90 123 45 67', telegram: '@newbie_co' });
    assert.ok(await owner.waitFor((e) => e.data.entity === 'members' && e.data.op === 'insert'), 'owner notified of the new request');
    assert.equal(await newbie.waitFor((e) => e.data.entity === 'members', 500), null, 'requester is not told about admin traffic');

    // someone else posts - the pending user must not be notified
    await env.as('b@test.com').post('/api/loads', validLoad(await env.cityId('Almaty, KZ'), await env.cityId('Tashkent, UZ')));
    assert.equal(await newbie.waitFor((e) => e.data.entity === 'loads', 600), null, 'pending users get no marketplace events');

    await env.as('owner@test.com').post(`/api/admin/members/${req.json.profile.id}/approve`);
    const me = await newbie.waitFor((e) => e.data.entity === 'me');
    assert.ok(me, 'requester told their status changed');
    assert.deepEqual(me.data, { entity: 'me' }, 'no email/PII in the notification');
  } finally { owner.close(); newbie.close(); }
});

test('at most 5 live streams per account', async () => {
  const streams = [];
  try {
    for (let i = 0; i < 5; i += 1) { const s = await openStream('a@test.com'); assert.equal(s.status, 200); streams.push(s); }
    const sixth = await openStream('a@test.com');
    assert.equal(sixth.status, 429);
  } finally { streams.forEach((s) => s.close()); }
});

test('if the database listener connection drops, clients are told to resync and events keep flowing', async () => {
  const a = await openStream('a@test.com');
  try {
    await env.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'sng-one-events'");
    assert.ok(await a.waitFor((e) => e.data.entity === 'resync', 5000), 'resync broadcast after the listener died');
    await new Promise((r) => setTimeout(r, 1500)); // reconnect backoff
    const posted = await env.as('b@test.com').post('/api/loads', validLoad(await env.cityId('Almaty, KZ'), await env.cityId('Bishkek, KG')));
    assert.ok(await a.waitFor((e) => e.data.id === posted.json.id, 5000), 'live again after reconnect');
  } finally { a.close(); }
});
