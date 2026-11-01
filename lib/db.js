'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

// Roughly in the order you walk through a supermarket, so the shopping list reads top-to-bottom.
const CATEGORIES = [
  'Fruit & Veg',
  'Meat & Fish',
  'Dairy & Eggs',
  'Bakery',
  'Pantry',
  'Spices & Sauces',
  'Frozen',
  'Drinks',
  'Other',
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_THAW_TIME = '19:00';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function cleanName(value, label, max = 80) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new HttpError(400, `${label} name can't be empty`);
  if (name.length > max) throw new HttpError(400, `${label} name is too long (max ${max} characters)`);
  return name;
}

function cleanCategory(value) {
  return CATEGORIES.includes(value) ? value : 'Other';
}

function toId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
}

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < 1) {
    db.exec(`
      CREATE TABLE ingredients (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        category   TEXT NOT NULL DEFAULT 'Other',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE meals (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        notes      TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE meal_ingredients (
        meal_id       INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
        ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
        quantity      TEXT NOT NULL DEFAULT '',
        position      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (meal_id, ingredient_id)
      );
      CREATE INDEX meal_ingredients_ingredient ON meal_ingredients(ingredient_id);
      CREATE TABLE plan (
        date       TEXT PRIMARY KEY,               -- YYYY-MM-DD, one meal per day
        meal_id    INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX plan_meal ON plan(meal_id);
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }
  if (version < 2) {
    // "Frozen" = kept in our freezer, so it needs taking out the evening before (separate from the shop's Frozen aisle).
    db.exec(`
      ALTER TABLE ingredients ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version = 2;
    `);
  }
  if (version < 3) {
    // "We have this at home" — shared kitchen inventory, used to split the shopping list.
    db.exec(`
      ALTER TABLE ingredients ADD COLUMN in_stock INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ingredients ADD COLUMN in_stock_since TEXT;
      PRAGMA user_version = 3;
    `);
  }
  if (version < 4) {
    // Put on the shopping list by hand (e.g. milk), independent of planned meals.
    db.exec(`
      ALTER TABLE ingredients ADD COLUMN on_list INTEGER NOT NULL DEFAULT 0;
      PRAGMA user_version = 4;
    `);
  }
  // Future schema changes go here as `if (version < 5) { ... PRAGMA user_version = 5; }`
}

function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  migrate(db);

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const q = {
    ingredients: db.prepare('SELECT id, name, category, frozen, in_stock, in_stock_since, on_list FROM ingredients ORDER BY name COLLATE NOCASE'),
    meals: db.prepare('SELECT id, name, notes FROM meals ORDER BY name COLLATE NOCASE'),
    mealIngredients: db.prepare('SELECT meal_id, ingredient_id, quantity FROM meal_ingredients ORDER BY meal_id, position'),
    plan: db.prepare('SELECT date, meal_id FROM plan ORDER BY date'),
    ingredientByName: db.prepare('SELECT id FROM ingredients WHERE name = ? COLLATE NOCASE'),
    ingredientExists: db.prepare('SELECT 1 FROM ingredients WHERE id = ?'),
    insertIngredient: db.prepare('INSERT INTO ingredients (name, category, frozen) VALUES (?, ?, ?)'),
    // Only stamps the date when it actually changes to "at home", so re-ticking doesn't reset "marked 3 weeks ago".
    setStock: db.prepare(`UPDATE ingredients
                          SET in_stock_since = CASE WHEN ? = 1 THEN coalesce(CASE WHEN in_stock = 1 THEN in_stock_since END, datetime('now')) END,
                              in_stock = ?
                          WHERE id = ?`),
    // Marking something "at home" means it's been bought, so it also comes off the hand-added list.
    clearOnListIfHome: db.prepare('UPDATE ingredients SET on_list = 0 WHERE id = ? AND in_stock = 1'),
    setOnList: db.prepare('UPDATE ingredients SET on_list = ? WHERE id = ?'),
    updateIngredient: db.prepare('UPDATE ingredients SET name = ?, category = ?, frozen = ? WHERE id = ?'),
    deleteIngredient: db.prepare('DELETE FROM ingredients WHERE id = ?'),
    touchMealsUsing: db.prepare(`UPDATE meals SET updated_at = datetime('now')
                                 WHERE id IN (SELECT meal_id FROM meal_ingredients WHERE ingredient_id = ?)`),
    insertMeal: db.prepare('INSERT INTO meals (name, notes) VALUES (?, ?)'),
    updateMeal: db.prepare(`UPDATE meals SET name = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`),
    deleteMeal: db.prepare('DELETE FROM meals WHERE id = ?'),
    mealExists: db.prepare('SELECT 1 FROM meals WHERE id = ?'),
    clearMealIngredients: db.prepare('DELETE FROM meal_ingredients WHERE meal_id = ?'),
    insertMealIngredient: db.prepare('INSERT INTO meal_ingredients (meal_id, ingredient_id, quantity, position) VALUES (?, ?, ?, ?)'),
    setPlan: db.prepare(`INSERT INTO plan (date, meal_id) VALUES (?, ?)
                         ON CONFLICT(date) DO UPDATE SET meal_id = excluded.meal_id, updated_at = datetime('now')`),
    clearPlan: db.prepare('DELETE FROM plan WHERE date = ?'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    feed: db.prepare(`SELECT p.date, m.id AS meal_id, m.name, m.notes,
                             max(p.updated_at, m.updated_at) AS updated_at
                      FROM plan p JOIN meals m ON m.id = p.meal_id
                      WHERE p.date >= ? ORDER BY p.date`),
    feedIngredients: db.prepare(`SELECT mi.meal_id, i.name, i.frozen, mi.quantity
                                 FROM meal_ingredients mi JOIN ingredients i ON i.id = mi.ingredient_id
                                 ORDER BY mi.meal_id, mi.position`),
  };

  function assertNoDuplicateIngredient(name, exceptId) {
    const row = q.ingredientByName.get(name);
    if (row && row.id !== exceptId) throw new HttpError(409, `"${name}" is already in your ingredients`);
  }

  function writeMealIngredients(mealId, items) {
    if (!Array.isArray(items)) throw new HttpError(400, 'ingredients must be a list');
    q.clearMealIngredients.run(mealId);
    const seen = new Set();
    let position = 0;
    for (const item of items) {
      const ingredientId = toId(item && item.ingredient_id);
      if (seen.has(ingredientId)) continue;
      if (!q.ingredientExists.get(ingredientId)) throw new HttpError(400, 'One of the ingredients no longer exists — refresh and try again');
      seen.add(ingredientId);
      const quantity = typeof item.quantity === 'string' ? item.quantity.trim().slice(0, 40) : '';
      q.insertMealIngredient.run(mealId, ingredientId, quantity, position++);
    }
  }

  function getSetting(key, createDefault) {
    const row = q.getSetting.get(key);
    if (row) return row.value;
    if (!createDefault) return null;
    const value = createDefault();
    q.setSetting.run(key, value);
    return value;
  }

  return {
    db,

    getState() {
      const ingredients = q.ingredients.all();
      const meals = q.meals.all().map((m) => ({ ...m, ingredients: [] }));
      const byId = new Map(meals.map((m) => [m.id, m]));
      for (const r of q.mealIngredients.all()) {
        byId.get(r.meal_id)?.ingredients.push({ ingredient_id: r.ingredient_id, quantity: r.quantity });
      }
      const plan = q.plan.all().map((p) => ({ ...p }));
      return { ingredients: ingredients.map((i) => ({ ...i, frozen: Boolean(i.frozen), in_stock: Boolean(i.in_stock), on_list: Boolean(i.on_list) })), meals, plan, categories: CATEGORIES };
    },

    addIngredient({ name, category, frozen }) {
      name = cleanName(name, 'Ingredient');
      assertNoDuplicateIngredient(name);
      return Number(q.insertIngredient.run(name, cleanCategory(category), frozen ? 1 : 0).lastInsertRowid);
    },

    updateIngredient(id, { name, category, frozen }) {
      id = toId(id);
      name = cleanName(name, 'Ingredient');
      assertNoDuplicateIngredient(name, id);
      tx(() => {
        if (q.updateIngredient.run(name, cleanCategory(category), frozen ? 1 : 0, id).changes === 0) throw new HttpError(404, 'Ingredient not found');
        q.touchMealsUsing.run(id); // so the calendar feed reflects the change
      });
    },

    /** Marks ingredients as at home (true) or not. Accepts one id or a list, for "mark all" actions. */
    setInStock(ids, inStock) {
      const list = (Array.isArray(ids) ? ids : [ids]).map(toId);
      const flag = inStock ? 1 : 0;
      tx(() => {
        for (const id of list) {
          q.setStock.run(flag, flag, id);
          q.clearOnListIfHome.run(id);
        }
      });
    },

    /** Adds ingredients to (or removes them from) the shopping list by hand, regardless of planned meals. */
    setOnList(ids, onList) {
      const list = (Array.isArray(ids) ? ids : [ids]).map(toId);
      tx(() => {
        for (const id of list) q.setOnList.run(onList ? 1 : 0, id);
      });
    },

    deleteIngredient(id) {
      id = toId(id);
      tx(() => {
        q.touchMealsUsing.run(id);
        q.deleteIngredient.run(id);
      });
    },

    createMeal({ name, notes = '', ingredients = [] }) {
      name = cleanName(name, 'Meal', 120);
      return tx(() => {
        const id = Number(q.insertMeal.run(name, String(notes).slice(0, 10000)).lastInsertRowid);
        writeMealIngredients(id, ingredients);
        return id;
      });
    },

    updateMeal(id, { name, notes = '', ingredients = [] }) {
      id = toId(id);
      name = cleanName(name, 'Meal', 120);
      tx(() => {
        if (q.updateMeal.run(name, String(notes).slice(0, 10000), id).changes === 0) throw new HttpError(404, 'Meal not found');
        writeMealIngredients(id, ingredients);
      });
    },

    deleteMeal(id) {
      q.deleteMeal.run(toId(id));
    },

    setPlan(date, mealId) {
      if (!isValidDate(date)) throw new HttpError(400, 'Invalid date');
      mealId = toId(mealId);
      if (!q.mealExists.get(mealId)) throw new HttpError(400, 'That meal no longer exists');
      q.setPlan.run(date, mealId);
    },

    clearPlan(date) {
      if (!isValidDate(date)) throw new HttpError(400, 'Invalid date');
      q.clearPlan.run(date);
    },

    /** Planned days from `fromDate` onwards, with each meal's ingredients, for the .ics feed. */
    getFeed(fromDate) {
      const ingredientsByMeal = new Map();
      for (const r of q.feedIngredients.all()) {
        if (!ingredientsByMeal.has(r.meal_id)) ingredientsByMeal.set(r.meal_id, []);
        ingredientsByMeal.get(r.meal_id).push({ name: r.name, quantity: r.quantity, frozen: Boolean(r.frozen) });
      }
      return q.feed.all(fromDate).map((r) => ({
        date: r.date,
        name: r.name,
        notes: r.notes,
        updatedAt: r.updated_at,
        ingredients: ingredientsByMeal.get(r.meal_id) || [],
      }));
    },

    getSetting,
    setSetting(key, value) {
      q.setSetting.run(key, value);
    },
    /** "HH:MM" for the take-it-out-of-the-freezer reminder the evening before, or '' when switched off. */
    thawTime() {
      return getSetting('thaw_time', () => DEFAULT_THAW_TIME);
    },
    setThawTime(value) {
      if (value !== '' && !TIME_RE.test(value)) throw new HttpError(400, 'Reminder time must look like 19:00');
      q.setSetting.run('thaw_time', value);
    },
    calendarToken() {
      return getSetting('calendar_token', () => crypto.randomBytes(18).toString('base64url'));
    },
    rotateCalendarToken() {
      const token = crypto.randomBytes(18).toString('base64url');
      q.setSetting.run('calendar_token', token);
      return token;
    },
  };
}

module.exports = { openStore, HttpError, CATEGORIES, isValidDate };
