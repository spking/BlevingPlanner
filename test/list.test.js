'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openStore } = require('../lib/db');
const { createApp } = require('../server');

const ing = (store, id) => store.getState().ingredients.find((i) => i.id === id);

test('hand-added shopping items: add, remove, and "at home" takes it off the list', () => {
  const store = openStore(':memory:');
  const milk = store.addIngredient({ name: 'Milk', category: 'Dairy & Eggs' });
  assert.equal(ing(store, milk).on_list, false);
  store.setOnList(milk, true);
  assert.equal(ing(store, milk).on_list, true);
  store.setOnList(milk, false);
  assert.equal(ing(store, milk).on_list, false);

  store.setOnList(milk, true);
  store.setInStock(milk, true); // bought it
  assert.equal(ing(store, milk).on_list, false);
  assert.equal(ing(store, milk).in_stock, true);

  store.setInStock(milk, false); // running out again doesn't put it back on the list by itself
  assert.equal(ing(store, milk).on_list, false);
});

test('putting something at home on the list keeps it at home until bought', () => {
  const store = openStore(':memory:');
  const milk = store.addIngredient({ name: 'Milk' });
  store.setInStock(milk, true);
  store.setOnList(milk, true); // "we have some, but get more"
  assert.equal(ing(store, milk).on_list, true);
  assert.equal(ing(store, milk).in_stock, true);
});

test('PUT /api/list validates and returns fresh state', async (t) => {
  const store = openStore(':memory:');
  const milk = store.addIngredient({ name: 'Milk' });
  const server = http.createServer(createApp({ store }));
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const put = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/list`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const ok = await put({ ids: [milk], on_list: true });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).state.ingredients[0].on_list, true);
  assert.equal((await put({ ids: [] })).status, 400);
  assert.equal((await put({ ids: [999], on_list: true })).status, 200, 'unknown ids are a no-op');
});
