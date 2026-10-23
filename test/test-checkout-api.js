#!/usr/bin/env node
/* ============================================================================
 * Tests for the on-site checkout (api/checkout.js, lib/checkout.js) and the
 * Razorpay webhook, against stand-ins for Shopify's Admin API and Razorpay.
 *
 *   node test/test-checkout-api.js
 * ========================================================================== */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const checkoutApi = require(path.join(ROOT, 'api', 'checkout.js'));
const webhookApi = require(path.join(ROOT, 'api', 'razorpay-webhook.js'));
const orderApi = require(path.join(ROOT, 'api', 'order.js'));
const C = require(path.join(ROOT, 'assets', 'catalogue.js'));
const mockStore = require('./mock-store.js');
const mockAdmin = require('./mock-admin.js');
const mockRazorpay = require('./mock-razorpay.js');

let passed = 0;
const failures = [];
function ok(what, cond) { if (cond) passed++; else failures.push(what); }
function eq(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else failures.push(what + '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}
function section(name) { process.stdout.write('\n  ' + name + '\n'); }

const products = mockStore.products;
const one = products.find((p) => p.availableForSale && p.variants.length === 1);
const multi = products.find((p) => p.availableForSale && p.variants.length === 3 && p.variants.every((v) => v.availableForSale));
const soldOut = products.find((p) => !p.availableForSale);
const rupee = (v) => Math.round(Number(v.price.amount) * 100);

const ADDRESS = { name: 'Asha Rao', phone: '98450 12345', email: 'asha@example.com', address1: '12 Temple Road', address2: 'Near the tank',
  city: 'Udupi', zip: '576101', state: 'KA' };

function rig(catalogue) {
  const admin = mockAdmin({ products: products });
  const rzp = mockRazorpay();
  const env = Object.assign({}, admin.env, rzp.env);
  const fetchImpl = (url, init) => (/razorpay\.com/.test(String(url)) ? rzp.fetch(url, init) : admin.fetch(url, init));
  return {
    admin, rzp,
    api: checkoutApi.createHandler({ env: env, fetchImpl: fetchImpl, catalogue: catalogue || C }),
    hook: webhookApi.createHandler({ env: env, fetchImpl: fetchImpl }),
    orders: orderApi.createHandler({ env: env, fetchImpl: fetchImpl })
  };
}
const run = (api, body) => api.run(body, '10.1.1.' + Math.floor(Math.random() * 200)).then((r) => r.body);
function hookCall(handler, body, sig) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, end: (t) => resolve({ status: res.statusCode, body: JSON.parse(t) }) };
    handler({ method: 'POST', body: body, headers: { 'x-razorpay-signature': sig } }, res);
  });
}

(async function main() {
  const LINES = [{ variantId: one.variants[0].id, qty: 2 }, { variantId: multi.variants[1].id, qty: 1 }];
  const subtotal = rupee(one.variants[0]) * 2 + rupee(multi.variants[1]);

  section('before the store is connected');
  {
    const h = checkoutApi.createHandler({ env: {} });
    eq('says so, rather than failing', await run(h, { action: 'quote', lines: LINES, address: ADDRESS }), { ok: false, configured: false });
  }

  section('pricing the bag for an address');
  {
    const r = rig();
    const q = await run(r.api, { action: 'quote', lines: LINES, address: ADDRESS });
    ok('the store prices it', q.ok === true);
    eq('subtotal from the store\'s own prices', q.subtotal, subtotal);
    eq('delivery options, cheapest first', q.rates.map((x) => x.handle), [subtotal >= 99900 ? 'mock-free' : 'mock-standard', 'mock-express']);
    eq('the cheapest is chosen to start', q.rate, q.rates[0].handle);
    eq('total is subtotal plus delivery', q.total, subtotal + q.shipping);
    ok('tax is shown as included', q.taxesIncluded === true && q.tax > 0);
    eq('each item with its name, price and quantity', q.items.map((i) => [i.title, i.unitPaise, i.qty]),
      [[one.title, rupee(one.variants[0]), 2], [multi.title, rupee(multi.variants[1]), 1]]);
    ok('cash on delivery and online both offered', q.cod.allowed === true && q.online === true);
    ok('nothing internal leaks out', q._lines === undefined && q._address === undefined && q._rate === undefined);

    const exp = await run(r.api, { action: 'quote', lines: LINES, address: ADDRESS, rate: 'mock-express' });
    eq('choosing express prices express', [exp.rate, exp.shipping], ['mock-express', 14900]);

    const far = await run(r.api, { action: 'quote', lines: LINES, address: Object.assign({}, ADDRESS, { zip: '960001' }) });
    ok('a pincode the store does not deliver to says so', far.ok === false && /cannot deliver to pincode 960001/.test(far.error));

    const gone = await run(r.api, { action: 'quote', lines: [{ variantId: soldOut.variants[0].id, qty: 1 }], address: ADDRESS });
    ok('a sold out item is named, not charged', gone.ok === false && gone.unavailable.length === 1 && /sold out/.test(gone.error));

    const junk = await run(r.api, { action: 'quote', lines: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 999 }], address: ADDRESS });
    ok('a silly quantity is refused', junk.ok === false);
    const noaddr = await run(r.api, { action: 'quote', lines: LINES, address: { zip: '12' } });
    ok('a bad address points at the fields', noaddr.ok === false && noaddr.fields && noaddr.fields.zip && noaddr.fields.state);
    eq('no draft orders were left behind by pricing', r.admin.stats.draftsCreated || 0, 0);
  }

  section('cash on delivery');
  {
    const r = rig();
    const q = await run(r.api, { action: 'quote', lines: LINES, address: ADDRESS });
    const p = await run(r.api, { action: 'place', payment: 'cod', lines: LINES, address: ADDRESS, rate: q.rate, expectTotal: q.total });
    ok('the order is placed', p.ok && p.placed && /^#\d+$/.test(p.order.name));
    eq('for the quoted total, as cash on delivery', [p.order.total, p.order.payment], [q.total, 'cod']);
    const made = r.admin.placed[0];
    eq('in the store as payment pending', made && made.displayFinancialStatus, 'PENDING');
    const draft = Array.from(r.admin.drafts.values())[0];
    ok('tagged as from this site and cash on delivery', draft.input.tags.indexOf('pawsandtails24.vercel.app') >= 0 && draft.input.tags.indexOf('Cash on delivery') >= 0);
    eq('with the shopper\'s address in the store\'s format', [draft.input.shippingAddress.provinceCode, draft.input.shippingAddress.countryCode, draft.input.shippingAddress.phone, draft.input.shippingAddress.lastName],
      ['KA', 'IN', '+919845012345', 'Rao']);
    const found = await r.orders.lookup({ order: p.order.name, contact: '9845012345' });
    eq('and tracking finds it straight away', [found.body.found, found.body.order.stage], [true, 'placed']);

    const noPhone = await run(r.api, { action: 'place', payment: 'cod', lines: LINES, address: Object.assign({}, ADDRESS, { phone: '12345' }), rate: q.rate });
    ok('a wrong mobile number is pointed at', noPhone.ok === false && noPhone.fields.phone);
    const moved = await run(r.api, { action: 'place', payment: 'cod', lines: LINES, address: ADDRESS, rate: q.rate, expectTotal: q.total - 100 });
    ok('a total that changed since the shopper looked is not placed', moved.ok === false && moved.changed === true && moved.total === q.total);
    const nopay = await run(r.api, { action: 'place', lines: LINES, address: ADDRESS });
    ok('no payment choice, no order', nopay.ok === false && /how you would like to pay/.test(nopay.error));

    const capped = rig(Object.assign({}, C, { checkout: Object.assign({}, C.checkout, { codMaxRupees: 100 }) }));
    const big = await run(capped.api, { action: 'place', payment: 'cod', lines: LINES, address: ADDRESS });
    ok('cash on delivery above the store\'s limit is refused, with the limit', big.ok === false && /up to ₹100/.test(big.error));
    eq('and nothing was created', capped.admin.stats.draftsCreated || 0, 0);
  }

  section('paying online with Razorpay');
  {
    const r = rig();
    const q = await run(r.api, { action: 'quote', lines: LINES, address: ADDRESS });
    const p = await run(r.api, { action: 'place', payment: 'online', lines: LINES, address: ADDRESS, rate: q.rate, expectTotal: q.total });
    ok('gives the popup what it needs', p.ok && !p.placed && p.pay && p.pay.key === 'rzp_test_mock' && /^order_mock/.test(p.pay.orderId));
    eq('the amount is the store\'s total, set by the server', p.pay.amount, q.total);
    eq('with the shopper filled in', p.pay.prefill, { name: 'Asha Rao', email: 'asha@example.com', contact: '+919845012345' });
    const ro = r.rzp.orders.get(p.pay.orderId);
    const draft = r.admin.drafts.get(ro.notes.draft_id);
    ok('a draft waits in the store, holding the stock for 30 minutes', draft && draft.status === 'OPEN' && !!draft.input.reserveInventoryUntil);
    eq('and no order exists until it is paid', r.admin.placed.length, 0);

    const forged = await run(r.api, { action: 'confirm', razorpay_order_id: p.pay.orderId, razorpay_payment_id: 'pay_fake', razorpay_signature: 'deadbeef' });
    ok('a forged confirmation is refused', forged.ok === false && /could not be verified/.test(forged.error));
    eq('and places nothing', r.admin.placed.length, 0);

    const signedUnpaid = r.rzp.pay(p.pay.orderId, { authorizeOnly: true });
    const c1 = await run(r.api, Object.assign({ action: 'confirm' }, signedUnpaid));
    ok('an authorised payment is captured, then the order placed', c1.ok && c1.placed && /^#\d+$/.test(c1.order.name));
    eq('as paid', r.admin.placed[0].displayFinancialStatus, 'PAID');
    ok('with the payment id on the order note', /pay_mock/.test(draft.input.note));
    const c2 = await run(r.api, Object.assign({ action: 'confirm' }, signedUnpaid));
    eq('confirming twice gives the same order, not a second one', [c2.order.name, r.admin.placed.length], [c1.order.name, 1]);

    const w = r.rzp.webhook('order.paid', p.pay.orderId, signedUnpaid.razorpay_payment_id);
    const wr = await hookCall(r.hook, w.body, w.signature);
    eq('the webhook arriving afterwards changes nothing', [wr.status, wr.body.order, r.admin.placed.length], [200, c1.order.name, 1]);
  }

  section('when things go wrong');
  {
    const r = rig();
    const p = await run(r.api, { action: 'place', payment: 'online', lines: LINES, address: ADDRESS });
    const short = r.rzp.pay(p.pay.orderId, { amount: 100 });
    const c = await run(r.api, Object.assign({ action: 'confirm' }, short));
    ok('a part payment does not place the order', c.ok === false && r.admin.placed.length === 0);

    const p2 = await run(r.api, { action: 'place', payment: 'online', lines: LINES, address: ADDRESS });
    const draftId = r.rzp.orders.get(p2.pay.orderId).notes.draft_id;
    await run(r.api, { action: 'abandon', razorpay_order_id: p2.pay.orderId });
    ok('closing the popup without paying removes the unpaid draft', !r.admin.drafts.has(draftId));

    const p3 = await run(r.api, { action: 'place', payment: 'online', lines: LINES, address: ADDRESS });
    const paid3 = r.rzp.pay(p3.pay.orderId);
    const bad = await hookCall(r.hook, r.rzp.webhook('order.paid', p3.pay.orderId, paid3.razorpay_payment_id).body, 'wrong');
    eq('a webhook with a wrong signature is refused', [bad.status, r.admin.placed.length], [401, 0]);
    const w3 = r.rzp.webhook('payment.captured', p3.pay.orderId, paid3.razorpay_payment_id);
    const good = await hookCall(r.hook, w3.body, w3.signature);
    ok('paid, tab closed: the webhook places the order on its own', good.status === 200 && /^#\d+$/.test(good.body.order) && r.admin.placed.length === 1);
    const late = await run(r.api, Object.assign({ action: 'confirm' }, paid3));
    eq('and the page catching up later shows that same order', late.order.name, good.body.order);

    const off = rig();
    const env = Object.assign({}, off.admin.env);
    const noRzp = checkoutApi.createHandler({ env: env, fetchImpl: off.admin.fetch });
    const q = await run(noRzp, { action: 'quote', lines: LINES, address: ADDRESS });
    eq('without Razorpay keys, online is not offered', q.online, false);
    const try1 = await run(noRzp, { action: 'place', payment: 'online', lines: LINES, address: ADDRESS });
    ok('and asking for it anyway is refused politely', try1.ok === false && /cash on delivery/.test(try1.error));

    const down = checkoutApi.createHandler({ env: off.admin.env, fetchImpl: () => Promise.reject(new Error('offline')) });
    const dr = await down.run({ action: 'quote', lines: LINES, address: ADDRESS }, '1.1.1.1');
    ok('the store not answering says nothing was charged', dr.status === 502 && /Nothing was charged/.test(dr.body.error));
  }

  process.stdout.write('\n');
  if (failures.length) {
    failures.forEach((f) => process.stdout.write('  FAILED  ' + f + '\n'));
    process.stdout.write('\n  checkout api: ' + passed + ' passed, ' + failures.length + ' failed.\n\n');
    process.exit(1);
  }
  process.stdout.write('  checkout api: ' + passed + ' passed, 0 failed.\n\n');
}());
