'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openStore, HttpError } = require('./lib/db');
const { buildCalendar } = require('./lib/ics');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const SESSION_COOKIE = 'mp_session';
const FEED_HISTORY_DAYS = 90; // how far back the calendar feed reaches

function createApp({ store, password = '', publicUrl = '', calendarName = 'Meals' }) {
  const authEnabled = Boolean(password);
  const sessionSalt = store.getSetting('session_salt', () => crypto.randomBytes(16).toString('hex'));
  const uidDomain = `${store.getSetting('instance_id', () => crypto.randomBytes(6).toString('hex'))}.meal-planner`;
  const sessionValue = crypto.createHmac('sha256', sessionSalt).update(`session:v1:${password}`).digest('base64url');

  const safeEqual = (a, b) => {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  };

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  const isAuthed = (req) => !authEnabled || safeEqual(cookies(req)[SESSION_COOKIE] || '', sessionValue);
  const isHttps = (req) => publicUrl.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https';

  function baseUrl(req) {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(body);
  }
  const json = (res, status, data, headers) =>
    send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256 * 1024) throw new HttpError(413, 'Request too large');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  function feedUrls(req) {
    const httpsUrl = `${baseUrl(req)}/cal/${store.calendarToken()}.ics`;
    return { feedUrl: httpsUrl, webcalUrl: httpsUrl.replace(/^https?:/, 'webcal:'), thawTime: store.thawTime() };
  }

  // [method, pattern, handler, isPublic]
  const routes = [
    ['GET', /^\/api\/session$/, (req) => ({ authEnabled, authenticated: isAuthed(req) }), true],

    ['POST', /^\/api\/login$/, async (req, res) => {
      const body = await readJson(req);
      if (!authEnabled) return { ok: true };
      if (!safeEqual(body.password || '', password)) {
        await new Promise((r) => setTimeout(r, 800)); // slow down guessing
        throw new HttpError(401, 'Wrong password');
      }
      const secure = isHttps(req) ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
      return { ok: true };
    }, true],

    ['POST', /^\/api\/logout$/, (req, res) => {
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return { ok: true };
    }, true],

    ['GET', /^\/api\/state$/, () => store.getState()],

    ['POST', /^\/api\/ingredients$/, async (req) => ({ id: store.addIngredient(await readJson(req)) })],
    ['PUT', /^\/api\/stock$/, async (req) => {
      const { ids, in_stock: inStock } = await readJson(req);
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw new HttpError(400, 'ids must be a non-empty list');
      store.setInStock(ids, Boolean(inStock));
    }],
    ['PUT', /^\/api\/list$/, async (req) => {
      const { ids, on_list: onList } = await readJson(req);
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000) throw new HttpError(400, 'ids must be a non-empty list');
      store.setOnList(ids, Boolean(onList));
    }],
    ['PUT', /^\/api\/ingredients\/(\d+)$/, async (req, res, [id]) => store.updateIngredient(id, await readJson(req))],
    ['DELETE', /^\/api\/ingredients\/(\d+)$/, (req, res, [id]) => store.deleteIngredient(id)],

    ['POST', /^\/api\/meals$/, async (req) => ({ id: store.createMeal(await readJson(req)) })],
    ['PUT', /^\/api\/meals\/(\d+)$/, async (req, res, [id]) => store.updateMeal(id, await readJson(req))],
    ['DELETE', /^\/api\/meals\/(\d+)$/, (req, res, [id]) => store.deleteMeal(id)],

    ['PUT', /^\/api\/plan\/([\d-]+)$/, async (req, res, [date]) => store.setPlan(date, (await readJson(req)).meal_id)],
    ['DELETE', /^\/api\/plan\/([\d-]+)$/, (req, res, [date]) => store.clearPlan(date)],

    ['GET', /^\/api\/calendar$/, (req) => feedUrls(req)],
    ['PUT', /^\/api\/calendar\/settings$/, async (req) => {
      const { thawTime } = await readJson(req);
      store.setThawTime(typeof thawTime === 'string' ? thawTime : '');
      return feedUrls(req);
    }],
    ['POST', /^\/api\/calendar\/rotate$/, (req) => {
      store.rotateCalendarToken();
      return feedUrls(req);
    }],
  ];

  async function handleApi(req, res, url) {
    for (const [method, pattern, handler, isPublic] of routes) {
      const match = url.pathname.match(pattern);
      if (!match) continue;
      if (req.method !== method) continue;
      if (!isPublic && !isAuthed(req)) throw new HttpError(401, 'Not signed in');
      const result = await handler(req, res, match.slice(1));
      // Every write returns the full, fresh state: the data set is tiny and it keeps both phones in sync.
      if (method !== 'GET' && !isPublic) return json(res, 200, { ...(result || {}), state: store.getState() });
      return json(res, 200, result ?? { ok: true });
    }
    throw new HttpError(404, 'Not found');
  }

  function handleFeed(req, res, token, url) {
    if (!safeEqual(token, store.calendarToken())) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const from = new Date(Date.now() - FEED_HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
    const body = buildCalendar({ events: store.getFeed(from), calendarName, uidDomain, thawTime: store.thawTime() });
    const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
    send(res, 200, body, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `${disposition}; filename="meals.ics"`,
      'Cache-Control': 'no-cache',
    });
  }

  function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      send(res, 200, req.method === 'HEAD' ? undefined : data, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', // always revalidate, so both phones pick up new versions
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      });
    });
  }

  return async function app(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      const feed = url.pathname.match(/^\/cal\/([A-Za-z0-9_-]+)\.ics$/);
      if (feed) return handleFeed(req, res, feed[1], url);
      return handleStatic(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong on the server' : err.message });
    }
  };
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const store = openStore(path.join(dataDir, 'meal-planner.db'));
  const password = process.env.APP_PASSWORD || '';
  if (!password) console.warn('⚠️  APP_PASSWORD is not set — anyone who can reach this server can edit your data.');
  const app = createApp({
    store,
    password,
    publicUrl: process.env.PUBLIC_URL || '',
    calendarName: process.env.CALENDAR_NAME || 'Meals',
  });
  const port = Number(process.env.PORT) || 3000;
  // HOST=127.0.0.1 makes the app reachable only from this machine (e.g. via Tailscale Funnel). Default: all interfaces.
  const host = process.env.HOST || undefined;
  http.createServer(app).listen(port, host, () => console.log(`Meal planner running on http://${host || 'localhost'}:${port}`));
}

module.exports = { createApp };
