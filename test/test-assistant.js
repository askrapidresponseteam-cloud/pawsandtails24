#!/usr/bin/env node
/* ============================================================================
 * Tests for the assistant (assets/assistant.js)
 * ============================================================================
 * The reading rules on their own (order numbers, phones, pincodes, prices,
 * delivery wording), then whole conversations against the mock store, which
 * runs the real order lookup against a stand-in Admin API. No language model
 * anywhere: every answer is checked against the store's own data.
 *
 *   node test/test-assistant.js
 * ========================================================================== */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const A = require(path.join(ROOT, 'assets', 'assistant.js'));
const S = require(path.join(ROOT, 'assets', 'storefront.js'));
const C = require(path.join(ROOT, 'assets', 'catalogue.js'));
const mock = require('./mock-store.js');

const PORT = 4229;
let passed = 0;
const failures = [];
function ok(what, cond) { if (cond) passed++; else failures.push(what); }
function eq(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else failures.push(what + '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}
function section(name) { process.stdout.write('\n  ' + name + '\n'); }

const textOf = (r) => r.blocks.filter((b) => b.type === 'text').map((b) => b.text + (b.note ? ' ' + b.note : '')).join(' ');
const cardsOf = (r) => (r.blocks.find((b) => b.type === 'products') || { items: [] }).items;
const orderOf = (r) => (r.blocks.find((b) => b.type === 'order') || {}).order || null;

(async function run() {
  section('reading what the shopper typed');
  eq('order with a hash', A.parseOrderNo('where is #1042?'), '1042');
  eq('order in words', A.parseOrderNo('my order no. is 1042'), '1042');
  eq('"track 1042"', A.parseOrderNo('track 1042'), '1042');
  eq('a mobile number is not an order', A.parseOrderNo('call me on 9876543210'), null);
  eq('a bare number only when one was asked for', [A.parseOrderNo('1042'), A.parseOrderNo('1042', true)], [null, '1042']);
  eq('a phone with +91 and spaces', A.parseContact('it is +91 98450-12345'), '9845012345');
  eq('an email', A.parseContact('use Asha@Example.com please'), 'asha@example.com');
  eq('a pincode', A.parsePin('deliver to 576101?'), '576101');
  eq('a phone is not a pincode', A.parsePin('9876543210'), null);
  eq('under 500', A.parsePrice('best deworming under 500'), { max: 50000 });
  eq('below rupee sign 1,200', A.parsePrice('food below ₹1,200'), { max: 120000 });
  eq('within 2k', A.parsePrice('within 2k'), { max: 200000 });
  eq('between 200 and 400', A.parsePrice('between rs 200 and 400'), { min: 20000, max: 40000 });
  eq('above 1000', A.parsePrice('above 1000'), { min: 100000 });
  eq('for rs 500 reads as a budget', A.parsePrice('something for rs 500'), { max: 50000 });
  eq('a pack size is not a price', A.parsePrice('the 3 kg pack'), {});

  section('understanding what is asked');
  const cases = {
    'best deworming under 500': 'product', 'cheapest cat food': 'product', 'do you have drools': 'product',
    'where is my order': 'track', 'track #1042': 'track', 'has my order shipped?': 'track',
    'when will it arrive if I order today': 'delivery', 'do you deliver to 576101': 'delivery',
    'what are the shipping charges': 'fee', 'is cash on delivery available': 'pay',
    'I want to return a damaged item': 'returns', 'cancel my order': 'cancelOrder',
    'talk to a person': 'human', 'hi': 'greet', 'thanks!': 'thanks'
  };
  Object.keys(cases).forEach((q) => eq('"' + q + '"', A.classify(q, {}), cases[q]));

  section('delivery times from the shipping page');
  const shipText = S.plainText(mock.POLICY.shipping);
  const terms = A.parseDelivery(shipText);
  eq('dispatch time', terms.dispatch, { min: 1, max: 2, business: true });
  eq('metro and rest of India, each labelled', terms.ranges.map((r) => [r.min, r.max, r.label]), [[3, 5, 'metro'], [5, 8, 'rest']]);
  eq('return windows are not delivery times', A.parseDelivery('Unopened items can be returned within 7 days.').ranges, []);
  eq('hours become days', A.parseDelivery('Ships within 24 hours. Delivered in 4 to 6 days.').dispatch, { min: 1, max: 1, business: false, upTo: true });
  const thu = new Date(2026, 9, 22, 18, 0); /* Thu 22 Oct 2026 */
  const metro = A.estimate(terms, { start: thu, region: A.regionOfPin('560001') });
  eq('Bengaluru: dispatch plus metro time, skipping Sunday', A.fmtEta(metro), 'between Tue 27 Oct and Fri 30 Oct');
  const rest = A.estimate(terms, { start: thu, region: A.regionOfPin('576101') });
  eq('Udupi: rest of India time', A.fmtEta(rest), 'between Thu 29 Oct and Tue 3 Nov');
  eq('a pincode tells metro from not', [A.regionOfPin('700019'), A.regionOfPin('576101')], [{ metro: true, city: 'Kolkata' }, { metro: false, city: null }]);
  const none = A.estimate({ dispatch: null, ranges: [] }, { start: thu, fallback: [3, 7] });
  eq('no times on the page: the usual range, said as usual', [none.basis, none.days], ['usual', [3, 7]]);
  eq('"within 7 days" reads as a date to expect it by', A.fmtEta(A.estimate(A.parseDelivery('We deliver within 7 business days.'), { start: thu })), 'by Fri 30 Oct');
  eq('working days skip Sundays', A.fmtDay(A.addDays(new Date(2026, 9, 24), 1, true)), 'Mon 26 Oct');

  section('when an order arrives');
  const courier = A.orderEta({ stage: 'shipped', shipments: [{ estimatedAt: '2026-10-24T10:00:00Z' }] }, terms);
  eq('the courier\'s own date wins', [courier.basis, A.fmtDay(courier.from)], ['courier', 'Sat 24 Oct']);
  const delivered = A.orderEta({ stage: 'delivered', shipments: [{ deliveredAt: '2026-10-20T10:00:00Z' }] }, terms);
  eq('delivered says when', A.fmtDay(delivered.delivered), 'Tue 20 Oct');
  eq('cancelled has no date', A.orderEta({ stage: 'cancelled', shipments: [] }, terms), null);
  const placed = A.orderEta({ stage: 'placed', placedAt: thu.toISOString(), zip: '700019', shipments: [] }, terms);
  eq('not yet shipped: counted from the order, for its pincode', [placed.basis, A.fmtEta(placed)], ['policy', 'between Tue 27 Oct and Fri 30 Oct']);

  /* ------------------------------------------------- whole conversations */
  await new Promise((r) => mock.server.listen(PORT, r));
  const memory = new Map();
  S.configure({ apiBase: 'http://localhost:' + PORT, version: C.apiVersion, quiet: true, brands: C.brands,
    storage: { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) } });
  const cols = () => S.collections().then((l) => l.filter((c) => c.hasProducts && C.hidden.indexOf(c.handle) < 0));
  const fresh = () => A.create({ S: S, C: C, collections: cols, now: () => thu });

  section('product picks from the live catalogue');
  {
    const bot = fresh();
    const r = await bot.reply('best deworming under 500');
    const picks = cardsOf(r);
    const deworm = mock.products.filter((p) => p.aisles.indexOf('deworming') >= 0);
    ok('shows up to three picks', picks.length > 0 && picks.length <= 3);
    ok('every pick is deworming', picks.every((p) => deworm.some((d) => d.handle === p.handle)));
    ok('every pick is under ₹500', picks.every((p) => p.paise <= 50000));
    ok('every pick is in stock', picks.every((p) => p.available));
    eq('in the store\'s best-seller order', picks.map((p) => p.handle), deworm.filter((p) => p.availableForSale).map((p) => p.handle).slice(0, picks.length));
    ok('says how they were ranked', /best-selling/i.test(textOf(r)) && /sells most/i.test(textOf(r)));
    ok('and to check the dose with a vet', /vet/i.test(textOf(r)));
    eq('with a link to the whole collection', r.blocks.find((b) => b.type === 'products').more.href, '#/c/deworming');
    ok('a single-size pick can go straight in the bag', picks.some((p) => !!p.quickVariant));

    const low = await bot.reply('best deworming under 100');
    ok('nothing under the limit says so honestly', /nothing in deworming is under ₹100/i.test(textOf(low)));
    ok('and shows the cheapest there is', cardsOf(low).length === 1 && /lowest price/i.test(textOf(low)));

    const cheap = await bot.reply('cheapest cat food');
    const cp = cardsOf(cheap).map((p) => p.paise);
    ok('cheapest is lowest price first', cp.length > 1 && cp.every((p, i) => i === 0 || p >= cp[i - 1]));

    const range = await bot.reply('flea and tick for my dog between 1000 and 2000');
    ok('a price range keeps to it', cardsOf(range).length > 0 && cardsOf(range).every((p) => p.paise >= 100000 && p.paise <= 200000));

    const brand = await bot.reply('drools');
    ok('a brand finds that brand, though the store lists everything under its own name', cardsOf(brand).length > 0 && cardsOf(brand).every((p) => p.brand === 'Drools'));

    const puppy = await bot.reply('food for my puppy');
    ok('a puppy asks for puppy food', /puppy food/i.test(textOf(puppy)));

    const unknown = await bot.reply('zzqx wobble');
    ok('something the store does not have says so', /could not find/i.test(textOf(unknown)) && cardsOf(unknown).length === 0);
  }

  section('tracking an order step by step');
  {
    const bot = fresh();
    let r = await bot.reply('where is my order');
    ok('asks for the order number', /order number/i.test(textOf(r)));
    r = await bot.reply('1002');
    ok('then for the phone or email', /phone number or email/i.test(textOf(r)) && /#1002/.test(textOf(r)));
    r = await bot.reply('98765 43210');
    const o = orderOf(r);
    eq('finds the order', o && o.name, '#1002');
    ok('says it is on its way with the courier', /on its way with Blue Dart/.test(textOf(r)));
    ok('and the courier\'s date', /courier expects to deliver it on/i.test(textOf(r)));
    r = await bot.reply('when will it arrive?');
    ok('"when will it arrive" then means that order', /#1002/.test(textOf(r)));

    r = await bot.reply('track #1001 asha@example.com');
    ok('everything in one message works too', /#1001 was delivered on/.test(textOf(r)));

    r = await bot.reply('track 1003');
    ok('a new order number asks for its contact again', /used for order #1003/.test(textOf(r)));
    r = await bot.reply('ravi@example.com');
    ok('a new order is estimated from the shipping page', /should reach you between/.test(textOf(r)) && /shipping page/i.test(textOf(r)));

    r = await bot.reply('track #1004 kiran@example.com');
    ok('a cancelled order says so', /was cancelled/.test(textOf(r)));

    r = await bot.reply('track #1001 wrong@example.com');
    ok('a wrong contact is not found, and says both must match', /could not find order #1001/i.test(textOf(r)) && /both have to be/i.test(textOf(r)));
    ok('nothing about the order leaks', !orderOf(r));
  }

  section('questions answered from the store\'s own pages');
  {
    const bot = fresh();
    let r = await bot.reply('do you deliver to 560001?');
    ok('a pincode gets dates for that place', /Bengaluru \(560001\) between Tue 27 Oct and Fri 30 Oct/.test(textOf(r)));
    r = await bot.reply('how long does delivery take');
    ok('without a pincode, metro and rest of India both', /Metro cities/.test(textOf(r)) && /Rest of India/.test(textOf(r)));
    r = await bot.reply('what are the shipping charges');
    ok('charges come from the shipping page', /free on orders above ₹999/.test(textOf(r)));
    r = await bot.reply('is cash on delivery available');
    ok('cash on delivery from the same page', /Cash on delivery is available/.test(textOf(r)));
    r = await bot.reply('can I return an opened pack');
    ok('returns from the returns page', /returned within 7 days/.test(textOf(r)));
    const pol = r.blocks.find((b) => b.type === 'links');
    eq('with a link to the full policy, on this site', pol && pol.links[0].href, '#/policy/returns');
    r = await bot.reply('talk to a person');
    const links = (r.blocks.find((b) => b.type === 'links') || { links: [] }).links.map((l) => l.href);
    ok('a person: WhatsApp, phone and email', links.some((h) => /wa\.me/.test(h)) && links.some((h) => /^tel:/.test(h)) && links.some((h) => /^mailto:/.test(h)));
  }

  /* ------------------------------------------------ ordering in the chat */

  /* The page side of placing an order, as app.js does it, with the stand-in
   * Razorpay playing the shopper paying (or closing the popup). */
  function shopFor(opts) {
    opts = opts || {};
    let saved = opts.saved || null;
    const calls = { place: 0, setCart: 0 };
    return {
      calls,
      savedAddress: () => saved,
      keepAddress: (a) => { saved = a; },
      setCart: () => { calls.setCart++; },
      stateOfPin: (pin) => (/^5[6-9]/.test(pin) ? 'KA' : /^7/.test(pin) ? 'WB' : ''),
      place: async (p) => {
        calls.place++;
        calls.last = p;
        const r = await S.checkout('place', p);
        if (!r.ok) return r.changed ? { ok: false, changed: true, quote: r, error: r.error } : { ok: false, error: r.error, fields: r.fields || null };
        if (r.placed) { S.forgetCart(); return { ok: true, order: r.order }; }
        if (opts.dismiss) { await S.checkout('abandon', { razorpay_order_id: r.pay.orderId }); return { ok: false, dismissed: true, error: 'Payment not completed. Nothing was charged.' }; }
        const c = await S.checkout('confirm', mock.razorpay.pay(r.pay.orderId));
        if (c.ok) S.forgetCart();
        return c.ok ? { ok: true, order: c.order } : { ok: false, error: c.error };
      }
    };
  }
  const buyer = (shop) => { S.forgetCart(); return A.create({ S: S, C: C, collections: cols, now: () => thu, shop: shop }); };
  const blockOf = (r, type) => r.blocks.find((b) => b.type === type) || null;
  const ADDR = { name: 'Asha Rao', phone: '98450 12345', address1: 'Flat 4, Lake View', address2: 'Temple Road', landmark: 'Krishna Temple', zip: '576101', city: 'Udupi' };
  const acana = mock.products.filter((p) => p.brand === 'Acana' && p.availableForSale);

  section('ordering in the chat: the request from the screenshot');
  {
    const shop = shopFor();
    const bot = buyer(shop);
    let r = await bot.reply('can you place an order for acana');
    const choices = cardsOf(r);
    ok('"can you place an order for acana" finds Acana, though the store lists it under its own name', choices.length >= 2 && choices.every((p) => p.brand === 'Acana'));
    ok('and asks which one', /Which Acana would you like/.test(textOf(r)));
    r = await bot.reply('the second one');
    const detail = blockOf(r, 'detail');
    ok('"the second one" opens its sizes', detail && detail.product.handle === choices[1].handle && /Which size/.test(textOf(r)));
    r = await bot.reply('1 kg');
    const v1kg = acana.find((p) => p.handle === choices[1].handle).variants.find((v) => v.title === '1 kg');
    ok('"1 kg" puts that size in the bag', /Added .*\(1 kg\) to your bag/.test(textOf(r)) && blockOf(r, 'bag').count === 1);
    ok('and asks if anything else is needed', /Anything else you need\?/.test(textOf(r)) && r.chips.some((c) => c.act && c.act.t === 'doneShopping'));
    ok('and tells the page the bag changed', shop.calls.setCart > 0);
    r = await bot.reply('make it 2');
    eq('"make it 2" changes the quantity of what was just added', [blockOf(r, 'bag').count, blockOf(r, 'bag').subtotal], [2, Math.round(Number(v1kg.price.amount) * 100) * 2]);
    const other = mock.products.find((p) => p.availableForSale && p.variants.length === 1 && p.brand !== 'Acana');
    r = await bot.reply('also add ' + other.title);
    ok('"also add ..." while asked for more adds a second item and asks again', blockOf(r, 'bag').lines.length === 2 && /Anything else/.test(textOf(r)));
    r = await bot.reply('no, that\'s all');
    const pc = blockOf(r, 'payChoice');
    ok('"no, that\'s all" asks how to pay', pc && /How would you like to pay/.test(textOf(r)));
    ok('online and cash on delivery both offered', pc.online === true && pc.cod.allowed === true);
    eq('nothing is priced yet', shop.calls.place, 0);
    r = await bot.reply('cash on delivery');
    ok('choosing cash on delivery asks for the full address', blockOf(r, 'address') && /Cash on delivery it is/.test(textOf(r)) && /full delivery address/.test(textOf(r)));
    r = await bot.act({ t: 'address', a: { name: 'A', phone: '123', address1: '', zip: '12', city: '' } });
    const errs = blockOf(r, 'address').errors;
    eq('a bad address comes back with each problem named, street or area included', Object.keys(errs).sort(), ['address1', 'address2', 'city', 'name', 'phone', 'state', 'zip']);
    eq('and nothing is priced or placed', shop.calls.place, 0);
    r = await bot.act({ t: 'address', a: ADDR });
    const sum = blockOf(r, 'summary');
    ok('a good address gives the order summary, priced by the store', sum && sum.total > 0 && sum.rates.length === 2);
    ok('the state was worked out from the pincode', sum.address.state === 'KA');
    ok('it says nothing is charged until the button', /Nothing is charged until you do/.test(textOf(r)));
    eq('the payment chosen earlier is kept', sum.payment, 'cod');
    ok('the landmark is kept', sum.address.landmark === 'Krishna Temple');
    const payChip = r.chips[0];
    ok('the Place order button is also first among the replies, with the total', payChip && payChip.primary && payChip.act.t === 'place' && payChip.act.ref === sum.ref && new RegExp('Place order').test(payChip.label));
    eq('and nothing has been placed yet', shop.calls.place, 0);
    r = await bot.reply('express');
    const sum2 = blockOf(r, 'summary');
    ok('"express" re-prices with express delivery', sum2.rate === 'mock-express' && sum2.total === sum.total + 14900 - sum.shipping);
    r = await bot.reply('pay online');
    eq('"pay online" in the review switches the payment', blockOf(r, 'summary').payment, 'online');
    r = await bot.reply('cash on delivery');
    eq('and back to cash on delivery', blockOf(r, 'summary').payment, 'cod');
    const sum3 = blockOf(r, 'summary');
    r = await bot.act({ t: 'place', ref: sum.ref });
    ok('an out of date summary cannot place the order', /out of date/.test(textOf(r)) && shop.calls.place === 0);
    r = await bot.reply('yes');
    const placed = blockOf(r, 'placed');
    ok('"yes" places it', placed && /^#\d+$/.test(placed.order.name));
    eq('for the total that was shown, cash on delivery', [placed.order.total, placed.order.payment, shop.calls.last.expectTotal], [sum3.total, 'cod', sum3.total]);
    const inStore = mock.admin.placed[mock.admin.placed.length - 1];
    eq('the store has it, payment pending, with what was chosen', [inStore.name, inStore.displayFinancialStatus, inStore.lineItems.nodes[0].quantity, inStore.lineItems.nodes.length], [placed.order.name, 'PENDING', 2, 2]);
    eq('with the full address: street, area and landmark', shop.calls.last.address.address2, 'Temple Road, near Krishna Temple');
    r = await bot.reply('where is my order');
    ok('"where is my order" then knows which one', blockOf(r, 'order') && blockOf(r, 'order').order.name === placed.order.name);
  }

  section('a store that answers brand and title queries with nothing');
  {
    mock.strict.fieldQueries = true;
    S.clearCache(); /* nothing remembered from before the store got strict */
    const bot = buyer(shopFor());
    let r = await bot.reply('i want to buy acana');
    const found = cardsOf(r);
    ok('"i want to buy acana" still finds Acana, from the store\'s own Acana collection', found.length >= 2 && found.every((p) => /^Acana /.test(p.title)));
    ok('and asks which one', /Which Acana/.test(textOf(r)));
    const viaCol = r.blocks.find((b) => b.type === 'products').more;
    eq('with a link to that collection', viaCol && viaCol.href, '#/c/acana');
    r = await bot.reply('i want to buy acana dog food');
    ok('"acana dog food" names the "Acana Dog Food" collection', /Acana Puppy Food/.test(textOf(r) + JSON.stringify(r.blocks)));
    r = await bot.reply('order orijen');
    const orijen = cardsOf(r);
    ok('a brand with no collection is found by the store\'s search instead', orijen.length >= 1 && orijen.every((p) => /^Orijen /.test(p.title)));
    r = await bot.reply('acanna');
    ok('a typo of the brand still lands', cardsOf(r).length > 0 && cardsOf(r).every((p) => /^Acana /.test(p.title)));
    const page = await S.brandPage('Orijen');
    ok('brand pages fall back to search too', page.products.length > 0 && page.products.every((p) => p.brand === 'Orijen') && page.via === 'search');
    mock.strict.fieldQueries = false;
  }

  section('the context of buying');
  {
    const bot = buyer(shopFor());
    let r = await bot.reply('I want to order something');
    ok('"I want to order something" asks what, and does not search for "something"', /What would you like/.test(textOf(r)) && !cardsOf(r).length);
    r = await bot.reply('acana puppy 250g');
    ok('the product named next goes straight into the bag, in that size', /Added Acana Puppy .*\(250 g\) to your bag\. Anything else you need\?/.test(textOf(r)));
    r = await bot.reply('I want to add something else');
    ok('"add something else" asks what, without checking out', /What else would you like/.test(textOf(r)) && !blockOf(r, 'payChoice'));
    r = await bot.reply('drools all medicines everyday pack 250 g');
    ok('a brand with generic words is that brand, added straight away', /Added Drools All Medicines everyday pack \(250 g\)/.test(textOf(r)) && blockOf(r, 'bag').lines.length === 2);
    r = await bot.reply('one more');
    ok('"one more" adds another of the last item and asks again', blockOf(r, 'bag').count === 3 && /Anything else/.test(textOf(r)));
    r = await bot.reply('no');
    ok('"no" moves on to how to pay', !!blockOf(r, 'payChoice'));
    r = await bot.reply('cash on delivery');
    ok('then the full address', !!blockOf(r, 'address'));
  }

  section('paying online in the chat');
  {
    const shop = shopFor({ saved: Object.assign({ state: 'KA' }, ADDR, { phone: '9845012345' }) });
    const bot = buyer(shop);
    const one = mock.products.find((p) => p.availableForSale && p.variants.length === 1);
    let r = await bot.reply('buy 2 ' + one.title);
    ok('a clear match with one size goes straight into the bag, with the quantity', /Added 2 x/.test(textOf(r)) && blockOf(r, 'bag').count === 2);
    r = await bot.reply('checkout');
    ok('"checkout" goes straight to how to pay', !!blockOf(r, 'payChoice'));
    r = await bot.act({ t: 'payMode', p: 'online' });
    ok('then a saved address is offered first', blockOf(r, 'savedAddress') && blockOf(r, 'savedAddress').address.name === 'Asha Rao' && /Paying online/.test(textOf(r)));
    r = await bot.reply('yes');
    const sum = blockOf(r, 'summary');
    eq('online payment, as chosen', sum.payment, 'online');
    ok('the button says Pay with the total', /^Pay /.test(r.chips[0].label));
    r = await bot.act({ t: 'place', ref: sum.ref });
    const placed = blockOf(r, 'placed');
    ok('paid and placed', placed && placed.order.payment === 'online' && /^Paid/.test(textOf(r)));
    eq('in the store as paid', mock.admin.placed[mock.admin.placed.length - 1].displayFinancialStatus, 'PAID');
    r = await bot.reply('checkout');
    ok('the bag is empty afterwards', /bag is empty/i.test(textOf(r)));
  }

  section('when the payment window is closed');
  {
    const shop = shopFor({ saved: Object.assign({ state: 'KA' }, ADDR, { phone: '9845012345' }), dismiss: true });
    const bot = buyer(shop);
    const one = mock.products.find((p) => p.availableForSale && p.variants.length === 1);
    await bot.reply('buy ' + one.title);
    await bot.reply('checkout');
    await bot.reply('pay online');
    let r = await bot.reply('yes');
    const sum = blockOf(r, 'summary');
    const before = mock.admin.placed.length;
    r = await bot.act({ t: 'place', ref: sum.ref });
    ok('says nothing was charged', /Nothing was charged/.test(textOf(r)) && !blockOf(r, 'placed'));
    eq('no order was made', mock.admin.placed.length, before);
    ok('and offers to pay again or switch to cash on delivery', r.chips.some((c) => c.act && c.act.t === 'place') && r.chips.some((c) => c.act && c.act.t === 'pay' && c.act.p === 'cod'));
    r = await bot.reply('not now');
    ok('"not now" leaves the bag for later', /nothing was placed/i.test(textOf(r)));
  }

  section('the bag, by chat');
  {
    const bot = buyer(shopFor());
    const one = mock.products.filter((p) => p.availableForSale && p.variants.length === 1);
    await bot.reply('buy ' + one[0].title);
    await bot.reply('add ' + one[1].title);
    let r = await bot.reply('what is in my cart');
    eq('"what is in my cart" shows both lines', blockOf(r, 'bag').lines.length, 2);
    r = await bot.reply('remove the first one');
    ok('"remove the first one" removes it', /Removed/.test(textOf(r)) && blockOf(r, 'bag').count === 1);
    r = await bot.act({ t: 'qty', line: (await S.cartGet()).lines[0].lineId, q: 3 });
    eq('the + button sets the quantity', blockOf(r, 'bag').count, 3);
    r = await bot.reply('empty my bag');
    ok('"empty my bag" asks first', /Remove everything/.test(textOf(r)));
    r = await bot.reply('yes');
    ok('and does it on yes', /bag is empty/i.test(textOf(r)) && (await S.cartGet()) && (await S.cartGet()).count === 0);
  }

  section('ordering the same again');
  {
    const bot = buyer(shopFor({ saved: Object.assign({ state: 'KA' }, ADDR, { phone: '9845012345' }) }));
    let r = await bot.reply('order again');
    ok('asks which order', /Which order/.test(textOf(r)));
    r = await bot.reply('#1001');
    ok('then for its phone or email', /phone number or email/.test(textOf(r)));
    r = await bot.reply('asha@example.com');
    ok('puts its items back in the bag and heads to checkout', /Added 2 of 2 items from #1001/.test(textOf(r)) && blockOf(r, 'payChoice'));
  }

  section('a person, with the conversation');
  {
    const bot = buyer(shopFor());
    await bot.reply('buy ' + mock.products.find((p) => p.availableForSale && p.variants.length === 1).title);
    const r = await bot.reply('talk to a person');
    const wa = (blockOf(r, 'links').links.find((l) => /wa\.me/.test(l.href)) || {}).href || '';
    const msg = decodeURIComponent(wa.split('text=')[1] || '');
    ok('the WhatsApp message carries the bag and what was asked', /In my bag:/.test(msg) && /I asked:/.test(msg));
  }

  section('robust');
  {
    const bot = buyer(shopFor());
    let r = await bot.reply('start over');
    ok('"start over" starts again', /I can find the right product/.test(textOf(r)));
    r = await bot.act({ t: 'nonsense' });
    ok('an unknown button is answered, not an error', /expired/.test(textOf(r)));
    r = await bot.reply('');
    ok('an empty message gets the welcome', /I can find/.test(textOf(r)));
    r = await bot.reply('yes');
    ok('a stray "yes" is answered', r.blocks.length > 0);
    r = await bot.reply('qwzx plorb');
    ok('nonsense is answered with a way forward', r.chips.length > 0);
    const fail = () => Promise.reject(new Error('down'));
    const partly = A.create({ S: Object.assign({}, S, { searchAll: fail, cartId: () => null }), C: C, collections: cols });
    r = await partly.reply('buy acana puppy');
    ok('one source down: the others still find it', cardsOf(r).length > 0 || !!blockOf(r, 'detail') || /Added/.test(textOf(r)));
    const down = A.create({ S: Object.assign({}, S, { searchAll: fail, brandPage: fail, collectionPage: fail, suggest: fail, cartId: () => null }), C: C, collections: cols });
    r = await down.reply('buy acana puppy');
    ok('the store not answering at all is a polite answer, not a crash', /could not reach the store/i.test(textOf(r)));
  }

  section('before tracking is connected');
  {
    const real = S.orderLookup;
    S.orderLookup = () => Promise.resolve({ found: false, configured: false });
    const bot = fresh();
    const r = await bot.reply('track #1001 asha@example.com');
    ok('points to the team instead, never to a page on the store', /our team/i.test(textOf(r)) && r.blocks.some((b) => b.type === 'links') && !/myshopify|pawsandtails24\.com\//.test(JSON.stringify(r)));
    S.orderLookup = real;
  }

  mock.server.close();
  process.stdout.write('\n');
  if (failures.length) {
    failures.forEach((f) => process.stdout.write('  FAILED  ' + f + '\n'));
    process.stdout.write('\n  assistant: ' + passed + ' passed, ' + failures.length + ' failed.\n\n');
    process.exit(1);
  }
  process.stdout.write('  assistant: ' + passed + ' passed, 0 failed.\n\n');
}());
