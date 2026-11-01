'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openStore } = require('../lib/db');
const { buildCalendar, previousDay, floatingDateTime } = require('../lib/ics');

const unfold = (ics) => ics.replace(/\r\n /g, '');
const events = (ics) => unfold(ics).split('BEGIN:VEVENT').slice(1);

function setup() {
  const store = openStore(':memory:');
  const beef = store.addIngredient({ name: 'Minced beef', category: 'Meat & Fish', frozen: true });
  const peas = store.addIngredient({ name: 'Peas', category: 'Frozen', frozen: true });
  const onion = store.addIngredient({ name: 'Onion', category: 'Fruit & Veg' });
  const chili = store.createMeal({ name: 'Chili', ingredients: [
    { ingredient_id: onion, quantity: '1' }, { ingredient_id: beef, quantity: '500 g' }, { ingredient_id: peas, quantity: '' }] });
  const salad = store.createMeal({ name: 'Salad', ingredients: [{ ingredient_id: onion }] });
  return { store, beef, peas, onion, chili, salad };
}
const feed = (store, thawTime = store.thawTime()) =>
  buildCalendar({ events: store.getFeed('2000-01-01'), calendarName: 'Meals', uidDomain: 'x', thawTime });

test('frozen flag is stored, returned and editable', () => {
  const { store, beef, onion } = setup();
  const byId = (id) => store.getState().ingredients.find((i) => i.id === id);
  assert.equal(byId(beef).frozen, true);
  assert.equal(byId(onion).frozen, false);
  store.updateIngredient(beef, { name: 'Minced beef', category: 'Meat & Fish', frozen: false });
  assert.equal(byId(beef).frozen, false);
});

test('a meal with frozen ingredients gets a timed reminder the evening before, with an alert', () => {
  const { store, chili, salad } = setup();
  store.setPlan('2026-12-01', chili); // previous day crosses a month boundary
  store.setPlan('2026-12-02', salad); // nothing frozen → no reminder
  const evs = events(feed(store));
  assert.equal(evs.length, 3);
  const thaw = evs.find((e) => e.includes('UID:thaw-2026-12-01@x'));
  assert.ok(thaw.includes('DTSTART:20261130T190000'), 'evening before, floating local time');
  assert.ok(thaw.includes('DTEND:20261130T191500'));
  assert.ok(thaw.includes('SUMMARY:❄ Take out: Minced beef\\, Peas'));
  assert.ok(thaw.includes("DESCRIPTION:For tomorrow's Chili:\\n• Minced beef — 500 g\\n• Peas"));
  assert.ok(thaw.includes('BEGIN:VALARM') && thaw.includes('TRIGGER:PT0M'));
  assert.ok(!evs.some((e) => e.includes('UID:thaw-2026-12-02')));
});

test('reminder time is configurable and can be switched off', () => {
  const { store, chili } = setup();
  store.setPlan('2026-12-01', chili);
  assert.equal(store.thawTime(), '19:00');
  store.setThawTime('21:30');
  assert.ok(feed(store).includes('DTSTART:20261130T213000'));
  store.setThawTime('');
  assert.ok(!feed(store).includes('thaw-'));
  assert.throws(() => store.setThawTime('7pm'), /look like/);
  assert.throws(() => store.setThawTime('24:00'));
});

test('unmarking an ingredient as frozen updates the feed and bumps LAST-MODIFIED', () => {
  const { store, chili, beef, peas } = setup();
  store.setPlan('2026-12-01', chili);
  store.db.exec("UPDATE meals SET updated_at = '2020-01-01 00:00:00'; UPDATE plan SET updated_at = '2020-01-01 00:00:00';");
  store.updateIngredient(peas, { name: 'Peas', category: 'Frozen', frozen: false });
  let thaw = events(feed(store)).find((e) => e.includes('UID:thaw-'));
  assert.ok(thaw.includes('SUMMARY:❄ Take out: Minced beef\r\n'));
  assert.ok(!thaw.includes('LAST-MODIFIED:2020'));
  store.updateIngredient(beef, { name: 'Minced beef', category: 'Meat & Fish', frozen: false });
  assert.ok(!feed(store).includes('thaw-'));
});

test('time helpers handle edges', () => {
  assert.equal(previousDay('2026-01-01'), '2025-12-31');
  assert.equal(previousDay('2028-03-01'), '2028-02-29');
  assert.equal(floatingDateTime('2026-12-31', '23:50', 15), '20270101T000500');
});

test('an existing v1 database upgrades in place without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE ingredients (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, category TEXT NOT NULL DEFAULT 'Other', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE meal_ingredients (meal_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL, quantity TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (meal_id, ingredient_id));
    CREATE TABLE plan (date TEXT PRIMARY KEY, meal_id INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO ingredients (name) VALUES ('Garlic');
    PRAGMA user_version = 1;`);
  old.close();
  const store = openStore(file);
  assert.deepEqual(store.getState().ingredients.map((i) => [i.name, i.frozen]), [['Garlic', false]]);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  store.db.close();
  fs.rmSync(dir, { recursive: true });
});
