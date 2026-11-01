'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../lib/db');
const { createApp } = require('../server');

const ing = (store, id) => store.getState().ingredients.find((i) => i.id === id);

test('ingredients start as not at home', () => {
  const store = openStore(':memory:');
  const id = store.addIngredient({ name: 'Rice' });
  assert.equal(ing(store, id).in_stock, false);
  assert.equal(ing(store, id).in_stock_since, null);
});

test('marking at home stamps the date once; re-marking keeps it; unmarking clears it', () => {
  const store = openStore(':memory:');
  const id = store.addIngredient({ name: 'Rice' });
  store.setInStock(id, true);
  assert.equal(ing(store, id).in_stock, true);
  assert.match(ing(store, id).in_stock_since, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  store.db.exec("UPDATE ingredients SET in_stock_since = '2026-01-01 10:00:00'");
  store.setInStock(id, true); // ticking again must not reset "marked on"
  assert.equal(ing(store, id).in_stock_since, '2026-01-01 10:00:00');

  store.setInStock(id, false);
  assert.equal(ing(store, id).in_stock, false);
  assert.equal(ing(store, id).in_stock_since, null);
  store.setInStock(id, true); // a fresh mark gets a fresh date
  assert.notEqual(ing(store, id).in_stock_since, '2026-01-01 10:00:00');
});

test('stock changes do not touch meals (so the calendar feed is not needlessly "updated")', () => {
  const store = openStore(':memory:');
  const id = store.addIngredient({ name: 'Rice' });
  store.createMeal({ name: 'Risotto', ingredients: [{ ingredient_id: id }] });
  store.db.exec("UPDATE meals SET updated_at = '2020-01-01 00:00:00'");
  store.setInStock([id], true);
  assert.equal(store.db.prepare('SELECT updated_at FROM meals').get().updated_at, '2020-01-01 00:00:00');
});

test('editing name/category keeps the at-home status', () => {
  const store = openStore(':memory:');
  const id = store.addIngredient({ name: 'Rice' });
  store.setInStock(id, true);
  store.updateIngredient(id, { name: 'Basmati rice', category: 'Pantry', frozen: false });
  assert.equal(ing(store, id).in_stock, true);
});

test('PUT /api/stock: bulk update, validation, and all-or-nothing on bad ids', async (t) => {
  const store = openStore(':memory:');
  const a = store.addIngredient({ name: 'A' });
  const b = store.addIngredient({ name: 'B' });
  const server = http.createServer(createApp({ store }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const put = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/stock`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const ok = await put({ ids: [a, b], in_stock: true });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.deepEqual(data.state.ingredients.map((i) => i.in_stock), [true, true]);

  assert.equal((await put({ ids: [], in_stock: true })).status, 400);
  assert.equal((await put({ ids: 'nope', in_stock: true })).status, 400);
  assert.equal((await put({ ids: [a, 'x'], in_stock: false })).status, 400);
  assert.equal(ing(store, a).in_stock, true, 'a bad id in the list rolls back the whole change');
});

test('a v2 database upgrades to v3 without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const file = path.join(dir, 'v2.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE ingredients (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, category TEXT NOT NULL DEFAULT 'Other', created_at TEXT NOT NULL DEFAULT (datetime('now')), frozen INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE meals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meal_ingredients (meal_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, quantity TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (meal_id, ingredient_id));
    CREATE TABLE plan (date TEXT PRIMARY KEY, meal_id INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO ingredients (name, frozen) VALUES ('Peas', 1);
    PRAGMA user_version = 2;`);
  old.close();
  const store = openStore(file);
  const [peas] = store.getState().ingredients;
  assert.equal(peas.frozen, true);
  assert.equal(peas.in_stock, false);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
  store.db.close();
  fs.rmSync(dir, { recursive: true });
});
