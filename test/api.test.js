'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openStore } = require('../lib/db');
const { createApp } = require('../server');
const { fold, escapeText, nextDay } = require('../lib/ics');

async function startServer(opts = {}) {
  const store = openStore(':memory:');
  const server = http.createServer(createApp({ store, ...opts }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, store, close: () => server.close() };
}

test('ingredients: create, reject case-insensitive duplicates, rename, delete cascades from meals', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const onion = await s.call('POST', '/api/ingredients', { name: '  Red   onion ', category: 'Fruit & Veg' });
  assert.equal(onion.status, 200);
  assert.equal(onion.data.state.ingredients[0].name, 'Red onion'); // trimmed + whitespace collapsed

  const dup = await s.call('POST', '/api/ingredients', { name: 'red ONION' });
  assert.equal(dup.status, 409);

  const bad = await s.call('POST', '/api/ingredients', { name: '   ' });
  assert.equal(bad.status, 400);

  const weird = await s.call('POST', '/api/ingredients', { name: 'Salt', category: 'Not a category' });
  assert.equal(weird.data.state.ingredients.find((i) => i.name === 'Salt').category, 'Other');

  const meal = await s.call('POST', '/api/meals', { name: 'Salsa', ingredients: [{ ingredient_id: onion.data.id, quantity: '1' }] });
  assert.equal(meal.data.state.meals[0].ingredients.length, 1);

  await s.call('DELETE', `/api/ingredients/${onion.data.id}`);
  const after = await s.call('GET', '/api/state');
  assert.equal(after.data.meals[0].ingredients.length, 0);
});

test('meals: update replaces ingredients in order, dedupes, rejects unknown ingredients atomically', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const a = (await s.call('POST', '/api/ingredients', { name: 'Rice' })).data.id;
  const b = (await s.call('POST', '/api/ingredients', { name: 'Beans' })).data.id;
  const id = (await s.call('POST', '/api/meals', { name: 'Rice & beans' })).data.id;

  const ok = await s.call('PUT', `/api/meals/${id}`, {
    name: 'Rice & beans', notes: 'Soak beans',
    ingredients: [{ ingredient_id: b, quantity: '1 can' }, { ingredient_id: a, quantity: '200 g' }, { ingredient_id: b, quantity: 'dup' }],
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.state.meals[0].ingredients, [
    { ingredient_id: b, quantity: '1 can' },
    { ingredient_id: a, quantity: '200 g' },
  ]);

  const bad = await s.call('PUT', `/api/meals/${id}`, { name: 'Changed', ingredients: [{ ingredient_id: 9999 }] });
  assert.equal(bad.status, 400);
  const state = (await s.call('GET', '/api/state')).data;
  assert.equal(state.meals[0].name, 'Rice & beans', 'failed update must roll back');
  assert.equal(state.meals[0].ingredients.length, 2);
});

test('plan: one meal per day, validates dates, deleting a meal clears its days', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const m1 = (await s.call('POST', '/api/meals', { name: 'Tacos' })).data.id;
  const m2 = (await s.call('POST', '/api/meals', { name: 'Pasta' })).data.id;
  await s.call('PUT', '/api/plan/2026-11-02', { meal_id: m1 });
  const replaced = await s.call('PUT', '/api/plan/2026-11-02', { meal_id: m2 });
  assert.deepEqual(replaced.data.state.plan, [{ date: '2026-11-02', meal_id: m2 }]);

  assert.equal((await s.call('PUT', '/api/plan/2026-02-30', { meal_id: m1 })).status, 400);
  assert.equal((await s.call('PUT', '/api/plan/2026-11-03', { meal_id: 12345 })).status, 400);

  await s.call('DELETE', `/api/meals/${m2}`);
  assert.deepEqual((await s.call('GET', '/api/state')).data.plan, []);
});

test('auth: API locked without password cookie; calendar feed works with token only', async (t) => {
  const s = await startServer({ password: 'secret' });
  t.after(s.close);
  assert.equal((await s.call('GET', '/api/state')).status, 401);
  assert.equal((await s.call('GET', '/api/session')).data.authenticated, false);
  assert.equal((await s.call('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await s.call('POST', '/api/login', { password: 'secret' })).status, 200);
  assert.equal((await s.call('GET', '/api/state')).status, 200);

  const { feedUrl, webcalUrl } = (await s.call('GET', '/api/calendar')).data;
  assert.match(webcalUrl, /^webcal:\/\//);
  const path = new URL(feedUrl).pathname;
  assert.equal((await s.call('GET', '/cal/wrong-token.ics')).status, 404);
  const feed = await s.call('GET', path);
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get('content-type'), /text\/calendar/);

  const rotated = (await s.call('POST', '/api/calendar/rotate')).data;
  assert.notEqual(rotated.feedUrl, feedUrl);
  assert.equal((await s.call('GET', path)).status, 404, 'old link stops working');
});

test('calendar feed: valid all-day events with ingredients, escaped and folded', async (t) => {
  const s = await startServer({ publicUrl: 'https://meals.example.com' });
  t.after(s.close);
  const garlic = (await s.call('POST', '/api/ingredients', { name: 'Garlic' })).data.id;
  const meal = (await s.call('POST', '/api/meals', {
    name: 'Fish, chips; peas',
    notes: 'Line one\nLine two',
    ingredients: [{ ingredient_id: garlic, quantity: '2 cloves' }],
  })).data.id;
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const longAgo = '2001-01-01';
  await s.call('PUT', `/api/plan/${future}`, { meal_id: meal });
  await s.call('PUT', `/api/plan/${longAgo}`, { meal_id: meal });

  const { feedUrl } = (await s.call('GET', '/api/calendar')).data;
  assert.match(feedUrl, /^https:\/\/meals\.example\.com\/cal\/[\w-]+\.ics$/);
  const ics = (await s.call('GET', new URL(feedUrl).pathname)).data;

  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'all line breaks are CRLF');
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 1, 'very old days are left out of the feed');
  const compact = future.replace(/-/g, '');
  assert.ok(ics.includes(`DTSTART;VALUE=DATE:${compact}`));
  assert.ok(ics.includes(`DTEND;VALUE=DATE:${nextDay(future).replace(/-/g, '')}`));
  assert.ok(ics.includes('SUMMARY:Fish\\, chips\\; peas'));
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('DESCRIPTION:Ingredients:\\n• Garlic — 2 cloves\\n\\nLine one\\nLine two'));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
});

test('ics helpers', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2028-02-28'), '2028-02-29');
  const folded = fold('SUMMARY:' + 'ð'.repeat(100)); // 2-byte characters must not be split
  for (const line of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(line) <= 75);
    assert.ok(!line.includes('�'));
  }
  assert.equal(folded.replace(/\r\n /g, ''), 'SUMMARY:' + 'ð'.repeat(100));
});

test('static files: served, and path traversal is blocked', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const index = await s.call('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal((await s.call('GET', '/..%2fserver.js')).status, 404);
  assert.equal((await s.call('GET', '/%2e%2e/package.json')).status, 404);
});
