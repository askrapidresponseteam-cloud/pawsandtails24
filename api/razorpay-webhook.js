/* ============================================================================
 * Razorpay webhook (optional, recommended)
 * ============================================================================
 * If a shopper pays and then closes the tab before the page hears back, this
 * is how the order still gets placed: Razorpay calls here with order.paid or
 * payment.captured, and the same finishing step as the page runs. It is safe
 * to arrive twice or after the page already finished.
 *
 * In the Razorpay Dashboard > Webhooks: URL
 *   https://pawsandtails24.vercel.app/api/razorpay-webhook
 * events order.paid and payment.captured, and a secret, which goes in Vercel
 * as RAZORPAY_WEBHOOK_SECRET.
 * ========================================================================== */
'use strict';

const { createAdmin, readRaw, send } = require('../lib/admin.js');
const { createRazorpay } = require('../lib/razorpay.js');
const { createCheckout } = require('../lib/checkout.js');
const C = require('../assets/catalogue.js');

function createHandler(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const admin = createAdmin({ env: env, fetchImpl: opts.fetchImpl, now: opts.now });
  const razorpay = createRazorpay({ env: env, fetchImpl: opts.rzpFetch || opts.fetchImpl });
  const checkout = createCheckout({ admin: admin, razorpay: razorpay, catalogue: C, now: opts.now });

  async function handler(req, res) {
    if (req.method !== 'POST') { send(res, 405, { ok: false }); return; }
    const raw = await readRaw(req);
    const sig = req.headers && (req.headers['x-razorpay-signature'] || req.headers['X-Razorpay-Signature']);
    if (!razorpay.verifyWebhook(raw, sig)) { send(res, 401, { ok: false, error: 'bad signature' }); return; }
    let event = {};
    try { event = JSON.parse(raw); } catch (e) { send(res, 400, { ok: false }); return; }
    const type = event.event;
    const p = event.payload || {};
    const orderId = (p.order && p.order.entity && p.order.entity.id) || (p.payment && p.payment.entity && p.payment.entity.order_id);
    const paymentId = p.payment && p.payment.entity && p.payment.entity.id;
    if ((type !== 'order.paid' && type !== 'payment.captured') || !orderId) { send(res, 200, { ok: true, ignored: true }); return; }
    try {
      const r = await checkout.finishPaid(orderId, paymentId);
      /* A 5xx makes Razorpay try again later, which is what we want if the
       * store did not answer; a payment we cannot match is acknowledged. */
      send(res, 200, { ok: !!r.ok, order: r.order ? r.order.name : null });
    } catch (e) {
      send(res, 502, { ok: false });
    }
  }
  return handler;
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
