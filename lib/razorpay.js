/* ============================================================================
 * Razorpay, for the server only
 * ============================================================================
 *   RAZORPAY_KEY_ID           rzp_live_... (public, also handed to the popup)
 *   RAZORPAY_KEY_SECRET       secret: creates orders, verifies payments
 *   RAZORPAY_WEBHOOK_SECRET   optional: verifies Razorpay's webhook calls
 *
 * The shopper pays in Razorpay's popup on our own page. Nothing is trusted
 * from the browser: the amount is set here from Shopify's own total, the
 * payment signature is checked with the secret, and the order is read back
 * from Razorpay to confirm it is paid in full before Shopify is told.
 * ========================================================================== */
'use strict';

const crypto = require('crypto');

const API = 'https://api.razorpay.com/v1';

function createRazorpay(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const doFetch = opts.fetchImpl || ((...a) => fetch(...a));

  function configured() { return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET); }
  function keyId() { return String(env.RAZORPAY_KEY_ID || ''); }

  async function call(method, path, body) {
    const auth = Buffer.from(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET).toString('base64');
    const res = await doFetch(API + path, {
      method: method,
      headers: Object.assign({ 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' },
        body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await res.json().catch(() => ({}));
    if (res.status < 200 || res.status >= 300) {
      const msg = (j && j.error && j.error.description) || ('razorpay ' + res.status);
      throw Object.assign(new Error(msg), { upstream: true, status: res.status });
    }
    return j;
  }

  /** A Razorpay order for `amount` paise, carrying our draft order id. */
  function createOrder(amount, receipt, notes) {
    return call('POST', '/orders', {
      amount: Math.round(amount), currency: 'INR', receipt: String(receipt || '').slice(0, 40),
      notes: notes || {}, payment_capture: 1
    });
  }
  function fetchOrder(id) { return call('GET', '/orders/' + encodeURIComponent(id)); }
  function orderPayments(id) { return call('GET', '/orders/' + encodeURIComponent(id) + '/payments'); }
  function capture(paymentId, amount) {
    return call('POST', '/payments/' + encodeURIComponent(paymentId) + '/capture', { amount: Math.round(amount), currency: 'INR' });
  }

  function hmac(secret, text) {
    return crypto.createHmac('sha256', String(secret || '')).update(text).digest('hex');
  }
  function same(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
  }

  /** The popup's answer is real only if this matches. */
  function verifyPayment(orderId, paymentId, signature) {
    return same(hmac(env.RAZORPAY_KEY_SECRET, orderId + '|' + paymentId), signature);
  }
  function webhookConfigured() { return !!env.RAZORPAY_WEBHOOK_SECRET; }
  function verifyWebhook(rawBody, signature) {
    return webhookConfigured() && same(hmac(env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
  }

  return {
    configured, keyId, createOrder, fetchOrder, orderPayments, capture,
    verifyPayment, verifyWebhook, webhookConfigured, sign: hmac
  };
}

module.exports = { createRazorpay };
