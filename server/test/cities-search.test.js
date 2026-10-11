import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

let env; let api;
before(async () => { env = await startTestEnv(); await env.approvedMember('c@test.com'); api = env.as('c@test.com'); });
after(async () => { await env.close(); });

const find = async (q, extra = '') => (await api.get(`/api/cities?q=${encodeURIComponent(q)}${extra}`)).json.items;
const labels = async (q, extra) => (await find(q, extra)).map((c) => c.label);

test('small towns, districts and old names of Central Asia are found in any script and spelling', async () => {
  const n = (await env.pool.query('SELECT count(*)::int AS n FROM cities')).rows[0].n;
  assert.ok(n > 5500, `the gazetteer is much bigger now (${n})`);
  // "Khuroson" is a Tajik district: Latin, Cyrillic and Uzbek-style spellings all lead to its towns
  for (const q of ['Khuroson', 'Xuroson', 'Хуросон', 'Хуросан', 'khurosan', 'Nohiyai Khuroson']) {
    const got = await labels(q);
    assert.ok(got.some((l) => l.endsWith(', TJ')), `${q} -> ${got}`);
  }
  assert.ok((await labels('Kuybyshevsk')).some((l) => l.endsWith(', TJ')), 'old Soviet names work');
  assert.equal((await labels('Термез'))[0], 'Termez, UZ');
  assert.equal((await labels('Termiz'))[0], 'Termez, UZ');
  assert.equal((await labels('Хорезм'))[0], 'Urgench, UZ');
  assert.ok((await labels('Душанбе'))[0].startsWith('Dushanbe'));
});

test('countries can be picked as a search target (UZ, Узбекистан, Oʻzbekiston ...) only where asked for', async () => {
  for (const q of ['Uzbekistan', 'узбекистан', 'Oʻzbekiston', 'uz', 'UZ', 'uzbek']) {
    const items = await find(q, '&countries=1');
    assert.equal(items[0].kind, 'country', q);
    assert.equal(items[0].country, 'UZ', q);
  }
  assert.equal((await find('Kaz', '&countries=1'))[0].country, 'KZ');
  assert.equal((await find('Россия', '&countries=1'))[0].country, 'RU');
  assert.ok((await find('Uzbekistan')).every((c) => c.kind !== 'country'), 'posting forms never get countries');
  assert.equal((await find('tashkent', '&countries=1'))[0].label, 'Tashkent, UZ', 'cities still lead for city names');
});

test('loads and trucks can be searched by whole country', async () => {
  const { validLoad } = await import('./helpers.js');
  const ids = {};
  for (const l of ['Tashkent, UZ', 'Samarkand, UZ', 'Almaty, KZ', 'Astana, KZ', 'Moscow, RU']) ids[l] = await env.cityId(l);
  for (const [a, b] of [['Tashkent, UZ', 'Almaty, KZ'], ['Samarkand, UZ', 'Astana, KZ'], ['Tashkent, UZ', 'Moscow, RU'], ['Almaty, KZ', 'Tashkent, UZ']]) {
    assert.equal((await api.post('/api/loads', validLoad(ids[a], ids[b]))).status, 201);
  }
  const count = async (qs) => (await api.get(`/api/loads?${qs}`)).json.total;
  assert.equal(await count('originCountry=UZ&destCountry=KZ'), 2, 'UZ -> KZ');
  assert.equal(await count('originCountry=UZ'), 3);
  assert.equal(await count('destCountry=kz'), 2, 'lower case is fine');
  assert.equal(await count(`origin=${ids['Tashkent, UZ']}&originRadius=50&destCountry=KZ`), 1, 'a city and a country can be combined');
  assert.equal((await api.get('/api/loads?originCountry=Uzbekistan')).status, 400, 'a 2-letter code is required');
  const truck = { locCityId: ids['Almaty, KZ'], equip: 'T', capacityT: 20, availableFrom: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), contactPhone: '+998901234567' };
  assert.equal((await api.post('/api/trucks', truck)).status, 201);
  assert.equal((await api.get('/api/trucks?locCountry=KZ')).json.total, 1);
  assert.equal((await api.get('/api/trucks?locCountry=UZ')).json.total, 0);
});

test('typing the first letters of a big city offers it first, not a tiny village whose other name happens to match', async () => {
  for (const [q, first] of [['tash', 'Tashkent, UZ'], ['ташк', 'Tashkent, UZ'], ['andi', 'Andijan, UZ']]) {
    const got = await labels(q);
    assert.equal(got[0], first, `${q} -> ${got}`);
  }
  assert.equal((await labels('tashkent'))[0], 'Tashkent, UZ');
});
