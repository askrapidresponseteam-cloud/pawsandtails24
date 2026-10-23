/* ============================================================================
 * A stand-in for the store's Admin API, for order lookups in tests
 * ============================================================================
 * api/order.js talks to Shopify with fetch. Handed this fetch instead, it gets
 * the same two answers Shopify gives: an access token from the client
 * credentials grant, and orders from the GraphQL endpoint. The orders are
 * invented, dated relative to now, so "in transit" stays in transit whatever
 * day the tests run.
 *
 *   const admin = require('./mock-admin.js')();
 *   createHandler({ env: admin.env, fetchImpl: admin.fetch })
 * ========================================================================== */
'use strict';

const DAY = 24 * 60 * 60 * 1000;

function makeOrders(now, products) {
  const at = (days) => new Date(now + days * DAY).toISOString();
  const item = (p, qty) => ({
    title: p ? p.title : 'Item', variantTitle: p ? p.variants[0].title : '', quantity: qty || 1,
    image: p ? { url: '/mock-img/huge-' + Number(String(p.id).split('/').pop()) + '.svg' } : null,
    variant: p ? { id: p.variants[0].id } : null
  });
  const pick = (i) => (products && products[i]) || null;
  const base = {
    displayFinancialStatus: 'PAID',
    totalPriceSet: { shopMoney: { amount: '1249.00', currencyCode: 'INR' } },
    statusPageUrl: 'https://pawsandtails24.com/orders/status-page'
  };
  return [
    Object.assign({}, base, {
      name: '#1001', createdAt: at(-6), cancelledAt: null, displayFulfillmentStatus: 'FULFILLED',
      email: 'asha@example.com', phone: '+91 98450 12345',
      shippingAddress: { city: 'Udupi', province: 'Karnataka', zip: '576101', phone: '+919845012345' },
      lineItems: { nodes: [item(pick(2), 1), item(pick(5), 2)] },
      fulfillments: [{ createdAt: at(-5), status: 'SUCCESS', displayStatus: 'DELIVERED', estimatedDeliveryAt: null,
        inTransitAt: at(-5), deliveredAt: at(-2),
        trackingInfo: [{ company: 'Delhivery', number: 'DL123456789', url: 'https://www.delhivery.com/track/package/DL123456789' }] }]
    }),
    Object.assign({}, base, {
      name: '#1002', createdAt: at(-2), cancelledAt: null, displayFulfillmentStatus: 'FULFILLED',
      email: 'meera@example.com', phone: null,
      shippingAddress: { city: 'Mangaluru', province: 'Karnataka', zip: '575001', phone: '9876543210' },
      lineItems: { nodes: [item(pick(8), 1)] },
      fulfillments: [{ createdAt: at(-1), status: 'SUCCESS', displayStatus: 'IN_TRANSIT', estimatedDeliveryAt: at(2),
        inTransitAt: at(-1), deliveredAt: null,
        trackingInfo: [{ company: 'Blue Dart', number: 'BD99887766', url: 'https://www.bluedart.com/tracking?awb=BD99887766' }] }]
    }),
    Object.assign({}, base, {
      name: '#1003', createdAt: at(0), cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED',
      email: 'ravi@example.com', phone: '+91 90000 11111',
      shippingAddress: { city: 'Kolkata', province: 'West Bengal', zip: '700019', phone: null },
      lineItems: { nodes: [item(pick(11), 3)] },
      fulfillments: []
    }),
    Object.assign({}, base, {
      name: '#1004', createdAt: at(-3), cancelledAt: at(-3), displayFulfillmentStatus: 'UNFULFILLED',
      displayFinancialStatus: 'REFUNDED',
      email: 'kiran@example.com', phone: null,
      shippingAddress: { city: 'Bengaluru', province: 'Karnataka', zip: '560001', phone: null },
      lineItems: { nodes: [item(pick(14), 1)] },
      fulfillments: []
    }),
    Object.assign({}, base, {
      name: '#1005', createdAt: at(-3), cancelledAt: null, displayFulfillmentStatus: 'FULFILLED',
      email: 'neha@example.com', phone: '9123456780',
      shippingAddress: { city: 'Udupi', province: 'Karnataka', zip: '576102', phone: null },
      lineItems: { nodes: [item(pick(17), 1)] },
      fulfillments: [{ createdAt: at(-2), status: 'SUCCESS', displayStatus: 'OUT_FOR_DELIVERY', estimatedDeliveryAt: at(0),
        inTransitAt: at(-2), deliveredAt: null, trackingInfo: [{ company: 'Delhivery', number: 'DL555', url: null }] }]
    })
  ];
}

module.exports = function mockAdmin(opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const products = opts.products || null;
  const stats = { tokens: 0, queries: 0 };
  let current = null;
  const env = {
    SHOPIFY_SHOP: 'paws-mock.myshopify.com',
    SHOPIFY_CLIENT_ID: 'mock-client',
    SHOPIFY_CLIENT_SECRET: 'mock-secret'
  };

  function reply(status, body) {
    return Promise.resolve({ status: status, json: () => Promise.resolve(body) });
  }

  function fakeFetch(url, init) {
    url = String(url);
    if (url === 'https://' + env.SHOPIFY_SHOP + '/admin/oauth/access_token') {
      const body = String((init && init.body) || '');
      const form = new URLSearchParams(body);
      if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== env.SHOPIFY_CLIENT_ID ||
          form.get('client_secret') !== env.SHOPIFY_CLIENT_SECRET) {
        return reply(400, { error: 'invalid_client' });
      }
      stats.tokens++;
      current = 'mock-token-' + stats.tokens;
      return reply(200, { access_token: current, scope: 'read_orders', expires_in: 86399 });
    }
    if (url.indexOf('https://' + env.SHOPIFY_SHOP + '/admin/api/') === 0 && /\/graphql\.json$/.test(url)) {
      const headers = (init && init.headers) || {};
      if (!current || headers['X-Shopify-Access-Token'] !== current) {
        return reply(401, { errors: '[API] Invalid API key or access token' });
      }
      stats.queries++;
      let body = {};
      try { body = JSON.parse(init.body); } catch (e) { /* ignore */ }
      const m0 = String(body.query || '').match(/(?:query|mutation)\s+(\w+)/);
      const op = m0 ? m0[1] : '';
      const v = body.variables || {};
      if (op === 'PtOrder') {
        const q = String(v.q || '');
        const m = q.match(/name:#?([A-Za-z0-9]+)/);
        const wanted = m ? m[1].toUpperCase() : '';
        const nodes = allOrders().filter((o) => o.name.replace('#', '').toUpperCase() === wanted);
        return reply(200, { data: { orders: { nodes: nodes } } });
      }
      return reply(200, { data: drafts(op, v) });
    }
    return Promise.reject(new Error('mock admin: unexpected ' + url));
  }

  /* ------------------------------------------------ draft orders (checkout) */

  const placed = [];          /* orders made from drafts, found by tracking too */
  const draftsById = new Map();
  let draftSeq = 0;
  let orderSeq = 1005;
  const allOrders = () => makeOrders(now(), products).concat(placed);

  function variant(id) {
    for (const p of products || []) for (const vv of p.variants) if (vv.id === id) return { p: p, v: vv };
    return null;
  }
  const amt = (p) => (Math.round(p) / 100).toFixed(2);
  const set = (p) => ({ shopMoney: { amount: amt(p) } });

  function price(input) {
    const lines = (input.lineItems || []).map((l) => {
      const hit = variant(l.variantId);
      return { hit: hit, qty: l.quantity, unit: hit ? Math.round(Number(hit.v.price.amount) * 100) : 0 };
    });
    const subtotal = lines.reduce((n, l) => n + l.unit * l.qty, 0);
    const zip = String((input.shippingAddress || {}).zip || '');
    /* Pincodes starting with 9 are where this pretend store cannot deliver. */
    const rates = /^9/.test(zip) ? [] : [
      subtotal >= 99900 ? { handle: 'mock-free', title: 'Standard delivery', price: { amount: '0.00' } }
        : { handle: 'mock-standard', title: 'Standard delivery', price: { amount: '79.00' } },
      { handle: 'mock-express', title: 'Express delivery', price: { amount: '149.00' } }
    ];
    const sl = input.shippingLine;
    const ship = sl ? Math.round(Number((sl.priceWithCurrency && sl.priceWithCurrency.amount) || 0) * 100) : 0;
    const total = subtotal + ship;
    return {
      lines: lines,
      calc: {
        subtotalPriceSet: set(subtotal), totalShippingPriceSet: set(ship),
        totalTaxSet: set(Math.round(total * 18 / 118)), totalPriceSet: set(total), taxesIncluded: true,
        availableShippingRates: rates
      },
      total: total
    };
  }

  function drafts(op, v) {
    if (op === 'PtVariants') {
      return { nodes: (v.ids || []).map((id) => {
        const hit = variant(id);
        if (!hit) return null;
        return { id: id, title: hit.v.title, availableForSale: hit.v.availableForSale, price: hit.v.price.amount, image: null,
          product: { title: hit.p.title, handle: hit.p.handle, status: 'ACTIVE', featuredImage: { url: '/mock-img/huge-' + Number(String(hit.p.id).split('/').pop()) + '.svg' } } };
      }) };
    }
    if (op === 'PtCalc') {
      stats.calcs = (stats.calcs || 0) + 1;
      return { draftOrderCalculate: { calculatedDraftOrder: price(v.input).calc, userErrors: [] } };
    }
    if (op === 'PtDraftCreate') {
      const pr = price(v.input);
      const id = 'gid://shopify/DraftOrder/' + (++draftSeq);
      const d = { id: id, name: '#D' + draftSeq, status: 'OPEN', input: v.input, total: pr.total, lines: pr.lines, order: null };
      draftsById.set(id, d);
      stats.draftsCreated = (stats.draftsCreated || 0) + 1;
      return { draftOrderCreate: { draftOrder: { id: id, name: d.name, totalPriceSet: set(d.total) }, userErrors: [] } };
    }
    if (op === 'PtDraft') {
      const d = draftsById.get(v.id);
      return { draftOrder: d ? { id: d.id, name: d.name, status: d.status, totalPriceSet: set(d.total), order: d.order } : null };
    }
    if (op === 'PtDraftUpdate') {
      const d = draftsById.get(v.id);
      if (d && v.input && v.input.note) d.input.note = v.input.note;
      return { draftOrderUpdate: { draftOrder: d ? { id: d.id } : null, userErrors: [] } };
    }
    if (op === 'PtDraftDelete') {
      const d = draftsById.get(v.input && v.input.id);
      if (d && d.status === 'OPEN') { draftsById.delete(d.id); stats.draftsDeleted = (stats.draftsDeleted || 0) + 1; }
      return { draftOrderDelete: { deletedId: d ? d.id : null, userErrors: [] } };
    }
    if (op === 'PtDraftComplete') {
      const d = draftsById.get(v.id);
      if (!d) return { draftOrderComplete: { draftOrder: null, userErrors: [{ field: ['id'], message: 'not found' }] } };
      if (d.status === 'COMPLETED') return { draftOrderComplete: { draftOrder: null, userErrors: [{ field: ['id'], message: 'This order has already been paid.' }] } };
      d.status = 'COMPLETED';
      d.order = { id: 'gid://shopify/Order/' + (++orderSeq), name: '#' + orderSeq };
      d.paymentPending = !!v.pending;
      const a = d.input.shippingAddress || {};
      placed.push({
        name: d.order.name, createdAt: new Date(now()).toISOString(), cancelledAt: null,
        displayFinancialStatus: v.pending ? 'PENDING' : 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
        email: d.input.email || null, phone: d.input.phone || null,
        shippingAddress: { city: a.city, province: a.provinceCode, zip: a.zip, phone: a.phone || null },
        totalPriceSet: set(d.total), statusPageUrl: null,
        lineItems: { nodes: d.lines.map((l) => ({ title: l.hit ? l.hit.p.title : 'Item', variantTitle: l.hit ? l.hit.v.title : '', quantity: l.qty, image: null, variant: l.hit ? { id: l.hit.v.id } : null })) },
        fulfillments: []
      });
      return { draftOrderComplete: { draftOrder: { id: d.id, status: 'COMPLETED', order: d.order }, userErrors: [] } };
    }
    return {};
  }

  return {
    env: env,
    fetch: fakeFetch,
    stats: stats,
    drafts: draftsById,
    placed: placed,
    orders: () => makeOrders(now(), products),
    /* Forget the token, as if Shopify had expired it early. */
    revoke: () => { current = 'revoked'; }
  };
};
