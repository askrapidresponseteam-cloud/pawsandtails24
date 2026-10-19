#!/usr/bin/env node
/* ============================================================================
 * Live check: run the shop's own code against the live store
 * ============================================================================
 * Not hand-written probes: this loads assets/storefront.js, the same file the
 * browser runs, points it at the deployed site and calls what the pages call.
 * If a field the store refuses ever creeps into a query, this fails the same
 * way the page would.
 *
 * The last step puts one product in a new cart and reads back its checkout
 * link, which is the proof that things can be bought. That cart is real but
 * empty-handed: no order is placed, and Shopify drops it after ten days, like
 * any abandoned cart.
 *
 *   node test/check-live.js                        the Vercel deploy
 *   node test/check-live.js http://localhost:4173  the dev server
 * ========================================================================== */
'use strict';

const path = require('path');
const C = require(path.join(__dirname, '..', 'assets', 'catalogue.js'));
const S = require(path.join(__dirname, '..', 'assets', 'storefront.js'));

const BASE = (process.argv[2] || 'https://pawsandtails24.vercel.app').replace(/\/+$/, '');
const memory = new Map();
S.configure({
  apiBase: BASE, version: C.apiVersion, domain: C.domain, quiet: true,
  fetchImpl: (url, init) => fetch(url, init),
  storage: { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) }
});

let blocking = 0, warnings = 0;
function line(name, good, detail, isBlocking) {
  if (!good) { if (isBlocking) blocking++; else warnings++; }
  process.stdout.write('  ' + (good ? 'ok  ' : (isBlocking ? 'FAIL' : 'warn')) + '  ' + name.padEnd(18) + (detail || '') + '\n');
}
function why(e) {
  const g = e && e.graphQLErrors && e.graphQLErrors.map((x) => x.message).join(' | ');
  return g || (e && e.message) || String(e);
}

(async function run() {
  process.stdout.write('\n  ' + BASE + '/api/' + C.apiVersion + '/graphql.json\n\n');

  try { const s = await S.ping(); line('store answers', true, s.name, true); }
  catch (e) { line('store answers', false, why(e), true); process.stdout.write('\n'); process.exit(1); }

  try {
    const cols = (await S.collections()).filter((c) => c.hasProducts && C.hidden.indexOf(c.handle) < 0);
    line('collections', cols.length > 0, cols.length + ' with products', false);
  } catch (e) { line('collections', false, why(e), false); }

  let first = null;
  try {
    const page = await S.allProducts({});
    first = page.products.find((p) => p.available) || page.products[0];
    line('shop all', page.products.length > 0, page.products.length + (page.hasMore ? '+' : '') + ' on the first page', true);
  } catch (e) { line('shop all', false, why(e), true); }

  try {
    const r = await S.searchAll('dog');
    line('search', r.products.length > 0, r.products.length + ' for "dog" via ' + r.mode, true);
  } catch (e) { line('search', false, why(e), true); }

  try {
    const r = await S.suggest('dog');
    line('as you type', r.products.length > 0, r.products.length + ' via ' + r.source, false);
  } catch (e) { line('as you type', false, why(e), false); }

  let variant = null;
  if (first) {
    try {
      const p = await S.product(first.handle);
      variant = p && p.variants.find((v) => v.available);
      line('product page', !!p, p ? p.title.slice(0, 38) + ', ' + p.variants.length + ' size(s), ' + S.money(p.variants[0].paise) : 'not found', true);
    } catch (e) { line('product page', false, why(e), true); }
  }

  if (variant) {
    try {
      const cart = await S.cartAdd(variant.id, 1);
      const host = cart && cart.checkoutUrl ? new URL(cart.checkoutUrl).host : '';
      line('add to bag', !!(cart && cart.count === 1), 'subtotal ' + S.money(cart.subtotalPaise), true);
      line('checkout link', !!host, host ? 'opens on ' + host : 'none returned', true);
    } catch (e) { line('add to bag', false, why(e), true); }
  } else {
    line('add to bag', false, 'no sellable product found to try', true);
  }

  process.stdout.write('\n  ' + (blocking ? blocking + ' blocking problem(s)' : 'the shop works end to end') +
    (warnings ? ', ' + warnings + ' warning(s)' : '') + '\n\n');
  process.exit(blocking ? 1 : 0);
}());
