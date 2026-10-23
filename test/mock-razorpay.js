/* ============================================================================
 * A stand-in for Razorpay, for tests and the offline mock store
 * ============================================================================
 * Answers the Orders and Payments API calls lib/razorpay.js makes, and plays
 * the shopper's side: pay(orderId) is what the popup would do, returning the
 * same three fields with a real signature made with the test secret.
 * ========================================================================== */
'use strict';

const crypto = require('crypto');

module.exports = function mockRazorpay() {
  const env = { RAZORPAY_KEY_ID: 'rzp_test_mock', RAZORPAY_KEY_SECRET: 'mock-rzp-secret', RAZORPAY_WEBHOOK_SECRET: 'mock-hook-secret' };
  const orders = new Map();
  const payments = new Map();
  let seq = 0;
  const stats = { created: 0 };

  function reply(status, body) { return Promise.resolve({ status: status, json: () => Promise.resolve(body) }); }

  function fakeFetch(url, init) {
    url = String(url);
    const auth = (init && init.headers && init.headers.Authorization) || '';
    const want = 'Basic ' + Buffer.from(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET).toString('base64');
    if (auth !== want) return reply(401, { error: { description: 'Authentication failed' } });
    const method = (init && init.method) || 'GET';
    let m;
    if (method === 'POST' && url === 'https://api.razorpay.com/v1/orders') {
      const b = JSON.parse(init.body);
      const o = { id: 'order_mock' + (++seq), entity: 'order', amount: b.amount, amount_paid: 0, amount_due: b.amount,
        currency: b.currency, receipt: b.receipt, notes: b.notes || {}, status: 'created' };
      orders.set(o.id, o);
      stats.created++;
      return reply(200, o);
    }
    if ((m = url.match(/\/v1\/orders\/([^/]+)\/payments$/))) {
      return reply(200, { items: Array.from(payments.values()).filter((p) => p.order_id === decodeURIComponent(m[1])) });
    }
    if ((m = url.match(/\/v1\/orders\/([^/]+)$/))) {
      const o = orders.get(decodeURIComponent(m[1]));
      return o ? reply(200, o) : reply(400, { error: { description: 'The id provided does not exist' } });
    }
    if (method === 'POST' && (m = url.match(/\/v1\/payments\/([^/]+)\/capture$/))) {
      const p = payments.get(decodeURIComponent(m[1]));
      if (!p) return reply(400, { error: { description: 'no such payment' } });
      p.status = 'captured';
      const o = orders.get(p.order_id);
      o.status = 'paid'; o.amount_paid = o.amount; o.amount_due = 0;
      return reply(200, p);
    }
    return Promise.reject(new Error('mock razorpay: unexpected ' + method + ' ' + url));
  }

  /** What the popup does when the shopper pays. `opts.authorizeOnly` leaves it
   *  for the server to capture; `opts.amount` pays a different amount. */
  function pay(orderId, opts) {
    opts = opts || {};
    const o = orders.get(orderId);
    if (!o) return null;
    const p = { id: 'pay_mock' + (++seq), order_id: orderId, amount: opts.amount || o.amount, status: opts.authorizeOnly ? 'authorized' : 'captured' };
    payments.set(p.id, p);
    if (!opts.authorizeOnly) { o.status = 'paid'; o.amount_paid = p.amount; o.amount_due = Math.max(0, o.amount - p.amount); }
    else o.status = 'attempted';
    return {
      razorpay_order_id: orderId, razorpay_payment_id: p.id,
      razorpay_signature: crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(orderId + '|' + p.id).digest('hex')
    };
  }

  function webhook(event, orderId, paymentId) {
    const body = JSON.stringify({ event: event, payload: {
      payment: { entity: { id: paymentId, order_id: orderId } }, order: { entity: { id: orderId } } } });
    return { body: body, signature: crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex') };
  }

  return { env, fetch: fakeFetch, pay, webhook, orders, payments, stats };
};
