#!/usr/bin/env node
/* ============================================================================
 * Live check: does the deployed shop answer the way the site needs?
 * ============================================================================
 * Asks the real store, through whatever origin serves the site, for the
 * things every page depends on: its collections, the full catalogue, search,
 * the as-you-type prediction, and one product with its prices. Read only: it
 * never creates a cart or an order.
 *
 *   node test/check-live.js                        the Vercel deploy
 *   node test/check-live.js https://pawsandtails24.com
 *   node test/check-live.js http://localhost:4173  the dev server
 *
 * Exits non-zero if anything the shop cannot do without is missing.
 * ========================================================================== */
'use strict';

const path = require('path');
const C = require(path.join(__dirname, '..', 'assets', 'catalogue.js'));

const BASE = (process.argv[2] || 'https://pawsandtails24.vercel.app').replace(/\/+$/, '');
const URL = BASE + '/api/' + C.apiVersion + '/graphql.json';

async function gql(query, variables) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) {
    throw new Error('status ' + res.status + ', not JSON: ' + text.slice(0, 120));
  }
  if (body.errors && body.errors.length) throw new Error(body.errors[0].message);
  return body.data;
}

const results = [];
function line(name, ok, detail, blocking) {
  results.push({ ok, blocking });
  process.stdout.write('  ' + (ok ? 'ok  ' : (blocking ? 'FAIL' : 'warn')) + '  ' + name.padEnd(22) + (detail || '') + '\n');
}

(async function run() {
  process.stdout.write('\n  ' + URL + '\n\n');

  try {
    const d = await gql('query PtCheckShop { shop { name } }');
    line('store answers', true, d.shop.name, true);
  } catch (e) {
    line('store answers', false, e.message, true);
    process.stdout.write('\n  Nothing else can work until the store answers.\n\n');
    process.exit(1);
  }

  try {
    let after = null, all = [], pages = 0;
    do {
      const d = await gql('query PtCheckCols($after: String) { collections(first: 100, after: $after) {' +
        ' pageInfo { hasNextPage endCursor } nodes { handle title products(first: 1) { nodes { id } } } } }', { after });
      all = all.concat(d.collections.nodes);
      after = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
      pages++;
    } while (after && pages < 3);
    const live = all.filter((c) => c.products.nodes.length && (C.hidden || []).indexOf(c.handle) < 0);
    line('collections', live.length > 0, live.length + ' with products, of ' + all.length + ' published', false);
  } catch (e) {
    line('collections', false, e.message, false);
  }

  try {
    const d = await gql('query PtCheckAll { products(first: 24) { pageInfo { hasNextPage } nodes { handle availableForSale } } }');
    const n = d.products.nodes.length;
    const sellable = d.products.nodes.filter((p) => p.availableForSale).length;
    line('shop all', n > 0, n + (d.products.pageInfo.hasNextPage ? '+' : '') + ' products, ' + sellable + ' of the first ' + n + ' buyable', true);
  } catch (e) {
    line('shop all', false, e.message, true);
  }

  try {
    const d = await gql('query PtCheckSearch { search(query: "dog", first: 3, types: [PRODUCT]) { totalCount } }');
    line('store search', true, d.search.totalCount + ' matches for "dog"', false);
  } catch (e) {
    line('store search', false, e.message + ' (the shop falls back to a catalogue match)', false);
  }

  try {
    const d = await gql('query PtCheckPrefix { products(first: 3, query: "dog*") { nodes { handle } } }');
    line('catalogue match', d.products.nodes.length > 0, d.products.nodes.length + ' for "dog*"', true);
  } catch (e) {
    line('catalogue match', false, e.message, true);
  }

  try {
    const d = await gql('query PtCheckSuggest { predictiveSearch(query: "dog", limit: 3, types: [PRODUCT]) { products { handle } } }');
    line('as you type', true, d.predictiveSearch.products.length + ' predicted for "dog"', false);
  } catch (e) {
    line('as you type', false, e.message + ' (the shop falls back to a catalogue match)', false);
  }

  try {
    const pick = await gql('query PtCheckPick { products(first: 1) { nodes { handle } } }');
    const handle = pick.products.nodes[0].handle;
    const p = await gql('query PtCheckProduct($h: String!) { product(handle: $h) { title variants(first: 5) {' +
      ' nodes { id availableForSale price { amount currencyCode } } } } }', { h: handle });
    const v = p.product.variants.nodes[0];
    line('product page', true, p.product.title.slice(0, 40) + ', ' + v.price.currencyCode + ' ' + v.price.amount, true);
  } catch (e) {
    line('product page', false, e.message, true);
  }

  const blocking = results.filter((r) => !r.ok && r.blocking).length;
  const warnings = results.filter((r) => !r.ok && !r.blocking).length;
  process.stdout.write('\n  ' + (blocking ? blocking + ' blocking problem(s)' : 'the shop has everything it needs') +
    (warnings ? ', ' + warnings + ' warning(s)' : '') + '\n\n');
  process.exit(blocking ? 1 : 0);
}());
