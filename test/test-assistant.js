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
    'I want to return a damaged item': 'returns', 'cancel my order': 'cancel',
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
  S.configure({ apiBase: 'http://localhost:' + PORT, version: C.apiVersion, quiet: true });
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
    ok('a brand finds that brand', cardsOf(brand).length > 0 && cardsOf(brand).every((p) => p.brand === 'Drools'));

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
    ok('with a link to the full policy', r.blocks.some((b) => b.type === 'links'));
    r = await bot.reply('talk to a person');
    const links = (r.blocks.find((b) => b.type === 'links') || { links: [] }).links.map((l) => l.href);
    ok('a person: WhatsApp, phone and email', links.some((h) => /wa\.me/.test(h)) && links.some((h) => /^tel:/.test(h)) && links.some((h) => /^mailto:/.test(h)));
  }

  section('before tracking is connected');
  {
    const real = S.orderLookup;
    S.orderLookup = () => Promise.resolve({ found: false, configured: false });
    const bot = fresh();
    const r = await bot.reply('track #1001 asha@example.com');
    ok('points to the confirmation email and the team instead', /confirmation email/i.test(textOf(r)) && r.blocks.some((b) => b.type === 'links'));
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
