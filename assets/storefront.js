/* ============================================================================
 * Paws and Tails storefront client
 * ============================================================================
 * Every product, price, picture and stock state on this site is read from the
 * store's own Shopify Storefront API at request time. Nothing is baked into
 * the page, so a price change in Shopify is the price the next visitor sees.
 *
 * Orders are placed by Shopify, not by this file. The bag IS a Shopify cart
 * (cartCreate / cartLinesAdd / cartLinesUpdate / cartLinesRemove), so it is
 * held on their servers against live inventory, and "Checkout" sends the
 * buyer to that cart's own checkoutUrl. Payment, delivery charge, tax invoice,
 * stock and the order record are all Shopify's. This file never sees a card.
 *
 * Transport: same origin. The API is called at /api/<version>/graphql.json,
 * a relative path, so when this is served from pawsandtails24.com the browser
 * treats it as the store's own API and no CORS, key or proxy is involved.
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
    storage: null
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

  /* ============================================================== CATALOGUE */

  var TILE_FIELDS =
    ' id handle title vendor productType availableForSale' +
    ' featuredImage { url altText }' +
    ' priceRange { minVariantPrice { amount currencyCode } maxVariantPrice { amount } }' +
    ' compareAtPriceRange { maxVariantPrice { amount } }';

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
      brand: String(node.vendor || '').trim(),
      type: String(node.productType || '').trim(),
      available: node.availableForSale !== false,
      image: (node.featuredImage && node.featuredImage.url) || null,
      imageAlt: (node.featuredImage && node.featuredImage.altText) || String(node.title || ''),
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
      ranged: ranged
    };
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

  /** One page of everything a brand lists, filtered by the store. */
  function brandPage(brand, opts) {
    opts = opts || {};
    var sort = SORTS[opts.sort] || SORTS.featured;
    var q = "vendor:'" + String(brand || '').replace(/\\/g, '').replace(/'/g, "\\'") + "'";
    return productsQuery(q, sort, opts, 'brand|' + brand);
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

  function productQuery(lean) {
    return 'query PtProduct($handle: String!) {' +
      ' product(handle: $handle) {' +
      '  id handle title vendor productType descriptionHtml availableForSale' +
      (lean ? '' : ' tags') +
      '  featuredImage { url altText }' +
      '  images(first: 12) { nodes { url altText } }' +
      '  options { name values }' +
      '  variants(first: 100) { nodes {' +
      '   id title availableForSale quantityAvailable currentlyNotInStock' +
      '   price { amount currencyCode } compareAtPrice { amount }' +
      '   image { url }' +
      '   selectedOptions { name value }' +
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

  var leanProduct = false;

  function product(handle, opts) {
    opts = opts || {};
    var cacheKey = 'prod|' + handle + (leanProduct ? '|l' : '');
    return gql(productQuery(leanProduct), { handle: handle }, { cacheKey: cacheKey, fresh: opts.fresh })
      .catch(function (e) {
        if (!leanProduct && e && e.fieldRefused) {
          leanProduct = true;
          return gql(productQuery(true), { handle: handle }, { cacheKey: 'prod|' + handle + '|l', fresh: opts.fresh });
        }
        throw e;
      })
      .then(function (data) {
        var p = data && data.product;
        if (!p) return null;
        var variants = ((p.variants && p.variants.nodes) || []).map(variantOf).filter(Boolean);
        var images = ((p.images && p.images.nodes) || []).map(function (i) {
          return { url: i.url, alt: i.altText || String(p.title || '') };
        });
        if (!images.length && p.featuredImage) {
          images = [{ url: p.featuredImage.url, alt: p.featuredImage.altText || String(p.title || '') }];
        }
        return {
          id: p.id,
          handle: p.handle,
          title: String(p.title || '').trim(),
          brand: String(p.vendor || '').trim(),
          type: String(p.productType || '').trim(),
          descriptionHtml: String(p.descriptionHtml || ''),
          tags: (p.tags || []).map(String),
          available: p.availableForSale !== false,
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
    ' id checkoutUrl totalQuantity' +
    ' cost { subtotalAmount { amount currencyCode } totalAmount { amount } }' +
    ' lines(first: 100) { nodes {' +
    '  id quantity' +
    '  cost { totalAmount { amount } }' +
    '  merchandise { ... on ProductVariant {' +
    '   id title availableForSale quantityAvailable' +
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
        brand: String(pr.vendor || ''),
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
      checkoutUrl: cart.checkoutUrl || null,
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

    /* exposed for the tests */
    _tileOf: tileOf,
    _cartOf: cartOf,
    _groupIndian: groupIndian
  };
}));
