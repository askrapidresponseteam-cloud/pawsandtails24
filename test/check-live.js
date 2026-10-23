#!/usr/bin/env node
/* ============================================================================
 * Live check: run the shop's own code against the live store
 * ============================================================================
 * Not hand-written probes: this loads assets/storefront.js, the same file the
 * browser runs, points it at the deployed site and calls what the pages call.
 * If a field the store refuses ever creeps into a query, this fails the same
 * way the page would.
 *
 * It puts one product in a new cart and has the site's own checkout price it
 * for a sample address, which is the proof that things can be bought here.
 * The cart is real but no order or draft is made; Shopify drops the cart
 * after ten days, like any abandoned cart.
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
  apiBase: BASE, version: C.apiVersion, domain: C.domain, quiet: true, brands: C.brands,
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
      line('add to bag', !!(cart && cart.count === 1), 'subtotal ' + S.money(cart.subtotalPaise), true);
    } catch (e) { line('add to bag', false, why(e), true); }
    /* Prices one item for a sample address. Only a calculation: no order and
     * no draft is created in the store. */
    try {
      const q = await S.checkout('quote', {
        lines: [{ variantId: variant.id, qty: 1 }],
        address: { address1: 'Live check only', city: 'Udupi', zip: '576101', state: 'KA' }
      });
      if (q.configured === false) line('checkout', false, 'not connected yet: set SHOPIFY_SHOP and the app credentials on Vercel', false);
      else if (!q.ok) line('checkout', false, q.error || 'could not price a sample order', true);
      else line('checkout', true, 'priced by the store: ' + S.money(q.total) + ', ' + q.rates.length + ' delivery option(s), ' +
        (q.online ? 'Razorpay on' : 'Razorpay keys not set, cash on delivery only'), true);
    } catch (e) { line('checkout', false, why(e), true); }
  } else {
    line('add to bag', false, 'no sellable product found to try', true);
  }

  /* The assistant against the live catalogue: a brand is found even though
   * the store lists everything under its own name. Read only: nothing is
   * added to a bag. */
  try {
    const A = require(path.join(__dirname, '..', 'assets', 'assistant.js'));
    const bot = A.create({ S: S, C: C, collections: () => S.collections().then((l) => l.filter((c) => c.hasProducts && C.hidden.indexOf(c.handle) < 0)) });
    const brand = C.brands.indexOf('Acana') >= 0 ? 'Acana' : C.brands[0];
    const r = await bot.reply('show me ' + brand);
    const cards = (r.blocks.find((b) => b.type === 'products') || { items: [] }).items;
    line('assistant', cards.length > 0, cards.length ? 'finds ' + brand + ': ' + cards.map((p) => p.title.slice(0, 28)).join(' | ') : 'found nothing for ' + brand, false);
  } catch (e) { line('assistant', false, why(e), false); }

  /* What the assistant and the track page read for delivery dates. */
  try {
    const A = require(path.join(__dirname, '..', 'assets', 'assistant.js'));
    const pol = await S.policies({ shippingPath: C.policies.shipping, refundPath: C.policies.refund });
    const t = A.parseDelivery(pol.shipping.text);
    line('shipping page', !!pol.shipping.text, pol.shipping.text
      ? (t.ranges.length ? 'delivery ' + t.ranges.map((r) => r.min + '-' + r.max + ' days' + (r.label ? ' ' + r.label : '')).join(', ') : 'read, but no delivery days found: estimates use ' + C.delivery.fallbackDays.join('-') + ' days')
      : 'not readable: estimates use ' + C.delivery.fallbackDays.join('-') + ' days', false);
    line('returns page', !!pol.refund.text, pol.refund.text ? pol.refund.text.length + ' characters' : 'not readable', false);
  } catch (e) { line('shipping page', false, why(e), false); }

  /* A made-up order: proves the lookup is reachable and connected, finds nothing. */
  try {
    const r = await S.orderLookup('#100', 'nobody@example.com');
    line('order tracking', r.configured !== false, r.configured === false
      ? 'not connected yet: set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET on Vercel'
      : 'connected to the store', false);
  } catch (e) { line('order tracking', false, why(e), false); }

  process.stdout.write('\n  ' + (blocking ? blocking + ' blocking problem(s)' : 'the shop works end to end') +
    (warnings ? ', ' + warnings + ' warning(s)' : '') + '\n\n');
  process.exit(blocking ? 1 : 0);
}());
