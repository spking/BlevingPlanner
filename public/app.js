// Meal planner — vanilla JS single-page app (hash routing, no build step).

/* =========================================================================
   Helpers
   ========================================================================= */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Case- and accent-insensitive matching for search boxes.
const norm = (s) => String(s).toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ICON = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
};

// ---- Dates (always local calendar dates, never toISOString, to avoid time-zone shifts) ----
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(parseYmd(s).getTime());
const fmtShort = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = (d) => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
function dateRange(from, to) {
  const out = [];
  for (let d = parseYmd(from); ymd(d) <= to; d = addDays(d, 1)) out.push(ymd(d));
  return out;
}
function relativeDays(dateStr) {
  const diff = Math.round((parseYmd(dateStr) - today()) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff < 0 && diff > -14) return `${-diff} days ago`;
  if (diff < 0) return `${Math.round(-diff / 7)} weeks ago`;
  return fmtDay(parseYmd(dateStr));
}

/* =========================================================================
   State & API
   ========================================================================= */
let state = { ingredients: [], meals: [], plan: [], categories: [] };
const idx = { ing: new Map(), meal: new Map(), plan: new Map() };

function setState(next) {
  state = next;
  idx.ing = new Map(next.ingredients.map((i) => [i.id, i]));
  idx.meal = new Map(next.meals.map((m) => [m.id, m]));
  idx.plan = new Map(next.plan.map((p) => [p.date, p.meal_id]));
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError("Can't reach the server — check your connection", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    showLogin();
    throw new ApiError('Please sign in again', 401);
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

/** Performs a write; the server answers with the fresh full state. Shows a toast on failure. */
async function mutate(method, url, body) {
  try {
    const data = await api(method, url, body);
    if (data.state) setState(data.state);
    return data;
  } catch (err) {
    toast(err.message, true);
    throw err;
  }
}

const loadState = async () => setState(await api('GET', '/api/state'));

// Which meals use each ingredient (for "used in" hints and delete warnings).
function mealsUsing(ingredientId) {
  return state.meals.filter((m) => m.ingredients.some((i) => i.ingredient_id === ingredientId));
}
function plannedDatesFor(mealId) {
  return state.plan.filter((p) => p.meal_id === mealId).map((p) => p.date);
}

/* =========================================================================
   UI primitives: toast, bottom sheet, top bar
   ========================================================================= */
let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 4000 : 2200);
}

const sheet = $('#sheet');
let sheetCtx = null;
function openSheet(html, ctx = {}) {
  sheetCtx = ctx;
  sheet.innerHTML = `<div class="sheet-inner"><div class="grabber"></div>${html}</div>`;
  if (!sheet.open) sheet.showModal();
  ctx.mount?.(sheet);
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('close', () => { sheet.innerHTML = ''; sheetCtx = null; });
// Tapping the dimmed backdrop closes the sheet.
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
const sheetHead = (title, closeLabel = 'Done') =>
  `<div class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-action="close-sheet">${closeLabel}</button></div>`;

function setTop({ title = '', left = '', right = '' }) {
  $('#title').textContent = title;
  $('#topLeft').innerHTML = left;
  $('#topRight').innerHTML = right;
  document.title = title ? `${title} · Meals` : 'Meals';
}
const backLink = (href, label) => `<a class="icon-btn" href="${href}">${ICON.back}<span>${esc(label)}</span></a>`;
const searchBox = (id, placeholder, value = '') =>
  `<div class="search">${ICON.search}<input type="search" class="field" id="${id}" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search"></div>`;
const fab = (action, label) => `<button type="button" class="fab" data-action="${action}" aria-label="${esc(label)}">${ICON.plus}</button>`;
const SNOW = '<span class="snow" title="Kept frozen" aria-label="kept frozen">❄</span>';
const frozenToggle = (checked) => `<label class="toggle-row">
    <input type="checkbox" class="checkbox" name="frozen" ${checked ? 'checked' : ''}>
    <span><b>Kept frozen</b><br><span class="muted">Remind us the evening before to take it out of the freezer</span></span>
  </label>`;
/** The one-tap "we have this at home" toggle, used on the Ingredients page and the shopping list. */
const stockPill = (ing) => `<button type="button" class="have${ing.in_stock ? ' on' : ''}" data-action="toggle-stock" data-id="${ing.id}"
    aria-pressed="${ing.in_stock}" aria-label="${esc(ing.name)}: ${ing.in_stock ? 'at home' : 'not at home'}">${ing.in_stock ? '✓ At home' : 'At home?'}</button>`;
// in_stock_since comes from SQLite as UTC "YYYY-MM-DD HH:MM:SS".
const stockAgeDays = (ing) => {
  if (!ing.in_stock || !ing.in_stock_since) return null;
  const marked = new Date(ing.in_stock_since.replace(' ', 'T') + 'Z');
  marked.setHours(0, 0, 0, 0);
  return Math.round((today() - marked) / 86400000);
};
const STALE_DAYS = 14;
const markedText = (ing) => {
  const days = stockAgeDays(ing);
  if (days === null) return '';
  if (days <= 0) return 'Marked today';
  if (days === 1) return 'Marked yesterday';
  if (days < 14) return `Marked ${days} days ago`;
  return `Marked ${Math.round(days / 7)} weeks ago — still there?`;
};
/** Frozen ingredients in a meal, for the thaw reminder. */
const frozenIn = (meal) => (meal ? meal.ingredients.map((i) => idx.ing.get(i.ingredient_id)).filter((i) => i && i.frozen) : []);
const categoryOptions = (selected) =>
  state.categories.map((c) => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-HTTPS contexts where the async clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

/* =========================================================================
   Router
   ========================================================================= */
const ui = {
  ingQuery: '',
  ingFilter: 'all', // all | home | out
  mealQuery: '',
  lastCategory: 'Fruit & Veg',
  calStart: null, // Date; null = today
};

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  switch (parts[0]) {
    case 'ingredients': return { name: 'ingredients', tab: 'ingredients' };
    case 'meals': return parts[1] ? { name: 'meal', tab: 'meals', id: Number(parts[1]) } : { name: 'meals', tab: 'meals' };
    case 'shopping': return { name: 'shopping', tab: 'calendar', from: parts[1], to: parts[2] };
    default: return { name: 'calendar', tab: 'calendar' };
  }
}

function render() {
  const route = parseRoute();
  if (route.name !== 'meal' || (draft && draft.id !== route.id)) leaveMealDetail();
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === route.tab));
  ({ ingredients: renderIngredients, meals: renderMeals, meal: renderMealDetail, calendar: renderCalendar, shopping: renderShopping })[route.name](route);
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// Global click delegation: any element with data-action="name" calls actions[name](el, event).
const actions = {};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  actions[el.dataset.action](el, e);
});
actions['close-sheet'] = closeSheet;

/* =========================================================================
   Ingredients page
   ========================================================================= */
function renderIngredients() {
  setTop({ title: 'Ingredients' });
  $('#view').innerHTML = `${searchBox('ingSearch', 'Search ingredients', ui.ingQuery)}<div id="ingFilter"></div><div id="ingList"></div>${fab('add-ingredient', 'Add ingredient')}`;
  $('#ingSearch').addEventListener('input', (e) => { ui.ingQuery = e.target.value; drawIngredientList(); });
  drawIngredientList();
}

function drawIngredientList() {
  const el = $('#ingList');
  if (!state.ingredients.length) {
    el.innerHTML = `<div class="empty"><strong>No ingredients yet</strong>Tap + to add the things you usually cook with.</div>`;
    return;
  }
  const q = norm(ui.ingQuery);
  const usage = new Map();
  for (const m of state.meals) for (const i of m.ingredients) usage.set(i.ingredient_id, (usage.get(i.ingredient_id) || 0) + 1);
  const atHome = state.ingredients.filter((i) => i.in_stock).length;
  const filters = [['all', 'All', state.ingredients.length], ['home', 'At home', atHome], ['out', 'Not at home', state.ingredients.length - atHome]];
  $('#ingFilter').innerHTML = `<div class="segmented" role="group" aria-label="Show">${filters.map(([key, label, n]) =>
    `<button type="button" data-action="ing-filter" data-filter="${key}" aria-pressed="${ui.ingFilter === key}" class="${ui.ingFilter === key ? 'on' : ''}">${label} <span>${n}</span></button>`).join('')}</div>`;
  const items = state.ingredients.filter((i) => norm(i.name).includes(q)
    && (ui.ingFilter === 'all' || (ui.ingFilter === 'home') === i.in_stock));
  if (!items.length && ui.ingFilter !== 'all' && !q) {
    el.innerHTML = `<div class="empty">${ui.ingFilter === 'home'
      ? 'Nothing is marked as at home yet.<br>Tap <b>At home?</b> next to an ingredient when you have it.'
      : 'Everything is marked as at home.'}</div>`;
    return;
  }
  if (!items.length) {
    el.innerHTML = `<div class="empty">No ingredients match “${esc(ui.ingQuery)}”.<br><br><button class="btn primary" data-action="add-ingredient" data-prefill="${esc(ui.ingQuery)}">Add “${esc(ui.ingQuery.trim())}”</button></div>`;
    return;
  }
  el.innerHTML = state.categories.map((cat) => {
    const group = items.filter((i) => i.category === cat);
    if (!group.length) return '';
    return `<div class="group-title">${esc(cat)}</div><ul class="list">${group.map((i) => `
      <li class="item-row"><button type="button" class="row" data-action="edit-ingredient" data-id="${i.id}">
        <div class="row-main"><div class="row-title">${esc(i.name)}${i.frozen ? ` ${SNOW}` : ''}</div>
          ${usage.get(i.id) ? `<div class="row-sub">Used in ${plural(usage.get(i.id), 'meal')}</div>` : ''}</div>
        </button>${stockPill(i)}</li>`).join('')}</ul>`;
  }).join('');
}

actions['add-ingredient'] = (el) => openAddIngredient(el.dataset.prefill || '');
actions['ing-filter'] = (el) => { ui.ingFilter = el.dataset.filter; drawIngredientList(); };

actions['toggle-stock'] = async (el) => {
  const ing = idx.ing.get(Number(el.dataset.id));
  if (!ing || el.disabled) return;
  el.disabled = true; // ignore double taps while saving
  try { await mutate('PUT', '/api/stock', { ids: [ing.id], in_stock: !ing.in_stock }); } catch { el.disabled = false; return; }
  const route = parseRoute();
  if (route.name === 'ingredients') drawIngredientList();
  else if (route.name === 'shopping') renderShopping(route);
};

function openAddIngredient(prefill = '') {
  openSheet(`
    ${sheetHead('Add ingredient')}
    <form id="addIngForm" class="stack" autocomplete="off">
      <input class="field" name="name" placeholder="Name, e.g. Red onion" maxlength="80" enterkeyhint="done" autocorrect="off" value="${esc(prefill)}" required>
      <div class="inline">
        <select class="field" name="category" aria-label="Category">${categoryOptions(ui.lastCategory)}</select>
        <button class="btn primary" type="submit">Add</button>
      </div>
      ${frozenToggle(false)}
      <p class="hint" id="addIngHint"></p>
    </form>
    <div class="label">Saved ingredients</div>
    <div class="scroll"><ul class="list" id="savedList"></ul></div>`, {
    mount(root) {
      const form = $('#addIngForm', root);
      const input = form.elements.name;
      const draw = () => {
        const q = norm(input.value);
        const exact = state.ingredients.find((i) => norm(i.name) === q);
        const hint = $('#addIngHint', root);
        hint.textContent = exact ? `“${exact.name}” is already saved (${exact.category})` : '';
        hint.classList.toggle('warn', Boolean(exact));
        form.querySelector('[type=submit]').disabled = !q || Boolean(exact);
        const matches = state.ingredients.filter((i) => norm(i.name).includes(q));
        $('#savedList', root).innerHTML = matches.length
          ? matches.map((i) => `<li class="row"><div class="row-main"><div class="row-title">${esc(i.name)}${i.frozen ? ` ${SNOW}` : ''}</div></div><span class="badge">${esc(i.category)}</span></li>`).join('')
          : `<li class="row muted">${state.ingredients.length ? 'No saved ingredient matches — this will be a new one' : 'Nothing saved yet'}</li>`;
      };
      input.addEventListener('input', draw);
      form.elements.category.addEventListener('change', (e) => { ui.lastCategory = e.target.value; });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          await mutate('POST', '/api/ingredients', { name, category: form.elements.category.value, frozen: form.elements.frozen.checked });
        } catch { return; }
        toast(`Added ${name}`);
        input.value = '';
        form.elements.frozen.checked = false;
        input.focus(); // ready for the next one
        draw();
        drawIngredientListIfVisible();
      });
      draw();
      input.focus();
    },
  });
}
const drawIngredientListIfVisible = () => { if ($('#ingList')) drawIngredientList(); };

actions['edit-ingredient'] = (el) => {
  const ing = idx.ing.get(Number(el.dataset.id));
  if (!ing) return;
  const usedIn = mealsUsing(ing.id);
  openSheet(`
    ${sheetHead('Edit ingredient', 'Cancel')}
    <form id="editIngForm" class="stack" autocomplete="off">
      <input class="field" name="name" value="${esc(ing.name)}" maxlength="80" required>
      <select class="field" name="category" aria-label="Category">${categoryOptions(ing.category)}</select>
      ${frozenToggle(ing.frozen)}
      <button class="btn primary block" type="submit">Save</button>
    </form>
    <p class="muted">${usedIn.length ? `Used in: ${usedIn.map((m) => esc(m.name)).join(', ')}` : 'Not used in any meals yet.'}</p>
    <button type="button" class="btn danger block" data-action="delete-ingredient" data-id="${ing.id}">Delete ingredient</button>`, {
    mount(root) {
      $('#editIngForm', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target.elements;
        try {
          await mutate('PUT', `/api/ingredients/${ing.id}`, { name: f.name.value, category: f.category.value, frozen: f.frozen.checked });
        } catch { return; }
        closeSheet();
        drawIngredientListIfVisible();
      });
    },
  });
};

actions['delete-ingredient'] = async (el) => {
  const ing = idx.ing.get(Number(el.dataset.id));
  if (!ing) return;
  const usedIn = mealsUsing(ing.id);
  const warning = usedIn.length ? `\n\nIt will also be removed from ${plural(usedIn.length, 'meal')}: ${usedIn.map((m) => m.name).join(', ')}.` : '';
  if (!confirm(`Delete “${ing.name}”?${warning}`)) return;
  try { await mutate('DELETE', `/api/ingredients/${ing.id}`); } catch { return; }
  closeSheet();
  toast(`Deleted ${ing.name}`);
  drawIngredientListIfVisible();
};

/* =========================================================================
   Meals page
   ========================================================================= */
function renderMeals() {
  setTop({ title: 'Meals' });
  $('#view').innerHTML = `${searchBox('mealSearch', 'Search meals', ui.mealQuery)}<div id="mealList"></div>${fab('new-meal', 'New meal')}`;
  $('#mealSearch').addEventListener('input', (e) => { ui.mealQuery = e.target.value; drawMealList(); });
  drawMealList();
}

function drawMealList() {
  const el = $('#mealList');
  if (!state.meals.length) {
    el.innerHTML = `<div class="empty"><strong>No meals yet</strong>Tap + to add a meal you like to make, then add its ingredients.</div>`;
    return;
  }
  const q = norm(ui.mealQuery);
  const now = ymd(today());
  const meals = state.meals.filter((m) => norm(m.name).includes(q));
  if (!meals.length) {
    el.innerHTML = `<div class="empty">No meals match “${esc(ui.mealQuery)}”.<br><br><button class="btn primary" data-action="new-meal" data-prefill="${esc(ui.mealQuery)}">Create “${esc(ui.mealQuery.trim())}”</button></div>`;
    return;
  }
  el.innerHTML = `<ul class="list">${meals.map((m) => {
    const dates = plannedDatesFor(m.id);
    const upcoming = dates.find((d) => d >= now);
    const last = dates.filter((d) => d < now).pop();
    const sub = [
      m.ingredients.length ? plural(m.ingredients.length, 'ingredient') : 'No ingredients yet',
      upcoming ? `Next: ${relativeDays(upcoming)}` : last ? `Last: ${relativeDays(last)}` : '',
    ].filter(Boolean).join(' · ');
    return `<li><a class="row" href="#/meals/${m.id}"><div class="row-main"><div class="row-title">${esc(m.name)}</div><div class="row-sub">${esc(sub)}</div></div><span class="chev"></span></a></li>`;
  }).join('')}</ul>`;
}

actions['new-meal'] = (el) => {
  openSheet(`
    ${sheetHead('New meal', 'Cancel')}
    <form id="newMealForm" class="stack" autocomplete="off">
      <input class="field" name="name" placeholder="Meal name, e.g. Chicken curry" maxlength="120" value="${esc(el.dataset.prefill || '')}" enterkeyhint="go" required>
      <p class="hint" id="newMealHint"></p>
      <button class="btn primary block" type="submit">Create and add ingredients</button>
    </form>`, {
    mount(root) {
      const form = $('#newMealForm', root);
      const input = form.elements.name;
      const check = () => {
        const dup = state.meals.find((m) => norm(m.name) === norm(input.value));
        $('#newMealHint', root).textContent = dup ? `You already have “${dup.name}”` : '';
      };
      input.addEventListener('input', check);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let res;
        try { res = await mutate('POST', '/api/meals', { name: input.value }); } catch { return; }
        closeSheet();
        location.hash = `#/meals/${res.id}`;
      });
      check();
      input.focus();
    },
  });
};

/* =========================================================================
   Meal detail (autosaves)
   ========================================================================= */
let draft = null;      // working copy of the meal being edited
let saveTimer = null;  // debounce timer
let inflight = false;  // a save request is running
let queued = null;     // newest snapshot waiting for the running save to finish

const setSaveState = (text) => { const el = $('#saveState'); if (el) el.textContent = text; };
const hasPendingSave = () => Boolean(saveTimer || inflight || queued);

function scheduleSave() {
  setSaveState('Editing…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!draft) return;
  if (!draft.name.trim()) { setSaveState('Name needed'); return; }
  const snapshot = {
    id: draft.id,
    body: { name: draft.name, notes: draft.notes, ingredients: draft.ingredients.map(({ ingredient_id, quantity }) => ({ ingredient_id, quantity })) },
  };
  if (inflight) { queued = snapshot; return; } // saves are sent in order, newest wins
  sendSave(snapshot);
}

async function sendSave(snapshot) {
  inflight = true;
  setSaveState('Saving…');
  try {
    await mutate('PUT', `/api/meals/${snapshot.id}`, snapshot.body);
    if (!queued) setSaveState('Saved');
  } catch {
    setSaveState('Not saved');
  } finally {
    inflight = false;
    if (queued) { const next = queued; queued = null; sendSave(next); }
    else if (parseRoute().name === 'meals') drawMealList(); // left the page mid-save: refresh the list
  }
}

function leaveMealDetail() {
  if (draft && saveTimer) flushSave(); // don't lose the last keystrokes when navigating away
  draft = null;
}

function renderMealDetail({ id }) {
  const meal = idx.meal.get(id);
  setTop({ left: backLink('#/meals', 'Meals'), right: '<span class="save-state" id="saveState"></span>' });
  if (!meal) {
    draft = null;
    $('#view').innerHTML = `<div class="empty"><strong>Meal not found</strong>It may have been deleted. <a href="#/meals">Back to meals</a></div>`;
    return;
  }
  if (!draft || draft.id !== id) draft = structuredClone(meal);
  $('#view').innerHTML = `
    <input class="title-input" id="mealName" value="${esc(draft.name)}" placeholder="Meal name" maxlength="120" enterkeyhint="done" aria-label="Meal name">
    <div class="label">Ingredients</div>
    <ul class="list" id="mealIngs"></ul>
    <div class="label">Recipe &amp; notes</div>
    <textarea class="field" id="mealNotes" placeholder="Steps, a link to the recipe, portions…">${esc(draft.notes)}</textarea>
    <div class="label">Plan it</div>
    <div class="inline">
      <input type="date" class="field" id="planDate" value="${nextFreeDate()}" aria-label="Date">
      <button type="button" class="btn primary" data-action="plan-meal">Add to calendar</button>
    </div>
    <p class="hint" id="planHint"></p>
    <div class="danger-zone"><button type="button" class="btn danger block" data-action="delete-meal">Delete meal</button></div>`;

  $('#mealName').addEventListener('input', (e) => { draft.name = e.target.value; scheduleSave(); });
  $('#mealName').addEventListener('blur', () => { if (saveTimer) flushSave(); });
  $('#mealNotes').addEventListener('input', (e) => { draft.notes = e.target.value; scheduleSave(); });
  $('#mealNotes').addEventListener('blur', () => { if (saveTimer) flushSave(); });
  $('#mealIngs').addEventListener('input', (e) => {
    if (!e.target.matches('.qty')) return;
    const item = draft.ingredients.find((i) => i.ingredient_id === Number(e.target.dataset.id));
    if (item) { item.quantity = e.target.value; scheduleSave(); }
  });
  drawMealIngredients();
  drawPlanHint();
}

function drawMealIngredients() {
  const el = $('#mealIngs');
  if (!el) return;
  const rows = draft.ingredients.map((item) => {
    const ing = idx.ing.get(item.ingredient_id);
    if (!ing) return '';
    return `<li class="ing-row">
      <span class="row-title">${esc(ing.name)}${ing.frozen ? ` ${SNOW}` : ''}</span>
      <input class="qty" data-id="${ing.id}" value="${esc(item.quantity)}" placeholder="Amount" maxlength="40" enterkeyhint="done" aria-label="Amount of ${esc(ing.name)}">
      <button type="button" class="remove" data-action="remove-ing" data-id="${ing.id}" aria-label="Remove ${esc(ing.name)}">×</button>
    </li>`;
  }).join('');
  el.innerHTML = `${rows}<li><button type="button" class="row add-row" data-action="open-ing-picker">＋ Add ingredients</button></li>`;
}

function nextFreeDate() {
  for (let d = today(), i = 0; i < 366; i++, d = addDays(d, 1)) if (!idx.plan.has(ymd(d))) return ymd(d);
  return ymd(today());
}

function drawPlanHint() {
  const el = $('#planHint');
  if (!el || !draft) return;
  const upcoming = plannedDatesFor(draft.id).filter((d) => d >= ymd(today()));
  el.textContent = upcoming.length ? `Planned: ${upcoming.map((d) => fmtDay(parseYmd(d))).join(', ')}` : '';
}

actions['remove-ing'] = (el) => {
  draft.ingredients = draft.ingredients.filter((i) => i.ingredient_id !== Number(el.dataset.id));
  drawMealIngredients();
  flushSave();
};

actions['plan-meal'] = async () => {
  const date = $('#planDate').value;
  if (!isYmd(date)) { toast('Pick a date first', true); return; }
  const existing = idx.meal.get(idx.plan.get(date));
  if (existing && existing.id !== draft.id && !confirm(`${fmtLong(parseYmd(date))} already has “${existing.name}”. Replace it?`)) return;
  try { await mutate('PUT', `/api/plan/${date}`, { meal_id: draft.id }); } catch { return; }
  toast(`Planned for ${fmtDay(parseYmd(date))}`);
  $('#planDate').value = nextFreeDate();
  drawPlanHint();
};

actions['delete-meal'] = async () => {
  const upcoming = plannedDatesFor(draft.id).filter((d) => d >= ymd(today()));
  const warning = upcoming.length ? `\n\nIt's planned on ${plural(upcoming.length, 'day')} — those days will be cleared.` : '';
  if (!confirm(`Delete “${draft.name}”?${warning}`)) return;
  const id = draft.id;
  clearTimeout(saveTimer);
  saveTimer = null;
  draft = null;
  try { await mutate('DELETE', `/api/meals/${id}`); } catch { return; }
  toast('Meal deleted');
  location.hash = '#/meals';
};

// ---- Ingredient picker (used from a meal) ----
actions['open-ing-picker'] = () => {
  openSheet(`
    ${sheetHead('Add ingredients')}
    ${searchBox('pickSearch', 'Search or type a new ingredient')}
    <div class="scroll"><ul class="list" id="pickList"></ul></div>`, {
    mount(root) {
      const input = $('#pickSearch', root);
      input.addEventListener('input', drawPicker);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // Enter picks the single obvious choice: the exact match, else "create".
        const exact = state.ingredients.find((i) => norm(i.name) === norm(input.value));
        if (exact) togglePick(exact.id); else if (input.value.trim()) actions['create-ing']();
      });
      drawPicker();
      input.focus();
    },
  });
};

function drawPicker() {
  const input = $('#pickSearch');
  const list = $('#pickList');
  if (!input || !list || !draft) return;
  const raw = input.value.trim();
  const q = norm(raw);
  const inMeal = new Set(draft.ingredients.map((i) => i.ingredient_id));
  const matches = state.ingredients.filter((i) => norm(i.name).includes(q));
  const exact = matches.some((i) => norm(i.name) === q);
  let html = '';
  if (raw && !exact) {
    html += `<li class="row">
      <div class="row-main"><div class="row-title">New: “${esc(raw)}”</div></div>
      <select class="field compact" id="pickCategory" aria-label="Category">${categoryOptions(ui.lastCategory)}</select>
      <button type="button" class="btn small primary" data-action="create-ing">Add</button></li>`;
  }
  html += matches.map((i) => `
    <li><button type="button" class="row" data-action="pick-ing" data-id="${i.id}">
      <div class="row-main"><div class="row-title">${esc(i.name)}</div><div class="row-sub">${esc(i.category)}${i.frozen ? ' · ❄ frozen' : ''}</div></div>
      ${inMeal.has(i.id) ? '<span class="check" aria-label="Added">✓</span>' : ''}
    </button></li>`).join('');
  if (!html) html = `<li class="row muted">Type the name of an ingredient to add it</li>`;
  list.innerHTML = html;
  $('#pickCategory')?.addEventListener('change', (e) => { ui.lastCategory = e.target.value; });
}

function togglePick(ingredientId) {
  const i = draft.ingredients.findIndex((x) => x.ingredient_id === ingredientId);
  if (i >= 0) draft.ingredients.splice(i, 1);
  else draft.ingredients.push({ ingredient_id: ingredientId, quantity: '' });
  drawMealIngredients();
  flushSave();
  const input = $('#pickSearch');
  if (input && input.value) { input.value = ''; input.focus(); }
  drawPicker();
}

actions['pick-ing'] = (el) => togglePick(Number(el.dataset.id));

actions['create-ing'] = async () => {
  const name = $('#pickSearch')?.value.trim();
  if (!name || !draft) return;
  const category = $('#pickCategory')?.value || 'Other';
  let res;
  try { res = await mutate('POST', '/api/ingredients', { name, category }); } catch { return; }
  ui.lastCategory = category;
  togglePick(res.id);
};

/* =========================================================================
   Calendar page
   ========================================================================= */
const PERIOD_DAYS = 14;
const STEP_DAYS = 7;

function calStart() { return ui.calStart || today(); }

function renderCalendar() {
  const start = calStart();
  const end = addDays(start, PERIOD_DAYS - 1);
  const dates = dateRange(ymd(start), ymd(end));
  const now = ymd(today());
  setTop({
    title: 'Calendar',
    right: `<button type="button" class="icon-btn" data-action="export">${ICON.share}<span>Export</span></button>`,
  });

  let lastMonth = -1;
  const rows = dates.map((date) => {
    const d = parseYmd(date);
    let sep = '';
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      sep = `<li class="month-sep">${esc(d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</li>`;
    }
    const meal = idx.meal.get(idx.plan.get(date));
    const thaw = frozenIn(idx.meal.get(idx.plan.get(ymd(addDays(d, 1)))));
    const thawLine = thaw.length && date >= now
      ? `<div class="row-sub thaw">❄ ${date === now ? 'Tonight' : 'Evening'}: take out ${esc(thaw.map((i) => i.name).join(', '))}</div>` : '';
    const cls = date === now ? 'today' : date < now ? 'past' : '';
    return `${sep}<li class="${cls}"><button type="button" class="row day" data-action="pick-day" data-date="${date}">
      <div class="day-date"><div class="dow">${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</div><div class="num">${d.getDate()}</div></div>
      <div class="row-main">${meal
        ? `<div class="row-title planned">${esc(meal.name)}</div>${meal.ingredients.length ? '' : '<div class="row-sub">No ingredients yet</div>'}`
        : '<div class="unplanned">＋ Plan a meal</div>'}${thawLine}</div>
      <span class="chev"></span></button></li>`;
  }).join('');

  const planned = dates.filter((d) => idx.plan.has(d)).length;
  const showingToday = ymd(start) === now;
  $('#view').innerHTML = `
    <div class="period">
      <button type="button" class="icon-btn" data-action="cal-prev" aria-label="Earlier">${ICON.prev}</button>
      <div class="period-label">${esc(fmtShort(start))} – ${esc(fmtShort(end))}
        ${showingToday ? '' : '<br><button type="button" class="btn small" data-action="cal-today">Back to today</button>'}</div>
      <button type="button" class="icon-btn" data-action="cal-next" aria-label="Later">${ICON.next}</button>
    </div>
    <ul class="list">${rows}</ul>
    <p class="muted center">${planned} of ${PERIOD_DAYS} days planned</p>
    <div class="summary"><a class="btn primary" href="#/shopping/${ymd(start)}/${ymd(end)}">Shopping list for these days</a></div>`;
}

actions['cal-prev'] = () => { ui.calStart = addDays(calStart(), -STEP_DAYS); renderCalendar(); };
actions['cal-next'] = () => { ui.calStart = addDays(calStart(), STEP_DAYS); renderCalendar(); };
actions['cal-today'] = () => { ui.calStart = null; renderCalendar(); };

actions['pick-day'] = (el) => {
  const date = el.dataset.date;
  const current = idx.plan.get(date);
  openSheet(`
    ${sheetHead(fmtLong(parseYmd(date)))}
    ${searchBox('mealPickSearch', state.meals.length ? 'Search or type a new meal' : 'Type a meal name to create it')}
    <div class="scroll"><ul class="list" id="mealPickList"></ul></div>
    ${current ? `<div class="toolbar">
        <a class="btn" href="#/meals/${current}" data-action="close-and-go">View meal</a>
        <button type="button" class="btn danger" data-action="clear-day">Clear day</button></div>` : ''}`, {
    date,
    mount(root) {
      const input = $('#mealPickSearch', root);
      input.addEventListener('input', drawMealPicker);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const exact = state.meals.find((m) => norm(m.name) === norm(input.value));
        if (exact) chooseMeal(exact.id); else if (input.value.trim()) actions['create-meal-for-day']();
      });
      drawMealPicker();
    },
  });
};

function drawMealPicker() {
  const input = $('#mealPickSearch');
  const list = $('#mealPickList');
  if (!input || !list || !sheetCtx?.date) return;
  const { date } = sheetCtx;
  const raw = input.value.trim();
  const q = norm(raw);
  const current = idx.plan.get(date);
  const matches = state.meals.filter((m) => norm(m.name).includes(q));
  let html = '';
  if (raw && !matches.some((m) => norm(m.name) === q)) {
    html += `<li><button type="button" class="row" data-action="create-meal-for-day"><div class="row-main"><div class="row-title add-row">＋ Create “${esc(raw)}”</div><div class="row-sub">You can add its ingredients later</div></div></button></li>`;
  }
  html += matches.map((m) => {
    // "Last had" helps you vary what you eat.
    const last = plannedDatesFor(m.id).filter((d) => d < date).pop();
    return `<li><button type="button" class="row" data-action="choose-meal" data-id="${m.id}">
      <div class="row-main"><div class="row-title">${esc(m.name)}</div>${last ? `<div class="row-sub">Last had ${esc(relativeDays(last))}</div>` : ''}</div>
      ${m.id === current ? '<span class="check" aria-label="Planned">✓</span>' : ''}</button></li>`;
  }).join('');
  if (!html) html = `<li class="row muted">No meals yet — type a name above to create one</li>`;
  list.innerHTML = html;
}

async function chooseMeal(mealId) {
  const { date } = sheetCtx;
  try { await mutate('PUT', `/api/plan/${date}`, { meal_id: mealId }); } catch { return; }
  closeSheet();
  renderCalendar();
}

actions['choose-meal'] = (el) => chooseMeal(Number(el.dataset.id));

actions['create-meal-for-day'] = async () => {
  const name = $('#mealPickSearch')?.value.trim();
  if (!name) return;
  let res;
  try { res = await mutate('POST', '/api/meals', { name }); } catch { return; }
  await chooseMeal(res.id);
  toast(`Created “${name}” — add its ingredients on the Meals page`);
};

actions['clear-day'] = async () => {
  const { date } = sheetCtx;
  try { await mutate('DELETE', `/api/plan/${date}`); } catch { return; }
  closeSheet();
  renderCalendar();
};

actions['close-and-go'] = (el) => { closeSheet(); location.hash = el.getAttribute('href'); };

/* =========================================================================
   Shopping list
   ========================================================================= */
const checkedKey = (from, to) => `mp:checked:${from}:${to}`;
function loadChecked(from, to) {
  try { return new Set(JSON.parse(localStorage.getItem(checkedKey(from, to)) || '[]')); } catch { return new Set(); }
}
function saveChecked(from, to, set) {
  try { localStorage.setItem(checkedKey(from, to), JSON.stringify([...set])); } catch { /* private mode etc. */ }
}

/** Collects every ingredient needed for the meals planned in [from, to], grouped by category. */
function buildShoppingList(from, to) {
  const mealCounts = new Map();
  for (const date of dateRange(from, to)) {
    const mealId = idx.plan.get(date);
    if (idx.meal.has(mealId)) mealCounts.set(mealId, (mealCounts.get(mealId) || 0) + 1);
  }
  const items = new Map(); // ingredient id -> { ingredient, uses: [{ meal, count, quantity }] }
  for (const [mealId, count] of mealCounts) {
    const meal = idx.meal.get(mealId);
    for (const { ingredient_id, quantity } of meal.ingredients) {
      const ingredient = idx.ing.get(ingredient_id);
      if (!ingredient) continue;
      if (!items.has(ingredient_id)) items.set(ingredient_id, { ingredient, uses: [] });
      items.get(ingredient_id).uses.push({ meal, count, quantity });
    }
  }
  const byName = (a, b) => a.ingredient.name.localeCompare(b.ingredient.name);
  const all = [...items.values()];
  const toBuy = all.filter((i) => !i.ingredient.in_stock);
  // "To buy" is grouped by aisle; "Already at home" is a flat list.
  const groups = state.categories.map((category) => ({
    category,
    items: toBuy.filter((i) => i.ingredient.category === category).sort(byName),
  })).filter((g) => g.items.length);
  const atHome = all.filter((i) => i.ingredient.in_stock).sort(byName);
  return { mealCounts, groups, atHome, toBuyCount: toBuy.length };
}

const describeUses = (uses) => uses
  .map((u) => `${u.meal.name}${u.count > 1 ? ` ×${u.count}` : ''}${u.quantity ? `: ${u.quantity}` : ''}`)
  .join(' · ');

function renderShopping(route) {
  const from = isYmd(route.from) ? route.from : ymd(today());
  const to = isYmd(route.to) && route.to >= from ? route.to : ymd(addDays(parseYmd(from), PERIOD_DAYS - 1));
  setTop({ title: 'Shopping list', left: backLink('#/calendar', 'Calendar') });
  const { mealCounts, groups, atHome, toBuyCount } = buildShoppingList(from, to);
  const checked = loadChecked(from, to);
  const noIngredients = [...mealCounts.keys()].map((id) => idx.meal.get(id)).filter((m) => !m.ingredients.length);

  let body;
  if (!mealCounts.size) {
    body = `<div class="empty"><strong>Nothing planned</strong>No meals are planned between these dates. <a href="#/calendar">Plan some meals</a></div>`;
  } else {
    const mealsLine = [...mealCounts].map(([id, n]) => `${esc(idx.meal.get(id).name)}${n > 1 ? ` ×${n}` : ''}`).join(', ');
    body = `
      <p class="muted">${plural([...mealCounts.values()].reduce((a, b) => a + b, 0), 'meal')}: ${mealsLine}</p>
      ${noIngredients.length ? `<p class="hint warn">No ingredients added yet for: ${noIngredients.map((m) => `<a href="#/meals/${m.id}">${esc(m.name)}</a>`).join(', ')}</p>` : ''}
      <h2 class="section-head">To buy <span class="badge">${toBuyCount}</span></h2>
      ${toBuyCount ? groups.map((g) => `<div class="group-title">${esc(g.category)}</div><ul class="list">${g.items.map(({ ingredient, uses }) => `
        <li class="item-row"><label class="check-row ${checked.has(ingredient.id) ? 'done' : ''}">
          <input type="checkbox" data-id="${ingredient.id}" ${checked.has(ingredient.id) ? 'checked' : ''} aria-label="${esc(ingredient.name)} in the basket">
          <div class="row-main"><div class="row-title">${esc(ingredient.name)}</div><div class="row-sub">${esc(describeUses(uses))}</div></div>
        </label>${stockPill(ingredient)}</li>`).join('')}</ul>`).join('')
        : '<div class="empty compact">You have everything for these meals at home.</div>'}
      ${toBuyCount ? `<p class="muted center" id="shopCount"></p>
      <div class="toolbar">
        <button type="button" class="btn" data-action="copy-list">Copy list</button>
        ${navigator.share ? '<button type="button" class="btn" data-action="share-list">Share…</button>' : ''}
        <button type="button" class="btn" data-action="uncheck-all">Uncheck all</button>
      </div>` : ''}
      ${atHome.length ? `
      <h2 class="section-head">Already at home <span class="badge muted-badge">${atHome.length}</span></h2>
      <p class="hint">Left out of the list you copy or share. Tap <b>✓ At home</b> to move something back to <i>To buy</i>.</p>
      <ul class="list">${atHome.map(({ ingredient, uses }) => {
        const stale = stockAgeDays(ingredient) >= STALE_DAYS;
        return `<li class="item-row"><div class="row">
          <div class="row-main"><div class="row-title">${esc(ingredient.name)}</div>
            <div class="row-sub">${esc(describeUses(uses))}</div>
            <div class="row-sub${stale ? ' stale' : ''}">${esc(markedText(ingredient))}</div></div>
        </div>${stockPill(ingredient)}</li>`;
      }).join('')}</ul>` : ''}`;
  }

  $('#view').innerHTML = `
    <div class="range">
      <label>From<input type="date" class="field" id="shopFrom" value="${from}"></label>
      <label>To<input type="date" class="field" id="shopTo" value="${to}"></label>
    </div>
    <div id="shopBody">${body}</div>`;

  const updateRange = () => {
    const f = $('#shopFrom').value;
    let t = $('#shopTo').value;
    if (!isYmd(f) || !isYmd(t)) return;
    if (t < f) t = f;
    history.replaceState(null, '', `#/shopping/${f}/${t}`);
    renderShopping({ from: f, to: t });
  };
  $('#shopFrom').addEventListener('change', updateRange);
  $('#shopTo').addEventListener('change', updateRange);

  const listIds = new Set(groups.flatMap((g) => g.items.map((i) => i.ingredient.id)));
  const updateCount = () => {
    const el = $('#shopCount');
    const inBasket = [...checked].filter((id) => listIds.has(id)).length;
    if (el) el.textContent = inBasket ? `${toBuyCount - inBasket} of ${plural(toBuyCount, 'item')} left to get` : `${plural(toBuyCount, 'item')} to buy`;
  };
  $('#shopBody').addEventListener('change', (e) => {
    if (!e.target.matches('.check-row input')) return;
    const id = Number(e.target.dataset.id);
    if (e.target.checked) checked.add(id); else checked.delete(id);
    e.target.closest('.check-row').classList.toggle('done', e.target.checked);
    saveChecked(from, to, checked);
    updateCount();
  });
  updateCount();
  shoppingCtx = { from, to, groups, checked };
}

let shoppingCtx = null;
function shoppingText() {
  const { from, to, groups, checked } = shoppingCtx;
  const lines = [`Shopping list ${fmtShort(parseYmd(from))} – ${fmtShort(parseYmd(to))}`];
  for (const g of groups) {
    const remaining = g.items.filter((i) => !checked.has(i.ingredient.id));
    if (!remaining.length) continue;
    lines.push('', g.category.toUpperCase());
    for (const { ingredient, uses } of remaining) {
      const qty = uses.filter((u) => u.quantity).map((u) => `${u.quantity}${u.count > 1 ? ` ×${u.count}` : ''}`).join(' + ');
      lines.push(`- ${ingredient.name}${qty ? ` (${qty})` : ''}`);
    }
  }
  return lines.join('\n');
}
actions['copy-list'] = () => copyText(shoppingText());
actions['share-list'] = async () => {
  try { await navigator.share({ title: 'Shopping list', text: shoppingText() }); } catch { /* cancelled */ }
};
actions['uncheck-all'] = () => {
  const { from, to } = shoppingCtx;
  saveChecked(from, to, new Set());
  renderShopping({ from, to });
};

/* =========================================================================
   Calendar export (Apple Calendar subscription)
   ========================================================================= */
let sessionInfo = { authEnabled: false };

actions['export'] = async () => {
  openSheet(`${sheetHead('Add to Apple Calendar')}<p class="muted">Loading…</p>`);
  let info;
  try { info = await api('GET', '/api/calendar'); } catch (err) { toast(err.message, true); closeSheet(); return; }
  drawExport(info);
};

function drawExport({ feedUrl, webcalUrl, thawTime }) {
  const isLocal = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(feedUrl);
  openSheet(`
    ${sheetHead('Add to Apple Calendar')}
    <p>Subscribe once and every planned meal appears in Apple Calendar as an all-day event, with its ingredients in the notes. Changes you make here show up when Calendar next refreshes.</p>
    ${isLocal ? '<p class="hint warn">This server address is only reachable on your own network. Apple Calendar (and iCloud) need a public address — see the README on hosting.</p>' : ''}
    <a class="btn primary block" href="${esc(webcalUrl)}">Subscribe in Calendar</a>
    <div class="label">Subscription link</div>
    <div class="url-box">${esc(feedUrl)}</div>
    <div class="toolbar">
      <button type="button" class="btn" data-action="copy-feed" data-url="${esc(feedUrl)}">Copy link</button>
      <a class="btn" href="${esc(feedUrl)}?download=1" download="meals.ics">Download .ics</a>
    </div>
    <div class="label">Freezer reminders</div>
    <form id="thawForm" class="stack">
      <label class="toggle-row">
        <input type="checkbox" class="checkbox" name="on" ${thawTime ? 'checked' : ''}>
        <span><b>Remind us the evening before</b><br><span class="muted">For meals with ingredients marked ❄ Kept frozen</span></span>
      </label>
      <div class="inline">
        <input type="time" class="field" name="time" value="${esc(thawTime || '19:00')}" aria-label="Reminder time" ${thawTime ? '' : 'disabled'}>
      </div>
    </form>
    <div class="label">Tips</div>
    <ol class="steps">
      <li><b>Mac (recommended):</b> Calendar → File → New Calendar Subscription → paste the link. Set <i>Location</i> to <b>iCloud</b> so it syncs to your iPhone, and <i>Auto-refresh</i> to every 5 minutes or every hour.</li>
      <li><b>iPhone:</b> tap “Subscribe in Calendar”, or go to Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add Subscribed Calendar.</li>
      <li><b>To get freezer notifications</b>, untick <i>Remove: Alerts</i> when subscribing (Mac: right-click the calendar → Get Info; it's ticked by default). Without that you still see the reminder as an event, just without the ping.</li>
      <li>You each subscribe once with your own Apple ID — subscribed calendars can't be shared like a normal iCloud calendar.</li>
      <li>Keep the link private: anyone who has it can see your meal plan (but not change it).</li>
    </ol>
    <div class="toolbar">
      <button type="button" class="btn danger" data-action="rotate-feed">Reset link</button>
      ${sessionInfo.authEnabled ? '<button type="button" class="btn" data-action="logout">Sign out</button>' : ''}
    </div>`, {
    mount(root) {
      const form = $('#thawForm', root);
      const save = async () => {
        const on = form.elements.on.checked;
        form.elements.time.disabled = !on;
        const time = form.elements.time.value;
        if (on && !time) return;
        try { await mutate('PUT', '/api/calendar/settings', { thawTime: on ? time : '' }); } catch { return; }
        toast(on ? `Freezer reminders at ${time}` : 'Freezer reminders off');
      };
      form.elements.on.addEventListener('change', save);
      form.elements.time.addEventListener('change', save);
    },
  });
}

actions['copy-feed'] = (el) => copyText(el.dataset.url);
actions['rotate-feed'] = async () => {
  if (!confirm('Create a new subscription link? The old link stops working, so you will both need to subscribe again.')) return;
  try { drawExport(await api('POST', '/api/calendar/rotate')); toast('New link created'); } catch (err) { toast(err.message, true); }
};
actions['logout'] = async () => {
  await api('POST', '/api/logout').catch(() => {});
  closeSheet();
  showLogin();
};

/* =========================================================================
   Boot, sign-in, and keeping both phones in sync
   ========================================================================= */
function showLogin() {
  closeSheet();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginForm').elements.password.focus();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.elements.password;
  $('#loginError').textContent = '';
  try {
    await api('POST', '/api/login', { password: input.value });
    input.value = '';
    await start();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

async function start() {
  try {
    sessionInfo = await api('GET', '/api/session');
    if (!sessionInfo.authenticated) return showLogin();
    await loadState();
  } catch (err) {
    if (err.status === 401) return;
    document.body.innerHTML = `<div class="empty"><strong>Couldn't load your meals</strong>${esc(err.message)}<br><br><a class="btn" href="/">Try again</a></div>`;
    return;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  render();
}

// When the app comes back to the foreground, pull in anything your partner changed —
// unless you're mid-edit (open sheet or unsaved meal), so nothing is yanked from under you.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || $('#app').hidden || sheet.open || hasPendingSave()) return;
  try {
    await loadState();
    if (!sheet.open && !hasPendingSave()) {
      if (parseRoute().name === 'meal') draft = null; // take the fresh copy
      render();
    }
  } catch { /* offline: keep what we have */ }
});

start();
