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
    image: p ? { url: '/mock-img/huge-' + Number(String(p.id).split('/').pop()) + '.svg' } : null
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
      let q = '';
      try { q = String(JSON.parse(init.body).variables.q || ''); } catch (e) { /* ignore */ }
      const m = q.match(/name:#?([A-Za-z0-9]+)/);
      const wanted = m ? m[1].toUpperCase() : '';
      const nodes = makeOrders(now(), products).filter((o) => o.name.replace('#', '').toUpperCase() === wanted);
      return reply(200, { data: { orders: { nodes: nodes } } });
    }
    return Promise.reject(new Error('mock admin: unexpected ' + url));
  }

  return {
    env: env,
    fetch: fakeFetch,
    stats: stats,
    orders: () => makeOrders(now(), products),
    /* Forget the token, as if Shopify had expired it early. */
    revoke: () => { current = 'revoked'; }
  };
};
