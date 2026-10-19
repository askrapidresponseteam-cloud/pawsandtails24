#!/usr/bin/env node
/* ============================================================================
 * Regression tests for the Paws and Tails storefront client
 * ============================================================================
 * The data layer is driven against a fake fetch, so every test is offline and
 * deterministic: no network, no store, no order. What is checked is the part
 * that decides money, stock and what the bag sends to Shopify.
 *
 *   node test/test-storefront.js
 * ========================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'assets', 'storefront.js');

let passed = 0;
const failures = [];

function ok(what, cond) {
  if (cond) { passed++; return; }
  failures.push(what);
}
function eq(what, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { passed++; return; }
  failures.push(what + '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}
function section(name) { process.stdout.write('\n  ' + name + '\n'); }

/* Asynchronous checks are collected and awaited at the end of the file. */
const pending = [];
function later(p) { pending.push(p); }

/* ------------------------------------------------------------- the fixtures */

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map
  };
}

/** A fake fetch. `handler(operation, variables, body)` returns either a data
 *  object, or { status }, or { errors }, or { raw } for a non-JSON answer. */
function fakeFetch(handler) {
  const calls = [];
  const f = function (url, init) {
    const body = JSON.parse(init.body);
    const m = String(body.query || '').match(/(?:query|mutation)\s+(\w+)/);
    const op = m ? m[1] : '(anonymous)';
    calls.push({ url: url, op: op, variables: body.variables, headers: init.headers, query: body.query });
    const out = handler(op, body.variables, body) || {};
    if (out.status && out.status !== 200) {
      return Promise.resolve({ status: out.status, json: () => Promise.resolve({}) });
    }
    if (out.raw !== undefined) {
      return Promise.resolve({ status: 200, json: () => Promise.reject(new Error('not json')) });
    }
    if (out.errors) {
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ errors: out.errors }) });
    }
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ data: out.data === undefined ? out : out.data }) });
  };
  f.calls = calls;
  return f;
}

/** A client with nothing carried over from the last test. */
function fresh(handler, opts) {
  delete require.cache[require.resolve(CLIENT)];
  const S = require(CLIENT);
  const f = fakeFetch(handler || (() => ({})));
  S.configure(Object.assign({
    apiBase: '', version: '2026-01', token: '', fetchImpl: f, storage: memStorage(), quiet: true
  }, opts || {}));
  S.clearCache();
  return { S, f };
}

const TILE = {
  id: 'gid://shopify/Product/1',
  handle: 'rc-medium-adult',
  title: 'Medium Adult Dry Dog Food',
  vendor: 'Royal Canin',
  productType: 'Dry food',
  availableForSale: true,
  featuredImage: { url: 'https://cdn.shopify.com/s/files/1/x/rc.jpg', altText: 'Bag of food' },
  priceRange: { minVariantPrice: { amount: '3450.00', currencyCode: 'INR' }, maxVariantPrice: { amount: '11250.00' } },
  compareAtPriceRange: { maxVariantPrice: { amount: '3650.00' } }
};

const CART = {
  id: 'gid://shopify/Cart/abc123',
  checkoutUrl: 'https://pawsandtails24.com/cart/c/abc123',
  totalQuantity: 2,
  cost: { subtotalAmount: { amount: '6900.00', currencyCode: 'INR' }, totalAmount: { amount: '6900.00' } },
  lines: { nodes: [{
    id: 'gid://shopify/CartLine/1',
    quantity: 2,
    cost: { totalAmount: { amount: '6900.00' } },
    merchandise: {
      id: 'gid://shopify/ProductVariant/11',
      title: '4 kg',
      availableForSale: true,
      quantityAvailable: 7,
      price: { amount: '3450.00' },
      compareAtPrice: { amount: '3650.00' },
      image: { url: 'https://cdn.shopify.com/s/files/1/x/rc.jpg' },
      product: { handle: 'rc-medium-adult', title: 'Medium Adult Dry Dog Food', vendor: 'Royal Canin', featuredImage: { url: 'x' } }
    }
  }] }
};

/* ==================================================================== MONEY */

section('money');
{
  const { S } = fresh();
  eq('whole rupees carry Indian grouping', S.money(345000), '₹3,450');
  eq('lakhs group in pairs', S.money(123456789), '₹12,34,567.89');
  eq('paise show only when present', S.money(1050), '₹10.50');
  eq('a round amount drops the paise', S.money(1000), '₹10');
  eq('under a rupee still reads', S.money(99), '₹0.99');
  eq('negative keeps its sign', S.money(-5000), '-₹50');
  eq('grouping of eight digits', S._groupIndian('12345678'), '1,23,45,678');
  eq('grouping of three digits is untouched', S._groupIndian('999'), '999');
  eq('an amount string becomes paise as text', S.paise('3450.00'), 345000);
  eq('one decimal place is padded', S.paise('1.5'), 150);
  eq('three decimal places are cut, not rounded up', S.paise('10.999'), 1099);
  eq('nonsense is not a price', S.paise('free'), null);
  eq('a number amount is accepted', S.paise(12.5), 1250);
  eq('no price formats to nothing, not to zero', S.money(null), '');
}

/* ================================================================ TRANSPORT */

section('transport');
{
  const { S, f } = fresh(() => ({ shop: { name: 'Paws and Tails', primaryDomain: { host: 'pawsandtails24.com' } } }));
  later(S.ping().then((r) => {
    eq('the API is called same origin at the version in config', f.calls[0].url, '/api/2026-01/graphql.json');
    eq('no token header when there is no token', f.calls[0].headers['X-Shopify-Storefront-Access-Token'], undefined);
    eq('ping reports the shop', r.name, 'Paws and Tails');
  }));
}
{
  const { S, f } = fresh(() => ({ shop: { name: 'x' } }), { token: 'public-token-123', apiBase: 'http://localhost:4173' });
  later(S.ping().then(() => {
    eq('a token is sent as the Storefront header', f.calls[0].headers['X-Shopify-Storefront-Access-Token'], 'public-token-123');
    eq('an api base is honoured', f.calls[0].url, 'http://localhost:4173/api/2026-01/graphql.json');
  }));
}

[
  [401, 'a refused request asks for a token', /Storefront token/],
  [429, 'a throttled store says it is busy', /busy/],
  [500, 'a broken store names the status', /\(500\)/],
  [404, 'a missing document is not found', /Not found/]
].forEach(([status, what, shape]) => {
  const { S } = fresh(() => ({ status }));
  later(S.ping().then(
    () => { failures.push(what + ' (it resolved instead)'); },
    (e) => { ok(what, shape.test(e.message) && e.status === status); }
  ));
});

{
  const { S } = fresh(() => ({ raw: '<html>maintenance</html>' }));
  later(S.ping().then(
    () => { failures.push('a page instead of JSON must not pass as data'); },
    (e) => ok('a page instead of JSON is reported, not parsed', /unexpected/.test(e.message))
  ));
}

{
  const { S } = fresh(() => ({ errors: [{ message: 'Field tags requires a token' }] }));
  later(S.ping().then(
    () => { failures.push('GraphQL errors must not pass as data'); },
    (e) => {
      ok('GraphQL errors are an error', e.storefront === true);
      ok('a refused field is recognised as such', e.fieldRefused === true);
    }
  ));
}

{
  const { S, f } = fresh(() => ({ collection: { title: 'Dog Food', description: '', products: { pageInfo: {}, nodes: [TILE] } } }));
  later(S.collectionPage('dog-food').then(() => S.collectionPage('dog-food')).then(() => {
    eq('a repeated read is served from cache, not the store', f.calls.length, 1);
    return S.collectionPage('dog-food', { fresh: true });
  }).then(() => {
    eq('fresh skips the cache', f.calls.length, 2);
  }));
}

/* ==================================================================== TILES */

section('listing tiles');
{
  const { S } = fresh();
  const t = S._tileOf(TILE);
  eq('price comes from the lowest variant', t.paise, 345000);
  eq('a spread of variant prices is flagged as a range', t.ranged, true);
  eq('a ranged product advertises no saving, since the two ends are different sizes', t.wasPaise, null);
  eq('and so no percentage either', S.discountPercent(t), 0);
  eq('brand and title survive', [t.brand, t.title], ['Royal Canin', 'Medium Adult Dry Dog Food']);

  /* One price, one MRP: the saving is real and belongs on the tile. */
  const oneSize = S._tileOf(Object.assign({}, TILE, {
    priceRange: { minVariantPrice: { amount: '3450.00', currencyCode: 'INR' }, maxVariantPrice: { amount: '3450.00' } }
  }));
  eq('a single price product keeps its MRP', oneSize.wasPaise, 365000);
  eq('and its saving is rounded to a percent', S.discountPercent(oneSize), 5);
  eq('a single price is not a range', oneSize.ranged, false);

  const noOffer = S._tileOf(Object.assign({}, TILE, {
    priceRange: { minVariantPrice: { amount: '3450.00' }, maxVariantPrice: { amount: '3450.00' } },
    compareAtPriceRange: { maxVariantPrice: { amount: '3450.00' } }
  }));
  eq('a compareAt equal to the price is not an offer', noOffer.wasPaise, null);
  eq('no offer means no percentage', S.discountPercent(noOffer), 0);

  const zero = S._tileOf(Object.assign({}, TILE, {
    priceRange: { minVariantPrice: { amount: '3450.00' }, maxVariantPrice: { amount: '3450.00' } },
    compareAtPriceRange: { maxVariantPrice: { amount: '0.00' } }
  }));
  eq('a zero compareAt is not an offer', zero.wasPaise, null);

  const out = S._tileOf(Object.assign({}, TILE, { availableForSale: false }));
  eq('sold out is carried through, not hidden', out.available, false);

  const bare = S._tileOf({ id: 'gid://x/1', handle: 'h', title: 'T' });
  eq('a tile with no price does not invent one', bare.paise, null);
  eq('a tile with no picture says so', bare.image, null);
  eq('junk is dropped rather than drawn', S._tileOf({ title: 'no handle' }), null);
}

/* ============================================================== COLLECTIONS */

section('aisles');
{
  const { S, f } = fresh((op, v) => {
    if (v.handle === 'nope') return { collection: null };
    return { collection: {
      title: 'Dog Food', description: 'Everyday food',
      products: { pageInfo: { hasNextPage: true, endCursor: 'cur1' }, nodes: [TILE, Object.assign({}, TILE, { handle: 'b', id: 'gid://shopify/Product/2' })] }
    } };
  });
  later(S.collectionPage('dog-food', { sort: 'priceLow' }).then((page) => {
    eq('the aisle keeps the store title', page.title, 'Dog Food');
    eq('both products are mapped', page.products.length, 2);
    eq('the next page is remembered', [page.hasMore, page.cursor], [true, 'cur1']);
    eq('an aisle that answers is not missing', page.missing, false);
    eq('the sort reaches the store as a collection sort key', f.calls[0].variables.sortKey, 'PRICE');
    eq('price low to high is not reversed', f.calls[0].variables.reverse, false);
    return S.collectionPage('nope');
  }).then((page) => {
    eq('an aisle the store does not have is marked missing', page.missing, true);
    eq('a missing aisle has no products', page.products.length, 0);
  }));
}

{
  const { S, f } = fresh(() => ({ products: { pageInfo: {}, nodes: [TILE] } }));
  later(S.brandPage("Hill's", { sort: 'priceHigh' }).then((page) => {
    eq('a brand page reads the products query', page.products.length, 1);
    eq('an apostrophe in a brand is escaped for the query', f.calls[0].variables.q, "vendor:'Hill\\'s'");
    eq('price high to low is reversed', f.calls[0].variables.reverse, true);
  }));
}

/* ================================================================== PRODUCT */

section('product');
{
  const PRODUCT = {
    id: 'gid://shopify/Product/1', handle: 'rc-medium-adult', title: 'Medium Adult',
    vendor: 'Royal Canin', productType: 'Dry food', descriptionHtml: '<p>Complete food</p>',
    availableForSale: true, tags: ['Veg'],
    featuredImage: { url: 'a.jpg', altText: 'a' },
    images: { nodes: [{ url: 'a.jpg', altText: 'a' }, { url: 'b.jpg', altText: null }] },
    options: [{ name: 'Size', values: ['4 kg', '10 kg'] }],
    variants: { nodes: [
      { id: 'gid://shopify/ProductVariant/11', title: '4 kg', availableForSale: true, quantityAvailable: 3, currentlyNotInStock: false, price: { amount: '3450.00' }, compareAtPrice: { amount: '3650.00' }, image: { url: 'a.jpg' }, selectedOptions: [{ name: 'Size', value: '4 kg' }] },
      { id: 'gid://shopify/ProductVariant/12', title: '10 kg', availableForSale: false, quantityAvailable: 0, currentlyNotInStock: true, price: { amount: '7990.00' }, compareAtPrice: null, image: null, selectedOptions: [{ name: 'Size', value: '10 kg' }] }
    ] }
  };
  const { S } = fresh((op, v) => (v.handle === 'gone' ? { product: null } : { product: PRODUCT }));
  later(S.product('rc-medium-adult').then((p) => {
    eq('every variant is kept', p.variants.length, 2);
    eq('the first variant price is read', p.variants[0].paise, 345000);
    eq('its MRP is read', p.variants[0].wasPaise, 365000);
    eq('low stock is reported as a number', p.variants[0].stock, 3);
    eq('a sold out variant says so', p.variants[1].available, false);
    eq('a variant with no MRP has none', p.variants[1].wasPaise, null);
    eq('back order is flagged', p.variants[1].backorder, true);
    eq('both pictures are kept', p.images.length, 2);
    eq('an image with no alt text falls back to the title', p.images[1].alt, 'Medium Adult');
    eq('the option name is offered for the picker', p.optionNames, ['Size']);
    eq('the store copy is passed through', p.descriptionHtml, '<p>Complete food</p>');
    return S.product('gone');
  }).then((p) => {
    eq('a product the store has dropped is null, not an empty shell', p, null);
  }));
}

{
  /* A field outside tokenless reach must cost the page nothing. */
  let seen = 0;
  const { S, f } = fresh((op, v, body) => {
    seen++;
    if (/\btags\b/.test(body.query)) return { errors: [{ message: 'Access denied for tags field' }] };
    return { product: { id: 'gid://x/1', handle: 'h', title: 'T', variants: { nodes: [] }, images: { nodes: [] }, options: [] } };
  });
  later(S.product('h').then((p) => {
    ok('a refused field is retried without it rather than failing', p !== null);
    eq('the retry is the second and last call', f.calls.length, 2);
    ok('the retry asks for no tags', !/\btags\b/.test(f.calls[1].query));
  }));
}

{
  /* Once the store has refused the rich read, it is not asked again. */
  const { S, f } = fresh((op, v, body) => {
    if (/quantityAvailable|\btags\b/.test(body.query)) return { errors: [{ message: 'Access denied for quantityAvailable field.' }] };
    return { product: { id: 'gid://x/1', handle: v.handle, title: 'T', variants: { nodes: [
      { id: 'gid://x/v1', title: '1 kg', availableForSale: true, price: { amount: '100.00' } }] }, images: { nodes: [] }, options: [] } };
  }, { quiet: true });
  later(S.product('a').then((p) => {
    ok('a refused stock count still gives a product page', p && p.variants.length === 1);
    eq('it took the rich read and one retry', f.calls.length, 2);
    ok('without stock counts, the variant is still buyable', p.variants[0].available === true);
    eq('and its stock is unknown rather than zero', p.variants[0].stock, null);
    return S.product('b');
  }).then(() => {
    eq('the next product goes straight to the read the store allows', f.calls.length, 3);
    ok('which asks for nothing tokenless access refuses', !/quantityAvailable|\btags\b/.test(f.calls[2].query));
  }));
}

{
  /* The bag must never ask for something the store can refuse: a refused
   * field there would mean nothing could be bought. */
  const { S, f } = fresh((op) => (op === 'PtCartCreate' ? { cartCreate: { cart: CART, userErrors: [] } } : {}));
  later(S.cartAdd('gid://shopify/ProductVariant/11', 1).then(() => {
    ok('the bag asks for no stock counts', !/quantityAvailable/.test(f.calls[0].query));
    ok('the bag asks for no tags', !/\btags\b/.test(f.calls[0].query));
  }));
}

{
  const { S } = fresh(() => ({ status: 500 }));
  later(S.recommendations('gid://x/1').then((r) => {
    eq('related products failing leaves the page alone', r, []);
  }));
}

/* =================================================================== SEARCH */

section('search');
{
  const { S } = fresh((op) => {
    if (op === 'PtSuggest') return { predictiveSearch: { products: [TILE], collections: [{ handle: 'dog-food', title: 'Dog Food' }] } };
    return { search: { totalCount: 41, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [TILE] } };
  });
  later(S.suggest('dog').then((r) => {
    eq('suggestions carry products', r.products.length, 1);
    eq('suggestions carry aisles', r.collections[0].handle, 'dog-food');
    return S.suggest('d');
  }).then((r) => {
    eq('one letter is not searched', r.products.length, 0);
    return S.searchAll('dog food');
  }).then((page) => {
    eq('the full count comes from the store', page.total, 41);
    eq('results are mapped as tiles', page.products[0].handle, 'rc-medium-adult');
    eq('there is another page', page.hasMore, true);
  }));
}

{
  /* A store with search switched off still has a catalogue. */
  const { S, f } = fresh((op) => {
    if (op === 'PtSearch') return { errors: [{ message: 'search is not available' }] };
    return { products: { pageInfo: {}, nodes: [TILE] } };
  });
  later(S.searchAll('royal canin').then((page) => {
    eq('search falling over falls back to a product query', page.products.length, 1);
    eq('the fallback is the second call', f.calls[1].op, 'PtProducts');
  }));
}

section('live collections');
{
  const { S, f } = fresh((op, v) => {
    if (op !== 'PtCollections') return {};
    if (!v.after) return { collections: {
      pageInfo: { hasNextPage: true, endCursor: 'p2' },
      nodes: [
        { id: 'c1', handle: 'dog-food', title: 'Dog Food', image: { url: 'https://cdn.shopify.com/x/d.jpg' }, products: { nodes: [{ id: 'p' }] } },
        { id: 'c2', handle: 'retired', title: 'Retired', image: null, products: { nodes: [] } }
      ] } };
    return { collections: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ id: 'c3', handle: 'cat-food', title: 'Cat Food', image: null, products: { nodes: [{ id: 'q' }] } }] } };
  });
  later(S.collections().then((cols) => {
    eq('every page of collections is read', cols.map((c) => c.handle), ['dog-food', 'retired', 'cat-food']);
    eq('a collection with products says so', cols[0].hasProducts, true);
    eq('an empty collection says so, so menus can leave it out', cols[1].hasProducts, false);
    eq('the store picture comes with it', cols[0].image, 'https://cdn.shopify.com/x/d.jpg');
    eq('it took one call per page', f.calls.length, 2);
  }));
}

section('shop all');
{
  const { S, f } = fresh(() => ({ products: { pageInfo: { hasNextPage: true, endCursor: 'n1' }, nodes: [TILE] } }));
  later(S.allProducts({ sort: 'newest' }).then((page) => {
    eq('the whole catalogue is one query, with no filter', f.calls[0].op, 'PtAll');
    ok('it asks for no search term at all', !('q' in f.calls[0].variables));
    eq('new in sorts by creation, newest first', [f.calls[0].variables.sortKey, f.calls[0].variables.reverse], ['CREATED_AT', true]);
    eq('it pages', [page.hasMore, page.cursor], [true, 'n1']);
    return S.allProducts({ after: 'n1' });
  }).then(() => {
    eq('the next page carries the cursor', f.calls[1].variables.after, 'n1');
  }));
}

section('search that always finds what exists');
{
  const { S } = fresh();
  eq('each word becomes a prefix', S.prefixQuery('Royal Canin'), 'royal* canin*');
  eq('half a brand still finds it', S.prefixQuery('drool'), 'drool*');
  eq('query syntax is taken out, not passed through', S.prefixQuery('a:b (c) "d"'), 'a* b* c* d*');
  eq('nothing to search is nothing', S.prefixQuery('   '), '');
}
{
  /* The store predicts nothing: the catalogue still answers. */
  const { S, f } = fresh((op) => {
    if (op === 'PtSuggest') return { predictiveSearch: { products: [], collections: [{ handle: 'dog-food', title: 'Dog Food' }] } };
    if (op === 'PtProducts') return { products: { pageInfo: {}, nodes: [TILE] } };
    return {};
  });
  later(S.suggest('drool').then((r) => {
    eq('an empty prediction falls back to a catalogue match', r.source, 'catalogue');
    eq('which finds the product', r.products.length, 1);
    eq('the prefix query is what was asked', f.calls[1].variables.q, 'drool*');
    eq('the store collections are kept alongside', r.collections[0].handle, 'dog-food');
  }));
}
{
  const { S } = fresh((op) => {
    if (op === 'PtSuggest') return { errors: [{ message: 'predictive search is not enabled' }] };
    if (op === 'PtProducts') return { products: { pageInfo: {}, nodes: [TILE] } };
    return {};
  });
  later(S.suggest('royal').then((r) => {
    eq('a store without prediction still suggests', r.products.length, 1);
  }));
}
{
  /* Store search finds nothing for a brand that is in the catalogue. */
  const { S, f } = fresh((op) => {
    if (op === 'PtSearch') return { search: { totalCount: 0, pageInfo: {}, nodes: [] } };
    if (op === 'PtProducts') return { products: { pageInfo: { hasNextPage: true, endCursor: 'k1' }, nodes: [TILE] } };
    return {};
  });
  later(S.searchAll('drools').then((page) => {
    eq('zero from the store search falls back to the catalogue', page.products.length, 1);
    eq('the page says which list answered', page.mode, 'catalogue');
    eq('an unknown total is not invented', page.total, null);
    return S.searchAll('drools', { after: page.cursor, mode: page.mode });
  }).then(() => {
    eq('show more keeps paging the same list', f.calls[f.calls.length - 1].op, 'PtProducts');
    eq('with the cursor that list gave', f.calls[f.calls.length - 1].variables.after, 'k1');
  }));
}
{
  const { S, f } = fresh(() => ({ search: { totalCount: 5, pageInfo: {}, nodes: [TILE] } }));
  later(S.searchAll('dog', { sort: 'priceHigh' }).then((page) => {
    eq('a store search keeps its own count', page.total, 5);
    eq('price high to low reaches the search sort', [f.calls[0].variables.sortKey, f.calls[0].variables.reverse], ['PRICE', true]);
    eq('the page says the store search answered', page.mode, 'search');
  }));
}

/* ====================================================================== BAG */

section('the bag');
{
  const { S, f } = fresh((op) => {
    if (op === 'PtCartCreate') return { cartCreate: { cart: CART, userErrors: [] } };
    return {};
  });
  later(S.cartAdd('gid://shopify/ProductVariant/11', 2).then((cart) => {
    eq('the first add opens a cart at the store', f.calls[0].op, 'PtCartCreate');
    eq('the variant goes up as a merchandise id', f.calls[0].variables.input.lines[0].merchandiseId, 'gid://shopify/ProductVariant/11');
    eq('the quantity goes with it', f.calls[0].variables.input.lines[0].quantity, 2);
    eq('the bag knows its count', cart.count, 2);
    eq('the subtotal comes from the store', cart.subtotalPaise, 690000);
    eq('the checkout link is the store own', cart.checkoutUrl, 'https://pawsandtails24.com/cart/c/abc123');
    eq('the line carries the product handle for linking back', cart.lines[0].handle, 'rc-medium-adult');
    eq('the line total comes from the store, not multiplication here', cart.lines[0].linePaise, 690000);
    eq('the cart id is kept for the next visit', S.cartId(), 'gid://shopify/Cart/abc123');
  }));
}

{
  const { S, f } = fresh((op) => {
    if (op === 'PtCartCreate') return { cartCreate: { cart: CART, userErrors: [] } };
    if (op === 'PtCartAdd') return { cartLinesAdd: { cart: CART, userErrors: [] } };
    return {};
  });
  later(S.cartAdd('gid://shopify/ProductVariant/11', 1)
    .then(() => S.cartAdd('gid://shopify/ProductVariant/12', 1))
    .then(() => {
      eq('a second add goes to the cart that exists', f.calls[1].op, 'PtCartAdd');
      eq('it names the cart', f.calls[1].variables.id, 'gid://shopify/Cart/abc123');
    }));
}

{
  /* A cart paid or expired is not an error the shopper should ever read. */
  const { S, f } = fresh((op) => {
    if (op === 'PtCartAdd') return { cartLinesAdd: { cart: null, userErrors: [] } };
    if (op === 'PtCartCreate') return { cartCreate: { cart: CART, userErrors: [] } };
    return {};
  }, { storage: (function () { const s = memStorage(); s.setItem('pt_cart_id', 'gid://shopify/Cart/old'); return s; }()) });
  later(S.cartAdd('gid://shopify/ProductVariant/11', 1).then((cart) => {
    eq('a bag the store has forgotten is quietly reopened', f.calls.map((c) => c.op), ['PtCartAdd', 'PtCartCreate']);
    eq('the shopper ends up with a working bag', cart.count, 2);
    eq('the new cart id replaces the dead one', S.cartId(), 'gid://shopify/Cart/abc123');
  }));
}

{
  const { S } = fresh((op) => {
    if (op === 'PtCartAdd') return { cartLinesAdd: { cart: null, userErrors: [{ message: 'Only 2 of that are available' }] } };
    return {};
  }, { storage: (function () { const s = memStorage(); s.setItem('pt_cart_id', 'gid://shopify/Cart/abc'); return s; }()) });
  later(S.cartAdd('gid://shopify/ProductVariant/11', 9).then(
    () => { failures.push('a stock refusal must reach the shopper'); },
    (e) => eq('a stock refusal is shown in the store own words', e.message, 'Only 2 of that are available')
  ));
}

{
  const { S, f } = fresh((op) => {
    if (op === 'PtCartUpdate') return { cartLinesUpdate: { cart: CART, userErrors: [] } };
    if (op === 'PtCartRemove') return { cartLinesRemove: { cart: Object.assign({}, CART, { totalQuantity: 0, lines: { nodes: [] } }), userErrors: [] } };
    return {};
  }, { storage: (function () { const s = memStorage(); s.setItem('pt_cart_id', 'gid://shopify/Cart/abc'); return s; }()) });
  later(S.cartSetQty('gid://shopify/CartLine/1', 3).then((cart) => {
    eq('a quantity change is sent to the store', f.calls[0].variables.lines[0], { id: 'gid://shopify/CartLine/1', quantity: 3 });
    eq('the answer is the bag', cart.count, 2);
    return S.cartSetQty('gid://shopify/CartLine/1', 0);
  }).then((cart) => {
    eq('a quantity of zero removes the line instead', f.calls[1].op, 'PtCartRemove');
    eq('the emptied bag has no lines', cart.lines.length, 0);
  }));
}

{
  const { S } = fresh((op) => (op === 'PtCart' ? { cart: null } : {}),
    { storage: (function () { const s = memStorage(); s.setItem('pt_cart_id', 'gid://shopify/Cart/gone'); return s; }()) });
  later(S.cartGet().then((cart) => {
    eq('a bag the store no longer knows reads as no bag', cart, null);
    eq('and its id is forgotten', S.cartId(), null);
  }));
}

{
  const { S, f } = fresh();
  later(S.cartGet().then((cart) => {
    eq('with no stored bag nothing is asked of the store', f.calls.length, 0);
    eq('and there is no bag', cart, null);
  }));
}

/* ==================================================================== SAVED */

section('saved items');
{
  const { S } = fresh();
  eq('nothing is saved to begin with', S.saved(), []);
  eq('the heart saves', S.toggleSaved('a'), true);
  S.toggleSaved('b');
  eq('the newest saved item comes first', S.saved(), ['b', 'a']);
  eq('the heart unsaves', S.toggleSaved('a'), false);
  eq('and it is gone', S.saved(), ['b']);
  ok('saved is recognised', S.isSaved('b') === true && S.isSaved('a') === false);
}
{
  /* A device that refuses storage must not break the shop. */
  const thrower = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); }
  };
  const { S } = fresh(undefined, { storage: thrower });
  eq('blocked storage reads as nothing saved', S.saved(), []);
  ok('blocked storage does not throw on save', (function () { try { S.toggleSaved('a'); return true; } catch (e) { return false; } }()));
  eq('blocked storage means no cart id', S.cartId(), null);
}

/* ================================================================== IMAGES */

section('images');
{
  const { S } = fresh();
  eq('a store image is asked for at the size drawn', S.sized('https://cdn.shopify.com/x/a.jpg', 460), 'https://cdn.shopify.com/x/a.jpg?width=460');
  eq('an existing query is replaced, not appended to', S.sized('https://cdn.shopify.com/x/a.jpg?width=99&v=2', 200), 'https://cdn.shopify.com/x/a.jpg?width=200');
  eq('a picture from anywhere else is left alone', S.sized('https://example.com/a.jpg', 200), 'https://example.com/a.jpg');
  eq('no picture stays no picture', S.sized(null, 200), null);
  eq('a store link is absolute', S.shopUrl('/account'), 'https://pawsandtails24.com/account');
}

/* =============================================================== CATALOGUE */

section('store facts');
{
  const C = require(path.join(ROOT, 'assets', 'catalogue.js'));
  ok('there is no shelf list: collections come from the store', C.shelves === undefined);
  ok('there are no lanes or home rails picked by hand', C.lanes === undefined && C.homeRails === undefined);
  const text = fs.readFileSync(path.join(ROOT, 'assets', 'catalogue.js'), 'utf8');
  ok('no collection handle is written into the shop', !/"handle"\s*:/.test(text));
  ok('the API version is dated', /^\d{4}-\d{2}$/.test(C.apiVersion));
  ok('the store domain is set', C.domain === 'pawsandtails24.com');
  ok('support details are present', !!(C.support.email && C.support.phone && C.support.whatsapp));
  ok('policy paths are present', !!(C.policies.refund && C.policies.shipping && C.policies.account));
  ok('the system home collection is kept out of menus', C.hidden.indexOf('frontpage') >= 0);
}

/* ============================================================ HOUSE RULES */

section('house rules');
{
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
      if (d.name === 'node_modules' || d.name.startsWith('.')) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { walk(full); return; }
      if (/\.(js|css|html|md|json|sh)$/.test(d.name)) files.push(full);
    });
  }(ROOT));

  /* Built from escape text on purpose: written as a literal the pattern
   * would itself be a long dash in a shipped file and fail its own check. */
  const LONG_DASH = new RegExp('[' + ['2010','2011','2012','2013','2014','2015','2212']
    .map(function (h) { return String.fromCharCode(parseInt(h, 16)); }).join('') + ']');
  let dashes = [];
  files.forEach((f) => {
    const text = fs.readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (LONG_DASH.test(line)) dashes.push(path.relative(ROOT, f) + ':' + (i + 1));
    });
  });
  eq('no em dashes, en dashes or figure dashes anywhere' + (dashes.length ? ' (' + dashes.slice(0, 6).join(', ') + ')' : ''), dashes.length, 0);
  ok('every shipped file was checked', files.length >= 6);

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('the page loads the catalogue, the client and the app', /catalogue\.js/.test(html) && /storefront\.js/.test(html) && /app\.js/.test(html));
  ok('the page carries no product data of its own', !/priceRange|₹[0-9]/.test(html));

  const appjs = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
  ok('the interface holds no hardcoded prices', !/\bpaise:\s*\d{3,}/.test(appjs));
  ok('checkout leaves for the cart checkout url', /checkoutUrl/.test(appjs));
}

/* ====================================================================== RUN */

Promise.all(pending).then(() => {
  process.stdout.write('\n');
  if (failures.length) {
    failures.forEach((f) => process.stdout.write('  FAILED  ' + f + '\n'));
    process.stdout.write('\n  storefront: ' + passed + ' passed, ' + failures.length + ' failed.\n\n');
    process.exit(1);
  }
  process.stdout.write('  storefront: ' + passed + ' passed, 0 failed.\n\n');
}).catch((e) => {
  process.stdout.write('\n  the suite itself broke: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
