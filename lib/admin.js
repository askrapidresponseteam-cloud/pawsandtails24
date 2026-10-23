/* ============================================================================
 * The store's Admin API, for the server only
 * ============================================================================
 * Shared by api/order.js (tracking) and api/checkout.js (placing orders).
 * Holds the one secret that can read and create orders, so it only ever runs
 * on Vercel; nothing here is sent to a browser.
 *
 *   SHOPIFY_SHOP            the store's myshopify address
 *   SHOPIFY_CLIENT_ID       from the app in the Shopify Dev Dashboard
 *   SHOPIFY_CLIENT_SECRET   from the same page
 *     or, for an app made before 2026 with a fixed token:
 *   SHOPIFY_ADMIN_TOKEN
 *
 * With client id and secret, a token comes from Shopify's client credentials
 * grant, is kept for its 24 hours, renewed early, and renewed at once if
 * Shopify stops accepting it.
 * ========================================================================== */
'use strict';

const API_VERSION = '2026-01';

function createAdmin(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const doFetch = opts.fetchImpl || ((...a) => fetch(...a));
  const now = opts.now || (() => Date.now());
  let token = null; /* { value, until } */

  function shop() {
    return String(env.SHOPIFY_SHOP || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  function configured() {
    return !!(shop() && (env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)));
  }

  async function accessToken(renew) {
    if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
    if (!renew && token && token.until > now()) return token.value;
    const body = 'grant_type=client_credentials' +
      '&client_id=' + encodeURIComponent(env.SHOPIFY_CLIENT_ID) +
      '&client_secret=' + encodeURIComponent(env.SHOPIFY_CLIENT_SECRET);
    const res = await doFetch('https://' + shop() + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body
    });
    if (res.status !== 200) throw Object.assign(new Error('token ' + res.status), { upstream: true });
    const j = await res.json();
    if (!j || !j.access_token) throw Object.assign(new Error('token missing'), { upstream: true });
    const life = Math.max(60, Number(j.expires_in) || 86399) * 1000;
    token = { value: j.access_token, until: now() + life - 5 * 60 * 1000 };
    return token.value;
  }

  /** One GraphQL call. Throws on transport or GraphQL errors; userErrors are
   *  the caller's to read. */
  async function query(q, variables, renewed) {
    const t = await accessToken(!!renewed);
    const res = await doFetch('https://' + shop() + '/admin/api/' + API_VERSION + '/graphql.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Shopify-Access-Token': t },
      body: JSON.stringify({ query: q, variables: variables || {} })
    });
    if (res.status === 401 && !renewed && !env.SHOPIFY_ADMIN_TOKEN) return query(q, variables, true);
    if (res.status !== 200) throw Object.assign(new Error('admin ' + res.status), { upstream: true, status: res.status });
    const j = await res.json();
    if (j && j.errors && (Array.isArray(j.errors) ? j.errors.length : true)) {
      const msg = Array.isArray(j.errors) ? j.errors.map((e) => e && e.message).join(' | ') : String(j.errors);
      throw Object.assign(new Error('admin: ' + msg), { upstream: true });
    }
    return j && j.data;
  }

  return { configured: configured, query: query, shop: shop };
}

/* ---------------------------------------------------------------- http bits */

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  const raw = await readRaw(req);
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function clientIp(req) {
  return String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) ||
    (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** At most `limit` calls per address per minute. */
function rateLimiter(limit, now) {
  const hits = new Map();
  now = now || (() => Date.now());
  return function allow(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter((x) => t - x < 60 * 1000);
    if (recent.length >= limit) return false;
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

module.exports = { createAdmin, readJson, readRaw, clientIp, send, rateLimiter, API_VERSION };
