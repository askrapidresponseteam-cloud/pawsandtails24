/* ============================================================================
 * Checkout on our own site: price, place and pay for an order
 * ============================================================================
 * Shoppers never leave pawsandtails24.vercel.app. The bag is priced by the
 * store itself (Shopify's draft order calculation: its prices, its shipping
 * rates for the address, its tax), and the order is created in the store's
 * admin like any other, so stock, fulfilment, couriers and tracking carry on
 * exactly as before.
 *
 *   quote    lines + address    -> items, delivery options, tax, total
 *   place    + contact, payment -> cash on delivery: the order, placed
 *                                  online: a Razorpay payment to open
 *   confirm  Razorpay's answer  -> signature checked, payment checked, order
 *                                  marked paid and placed
 *   abandon  popup closed       -> the unpaid draft is removed
 *
 * Nothing from the browser is trusted for money: prices and totals come from
 * Shopify, the amount to pay is set here, and an order is marked paid only
 * after Razorpay confirms that exact amount was paid for that exact draft.
 * Needs the app scopes read_products, write_draft_orders and read_orders.
 * ========================================================================== */
'use strict';

const VARIANT_RX = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const MAX_LINES = 60;
const MAX_QTY = 50;

const Q = {
  variants:
    'query PtVariants($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant {' +
    ' id title availableForSale price image { url }' +
    ' product { title handle status featuredImage { url } }' +
    ' } } }',
  calc:
    'mutation PtCalc($input: DraftOrderInput!) { draftOrderCalculate(input: $input) {' +
    ' calculatedDraftOrder {' +
    '  subtotalPriceSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } }' +
    '  totalTaxSet { shopMoney { amount } } totalPriceSet { shopMoney { amount } } taxesIncluded' +
    '  availableShippingRates { handle title price { amount } }' +
    ' }' +
    ' userErrors { field message } } }',
  create:
    'mutation PtDraftCreate($input: DraftOrderInput!) { draftOrderCreate(input: $input) {' +
    ' draftOrder { id name totalPriceSet { shopMoney { amount } } }' +
    ' userErrors { field message } } }',
  complete:
    'mutation PtDraftComplete($id: ID!, $pending: Boolean) { draftOrderComplete(id: $id, paymentPending: $pending) {' +
    ' draftOrder { id status order { id name } }' +
    ' userErrors { field message } } }',
  draft:
    'query PtDraft($id: ID!) { draftOrder(id: $id) { id name status totalPriceSet { shopMoney { amount } } order { id name } } }',
  update:
    'mutation PtDraftUpdate($id: ID!, $input: DraftOrderInput!) { draftOrderUpdate(id: $id, input: $input) {' +
    ' draftOrder { id } userErrors { field message } } }',
  remove:
    'mutation PtDraftDelete($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { field message } } }'
};

/** "1249.50" -> 124950 paise, without floats. */
function paise(amount) {
  const m = String(amount === undefined || amount === null ? '' : amount).trim().match(/^(\d+)(?:\.(\d{1,2})\d*)?$/);
  return m ? Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0')) : null;
}
function rupees(p) { return (Math.round(p) / 100).toFixed(2); }
function money(set) { return paise(set && set.shopMoney && set.shopMoney.amount); }

/* ------------------------------------------------------------ input checks */

function cleanLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_LINES) return null;
  const merged = new Map();
  for (const l of lines) {
    const id = String((l && l.variantId) || '');
    const qty = Math.round(Number(l && l.qty));
    if (!VARIANT_RX.test(id) || !(qty >= 1 && qty <= MAX_QTY)) return null;
    merged.set(id, Math.min(MAX_QTY, (merged.get(id) || 0) + qty));
  }
  return Array.from(merged, ([variantId, qty]) => ({ variantId, qty }));
}

function cleanAddress(a, states, needContact) {
  a = a || {};
  const errors = {};
  const s = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const out = {
    name: s(a.name, 80), phone: String(a.phone || '').replace(/\D/g, '').slice(-10), email: s(a.email, 120).toLowerCase(),
    address1: s(a.address1, 120), address2: s(a.address2, 120), city: s(a.city, 60),
    zip: String(a.zip || '').replace(/\D/g, ''), state: s(a.state, 4).toUpperCase()
  };
  if (needContact) {
    if (out.name.length < 2) errors.name = 'Enter your full name.';
    if (!/^[6-9]\d{9}$/.test(out.phone)) errors.phone = 'Enter a 10 digit mobile number.';
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.email = 'Check the email address.';
  }
  if (out.address1.length < 3) errors.address1 = 'Enter the house, street or building.';
  if (out.city.length < 2) errors.city = 'Enter the town or city.';
  if (!/^[1-9]\d{5}$/.test(out.zip)) errors.zip = 'Enter a 6 digit pincode.';
  if (!states.some((st) => st[0] === out.state)) errors.state = 'Choose the state.';
  return { address: out, errors: errors, ok: Object.keys(errors).length === 0 };
}

function shopifyAddress(a) {
  const parts = a.name ? a.name.split(' ') : [];
  const last = parts.length > 1 ? parts.slice(1).join(' ') : (parts[0] || '');
  const first = parts.length > 1 ? parts[0] : '';
  const out = {
    firstName: first, lastName: last, address1: a.address1, city: a.city,
    provinceCode: a.state, countryCode: 'IN', zip: a.zip
  };
  if (a.address2) out.address2 = a.address2;
  if (a.phone) out.phone = '+91' + a.phone;
  return out;
}

/* ------------------------------------------------------------ the checkout */

function createCheckout(deps) {
  const admin = deps.admin;
  const rzp = deps.razorpay;
  const C = deps.catalogue || {};
  const now = deps.now || (() => Date.now());
  const states = C.states || [];
  const conf = C.checkout || {};

  function codRule(total) {
    if (conf.cod === false) return { allowed: false, why: 'Cash on delivery is not offered right now.' };
    const max = conf.codMaxRupees ? conf.codMaxRupees * 100 : null;
    if (max && total > max) return { allowed: false, why: 'Cash on delivery is available up to ₹' + conf.codMaxRupees.toLocaleString('en-IN') + '.', max: max };
    return { allowed: true, max: max };
  }

  async function variantsOf(lines) {
    const data = await admin.query(Q.variants, { ids: lines.map((l) => l.variantId) });
    const byId = new Map(((data && data.nodes) || []).filter(Boolean).map((n) => [n.id, n]));
    return lines.map((l) => {
      const v = byId.get(l.variantId);
      const ok = !!(v && v.availableForSale && (!v.product || !v.product.status || v.product.status === 'ACTIVE'));
      return {
        variantId: l.variantId, qty: l.qty, available: ok,
        title: v && v.product ? v.product.title : 'An item no longer in the store',
        handle: v && v.product ? v.product.handle : '',
        variantTitle: v ? String(v.title || '').replace(/^Default Title$/, '') : '',
        unitPaise: v ? paise(v.price) : null,
        image: v ? ((v.image && v.image.url) || (v.product && v.product.featuredImage && v.product.featuredImage.url) || null) : null
      };
    });
  }

  async function calculate(input) {
    const data = await admin.query(Q.calc, { input: input });
    const r = data && data.draftOrderCalculate;
    const errs = (r && r.userErrors) || [];
    if (errs.length || !r || !r.calculatedDraftOrder) {
      throw Object.assign(new Error((errs[0] && errs[0].message) || 'calculation failed'), { business: true });
    }
    return r.calculatedDraftOrder;
  }

  function baseInput(lines, address) {
    return {
      lineItems: lines.map((l) => ({ variantId: l.variantId, quantity: l.qty })),
      shippingAddress: shopifyAddress(address),
      presentmentCurrencyCode: 'INR'
    };
  }

  /** Prices the bag for an address. { ok, ... } or { ok: false, error }. */
  async function quote(input) {
    const lines = cleanLines(input && input.lines);
    if (!lines) return { ok: false, error: 'The bag is empty or could not be read. Refresh and try again.' };
    const addr = cleanAddress(input.address, states, false);
    if (!addr.ok) return { ok: false, error: 'Check the address.', fields: addr.errors };
    const items = await variantsOf(lines);
    const gone = items.filter((i) => !i.available);
    if (gone.length) {
      return { ok: false, error: 'Some items have just sold out. Remove them from the bag to continue.', unavailable: gone.map((g) => g.variantId), items: items };
    }
    const first = await calculate(baseInput(lines, addr.address));
    const rates = (first.availableShippingRates || []).map((r) => ({
      handle: String(r.handle || ''), title: String(r.title || 'Delivery'), paise: paise(r.price && r.price.amount)
    })).filter((r) => r.handle && r.paise !== null).sort((a, b) => a.paise - b.paise);
    if (!rates.length) {
      return { ok: false, error: 'We cannot deliver to pincode ' + addr.address.zip + ' yet. Try another address, or talk to us and we will find a way.' };
    }
    const rate = rates.find((r) => r.handle === input.rate) || rates[0];
    const priced = await calculate(Object.assign(baseInput(lines, addr.address), {
      shippingLine: { title: rate.title, shippingRateHandle: rate.handle, priceWithCurrency: { amount: rupees(rate.paise), currencyCode: 'INR' } }
    }));
    const total = money(priced.totalPriceSet);
    return {
      ok: true,
      items: items,
      rates: rates,
      rate: rate.handle,
      subtotal: money(priced.subtotalPriceSet),
      shipping: money(priced.totalShippingPriceSet),
      tax: money(priced.totalTaxSet),
      taxesIncluded: priced.taxesIncluded !== false,
      total: total,
      cod: codRule(total),
      online: rzp.configured(),
      _lines: lines,
      _address: addr.address,
      _rate: rate
    };
  }

  function publicQuote(q) {
    const out = Object.assign({}, q);
    delete out._lines; delete out._address; delete out._rate;
    return out;
  }

  async function complete(draftId, pending) {
    const data = await admin.query(Q.complete, { id: draftId, pending: !!pending });
    const r = data && data.draftOrderComplete;
    const order = r && r.draftOrder && r.draftOrder.order;
    if (order && order.name) return order;
    /* Completed already (a second confirm, or the webhook got there first). */
    const d = await admin.query(Q.draft, { id: draftId });
    const dd = d && d.draftOrder;
    if (dd && dd.order && dd.order.name) return dd.order;
    throw new Error('complete failed: ' + ((r && r.userErrors && r.userErrors[0] && r.userErrors[0].message) || 'no order'));
  }

  /** Places the order. Cash on delivery finishes here; online returns the
   *  Razorpay order to open. */
  async function place(input) {
    const payment = input && input.payment === 'online' ? 'online' : input && input.payment === 'cod' ? 'cod' : null;
    if (!payment) return { ok: false, error: 'Choose how you would like to pay.' };
    const addr = cleanAddress(input.address, states, true);
    if (!addr.ok) return { ok: false, error: 'Check the details marked below.', fields: addr.errors };
    const q = await quote({ lines: input.lines, address: addr.address, rate: input.rate });
    if (!q.ok) return q;
    if (input.expectTotal !== undefined && Number(input.expectTotal) !== q.total) {
      return Object.assign(publicQuote(q), { ok: false, changed: true, error: 'Prices or delivery changed since you looked. Check the new total and place the order again.' });
    }
    if (payment === 'cod' && !q.cod.allowed) return { ok: false, error: q.cod.why };
    if (payment === 'online' && !rzp.configured()) return { ok: false, error: 'Online payment is not switched on yet. Choose cash on delivery.' };

    const a = addr.address;
    const draftInput = Object.assign(baseInput(q._lines, a), {
      billingAddress: shopifyAddress(a),
      phone: '+91' + a.phone,
      shippingLine: { title: q._rate.title, shippingRateHandle: q._rate.handle, priceWithCurrency: { amount: rupees(q._rate.paise), currencyCode: 'INR' } },
      note: payment === 'cod' ? 'Cash on delivery. Placed on pawsandtails24.vercel.app.' : 'Paying online with Razorpay. Placed on pawsandtails24.vercel.app.',
      tags: ['pawsandtails24.vercel.app', payment === 'cod' ? 'Cash on delivery' : 'Razorpay'],
      customAttributes: [{ key: 'Payment', value: payment === 'cod' ? 'Cash on delivery' : 'Razorpay' }]
    });
    if (a.email) draftInput.email = a.email;
    if (payment === 'online') draftInput.reserveInventoryUntil = new Date(now() + 30 * 60 * 1000).toISOString();

    const data = await admin.query(Q.create, { input: draftInput });
    const r = data && data.draftOrderCreate;
    const draft = r && r.draftOrder;
    if (!draft || !draft.id) {
      const msg = r && r.userErrors && r.userErrors[0] && r.userErrors[0].message;
      return { ok: false, error: 'The store could not take the order' + (msg ? ': ' + msg : '') + '. Try again, or talk to us.' };
    }
    const total = money(draft.totalPriceSet);

    if (payment === 'cod') {
      const order = await complete(draft.id, true);
      return { ok: true, placed: true, order: { name: order.name, total: total, payment: 'cod' } };
    }

    const ro = await rzp.createOrder(total, draft.name, { draft_id: draft.id, draft_name: draft.name });
    return {
      ok: true,
      placed: false,
      pay: {
        key: rzp.keyId(), orderId: ro.id, amount: ro.amount, currency: 'INR', name: 'Paws and Tails',
        description: 'Order ' + draft.name,
        prefill: { name: a.name, email: a.email || '', contact: '+91' + a.phone }
      },
      total: total
    };
  }

  /** Turns a paid Razorpay order into a placed Shopify order. Safe to call
   *  more than once (the popup and the webhook can both arrive). */
  async function finishPaid(rzOrderId, paymentId) {
    let ro = await rzp.fetchOrder(rzOrderId);
    if (ro.status !== 'paid') {
      const pays = await rzp.orderPayments(rzOrderId);
      const auth = ((pays && pays.items) || []).find((p) => p.status === 'authorized' && (!paymentId || p.id === paymentId));
      if (auth) { await rzp.capture(auth.id, auth.amount); ro = await rzp.fetchOrder(rzOrderId); }
    }
    if (ro.status !== 'paid' || Number(ro.amount_paid) < Number(ro.amount)) {
      return { ok: false, error: 'The payment has not come through yet. If money left your account, it is refunded automatically; you can also talk to us.' };
    }
    const draftId = ro.notes && ro.notes.draft_id;
    if (!draftId) return { ok: false, error: 'This payment is not linked to an order. Talk to us with the payment id ' + (paymentId || '') + '.' };
    const d = await admin.query(Q.draft, { id: draftId });
    const draft = d && d.draftOrder;
    if (!draft) return { ok: false, error: 'The order for this payment could not be found. Talk to us with the payment id ' + (paymentId || '') + '.' };
    if (draft.order && draft.order.name) {
      return { ok: true, placed: true, order: { name: draft.order.name, total: money(draft.totalPriceSet), payment: 'online' } };
    }
    if (money(draft.totalPriceSet) !== Number(ro.amount)) {
      return { ok: false, error: 'The amount paid does not match the order. Our team will sort it out; talk to us with the payment id ' + (paymentId || '') + '.' };
    }
    await admin.query(Q.update, { id: draftId, input: { note: 'Paid online with Razorpay. Payment ' + (paymentId || '') + ', Razorpay order ' + rzOrderId + '. Placed on pawsandtails24.vercel.app.' } })
      .catch(() => null);
    const order = await complete(draftId, false);
    return { ok: true, placed: true, order: { name: order.name, total: money(draft.totalPriceSet), payment: 'online' } };
  }

  async function confirm(input) {
    const oid = String((input && input.razorpay_order_id) || '');
    const pid = String((input && input.razorpay_payment_id) || '');
    const sig = String((input && input.razorpay_signature) || '');
    if (!oid || !pid || !rzp.verifyPayment(oid, pid, sig)) {
      return { ok: false, error: 'The payment could not be verified. If money left your account, it is refunded automatically; you can also talk to us.' };
    }
    return finishPaid(oid, pid);
  }

  /** The popup was closed without paying: remove the unpaid draft. */
  async function abandon(input) {
    const oid = String((input && input.razorpay_order_id) || '');
    if (!oid) return { ok: true };
    const ro = await rzp.fetchOrder(oid).catch(() => null);
    if (!ro || ro.status === 'paid' || ro.status === 'attempted') return { ok: true };
    const draftId = ro.notes && ro.notes.draft_id;
    if (!draftId) return { ok: true };
    const d = await admin.query(Q.draft, { id: draftId }).catch(() => null);
    if (d && d.draftOrder && !d.draftOrder.order && d.draftOrder.status === 'OPEN') {
      await admin.query(Q.remove, { input: { id: draftId } }).catch(() => null);
    }
    return { ok: true };
  }

  return { quote: async (i) => { const q = await quote(i); return q.ok ? publicQuote(q) : q; }, place, confirm, abandon, finishPaid };
}

module.exports = { createCheckout, cleanLines, cleanAddress, shopifyAddress, paise, QUERIES: Q };
