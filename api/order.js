/* ============================================================================
 * Order lookup, for the track page and the assistant
 * ============================================================================
 * A Vercel function: POST /api/order with { order, contact }. The order
 * number is what the confirmation email shows (#1042), the contact is the
 * phone number or email the order was placed with. Both have to match the
 * same order, otherwise the answer is the same "not found" a wrong number
 * gets, so nobody can read someone else's order by guessing numbers.
 *
 * Orders are only readable with the store's Admin API, which needs a secret,
 * so this runs on the server and the browser never sees it. Set on Vercel:
 *
 *   SHOPIFY_SHOP            your-store.myshopify.com
 *   SHOPIFY_CLIENT_ID       from the app in the Shopify Dev Dashboard
 *   SHOPIFY_CLIENT_SECRET   from the same page
 *     or, for an app made before 2026 that shows a fixed token:
 *   SHOPIFY_ADMIN_TOKEN     shpat_...
 *
 * With client id and secret, a token is fetched with Shopify's client
 * credentials grant, kept for its 24 hours and fetched again when it runs out.
 * The app needs the read_orders scope (read_all_orders too, to find orders
 * older than 60 days). Nothing is written to the store.
 *
 * What comes back is only what a shopper needs to follow their parcel: the
 * stage, dates, courier and tracking link, item names, city and pincode. Not
 * the email, phone, street address or payment details.
 * ========================================================================== */
'use strict';

const { createAdmin, readJson, clientIp, send, rateLimiter, API_VERSION } = require('../lib/admin.js');
const RATE_LIMIT = 12;          /* lookups per address per minute */

const ORDER_QUERY =
  'query PtOrder($q: String!) {' +
  ' orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) { nodes {' +
  '  name createdAt cancelledAt' +
  '  displayFinancialStatus displayFulfillmentStatus' +
  '  email phone' +
  '  shippingAddress { city province zip phone }' +
  '  totalPriceSet { shopMoney { amount currencyCode } }' +
  '  statusPageUrl' +
  '  lineItems(first: 30) { nodes { title variantTitle quantity image { url } variant { id } } }' +
  '  fulfillments(first: 10) {' +
  '   createdAt status displayStatus estimatedDeliveryAt inTransitAt deliveredAt' +
  '   trackingInfo(first: 3) { company number url }' +
  '  }' +
  ' } }' +
  '}';

/* ------------------------------------------------------------ input checks */

/** "#1042", "1042", "order no. PT-1042" -> "1042" / "PT1042". Null if unusable. */
function cleanOrder(raw) {
  const s = String(raw || '').toUpperCase().replace(/ORDER|NO\.?|NUMBER|[#\s-]/g, '');
  return /^[A-Z]{0,6}\d{3,10}$/.test(s) ? s : null;
}

/** An email, or an Indian mobile as its last ten digits. Null if neither. */
function cleanContact(raw) {
  const s = String(raw || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { email: s.toLowerCase() };
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 13) return { phone: digits.slice(-10) };
  return null;
}

function lastTen(p) { return String(p || '').replace(/\D/g, '').slice(-10); }

function contactMatches(node, contact) {
  if (contact.email) return String(node.email || '').toLowerCase() === contact.email;
  const phones = [node.phone, node.shippingAddress && node.shippingAddress.phone].map(lastTen);
  return phones.some((p) => p.length === 10 && p === contact.phone);
}

/* ------------------------------------------------------------ the answer */

const STAGES = ['placed', 'packed', 'shipped', 'out_for_delivery', 'delivered'];
const LABELS = {
  placed: 'Order placed', packed: 'Being packed', shipped: 'Shipped',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered',
  attempted: 'Delivery attempted', cancelled: 'Cancelled', issue: 'Delivery problem'
};

function stageOfShipment(f) {
  const d = String(f.displayStatus || f.status || '').toUpperCase();
  if (d === 'DELIVERED') return 'delivered';
  if (d === 'OUT_FOR_DELIVERY') return 'out_for_delivery';
  if (d === 'ATTEMPTED_DELIVERY') return 'attempted';
  if (d === 'FAILURE' || d === 'NOT_DELIVERED') return 'issue';
  if (d === 'CANCELED' || d === 'CANCELLED') return null;
  if (d === 'LABEL_PRINTED' || d === 'LABEL_PURCHASED' || d === 'SUBMITTED') return 'packed';
  return 'shipped'; /* IN_TRANSIT, CONFIRMED, FULFILLED, SUCCESS and the rest */
}

function shape(node) {
  const shipments = (node.fulfillments || []).map((f) => {
    const stage = stageOfShipment(f);
    if (!stage) return null;
    const t = (f.trackingInfo || [])[0] || {};
    return {
      stage: stage,
      label: LABELS[stage],
      shippedAt: f.inTransitAt || f.createdAt || null,
      deliveredAt: f.deliveredAt || null,
      estimatedAt: f.estimatedDeliveryAt || null,
      courier: t.company || null,
      number: t.number || null,
      url: /^https?:\/\//.test(String(t.url || '')) ? t.url : null
    };
  }).filter(Boolean);

  let stage;
  if (node.cancelledAt) stage = 'cancelled';
  else if (shipments.some((s) => s.stage === 'issue')) stage = 'issue';
  else if (shipments.some((s) => s.stage === 'attempted')) stage = 'attempted';
  else if (shipments.length) {
    /* With several parcels, the order is as far along as its slowest one. */
    const rank = shipments.map((s) => STAGES.indexOf(s.stage)).filter((i) => i >= 0);
    stage = STAGES[Math.min.apply(null, rank)];
  } else {
    const fs = String(node.displayFulfillmentStatus || '').toUpperCase();
    stage = fs === 'IN_PROGRESS' || fs === 'PENDING_FULFILLMENT' || fs === 'PARTIALLY_FULFILLED' ? 'packed' : 'placed';
  }
  const addr = node.shippingAddress || {};
  const total = node.totalPriceSet && node.totalPriceSet.shopMoney;
  return {
    name: String(node.name || ''),
    placedAt: node.createdAt || null,
    stage: stage,
    label: LABELS[stage],
    step: STAGES.indexOf(stage),
    paid: String(node.displayFinancialStatus || '').toUpperCase() === 'PAID',
    city: addr.city || null,
    zip: addr.zip || null,
    total: total ? String(total.amount) : null,
    items: ((node.lineItems && node.lineItems.nodes) || []).map((l) => ({
      title: String(l.title || ''),
      variant: String(l.variantTitle || '').replace(/^Default Title$/, ''),
      qty: l.quantity || 0,
      image: (l.image && l.image.url) || null,
      /* So "order the same again" can put it back in a bag. */
      variantId: (l.variant && l.variant.id) || null
    })),
    shipments: shipments,
    statusUrl: /^https?:\/\//.test(String(node.statusPageUrl || '')) ? node.statusPageUrl : null
  };
}

/* ------------------------------------------------------------ the service */

function createHandler(opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const store = createAdmin({ env: opts.env || process.env, fetchImpl: opts.fetchImpl, now: now });
  const configured = store.configured;
  const admin = (q, v) => store.query(q, v);
  const allow = rateLimiter(RATE_LIMIT, now);

  /** The lookup itself: { status, body }. Exposed for tests. */
  async function lookup(input, ip) {
    /* "Not connected yet" and "not found" are answers, not failures, so they
     * come back as 200: a browser logs every 4xx and 5xx as an error. */
    if (!configured()) return { status: 200, body: { found: false, configured: false } };
    const order = cleanOrder(input && input.order);
    const contact = cleanContact(input && input.contact);
    if (!order || !contact) {
      return { status: 400, body: { error: 'Enter the order number and the phone number or email used for the order.' } };
    }
    if (!allow(String(ip || 'unknown'))) return { status: 429, body: { error: 'Too many tries. Wait a minute and try again.' } };

    const q = 'name:#' + order + ' OR name:' + order;
    let data;
    try {
      data = await admin(ORDER_QUERY, { q: q });
    } catch (e) {
      return { status: 502, body: { error: 'Order lookup is not answering right now. Try again shortly.' } };
    }
    const nodes = (data && data.orders && data.orders.nodes) || [];
    const hit = nodes.find((n) => String(n.name || '').toUpperCase().replace(/[#\s-]/g, '') === order && contactMatches(n, contact));
    if (!hit) return { status: 200, body: { found: false } };
    return { status: 200, body: { found: true, order: shape(hit) } };
  }

  async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(res, 405, { error: 'POST only' }); return; }
    let out;
    try {
      out = await lookup(await readJson(req), clientIp(req));
    } catch (e) {
      out = { status: 500, body: { error: 'Something went wrong looking up the order.' } };
    }
    send(res, out.status, out.body);
  }

  handler.lookup = lookup;
  handler.configured = configured;
  return handler;
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.cleanOrder = cleanOrder;
module.exports.cleanContact = cleanContact;
module.exports.shape = shape;
module.exports.API_VERSION = API_VERSION;
module.exports.STAGE_LABELS = LABELS;
