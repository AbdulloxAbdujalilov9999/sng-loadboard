import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const formBody = (id) => { const a = html.indexOf(`id="${id}"`); return html.slice(a, html.indexOf('</form>', a)); };

// The profile form sends EVERY named field in it to PATCH /api/me/profile, which refuses unknown keys: a card placed inside it with
// named fields (the "My truck" card was, once) makes saving the profile fail for everyone.
test('the profile form only holds profile fields (other cards live outside it)', () => {
  const body = formBody('profile-form');
  const names = [...body.matchAll(/\sname="(\w+)"/g)].map((m) => m[1]);
  const allowed = new Set(['company', 'contactName', 'phone', 'telegram', 'contactEmail', 'location', 'tirCarnet', 'fleet', 'routes', 'email']);
  assert.deepEqual(names.filter((n) => !allowed.has(n)), [], 'a field inside the profile form is not a profile field');
  assert.ok(!body.includes('id="mytruck-card"'));
});
