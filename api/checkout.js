/* ============================================================================
 * Checkout on pawsandtails24.vercel.app
 * ============================================================================
 * POST /api/checkout with { action, ... }:
 *   options  {}                                              payment ways on offer
 *   quote    { lines, address, rate }                        price the bag
 *   place    { lines, address, rate, payment, expectTotal }  cod or online
 *   confirm  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *   abandon  { razorpay_order_id }
 * The work is in lib/checkout.js. Expected outcomes ("sold out", "we do not
 * deliver there") come back as 200 with ok: false, so the browser does not
 * log them as errors; only malformed calls get a 4xx.
 * ========================================================================== */
'use strict';

const { createAdmin, readJson, clientIp, send, rateLimiter } = require('../lib/admin.js');
const { createRazorpay } = require('../lib/razorpay.js');
const { createCheckout } = require('../lib/checkout.js');
const C = require('../assets/catalogue.js');

function createHandler(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const now = opts.now || (() => Date.now());
  const admin = createAdmin({ env: env, fetchImpl: opts.fetchImpl, now: now });
  const razorpay = createRazorpay({ env: env, fetchImpl: opts.rzpFetch || opts.fetchImpl });
  const checkout = createCheckout({ admin: admin, razorpay: razorpay, catalogue: opts.catalogue || C, now: now });
  const allow = rateLimiter(40, now);

  async function run(body, ip) {
    if (!admin.configured()) return { status: 200, body: { ok: false, configured: false } };
    if (!allow(String(ip || 'unknown'))) return { status: 429, body: { ok: false, error: 'Too many tries. Wait a minute and try again.' } };
    const action = body && body.action;
    try {
      /* What can be offered before there is an address: online payment (are
       * Razorpay keys set) and cash on delivery (on, and its cap). */
      if (action === 'options') {
        const conf = (opts.catalogue || C).checkout || {};
        return { status: 200, body: { ok: true, online: razorpay.configured(), cod: { enabled: conf.cod !== false, maxPaise: conf.codMaxRupees ? conf.codMaxRupees * 100 : null } } };
      }
      if (action === 'quote') return { status: 200, body: await checkout.quote(body) };
      if (action === 'place') return { status: 200, body: await checkout.place(body) };
      if (action === 'confirm') return { status: 200, body: await checkout.confirm(body) };
      if (action === 'abandon') return { status: 200, body: await checkout.abandon(body) };
      return { status: 400, body: { ok: false, error: 'Unknown action.' } };
    } catch (e) {
      if (e && e.business) return { status: 200, body: { ok: false, error: 'The store could not price this order: ' + e.message } };
      return { status: 502, body: { ok: false, error: 'The store is not answering right now. Nothing was charged. Try again in a moment.' } };
    }
  }

  async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(res, 405, { ok: false, error: 'POST only' }); return; }
    let out;
    try { out = await run(await readJson(req), clientIp(req)); }
    catch (e) { out = { status: 500, body: { ok: false, error: 'Something went wrong. Nothing was charged.' } }; }
    send(res, out.status, out.body);
  }
  handler.run = run;
  handler.configured = admin.configured;
  handler.online = razorpay.configured;
  return handler;
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
