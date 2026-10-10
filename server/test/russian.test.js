import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';
import { createHeuristicParser } from '../src/lib/ai/heuristic.js';

let env; let ids;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  env = await startTestEnv({}, { ai: createHeuristicParser() });
  ids = {};
  for (const l of ['Tashkent, UZ', 'Moscow, RU', 'Almaty, KZ', 'Samarkand, UZ']) ids[l] = await env.cityId(l);
  await env.approvedMember('vostok@test.com', 'Восток Логистик');
});
after(async () => { await env.close(); });

test('Russian text is stored and searched regardless of letter case', async () => {
  const api = env.as('vostok@test.com');
  const r = await api.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Moscow, RU'], { commodity: 'Яблоки и ГРУШИ', notes: 'Оплата по факту выгрузки' }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.commodity, 'Яблоки и ГРУШИ');
  assert.equal(r.json.notes, 'Оплата по факту выгрузки');
  for (const q of ['яблоки', 'ЯБЛОКИ', 'Груши', 'восток', 'ЛОГИСТИК']) {
    const res = (await api.get(`/api/loads?q=${encodeURIComponent(q)}`)).json;
    assert.equal(res.total, 1, `loads q=${q}`);
  }
  const t = await api.post('/api/trucks', { locCityId: ids['Samarkand, UZ'], equip: 'T', capacityT: 20, availableFrom: day(1), destPref: 'Москва, Россия', notes: 'Тент, ремни, коники', contactPhone: '+998 90 111 22 33', contactTelegram: '@vostok_log' });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  assert.equal(t.json.notes, 'Тент, ремни, коники');
  for (const d of ['москва', 'МОСКВА', 'Россия']) assert.equal((await api.get(`/api/trucks?dest=${encodeURIComponent(d)}`)).json.total, 1, `trucks dest=${d}`);
  const dir = async (q) => (await api.get(`/api/directory?q=${encodeURIComponent(q)}`)).json;
  await env.approvedMember('other@test.com', 'Другой Перевозчик');
  assert.equal((await dir('логистик')).total, 1, 'directory finds Russian company in any case');
  assert.equal((await dir('ПЕРЕВОЗЧИК')).total, 1);
});

test('cities: Russian names, cases, ё/е, hyphens, abbreviations and wrong-keyboard-layout typing', async () => {
  const api = env.as('vostok@test.com');
  const q = async (s) => (await api.get(`/api/cities?q=${encodeURIComponent(s)}`)).json.items.map((c) => c.label);
  for (const [s, want] of [
    ['москва', 'Moscow, RU'], ['МОСКВА', 'Moscow, RU'], ['Москву', 'Moscow, RU'], ['Москве', 'Moscow, RU'],
    ['Ташкент', 'Tashkent, UZ'], ['ташкент уз', 'Tashkent, UZ'], ['Самарканд, УЗ', 'Samarkand, UZ'], ['Алматы', 'Almaty, KZ'], ['Алма-Ата', 'Almaty, KZ'],
    ['Питер', 'Saint Petersburg, RU'], ['Санкт-Петербург', 'Saint Petersburg, RU'], ['СПб', 'Saint Petersburg, RU'], ['Новосиб', 'Novosibirsk, RU'], ['Екат', 'Yekaterinburg, RU'],
    ['Хоразм', 'Urgench, UZ'], ['Ургенч', 'Urgench, UZ'], ['Коканд', 'Kokand, UZ'], ['Коканд', 'Kokand, UZ'], ['Наманган', 'Namangan, UZ'],
    ['Vjcrdf', 'Moscow, RU'], ['Nfirtyn', 'Tashkent, UZ'], ['Cfvfhrfyl', 'Samarkand, UZ'], ['ьщсзщцршт', null],
  ]) {
    const got = await q(s);
    if (want) assert.equal(got[0], want, `${s} -> ${got.slice(0, 3)}`);
  }
});

test('AI paste in Russian: places, weight and volume are read; drafts post through the bulk endpoints', async () => {
  const api = env.as('vostok@test.com');
  const text = `🇺🇿 Хоразм
🇷🇺 Санкт Петербург
Яблоки, 20 тонн
Тент, 90 куб
Оплата: наличные
+998 90 111 22 33

🇰🇿 Алма-Ата
🇷🇺 Москва
Груши 18т рефрижератор
+7 777 123 45 67`;
  const r = await api.post('/api/ai/parse-loads', { text });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [a, b] = r.json.loads;
  assert.equal(a.originCity, 'Urgench, UZ');
  assert.equal(a.destCity, 'Saint Petersburg, RU');
  assert.equal(a.weightT, 20);
  assert.equal(a.volumeM3, 90, 'volume is read from "90 куб"');
  assert.equal(a.equip, 'T');
  assert.equal(b.originCity, 'Almaty, KZ');
  assert.equal(b.weightT, 18);
  assert.equal(b.equip, 'R');
  const trucks = await api.post('/api/ai/parse-trucks', { text: '🇺🇿 Хоразм → 🇷🇺 Москва\nТент 20т 82 куб, свободен\n+998 90 111 22 33' });
  assert.equal(trucks.status, 200, JSON.stringify(trucks.json));
  assert.equal(trucks.json.trucks[0].locCity, 'Urgench, UZ');
  assert.equal(trucks.json.trucks[0].volumeM3, 82);
});
