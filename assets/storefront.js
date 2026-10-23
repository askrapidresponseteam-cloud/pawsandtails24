/* ============================================================================
 * Paws and Tails storefront client
 * ============================================================================
 * Every product, price, picture and stock state on this site is read from the
 * store's own Shopify Storefront API at request time. Nothing is baked into
 * the page, so a price change in Shopify is the price the next visitor sees.
 *
 * Shoppers never leave this site. The bag is a Shopify cart (cartCreate /
 * cartLinesAdd / cartLinesUpdate / cartLinesRemove), held by the store against
 * live inventory. Checkout is a page here: api/checkout.js prices the bag with
 * the store and places the order in it, and online payment opens Razorpay's
 * popup on this page. This file never sees a card.
 *
 * Transport: same origin. The API is called at /api/<version>/graphql.json,
 * a relative path; vercel.json forwards it to the store on the server side, so
 * the browser only ever talks to this site.
 * For local work, dev/serve.js forwards that path to the live store, which is
 * what makes a laptop look like the same origin. If the store ever asks for a
 * public Storefront token, put it in config.token and it is sent as the
 * X-Shopify-Storefront-Access-Token header.
 *
 * Loadable in a browser (window.PTStorefront) and in node (module.exports),
 * which is how test/test-storefront.js drives it against a fake fetch.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PTStorefront = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TIMEOUT_MS = 15000;
  var CACHE_TTL_MS = 3 * 60 * 1000;
  var PAGE_SIZE = 24;
  var CART_KEY = 'pt_cart_id';
  var SAVED_KEY = 'pt_saved';

  var config = {
    apiBase: '',
    version: '2026-01',
    token: '',
    fetchImpl: null,
    storage: null,
    /* Known brands, and the vendor names that mean "the store itself". The
     * live store lists every product under its own name, so the brand is
     * read from the title instead. */
    brands: [],
    ownVendor: /^paws\s*(&|and)?\s*tails/i
  };

  function configure(opts) {
    opts = opts || {};
    Object.keys(opts).forEach(function (k) {
      if (opts[k] !== undefined && opts[k] !== null) config[k] = opts[k];
    });
    return config;
  }

  function fetcher() {
    if (config.fetchImpl) return config.fetchImpl;
    if (typeof fetch === 'function') return fetch.bind(typeof window !== 'undefined' ? window : null);
    throw new Error('storefront: no fetch available');
  }

  /* localStorage is a convenience, never a requirement: private windows and
   * blocked site data throw on access, and the site must still work. */
  function store() {
    if (config.storage) return config.storage;
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) { /* blocked */ }
    return null;
  }
  function readLocal(key) {
    try { var s = store(); return s ? s.getItem(key) : null; } catch (e) { return null; }
  }
  function writeLocal(key, value) {
    try { var s = store(); if (s) s.setItem(key, value); } catch (e) { /* full or blocked */ }
  }
  function dropLocal(key) {
    try { var s = store(); if (s) s.removeItem(key); } catch (e) { /* blocked */ }
  }

  /* ================================================================= ERRORS */

  function StorefrontError(message, status) {
    var e = new Error(message);
    e.storefront = true;
    if (status) e.status = status;
    return e;
  }

  /* A field outside tokenless reach answers with GraphQL errors rather than a
   * transport failure. Spotting that lets a read retry without the field. */
  function refusedField(errors) {
    return (errors || []).some(function (e) {
      var m = String((e && e.message) || '').toLowerCase();
      return m.indexOf('access denied') >= 0 || m.indexOf('not authorized') >= 0 ||
             m.indexOf('requires') >= 0 || m.indexOf('scope') >= 0;
    });
  }

  /* ============================================================== TRANSPORT */

  var cache = {};
  function cacheGet(key) {
    var hit = cache[key];
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_TTL_MS) { delete cache[key]; return undefined; }
    return hit.value;
  }
  function cacheSet(key, value) { cache[key] = { at: Date.now(), value: value }; }
  function cacheClear() { cache = {}; }

  function apiUrl() {
    return config.apiBase + '/api/' + config.version + '/graphql.json';
  }

  function gql(query, variables, opts) {
    opts = opts || {};
    var key = opts.cacheKey || null;
    if (key && !opts.fresh) {
      var hit = cacheGet(key);
      if (hit !== undefined) return Promise.resolve(hit);
    }

    var headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (config.token) headers['X-Shopify-Storefront-Access-Token'] = config.token;

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);
    var done = false;
    function stop() { if (!done) { done = true; clearTimeout(timer); } }

    return fetcher()(apiUrl(), {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ query: query, variables: variables || {} }),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      stop();
      if (res.status === 401 || res.status === 403) {
        throw StorefrontError('The store refused this request. A public Storefront token is needed in config.token.', res.status);
      }
      if (res.status === 429 || res.status === 430) {
        throw StorefrontError('The store is busy right now. Try again in a moment.', res.status);
      }
      if (res.status === 404) throw StorefrontError('Not found', 404);
      if (res.status !== 200) {
        throw StorefrontError('The store could not load this right now (' + res.status + ').', res.status);
      }
      return res.json().catch(function () {
        throw StorefrontError('The store sent something unexpected. Try again shortly.');
      });
    }).then(function (body) {
      if (!body || typeof body !== 'object') {
        throw StorefrontError('The store sent something unexpected. Try again shortly.');
      }
      if (Array.isArray(body.errors) && body.errors.length) {
        var err = StorefrontError('The store could not load this right now.');
        err.graphQLErrors = body.errors;
        try {
          if (typeof console !== 'undefined' && !config.quiet) {
            console.warn('[storefront] ' + body.errors.map(function (x) { return x && x.message; }).join(' | '));
          }
        } catch (w) { /* no console */ }
        err.fieldRefused = refusedField(body.errors);
        throw err;
      }
      if (key) cacheSet(key, body.data);
      return body.data;
    }).catch(function (e) {
      stop();
      if (e && e.storefront) throw e;
      if (e && e.name === 'AbortError') {
        throw StorefrontError('The store is taking too long to answer. Try again.');
      }
      throw StorefrontError('Could not reach the store. Check your connection and try again.');
    });
  }

  /** Does the API answer at all? Used by the dev server and the tests. */
  function ping() {
    return gql('query PtPing { shop { name primaryDomain { host } } }', {}, { fresh: true })
      .then(function (d) {
        var shop = (d && d.shop) || {};
        return { name: shop.name || '', host: (shop.primaryDomain && shop.primaryDomain.host) || '' };
      });
  }

  /* ================================================================== MONEY */

  /** "3450.00" -> 345000 paise. Parsed as text so paise never cross a float. */
  function paise(amount) {
    if (typeof amount === 'number' && isFinite(amount)) amount = amount.toFixed(2);
    if (typeof amount !== 'string') return null;
    var m = amount.trim().match(/^(\d+)(?:\.(\d{1,2})\d*)?$/);
    if (!m) return null;
    return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
  }

  /** 345000 -> "3,450". Indian grouping: last three, then pairs. */
  function groupIndian(digits) {
    if (digits.length <= 3) return digits;
    var head = digits.slice(0, -3);
    var tail = digits.slice(-3);
    var parts = [];
    while (head.length > 2) { parts.unshift(head.slice(-2)); head = head.slice(0, -2); }
    if (head) parts.unshift(head);
    return parts.join(',') + ',' + tail;
  }

  /** 345000 -> "Rs 3,450"; paise are shown only when they are not zero. */
  function money(p, opts) {
    opts = opts || {};
    if (p === null || p === undefined || !isFinite(p)) return '';
    var sign = p < 0 ? '-' : '';
    p = Math.abs(Math.round(p));
    var whole = groupIndian(String(Math.floor(p / 100)));
    var rem = p % 100;
    var symbol = opts.symbol === undefined ? '₹' : opts.symbol;
    return sign + symbol + whole + (rem ? '.' + String(rem).padStart(2, '0') : '');
  }

  /** Money straight from an API amount string. */
  function moneyOf(amount) {
    var p = paise(amount);
    return p === null ? '' : money(p);
  }

  /* ================================================================= BRANDS */

  function escRx(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** A known brand named in a title, preferring one at the start. */
  function brandInTitle(title) {
    var t = String(title || '');
    var best = null;
    (config.brands || []).forEach(function (b) {
      var m = new RegExp('(^|[^a-z0-9])' + escRx(b) + '(?![a-z0-9])', 'i').exec(t);
      if (!m) return;
      var at = m.index + m[1].length;
      if (!best || at < best.at || (at === best.at && b.length > best.b.length)) best = { b: b, at: at };
    });
    return best ? best.b : '';
  }

  /** The brand to show: the vendor, unless the vendor is the store itself. */
  function brandOf(vendor, title) {
    var v = String(vendor || '').trim();
    if (v && !config.ownVendor.test(v)) return v;
    return brandInTitle(title);
  }

  /* ============================================================== CATALOGUE */

  var TILE_FIELDS =
    ' id handle title vendor productType availableForSale' +
    ' featuredImage { url }' +
    ' priceRange { minVariantPrice { amount currencyCode } maxVariantPrice { amount } }' +
    ' compareAtPriceRange { maxVariantPrice { amount } }' +
    ' variants(first: 2) { nodes { id availableForSale } }';

  var SORTS = {
    featured: { key: 'BEST_SELLING', reverse: false, label: 'Featured' },
    newest: { key: 'CREATED_AT', reverse: true, label: 'New in' },
    priceLow: { key: 'PRICE', reverse: false, label: 'Price, low to high' },
    priceHigh: { key: 'PRICE', reverse: true, label: 'Price, high to low' }
  };
  var COLLECTION_SORTS = {
    featured: { key: 'BEST_SELLING', reverse: false },
    newest: { key: 'CREATED', reverse: true },
    priceLow: { key: 'PRICE', reverse: false },
    priceHigh: { key: 'PRICE', reverse: true }
  };

  /** One listing tile, as the UI wants it. Null for anything unusable. */
  function tileOf(node) {
    if (!node || !node.handle || !node.id) return null;
    var min = node.priceRange && node.priceRange.minVariantPrice;
    var max = node.priceRange && node.priceRange.maxVariantPrice;
    var was = node.compareAtPriceRange && node.compareAtPriceRange.maxVariantPrice;
    var from = paise(min && min.amount);
    var to = paise(max && max.amount);
    var wasP = paise(was && was.amount);
    var ranged = from !== null && to !== null && to > from;
    return {
      id: node.id,
      handle: node.handle,
      title: String(node.title || '').trim(),
      brand: brandOf(node.vendor, node.title),
      type: String(node.productType || '').trim(),
      available: node.availableForSale !== false,
      image: (node.featuredImage && node.featuredImage.url) || null,
      imageAlt: String(node.title || ''),
      paise: from,
      paiseMax: to,
      /* Shopify reports a compareAt of 0 or below the price when nothing is on
       * offer, so a strike-through is only honest when it is above. On a
       * product whose sizes differ in price the two ends do not belong to the
       * same variant (the smallest price against the largest MRP), which would
       * read as a far bigger saving than any size actually carries. A tile
       * like that shows "from" and no saving; the real one is on the product
       * page, where a size has been chosen. */
      wasPaise: !ranged && wasP && from && wasP > from ? wasP : null,
      ranged: ranged,
      /* One size only: it can go straight in the bag from a listing. More
       * than one: the shopper picks the size on the product page. */
      quickVariant: oneVariant(node),
      sizes: node.variants && node.variants.nodes ? node.variants.nodes.length : null
    };
  }

  function oneVariant(node) {
    var vs = node.variants && node.variants.nodes;
    if (!vs || vs.length !== 1 || !vs[0] || !vs[0].id) return null;
    return vs[0].availableForSale === false || node.availableForSale === false ? null : vs[0].id;
  }

  function discountPercent(tile) {
    if (!tile || !tile.wasPaise || !tile.paise) return 0;
    return Math.round(((tile.wasPaise - tile.paise) / tile.wasPaise) * 100);
  }

  function pageOf(conn) {
    var info = (conn && conn.pageInfo) || {};
    return {
      products: ((conn && conn.nodes) || []).map(tileOf).filter(Boolean),
      hasMore: info.hasNextPage === true,
      cursor: info.endCursor || null
    };
  }

  /** One page of an aisle (a Shopify collection handle). */
  function collectionPage(handle, opts) {
    opts = opts || {};
    var sort = COLLECTION_SORTS[opts.sort] || COLLECTION_SORTS.featured;
    var query =
      'query PtCollection($handle: String!, $after: String, $sortKey: ProductCollectionSortKeys, $reverse: Boolean) {' +
      ' collection(handle: $handle) {' +
      '  title description' +
      '  products(first: ' + PAGE_SIZE + ', after: $after, sortKey: $sortKey, reverse: $reverse) {' +
      '   pageInfo { hasNextPage endCursor }' +
      '   nodes {' + TILE_FIELDS + ' }' +
      '  }' +
      ' }' +
      '}';
    var cacheKey = 'col|' + handle + '|' + (opts.sort || 'featured') + '|' + (opts.after || '');
    return gql(query, {
      handle: handle, after: opts.after || null, sortKey: sort.key, reverse: sort.reverse
    }, { cacheKey: cacheKey, fresh: opts.fresh }).then(function (data) {
      var col = data && data.collection;
      if (!col) {
        return { title: '', description: '', products: [], hasMore: false, cursor: null, missing: true };
      }
      var page = pageOf(col.products);
      page.title = String(col.title || '');
      page.description = String(col.description || '');
      page.missing = false;
      return page;
    });
  }

  /** One page of everything a brand lists. The vendor, or the brand at the
   *  start of title words: the live store lists everything under its own
   *  name. If that finds nothing (a store can answer field queries
   *  differently), the store's own search for the brand name takes over, and
   *  the cursor remembers which one is paging. */
  function brandPage(brand, opts) {
    opts = opts || {};
    var sort = SORTS[opts.sort] || SORTS.featured;
    var name = String(brand || '').replace(/\\/g, '');
    var want = name.toLowerCase();
    var after = String(opts.after || '');
    function mine(p) {
      return p.brand.toLowerCase() === want || (' ' + p.title.toLowerCase() + ' ').indexOf(' ' + want + ' ') >= 0;
    }
    function bySearch(cursor, mode) {
      return searchAll(name, { sort: opts.sort, after: cursor || null, mode: mode || undefined }).then(function (page) {
        page.products = page.products.filter(mine);
        page.cursor = page.hasMore && page.cursor ? 's|' + page.mode + '|' + page.cursor : null;
        page.via = 'search';
        return page;
      });
    }
    if (after.indexOf('s|') === 0) {
      var parts = after.split('|');
      return bySearch(parts.slice(2).join('|'), parts[1] === 'catalogue' ? 'catalogue' : undefined);
    }
    var words = want.replace(/["'\\:()\[\]{}<>!^~*?]/g, ' ').split(/\s+/).filter(Boolean);
    var q = "vendor:'" + name.replace(/'/g, "\\'") + "'" +
      (words.length ? ' OR (' + words.map(function (w) { return 'title:' + w + '*'; }).join(' AND ') + ')' : '');
    return productsQuery(q, sort, opts, 'brand|' + brand).then(function (page) {
      page.products = page.products.filter(mine);
      if (!page.products.length && !after) return bySearch(null);
      page.via = 'query';
      return page;
    }, function (e) {
      if (after) throw e;
      return bySearch(null);
    });
  }

  function productsQuery(q, sort, opts, keyPrefix) {
    var query =
      'query PtProducts($q: String!, $after: String, $sortKey: ProductSortKeys, $reverse: Boolean) {' +
      ' products(first: ' + PAGE_SIZE + ', after: $after, query: $q, sortKey: $sortKey, reverse: $reverse) {' +
      '  pageInfo { hasNextPage endCursor }' +
      '  nodes {' + TILE_FIELDS + ' }' +
      ' }' +
      '}';
    var cacheKey = keyPrefix + '|' + (opts.sort || 'featured') + '|' + (opts.after || '');
    return gql(query, {
      q: q, after: opts.after || null, sortKey: sort.key, reverse: sort.reverse
    }, { cacheKey: cacheKey, fresh: opts.fresh }).then(function (data) {
      var page = pageOf(data && data.products);
      page.missing = false;
      return page;
    });
  }

  /* The store's own collections, straight from the store. The shop lists
   * what Shopify lists, so a collection renamed, added or retired by the shop
   * shows up here without anyone editing this code. Each one carries a single
   * product probe, which is enough to leave the empty ones out of the menus.
   * Up to 250, which is more than the API returns in one page. */
  function collections(opts) {
    opts = opts || {};
    var query =
      'query PtCollections($after: String) {' +
      ' collections(first: 100, after: $after, sortKey: TITLE) {' +
      '  pageInfo { hasNextPage endCursor }' +
      '  nodes { id handle title image { url } products(first: 1) { nodes { id } } }' +
      ' }' +
      '}';
    var found = [];
    function page(after, depth) {
      return gql(query, { after: after }, { cacheKey: 'cols|' + (after || ''), fresh: opts.fresh })
        .then(function (data) {
          var conn = (data && data.collections) || {};
          (conn.nodes || []).forEach(function (n) {
            if (!n || !n.handle) return;
            found.push({
              id: n.id,
              handle: n.handle,
              title: String(n.title || n.handle),
              image: (n.image && n.image.url) || null,
              hasProducts: !!(n.products && n.products.nodes && n.products.nodes.length)
            });
          });
          var info = conn.pageInfo || {};
          if (info.hasNextPage && info.endCursor && depth < 2) return page(info.endCursor, depth + 1);
          return found;
        });
    }
    return page(null, 0);
  }

  /* Everything the store sells, paged. This is what makes "shop all" true
   * rather than a tour of whichever collections someone remembered. */
  function allProducts(opts) {
    opts = opts || {};
    var sort = SORTS[opts.sort] || SORTS.featured;
    var query =
      'query PtAll($after: String, $sortKey: ProductSortKeys, $reverse: Boolean) {' +
      ' products(first: ' + PAGE_SIZE + ', after: $after, sortKey: $sortKey, reverse: $reverse) {' +
      '  pageInfo { hasNextPage endCursor }' +
      '  nodes {' + TILE_FIELDS + ' }' +
      ' }' +
      '}';
    return gql(query, { after: opts.after || null, sortKey: sort.key, reverse: sort.reverse },
      { cacheKey: 'all|' + (opts.sort || 'featured') + '|' + (opts.after || ''), fresh: opts.fresh })
      .then(function (data) {
        var page = pageOf(data && data.products);
        page.missing = false;
        return page;
      });
  }

  /* ================================================================ PRODUCT */

  /* Two shapes. BASE asks only for fields this store is known to answer
   * without a key: the same set the RRT app reads from it in production.
   * RICH adds tags and stock counts, which tokenless access can refuse
   * ("access denied", needs an inventory scope). The page asks RICH once;
   * any GraphQL error drops to BASE for the rest of the visit, so a refused
   * field costs one extra call, never a broken page. */
  function productQuery(rich) {
    return 'query PtProduct($handle: String!) {' +
      ' product(handle: $handle) {' +
      '  id handle title vendor productType descriptionHtml' +
      (rich ? ' tags' : '') +
      '  featuredImage { url }' +
      '  images(first: 12) { nodes { url } }' +
      '  options { name }' +
      '  variants(first: 100) { nodes {' +
      '   id title availableForSale' +
      '   price { amount } compareAtPrice { amount }' +
      '   image { url }' +
      '   selectedOptions { name value }' +
      (rich ? '   quantityAvailable currentlyNotInStock' : '') +
      '  } }' +
      ' }' +
      '}';
  }

  function variantOf(node) {
    if (!node || !node.id) return null;
    var p = paise(node.price && node.price.amount);
    var was = paise(node.compareAtPrice && node.compareAtPrice.amount);
    return {
      id: node.id,
      title: String(node.title || '').trim(),
      available: node.availableForSale === true,
      stock: typeof node.quantityAvailable === 'number' ? node.quantityAvailable : null,
      backorder: node.currentlyNotInStock === true,
      paise: p,
      wasPaise: was && p && was > p ? was : null,
      image: (node.image && node.image.url) || null,
      options: (node.selectedOptions || []).map(function (o) {
        return { name: String(o.name || ''), value: String(o.value || '') };
      })
    };
  }

  var richProduct = true;

  function product(handle, opts) {
    opts = opts || {};
    var rich = richProduct;
    return gql(productQuery(rich), { handle: handle }, { cacheKey: 'prod|' + handle + (rich ? '|r' : '|b'), fresh: opts.fresh })
      .catch(function (e) {
        if (rich && e && e.graphQLErrors) {
          richProduct = false;
          return gql(productQuery(false), { handle: handle }, { cacheKey: 'prod|' + handle + '|b', fresh: opts.fresh });
        }
        throw e;
      })
      .then(function (data) {
        var p = data && data.product;
        if (!p) return null;
        var variants = ((p.variants && p.variants.nodes) || []).map(variantOf).filter(Boolean);
        var images = ((p.images && p.images.nodes) || []).map(function (i) {
          return { url: i.url, alt: String(p.title || '') };
        });
        if (!images.length && p.featuredImage) {
          images = [{ url: p.featuredImage.url, alt: String(p.title || '') }];
        }
        return {
          id: p.id,
          handle: p.handle,
          title: String(p.title || '').trim(),
          brand: brandOf(p.vendor, p.title),
          type: String(p.productType || '').trim(),
          descriptionHtml: String(p.descriptionHtml || ''),
          tags: (p.tags || []).map(String),
          available: variants.some(function (v) { return v.available; }),
          images: images,
          optionNames: ((p.options || []).map(function (o) { return String(o.name || ''); })
            .filter(function (n) { return n && n.toLowerCase() !== 'title'; })),
          variants: variants
        };
      });
  }

  /** Products the store itself suggests alongside this one. */
  function recommendations(productId) {
    var query =
      'query PtRecommend($id: ID!) {' +
      ' productRecommendations(productId: $id) {' + TILE_FIELDS + ' }' +
      '}';
    return gql(query, { id: productId }, { cacheKey: 'rec|' + productId })
      .then(function (data) {
        return ((data && data.productRecommendations) || []).map(tileOf).filter(Boolean);
      })
      .catch(function () { return []; });
  }

  /* ================================================================= SEARCH */

  /* Search terms as the products query reads them: each word a prefix, so
   * "drool" finds Drools and "roy can" finds Royal Canin. Characters that mean
   * something to Shopify's query syntax are taken out rather than escaped. */
  function prefixQuery(q) {
    return String(q || '').toLowerCase()
      .replace(/["'\\:()\[\]{}<>!^~*?]/g, ' ')
      .split(/\s+/).filter(function (w) { return w.length > 0; })
      .map(function (w) { return w + '*'; })
      .join(' ');
  }

  /** As-you-type. The store's own prediction first; if the store has none,
   *  or predicts nothing, a prefix match over the catalogue, so a shopper
   *  typing a brand or half a product name always sees something real. */
  function suggest(q) {
    q = String(q || '').trim();
    if (q.length < 2) return Promise.resolve({ query: q, products: [], collections: [], source: 'none' });
    var query =
      'query PtSuggest($q: String!) {' +
      ' predictiveSearch(query: $q, limit: 8, limitScope: EACH,' +
      '  types: [PRODUCT, COLLECTION], unavailableProducts: LAST) {' +
      '  products {' + TILE_FIELDS + ' }' +
      '  collections { handle title }' +
      ' }' +
      '}';
    function fallback() {
      var pq = prefixQuery(q);
      if (!pq) return { query: q, products: [], collections: [], source: 'none' };
      return productsQuery(pq, SORTS.featured, {}, 'sugq|' + q.toLowerCase()).then(function (page) {
        return { query: q, products: page.products.slice(0, 8), collections: [], source: 'catalogue' };
      }).catch(function () { return { query: q, products: [], collections: [], source: 'none' }; });
    }
    return gql(query, { q: q }, { cacheKey: 'sug|' + q.toLowerCase() }).then(function (data) {
      var ps = (data && data.predictiveSearch) || {};
      var r = {
        query: q,
        products: (ps.products || []).map(tileOf).filter(Boolean),
        collections: (ps.collections || []).map(function (c) {
          return { handle: String(c.handle || ''), title: String(c.title || '') };
        }).filter(function (c) { return c.handle && c.title; }),
        source: 'predictive'
      };
      if (!r.products.length) {
        return fallback().then(function (f) {
          f.collections = r.collections;
          return f;
        });
      }
      return r;
    }).catch(fallback);
  }

  /** The full result page for a search term. The store's search first (it
   *  understands plurals and typos); if it errors or finds nothing, a prefix
   *  match over the whole catalogue. The page remembers which one answered,
   *  so "show more" keeps paging the same list. */
  function searchAll(q, opts) {
    opts = opts || {};
    q = String(q || '').trim();
    if (!q) return Promise.resolve({ products: [], hasMore: false, cursor: null, total: 0, mode: 'search' });
    var sort = SORTS[opts.sort] || SORTS.featured;

    function byCatalogue() {
      var pq = prefixQuery(q);
      if (!pq) return Promise.resolve({ products: [], hasMore: false, cursor: null, total: 0, mode: 'catalogue' });
      return productsQuery(pq, sort, opts, 'searchq|' + q.toLowerCase()).then(function (page) {
        page.total = page.hasMore ? null : page.products.length;
        page.mode = 'catalogue';
        return page;
      });
    }
    if (opts.mode === 'catalogue') return byCatalogue();

    var query =
      'query PtSearch($q: String!, $after: String, $sortKey: SearchSortKeys, $reverse: Boolean) {' +
      ' search(query: $q, first: ' + PAGE_SIZE + ', after: $after, types: [PRODUCT],' +
      '  sortKey: $sortKey, reverse: $reverse, unavailableProducts: LAST) {' +
      '  totalCount' +
      '  pageInfo { hasNextPage endCursor }' +
      '  nodes { ... on Product {' + TILE_FIELDS + ' } }' +
      ' }' +
      '}';
    var searchSort = { featured: ['RELEVANCE', false], newest: ['RELEVANCE', false],
      priceLow: ['PRICE', false], priceHigh: ['PRICE', true] }[opts.sort || 'featured'] || ['RELEVANCE', false];
    var cacheKey = 'search|' + q.toLowerCase() + '|' + (opts.sort || 'featured') + '|' + (opts.after || '');
    return gql(query, { q: q, after: opts.after || null, sortKey: searchSort[0], reverse: searchSort[1] },
      { cacheKey: cacheKey })
      .then(function (data) {
        var page = pageOf(data && data.search);
        page.total = (data && data.search && typeof data.search.totalCount === 'number')
          ? data.search.totalCount : page.products.length;
        page.mode = 'search';
        if (!page.products.length && !opts.after) return byCatalogue();
        return page;
      })
      .catch(function (e) {
        if (opts.after) throw e;
        return byCatalogue();
      });
  }

  /* =================================================================== BAG
   * The bag is a Shopify cart. Its id is the only thing kept on the device;
   * quantities, prices, stock and the checkout link all come from the store,
   * so a bag opened on a laptop and paid on a phone cannot disagree. */

  var CART_FIELDS =
    ' id totalQuantity' +
    ' cost { subtotalAmount { amount currencyCode } totalAmount { amount } }' +
    ' lines(first: 100) { nodes {' +
    '  id quantity' +
    '  cost { totalAmount { amount } }' +
    '  merchandise { ... on ProductVariant {' +
    '   id title availableForSale' +
    '   price { amount } compareAtPrice { amount }' +
    '   image { url }' +
    '   product { handle title vendor featuredImage { url } }' +
    '  } }' +
    ' } }';

  function cartOf(cart) {
    if (!cart || !cart.id) return null;
    var lines = ((cart.lines && cart.lines.nodes) || []).map(function (l) {
      var v = l && l.merchandise;
      if (!v || !v.id) return null;
      var pr = v.product || {};
      var p = paise(v.price && v.price.amount);
      var was = paise(v.compareAtPrice && v.compareAtPrice.amount);
      return {
        lineId: l.id,
        variantId: v.id,
        handle: String(pr.handle || ''),
        title: String(pr.title || ''),
        brand: brandOf(pr.vendor, pr.title),
        variantTitle: String(v.title || '').replace(/^Default Title$/, ''),
        qty: l.quantity || 0,
        available: v.availableForSale === true,
        stock: typeof v.quantityAvailable === 'number' ? v.quantityAvailable : null,
        paise: p,
        wasPaise: was && p && was > p ? was : null,
        linePaise: paise(l.cost && l.cost.totalAmount && l.cost.totalAmount.amount),
        image: (v.image && v.image.url) || (pr.featuredImage && pr.featuredImage.url) || null
      };
    }).filter(Boolean);
    return {
      id: cart.id,
      count: cart.totalQuantity || 0,
      subtotalPaise: paise(cart.cost && cart.cost.subtotalAmount && cart.cost.subtotalAmount.amount),
      lines: lines
    };
  }

  function userError(res) {
    var e = res && res.userErrors && res.userErrors[0];
    return e && e.message ? e.message : null;
  }

  function cartId() { return readLocal(CART_KEY); }
  function forgetCart() { dropLocal(CART_KEY); }
  function rememberCart(cart) {
    if (cart && cart.id) writeLocal(CART_KEY, cart.id);
    return cart;
  }

  /** The current bag, or null when there is none. A cart that Shopify no
   *  longer knows (paid, or expired after ten days) is forgotten, not an
   *  error: the next add simply starts a new one. */
  function cartGet(opts) {
    opts = opts || {};
    var id = cartId();
    if (!id) return Promise.resolve(null);
    var query = 'query PtCart($id: ID!) { cart(id: $id) {' + CART_FIELDS + ' } }';
    return gql(query, { id: id }, { fresh: true }).then(function (data) {
      var cart = cartOf(data && data.cart);
      if (!cart) { forgetCart(); return null; }
      return cart;
    }).catch(function (e) {
      if (opts.quiet) return null;
      throw e;
    });
  }

  function cartCreate(lines) {
    var mutation =
      'mutation PtCartCreate($input: CartInput!) {' +
      ' cartCreate(input: $input) { cart {' + CART_FIELDS + ' } userErrors { message field } }' +
      '}';
    return gql(mutation, { input: { lines: lines } }, { fresh: true }).then(function (data) {
      var res = data && data.cartCreate;
      var msg = userError(res);
      if (msg) throw StorefrontError(msg);
      var cart = cartOf(res && res.cart);
      if (!cart) throw StorefrontError('The bag could not be opened right now. Try again.');
      return rememberCart(cart);
    });
  }

  /** Add a variant to the bag. Opens a cart when there is none, and starts a
   *  fresh one if the stored cart has gone. */
  function cartAdd(variantId, qty) {
    qty = Math.max(1, Math.round(qty || 1));
    var lines = [{ merchandiseId: variantId, quantity: qty }];
    var id = cartId();
    if (!id) return cartCreate(lines);
    var mutation =
      'mutation PtCartAdd($id: ID!, $lines: [CartLineInput!]!) {' +
      ' cartLinesAdd(cartId: $id, lines: $lines) { cart {' + CART_FIELDS + ' } userErrors { message field } }' +
      '}';
    return gql(mutation, { id: id, lines: lines }, { fresh: true }).then(function (data) {
      var res = data && data.cartLinesAdd;
      var cart = cartOf(res && res.cart);
      if (cart) return rememberCart(cart);
      var msg = userError(res);
      /* No cart back means the stored one is gone (paid or expired). */
      forgetCart();
      if (msg && /quantity|stock|sold|availab/i.test(msg)) throw StorefrontError(msg);
      return cartCreate(lines);
    });
  }

  function cartSetQty(lineId, qty) {
    var id = cartId();
    if (!id) return Promise.resolve(null);
    qty = Math.max(0, Math.round(qty || 0));
    if (qty === 0) return cartRemove(lineId);
    var mutation =
      'mutation PtCartUpdate($id: ID!, $lines: [CartLineUpdateInput!]!) {' +
      ' cartLinesUpdate(cartId: $id, lines: $lines) { cart {' + CART_FIELDS + ' } userErrors { message field } }' +
      '}';
    return gql(mutation, { id: id, lines: [{ id: lineId, quantity: qty }] }, { fresh: true })
      .then(function (data) {
        var res = data && data.cartLinesUpdate;
        var msg = userError(res);
        if (msg) throw StorefrontError(msg);
        var cart = cartOf(res && res.cart);
        if (!cart) { forgetCart(); return null; }
        return rememberCart(cart);
      });
  }

  function cartRemove(lineId) {
    var id = cartId();
    if (!id) return Promise.resolve(null);
    var mutation =
      'mutation PtCartRemove($id: ID!, $lineIds: [ID!]!) {' +
      ' cartLinesRemove(cartId: $id, lineIds: $lineIds) { cart {' + CART_FIELDS + ' } userErrors { message field } }' +
      '}';
    return gql(mutation, { id: id, lineIds: [lineId] }, { fresh: true }).then(function (data) {
      var res = data && data.cartLinesRemove;
      var msg = userError(res);
      if (msg) throw StorefrontError(msg);
      var cart = cartOf(res && res.cart);
      if (!cart) { forgetCart(); return null; }
      return rememberCart(cart);
    });
  }

  /* ================================================================== SAVED */

  function saved() {
    var raw = readLocal(SAVED_KEY);
    if (!raw) return [];
    try {
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list.filter(function (h) { return typeof h === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function isSaved(handle) { return saved().indexOf(handle) >= 0; }
  function toggleSaved(handle) {
    var list = saved();
    var i = list.indexOf(handle);
    if (i >= 0) list.splice(i, 1); else list.unshift(handle);
    writeLocal(SAVED_KEY, JSON.stringify(list.slice(0, 120)));
    return i < 0;
  }
  /** The saved list as live tiles, in saved order, skipping anything gone. */
  function savedProducts() {
    var list = saved();
    if (!list.length) return Promise.resolve([]);
    var q = list.slice(0, 24).map(function (h) { return 'handle:' + JSON.stringify(h); }).join(' OR ');
    return productsQuery(q, SORTS.featured, {}, 'saved|' + list.slice(0, 24).join(','))
      .then(function (page) {
        var by = {};
        page.products.forEach(function (p) { by[p.handle] = p; });
        return list.map(function (h) { return by[h]; }).filter(Boolean);
      })
      .catch(function () { return []; });
  }

  /* =============================================================== POLICIES
   * The store's own shipping and returns wording. Delivery estimates and the
   * assistant's answers about charges, cash on delivery and returns are read
   * from this text, so they change when the shop edits its pages. Both the
   * shop's policy settings and its pages are asked for; the page wins when
   * both exist, because that is the one the footer links to. */

  function plainText(html) {
    return String(html || '')
      .replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8377;|&#x20b9;/gi, '\u20b9')
      .replace(/&rsquo;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;/gi, ' ')
      .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  }

  function handleOf(path) { return String(path || '').split('/').filter(Boolean).pop() || ''; }

  function policies(opts) {
    opts = opts || {};
    var query =
      'query PtPolicies($ship: String!, $refund: String!) {' +
      ' shop { shippingPolicy { body url } refundPolicy { body url } }' +
      ' ship: page(handle: $ship) { body }' +
      ' refund: page(handle: $refund) { body }' +
      '}';
    var shipPath = opts.shippingPath || '/pages/shipping';
    var refundPath = opts.refundPath || '/pages/returns';
    return gql(query, { ship: handleOf(shipPath), refund: handleOf(refundPath) }, { cacheKey: 'policies' })
      .then(function (d) {
        d = d || {};
        var shop = d.shop || {};
        /* Shown on this site at #/policy/..., never on the store's own domain. */
        function pick(page, pol, key) {
          var html = (page && page.body) || (pol && pol.body) || '';
          return { text: plainText(html), html: String(html), url: '#/policy/' + key };
        }
        return {
          shipping: pick(d.ship, shop.shippingPolicy, 'shipping'),
          refund: pick(d.refund, shop.refundPolicy, 'returns')
        };
      })
      .catch(function () {
        return { shipping: { text: '', html: '', url: '#/policy/shipping' }, refund: { text: '', html: '', url: '#/policy/returns' } };
      });
  }

  /* ================================================================= ORDERS
   * Order lookups go to api/order.js on this site, which holds the store's
   * Admin credentials. Resolves to { found, order }, or { configured: false }
   * while the store has not been connected yet. */

  function orderLookup(order, contact) {
    var url = config.apiBase + '/api/order';
    return fetcher()(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ order: String(order || ''), contact: String(contact || '') })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        body = body || {};
        if (res.status === 200 && body.found) return { found: true, order: body.order };
        if (res.status === 200 && body.configured === false) return { found: false, configured: false };
        if (res.status === 200 || res.status === 404) return { found: false };
        throw StorefrontError(body.error || 'Order lookup is not answering right now. Try again shortly.', res.status);
      });
    }, function () {
      throw StorefrontError('Could not reach the order desk. Check your connection and try again.');
    });
  }

  /* =============================================================== CHECKOUT
   * Checkout happens on this site: api/checkout.js prices the bag with the
   * store and places the order in it. Business answers ("sold out", "we do
   * not deliver there") come back as { ok: false, error }; only a failure to
   * reach the server throws. */

  function checkout(action, payload) {
    var body = {};
    Object.keys(payload || {}).forEach(function (k) { body[k] = payload[k]; });
    body.action = action;
    return fetcher()(config.apiBase + '/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        j = j || {};
        if (res.status === 200) return j;
        throw StorefrontError(j.error || 'Checkout is not answering right now. Nothing was charged. Try again in a moment.', res.status);
      });
    }, function () {
      throw StorefrontError('Could not reach checkout. Check your connection; nothing was charged.');
    });
  }

  /* ============================================================== UTILITIES */

  /** A Shopify image at the width actually drawn, so a 320 px tile does not
   *  download a 2000 px photograph. */
  function sized(url, width) {
    if (!url) return null;
    if (!/cdn\.shopify\.com|shopifycdn|myshopify/.test(url)) return url;
    var clean = String(url).split('?')[0];
    return clean + '?width=' + Math.round(width);
  }

  function shopUrl(path) {
    return 'https://' + (config.domain || 'pawsandtails24.com') + path;
  }

  return {
    configure: configure,
    config: config,
    gql: gql,
    ping: ping,
    clearCache: cacheClear,
    error: StorefrontError,

    paise: paise,
    money: money,
    moneyOf: moneyOf,
    discountPercent: discountPercent,
    sorts: SORTS,
    pageSize: PAGE_SIZE,

    collections: collections,
    allProducts: allProducts,
    collectionPage: collectionPage,
    brandPage: brandPage,
    product: product,
    recommendations: recommendations,
    suggest: suggest,
    searchAll: searchAll,
    policies: policies,
    orderLookup: orderLookup,
    checkout: checkout,
    plainText: plainText,

    cartGet: cartGet,
    cartAdd: cartAdd,
    cartSetQty: cartSetQty,
    cartRemove: cartRemove,
    cartId: cartId,
    forgetCart: forgetCart,

    saved: saved,
    isSaved: isSaved,
    toggleSaved: toggleSaved,
    savedProducts: savedProducts,

    sized: sized,
    shopUrl: shopUrl,
    prefixQuery: prefixQuery,
    brandOf: brandOf,

    /* exposed for the tests */
    _tileOf: tileOf,
    _cartOf: cartOf,
    _groupIndian: groupIndian
  };
}));
