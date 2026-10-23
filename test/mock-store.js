#!/usr/bin/env node
/* ============================================================================
 * A stand-in for the store, for tests and for looking at the site offline
 * ============================================================================
 * Answers the same Storefront API operations the real store answers, with
 * invented products, and serves the site next to them so the browser sees one
 * origin. The cart is real state: adding, changing and removing behave as
 * Shopify behaves, including refusing more than is in stock.
 *
 *   node test/mock-store.js --port 4199
 *
 * Nothing here ever reaches pawsandtails24.com, and no order can be placed:
 * its checkoutUrl is a dead local address on purpose.
 * ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const STRICT_OFF = process.argv.indexOf('--permissive') >= 0;
const PORT = Number((args.indexOf('--port') >= 0 && args[args.indexOf('--port') + 1]) || 4199);

const C = require(path.join(ROOT, 'assets', 'catalogue.js'));

/* The port actually listened on, so a cart checkout link points at this
 * server even when a test picks its own port. */
let activePort = PORT;

/* ------------------------------------------------------------- the pretend stock */

const BRANDS = C.brands;
/* Invented collections. The shop reads these through the same query it uses
 * on the live store, so the menus are built from the API, not from a list.
 * "frontpage" is a system collection the shop must hide, and "retired" has no
 * products, which the shop must leave out of its menus. */
const FIXTURE = [
  { name: 'Pharmacy', aisles: [['All Medicines', 'pharmacy'], ['Deworming', 'deworming'], ['Flea & Tick', 'ticks-fleas'], ['Antibiotics', 'antibiotic']] },
  { name: 'Vaccines', aisles: [['All Vaccines', 'vaccine-immunoglobulin'], ['Puppy Vaccines', 'puppy-vaccine']] },
  { name: 'Supplements', aisles: [['Multivitamins', 'multivitamin-supplement'], ['Joint Support', 'joint-support']] },
  { name: 'Dog Food', aisles: [['Dog Food', 'dog-food'], ['Puppy Food', 'best-puppy-food'], ['Royal Canin Dog', 'royal-canin-dog-food']] },
  { name: 'Cat Food', aisles: [['Cat Food', 'best-cat-food'], ['Kitten Milk', 'kitten-milk']] },
  { name: 'Treats', aisles: [['Dog Treats', 'dog-treats'], ['Cat Treats', 'cat-treats']] },
  { name: 'Grooming', aisles: [['Grooming', 'grooming'], ['Dog Shampoo', 'dog-shampoo']] },
  { name: 'Toys & Gear', aisles: [['Dog Toys', 'dog-toys'], ['Cat Litter', 'cat-litter'], ['Bowls', 'feeding-bowl']] },
  { name: 'Small Pets', aisles: [['Birds', 'bird'], ['Rabbits', 'rabbit']] },
  { name: 'Home', aisles: [['Home page', 'frontpage']] }
];
const EMPTY_COLLECTIONS = [{ handle: 'retired', title: 'Retired range' }];

const products = [];
FIXTURE.forEach((shelf, si) => {
  shelf.aisles.map((a) => ({ label: a[0], handle: a[1] })).forEach((aisle, ai) => {
    const n = 3 + ((si + ai) % 3);
    for (let k = 0; k < n; k++) {
      const idx = products.length + 1;
      /* As in the live store: every product is listed under the store's own
       * name, and the brand is only in the title. */
      const brand = aisle.handle === 'royal-canin-dog-food' ? 'Royal Canin' : BRANDS[idx % BRANDS.length];
      const label = aisle.label.replace(/^Royal Canin /, '');
      /* Deworming is priced as it is in real shops, a few hundred rupees, so
       * "best deworming under 500" has real answers to find. */
      const base = aisle.handle === 'deworming' ? 140 + k * 110 : 180 + ((idx * 137) % 9000);
      const soldOut = idx % 17 === 0;
      const onOffer = idx % 3 === 0;
      const sizes = idx % 4 === 0 ? ['250 g'] : ['250 g', '1 kg', '4 kg'];
      products.push({
        id: 'gid://shopify/Product/' + idx,
        handle: aisle.handle + '-item-' + (k + 1),
        title: brand + ' ' + label + ' ' + (k === 0 ? 'everyday' : k === 1 ? 'premium' : 'value') + ' pack',
        vendor: 'Paws & Tails\u2122',
        brand: brand,
        productType: shelf.name,
        availableForSale: !soldOut,
        tags: ['Veg'],
        /* Store-written text links to the store's own domains, as real
         * descriptions do; the site must turn those into its own pages. */
        descriptionHtml: '<p>See also <a href="https://sg37v1-ta.myshopify.com/products/' + aisle.handle + '-item-1">the everyday pack</a>, ' +
          '<a href="https://pawsandtails24.com/collections/' + aisle.handle + '">the whole range</a> and ' +
          '<a href="https://sg37v1-ta.myshopify.com/cart">your cart</a>.</p>' +
          '<p>Invented copy for the mock store. ' + aisle.label +
          ' from ' + brand + '.</p><ul><li>Not a real product</li><li>Prices are made up</li></ul>',
        aisles: [aisle.handle],
        variants: sizes.map((size, vi) => ({
          id: 'gid://shopify/ProductVariant/' + idx + '0' + vi,
          title: sizes.length === 1 ? 'Default Title' : size,
          availableForSale: !soldOut && !(idx % 11 === 0 && vi === sizes.length - 1),
          quantityAvailable: soldOut ? 0 : (idx % 7 === 0 ? 3 : 25),
          currentlyNotInStock: false,
          price: { amount: (base * (vi + 1)).toFixed(2), currencyCode: 'INR' },
          compareAtPrice: onOffer ? { amount: (base * (vi + 1) * 1.18).toFixed(2) } : null,
          image: null,
          selectedOptions: [{ name: sizes.length === 1 ? 'Title' : 'Size', value: size }]
        }))
      });
    }
  });
});

/* Product photos as stores really have them: some with a wide white margin,
 * some cropped tight, tall and wide pictures, a cut-out on transparency and
 * an edge-to-edge photograph. Served at /mock-img/<kind>-<n>.svg. The shop has
 * to show every product at the same size whatever the picture looks like. */
const SHOT_KINDS = ['tiny', 'huge', 'tall', 'cutout', 'corner', 'photo'];
function shotUrl(idx, k) { return '/mock-img/' + SHOT_KINDS[(idx + k) % SHOT_KINDS.length] + '-' + idx + '.svg'; }
function shotSvg(kind, n) {
  const hue = (n * 47) % 360;
  const fill = 'hsl(' + hue + ',55%,48%)';
  const dark = 'hsl(' + hue + ',55%,30%)';
  /* [canvas width, height, product box x, y, w, h, background] */
  const spec = {
    tiny:   [800, 800, 320, 300, 160, 200, '#ffffff'],
    huge:   [800, 800, 32, 20, 736, 760, '#ffffff'],
    tall:   [600, 900, 200, 180, 200, 540, '#ffffff'],
    cutout: [1000, 600, 150, 90, 700, 420, 'none'],
    corner: [800, 800, 40, 60, 260, 300, '#ffffff'],
    photo:  [900, 900, 0, 0, 900, 900, 'hsl(' + hue + ',30%,82%)']
  }[kind] || [800, 800, 200, 200, 400, 400, '#ffffff'];
  const [W, H, x, y, w, h, bg] = spec;
  const body = kind === 'photo'
    ? '<defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="' + bg + '"/>' +
      '<stop offset="1" stop-color="hsl(' + hue + ',40%,35%)"/></linearGradient></defs>' +
      '<rect width="' + W + '" height="' + H + '" fill="url(#g)"/><circle cx="450" cy="470" r="260" fill="' + fill + '"/>'
    : (bg === 'none' ? '' : '<rect width="' + W + '" height="' + H + '" fill="' + bg + '"/>') +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + Math.round(Math.min(w, h) / 10) + '" fill="' + fill + '"/>' +
      '<rect x="' + (x + w * 0.15) + '" y="' + (y + h * 0.35) + '" width="' + (w * 0.7) + '" height="' + (h * 0.3) + '" fill="' + dark + '"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + body + '</svg>';
}
function idxOf(p) { return Number(String(p.id).split('/').pop()); }

function tile(p) {
  const prices = p.variants.map((v) => Number(v.price.amount));
  const was = p.variants.map((v) => (v.compareAtPrice ? Number(v.compareAtPrice.amount) : 0));
  return {
    id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, productType: p.productType,
    availableForSale: p.availableForSale,
    featuredImage: { url: shotUrl(idxOf(p), 0) },
    priceRange: {
      minVariantPrice: { amount: Math.min.apply(null, prices).toFixed(2), currencyCode: 'INR' },
      maxVariantPrice: { amount: Math.max.apply(null, prices).toFixed(2) }
    },
    compareAtPriceRange: { maxVariantPrice: { amount: Math.max.apply(null, was).toFixed(2) } },
    variants: { nodes: p.variants.slice(0, 2).map((v) => ({ id: v.id, availableForSale: v.availableForSale })) }
  };
}

function full(p) {
  return {
    id: p.id, handle: p.handle, title: p.title, vendor: p.vendor, productType: p.productType,
    descriptionHtml: p.descriptionHtml, availableForSale: p.availableForSale, tags: p.tags,
    featuredImage: { url: shotUrl(idxOf(p), 0) },
    images: { nodes: [0, 1, 2].map((k) => ({ url: shotUrl(idxOf(p), k) })) },
    options: [{ name: p.variants.length > 1 ? 'Size' : 'Title', values: p.variants.map((v) => v.title) }],
    variants: { nodes: p.variants }
  };
}

function byHandle(handle) {
  for (const p of products) if (p.handle === handle) return p;
  return null;
}
function variantById(id) {
  for (const p of products) for (const v of p.variants) if (v.id === id) return { product: p, variant: v };
  return null;
}
/* Brand collections, as the live store has them ("Acana", "Acana Dog Food"),
 * filled from the products above. */
const BRAND_COLLECTIONS = [{ handle: 'acana', title: 'Acana' }, { handle: 'acana-dog-food', title: 'Acana Dog Food' }];
products.forEach((p) => {
  if (p.brand !== 'Acana') return;
  p.aisles.push('acana');
  if (/food/i.test(p.title)) p.aisles.push('acana-dog-food');
});

/* How strict the pretend store is about field queries. The live store may
 * answer vendor: and title: queries with nothing; the shop must still find
 * brands. Tests switch this on to prove it. */
const strict = { fieldQueries: false };

function inAisle(handle) { return products.filter((p) => p.aisles.indexOf(handle) >= 0); }

function allCollections() {
  const out = [];
  FIXTURE.forEach((s) => s.aisles.forEach((a) => out.push({ handle: a[1], title: a[0] })));
  BRAND_COLLECTIONS.forEach((c) => out.push(c));
  EMPTY_COLLECTIONS.forEach((c) => out.push(c));
  return out;
}

/* Shopify's products query: words must all match, "word*" is a prefix. */
function matches(p, term) {
  const hay = (p.title + ' ' + p.vendor + ' ' + p.productType).toLowerCase();
  const words = String(term || '').toLowerCase().replace(/\*/g, '').split(/\s+/).filter(Boolean);
  return words.every((w) => hay.indexOf(w) >= 0);
}

/* Enough of Shopify's query grammar for what the shop sends:
 *   vendor:'X' OR (title:w1* AND title:w2*)   and plain prefix words. */
function queryMatches(p, q) {
  return String(q).split(/\s+OR\s+/i).some((clause) => {
    const terms = clause.replace(/[()]/g, ' ').split(/\s+AND\s+|\s+/i).filter((x) => x && !/^and$/i.test(x));
    let vendor = null;
    const vm = clause.match(/vendor:'((?:[^'\\]|\\.)*)'/);
    if (vm) vendor = vm[1].replace(/\\'/g, "'");
    if (vendor !== null) return p.vendor.toLowerCase() === vendor.toLowerCase();
    return terms.every((t) => {
      const f = t.match(/^title:(.+)$/i);
      if (f) {
        const w = f[1].toLowerCase().replace(/\*$/, '');
        return p.title.toLowerCase().split(/[^a-z0-9-]+/).some((x) => x.indexOf(w) === 0);
      }
      return matches(p, t);
    });
  });
}

/* -------------------------------------------------------------------- carts */

const carts = new Map();
let cartSeq = 0;

function cartJson(cart) {
  let subtotal = 0;
  const nodes = cart.lines.map((l) => {
    const hit = variantById(l.variantId);
    const unit = Number(hit.variant.price.amount);
    subtotal += unit * l.qty;
    return {
      id: l.id, quantity: l.qty,
      cost: { totalAmount: { amount: (unit * l.qty).toFixed(2) } },
      merchandise: {
        id: hit.variant.id, title: hit.variant.title,
        availableForSale: hit.variant.availableForSale,
        quantityAvailable: hit.variant.quantityAvailable,
        price: hit.variant.price, compareAtPrice: hit.variant.compareAtPrice,
        image: null,
        product: { handle: hit.product.handle, title: hit.product.title, vendor: hit.product.vendor, featuredImage: { url: shotUrl(idxOf(hit.product), 0) } }
      }
    };
  });
  return {
    id: cart.id,
    checkoutUrl: 'http://localhost:' + activePort + '/mock-checkout/' + cart.id.split('/').pop(),
    totalQuantity: cart.lines.reduce((s, l) => s + l.qty, 0),
    cost: { subtotalAmount: { amount: subtotal.toFixed(2), currencyCode: 'INR' }, totalAmount: { amount: subtotal.toFixed(2) } },
    lines: { nodes: nodes }
  };
}

function addLines(cart, lines) {
  for (const line of lines) {
    const hit = variantById(line.merchandiseId);
    if (!hit) return 'That product is no longer available.';
    if (!hit.variant.availableForSale) return 'That size is sold out.';
    if (line.quantity > hit.variant.quantityAvailable) {
      return 'Only ' + hit.variant.quantityAvailable + ' of that are available.';
    }
    const existing = cart.lines.find((l) => l.variantId === line.merchandiseId);
    if (existing) existing.qty += line.quantity;
    else cart.lines.push({ id: 'gid://shopify/CartLine/' + (++cartSeq), variantId: line.merchandiseId, qty: line.quantity });
  }
  return null;
}

/* ----------------------------------------------------------------- resolver */

/* The store's own policy pages, as a shop might word them. The assistant and
 * the track page read delivery times and charges from this text. */
const POLICY = {
  shipping: '<h2>Shipping</h2><p>Orders placed before 2 pm are dispatched within 1-2 working days.</p>' +
    '<p>Delivery takes 3-5 working days to metro cities and 5-8 working days to the rest of India.</p>' +
    '<p>Shipping is free on orders above &#8377;999; below that a flat &#8377;79 applies.</p>' +
    '<p>Cash on delivery is available on orders up to &#8377;5,000.</p>',
  refund: '<p>Unopened products can be returned within 7 days of delivery.</p>' +
    '<p>Medicines and opened food cannot be returned for safety reasons.</p>' +
    '<p>Refunds reach your original payment method within 5-7 working days after we receive the item.</p>'
};

function resolve(op, v, query) {
  if (op === 'PtPolicies') {
    return {
      shop: { shippingPolicy: null, refundPolicy: { body: POLICY.refund, url: 'https://pawsandtails24.com/policies/refund-policy' } },
      ship: v.ship === 'shipping' ? { body: POLICY.shipping } : null,
      refund: null
    };
  }

  if (op === 'PtCheckShop') return { shop: { name: 'Paws and Tails (mock)' } };

  if (op === 'PtCheckCols') {
    return { collections: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: allCollections().map((c) => ({
        handle: c.handle, title: c.title,
        products: { nodes: inAisle(c.handle).slice(0, 1).map((p) => ({ id: p.id })) }
      }))
    } };
  }

  if (op === 'PtCheckAll') {
    return { products: { pageInfo: { hasNextPage: products.length > 24 },
      nodes: products.slice(0, 24).map((p) => ({ handle: p.handle, availableForSale: p.availableForSale })) } };
  }

  if (op === 'PtCheckSearch') {
    return { search: { totalCount: products.filter((p) => p.title.toLowerCase().indexOf('dog') >= 0).length } };
  }

  if (op === 'PtCheckPrefix') {
    return { products: { nodes: products.filter((p) => matches(p, 'dog*')).slice(0, 3).map((p) => ({ handle: p.handle })) } };
  }

  if (op === 'PtCheckSuggest') {
    return { predictiveSearch: { products: products.filter((p) => p.title.toLowerCase().indexOf('dog') >= 0)
      .slice(0, 3).map((p) => ({ handle: p.handle })) } };
  }

  if (op === 'PtCheckPick') {
    return { products: { nodes: [{ handle: products[0].handle }] } };
  }

  if (op === 'PtCheckProduct') {
    const p = byHandle(v.h);
    return { product: p ? { title: p.title, variants: { nodes: p.variants.slice(0, 5) } } : null };
  }

  if (op === 'PtCollections') {
    const cols = allCollections();
    const start = v.after ? Number(v.after) : 0;
    const slice = cols.slice(start, start + 100);
    return { collections: {
      pageInfo: { hasNextPage: start + 100 < cols.length, endCursor: String(start + 100) },
      nodes: slice.map((c, i) => ({
        id: 'gid://shopify/Collection/' + (start + i + 1), handle: c.handle, title: c.title, image: null,
        products: { nodes: inAisle(c.handle).slice(0, 1).map((p) => ({ id: p.id })) }
      }))
    } };
  }

  if (op === 'PtAll') {
    let list = products.slice();
    if (v.sortKey === 'PRICE') list.sort((a, b) => Number(a.variants[0].price.amount) - Number(b.variants[0].price.amount));
    if (v.sortKey === 'CREATED_AT') list.reverse();
    if (v.reverse && v.sortKey === 'PRICE') list.reverse();
    const start = v.after ? Number(v.after) : 0;
    return { products: {
      pageInfo: { hasNextPage: start + 24 < list.length, endCursor: String(start + 24) },
      nodes: list.slice(start, start + 24).map(tile)
    } };
  }

  if (op === 'PtPing') return { shop: { name: 'Paws and Tails (mock)', primaryDomain: { host: 'localhost' } } };

  if (op === 'PtCollection') {
    const list = inAisle(v.handle);
    if (!list.length && !allCollections().some((c) => c.handle === v.handle)) return { collection: null };
    const start = v.after ? Number(v.after) : 0;
    const slice = list.slice(start, start + 24);
    const label = (allCollections().find((c) => c.handle === v.handle) || { title: v.handle }).title;
    return { collection: {
      title: label, description: 'Mock aisle: ' + label,
      products: {
        pageInfo: { hasNextPage: start + 24 < list.length, endCursor: String(start + 24) },
        nodes: slice.map(tile)
      }
    } };
  }

  if (op === 'PtProducts') {
    const term = String(v.q || '').toLowerCase();
    const handles = String(v.q || '').match(/handle:"[^"]+"/g);
    let list;
    if (handles) {
      /* Shopify answers handle:"a" OR handle:"b" from the products query,
       * which is how the saved list is read back. */
      const wanted = handles.map((h) => h.slice(8, -1));
      list = products.filter((p) => wanted.indexOf(p.handle) >= 0);
    } else if (strict.fieldQueries && /\b(vendor|title):/i.test(term)) {
      list = [];
    } else {
      list = products.filter((p) => queryMatches(p, term));
    }
    const start = v.after ? Number(v.after) : 0;
    return { products: {
      pageInfo: { hasNextPage: start + 24 < list.length, endCursor: String(start + 24) },
      nodes: list.slice(start, start + 24).map(tile)
    } };
  }

  if (op === 'PtProduct') {
    const p = byHandle(v.handle);
    return { product: p ? full(p) : null };
  }

  if (op === 'PtRecommend') {
    return { productRecommendations: products.slice(4, 10).map(tile) };
  }

  if (op === 'PtSuggest') {
    const term = String(v.q || '').toLowerCase();
    return { predictiveSearch: {
      products: products.filter((p) => p.title.toLowerCase().indexOf(term) >= 0).slice(0, 8).map(tile),
      collections: allCollections().filter((c) => c.title.toLowerCase().indexOf(term) >= 0).slice(0, 3)
        .map((c) => ({ handle: c.handle, title: c.title }))
    } };
  }

  if (op === 'PtSearch') {
    const term = String(v.q || '').toLowerCase();
    /* The real store search is stricter than the catalogue match on purpose
     * here, so the fallback path is exercised: it only knows whole titles. */
    const list = products.filter((p) => p.title.toLowerCase().indexOf(term) >= 0);
    const start = v.after ? Number(v.after) : 0;
    return { search: {
      totalCount: list.length,
      pageInfo: { hasNextPage: start + 24 < list.length, endCursor: String(start + 24) },
      nodes: list.slice(start, start + 24).map(tile)
    } };
  }

  if (op === 'PtCartCreate') {
    const cart = { id: 'gid://shopify/Cart/mock' + (++cartSeq), lines: [] };
    const err = addLines(cart, (v.input && v.input.lines) || []);
    if (err) return { cartCreate: { cart: null, userErrors: [{ message: err, field: null }] } };
    carts.set(cart.id, cart);
    return { cartCreate: { cart: cartJson(cart), userErrors: [] } };
  }

  if (op === 'PtCartAdd') {
    const cart = carts.get(v.id);
    if (!cart) return { cartLinesAdd: { cart: null, userErrors: [] } };
    const err = addLines(cart, v.lines || []);
    if (err) return { cartLinesAdd: { cart: null, userErrors: [{ message: err, field: null }] } };
    return { cartLinesAdd: { cart: cartJson(cart), userErrors: [] } };
  }

  if (op === 'PtCart') {
    const cart = carts.get(v.id);
    return { cart: cart ? cartJson(cart) : null };
  }

  if (op === 'PtCartUpdate') {
    const cart = carts.get(v.id);
    if (!cart) return { cartLinesUpdate: { cart: null, userErrors: [] } };
    (v.lines || []).forEach((u) => {
      const line = cart.lines.find((l) => l.id === u.id);
      if (line) line.qty = u.quantity;
    });
    return { cartLinesUpdate: { cart: cartJson(cart), userErrors: [] } };
  }

  if (op === 'PtCartRemove') {
    const cart = carts.get(v.id);
    if (!cart) return { cartLinesRemove: { cart: null, userErrors: [] } };
    cart.lines = cart.lines.filter((l) => (v.lineIds || []).indexOf(l.id) < 0);
    return { cartLinesRemove: { cart: cartJson(cart), userErrors: [] } };
  }

  return { errors: [{ message: 'mock store does not know the operation ' + op }] };
}

/* ------------------------------------------------------------------- server */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

/* Order lookups and checkout run the real api/order.js and api/checkout.js
 * against stand-ins for the Admin API and Razorpay, sharing one pretend
 * store, so an order placed here can be tracked straight away. */
const admin = require('./mock-admin.js')({ products: products });
const razorpay = require('./mock-razorpay.js')();
const apiEnv = Object.assign({}, admin.env, razorpay.env);
const apiFetch = (u, i) => (/razorpay\.com/.test(String(u)) ? razorpay.fetch(u, i) : admin.fetch(u, i));
const orderApi = require(path.join(ROOT, 'api', 'order.js')).createHandler({ env: apiEnv, fetchImpl: apiFetch });
const checkoutApi = require(path.join(ROOT, 'api', 'checkout.js')).createHandler({ env: apiEnv, fetchImpl: apiFetch });

/* What Razorpay's popup does, in miniature: a sheet with Pay and Close.
 * Pay asks this server to pay the order and hands the page the same three
 * signed fields the real popup does. */
const FAKE_CHECKOUT_JS = `window.Razorpay = function (o) {
  this.open = function () {
    var d = document.createElement('div');
    d.id = 'mock-razorpay';
    d.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.5);display:grid;place-items:center';
    d.innerHTML = '<div style="background:#fff;padding:24px;border-radius:8px;font:15px system-ui;display:grid;gap:12px;min-width:260px">' +
      '<b>Mock Razorpay</b><span>Pay Rs ' + (o.amount / 100) + ' for ' + o.description + '</span>' +
      '<button id="mrzp-pay">Pay</button><button id="mrzp-close">Close</button></div>';
    document.body.appendChild(d);
    d.querySelector('#mrzp-pay').onclick = function () {
      fetch('/mock-razorpay/pay', { method: 'POST', body: JSON.stringify({ order_id: o.order_id }) })
        .then(function (r) { return r.json(); }).then(function (r) { d.remove(); o.handler(r); });
    };
    d.querySelector('#mrzp-close').onclick = function () { d.remove(); if (o.modal && o.modal.ondismiss) o.modal.ondismiss(); };
  };
  this.on = function () {};
};`;

/* The page as shipped, told to load the stand-in Razorpay popup. */
function homePage() {
  return fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('</head>', '<script>window.PT_RAZORPAY_SCRIPT = "/mock-razorpay/checkout.js";</script>\n</head>');
}

const server = http.createServer((req, res) => {
  const url = String(req.url || '/').split('?')[0];

  if (url === '/api/order') {
    orderApi(req, res);
    return;
  }

  if (url === '/api/checkout') {
    checkoutApi(req, res);
    return;
  }

  if (url === '/mock-razorpay/checkout.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(FAKE_CHECKOUT_JS);
    return;
  }

  if (url === '/mock-razorpay/pay') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(razorpay.pay(b.order_id) || {}));
    });
    return;
  }

  if (url.startsWith('/api/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* ignore */ }
      const m = String(body.query || '').match(/(?:query|mutation)\s+(\w+)/);
      /* Tokenless access, as the live store has it: no stock counts, no tags.
       * Asking for either fails the whole request, exactly as Shopify does. */
      const refused = String(body.query || '').match(/\b(quantityAvailable|tags)\b/);
      if (refused && !STRICT_OFF) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ errors: [{
          message: 'Access denied for ' + refused[1] + ' field. Required access: `unauthenticated_read_product_' +
            (refused[1] === 'tags' ? 'tags' : 'inventory') + '` access scope.',
          extensions: { code: 'ACCESS_DENIED' }
        }] }));
        return;
      }
      const out = resolve(m ? m[1] : '', body.variables || {}, body.query);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out.errors ? out : { data: out }));
    });
    return;
  }

  if (url.startsWith('/mock-img/')) {
    const m = url.match(/^\/mock-img\/([a-z]+)-(\d+)\.svg$/);
    if (!m) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=60' });
    res.end(shotSvg(m[1], Number(m[2])));
    return;
  }

  if (url.startsWith('/mock-checkout/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Mock checkout</title><body style="font-family:system-ui;padding:40px">' +
      '<h1>This is where the real store checkout would open</h1>' +
      '<p>Cart ' + url.split('/').pop() + '. No order is placed by the mock store.</p>');
    return;
  }

  const target = url === '/' ? '/index.html' : url;
  const file = path.join(ROOT, target.replace(/^\/+/, ''));
  if (target === '/index.html' || !file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(homePage());
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

server.on('listening', () => { activePort = server.address().port; });

if (require.main === module) {
  server.listen(PORT, () => {
    process.stdout.write('\n  mock store on http://localhost:' + activePort + '\n' +
      '  ' + products.length + ' invented products across ' + allCollections().length + ' collections\n' +
      '  nothing here touches the live store\n\n');
  });
}

module.exports = { server, products, PORT, admin, razorpay, POLICY, strict };
