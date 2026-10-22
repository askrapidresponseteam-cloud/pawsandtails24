#!/usr/bin/env node
/* ============================================================================
 * Tests for api/order.js, the order lookup
 * ============================================================================
 * Runs the real handler against test/mock-admin.js: the token grant, the
 * order query, matching by phone or email, what is and is not sent back,
 * and the ways it refuses.
 *
 *   node test/test-order-api.js
 * ========================================================================== */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const api = require(path.join(ROOT, 'api', 'order.js'));
const mockAdmin = require('./mock-admin.js');

let passed = 0;
const failures = [];
function ok(what, cond) { if (cond) passed++; else failures.push(what); }
function eq(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else failures.push(what + '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}
function section(name) { process.stdout.write('\n  ' + name + '\n'); }

/* A request and response as Vercel and node hand them over. */
function call(handler, method, body, ip) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (text) => resolve({ status: res.statusCode, headers: headers, body: JSON.parse(text || '{}') })
    };
    handler({ method: method, body: body, headers: { 'x-forwarded-for': ip || '10.0.0.1' } }, res);
  });
}

(async function run() {
  section('reading what the shopper typed');
  eq('a plain number', api.cleanOrder('1042'), '1042');
  eq('with a hash and spaces', api.cleanOrder(' # 1042 '), '1042');
  eq('as written in a sentence', api.cleanOrder('Order No. PT-1042'), 'PT1042');
  eq('too short to be an order', api.cleanOrder('42'), null);
  eq('not an order at all', api.cleanOrder('hello'), null);
  eq('a mobile with +91 and spaces', api.cleanContact('+91 98450 12345'), { phone: '9845012345' });
  eq('a mobile with a leading 0', api.cleanContact('09845012345'), { phone: '9845012345' });
  eq('an email, any case', api.cleanContact(' Asha@Example.COM '), { email: 'asha@example.com' });
  eq('a pincode is not a contact', api.cleanContact('576101'), null);

  section('before the store is connected');
  {
    const h = api.createHandler({ env: {} });
    const r = await call(h, 'POST', { order: '1001', contact: 'asha@example.com' });
    eq('says it is not set up, rather than failing', [r.status, r.body], [200, { found: false, configured: false }]);
    ok('and is never cached', r.headers['cache-control'] === 'no-store');
  }

  section('finding an order');
  {
    const admin = mockAdmin();
    const h = api.createHandler({ env: admin.env, fetchImpl: admin.fetch });
    const r = await call(h, 'POST', { order: '#1001', contact: 'asha@example.com' });
    eq('order and email together find it', [r.status, r.body.found], [200, true]);
    const o = r.body.order;
    eq('it is the right one', o.name, '#1001');
    eq('delivered', [o.stage, o.label, o.step], ['delivered', 'Delivered', 4]);
    eq('with the courier and its tracking link', [o.shipments[0].courier, o.shipments[0].number, o.shipments[0].url],
      ['Delhivery', 'DL123456789', 'https://www.delhivery.com/track/package/DL123456789']);
    ok('and the date it arrived', !!o.shipments[0].deliveredAt);
    eq('the items in it', o.items.map((i) => i.qty), [1, 2]);
    eq('the town and pincode it went to', [o.city, o.zip], ['Udupi', '576101']);
    const text = JSON.stringify(r.body);
    ok('never the email, phone or street address', text.indexOf('asha@') < 0 && text.indexOf('98450') < 0 && text.indexOf('9845012345') < 0);
    eq('one token was fetched with the client credentials grant', admin.stats.tokens, 1);

    const byPhone = await call(h, 'POST', { order: '1001', contact: '98450 12345' });
    eq('the phone on the order finds it too', byPhone.body.found, true);
    const byShipPhone = await call(h, 'POST', { order: '1002', contact: '+91-9876543210' });
    eq('so does the phone on the delivery address', byShipPhone.body.found, true);
    eq('in transit with an expected date from the courier', [byShipPhone.body.order.stage, !!byShipPhone.body.order.shipments[0].estimatedAt], ['shipped', true]);
    eq('the token is reused for later lookups', admin.stats.tokens, 1);

    const placed = await call(h, 'POST', { order: '1003', contact: 'ravi@example.com' });
    eq('not yet shipped', [placed.body.order.stage, placed.body.order.shipments.length], ['placed', 0]);
    const cancelled = await call(h, 'POST', { order: '1004', contact: 'kiran@example.com' });
    eq('cancelled says so', [cancelled.body.order.stage, cancelled.body.order.label], ['cancelled', 'Cancelled']);
    const out = await call(h, 'POST', { order: '1005', contact: '9123456780' });
    eq('out for delivery', out.body.order.stage, 'out_for_delivery');
    eq('a tracking link that is not a web address is dropped', out.body.order.shipments[0].url, null);

    section('refusing what it should');
    const wrong = await call(h, 'POST', { order: '1001', contact: 'someone@else.com' });
    eq('the right number with the wrong email is "not found"', [wrong.status, wrong.body], [200, { found: false }]);
    const none = await call(h, 'POST', { order: '9999', contact: 'asha@example.com' });
    eq('a number that does not exist looks exactly the same', [none.status, none.body], [200, { found: false }]);
    const bad = await call(h, 'POST', { order: 'abc', contact: 'x' });
    eq('nonsense asks for both again', bad.status, 400);
    ok('in words a shopper understands', /order number/i.test(bad.body.error));
    const get = await call(h, 'GET', null);
    eq('only POST is answered', get.status, 405);

    section('keeping going');
    admin.revoke();
    const again = await call(h, 'POST', { order: '1001', contact: 'asha@example.com' });
    eq('a token Shopify stopped accepting is renewed once and the lookup still works', [again.body.found, admin.stats.tokens], [true, 2]);

    let t = Date.now();
    const timed = mockAdmin();
    const ht = api.createHandler({ env: timed.env, fetchImpl: timed.fetch, now: () => t });
    await call(ht, 'POST', { order: '1001', contact: 'asha@example.com' });
    t += 23 * 60 * 60 * 1000;
    await call(ht, 'POST', { order: '1001', contact: 'asha@example.com' });
    eq('a token is kept for most of its day', timed.stats.tokens, 1);
    t += 60 * 60 * 1000;
    await call(ht, 'POST', { order: '1001', contact: 'asha@example.com' });
    eq('and fetched again before it runs out', timed.stats.tokens, 2);

    let last = null;
    for (let i = 0; i < 13; i++) last = await call(h, 'POST', { order: '9999', contact: 'asha@b.co' }, '10.9.9.9');
    eq('guessing over and over from one address is slowed down', last.status, 429);
    const other = await call(h, 'POST', { order: '1001', contact: 'asha@example.com' }, '10.9.9.10');
    eq('while everyone else carries on', other.status, 200);

    const fixed = api.createHandler({
      env: { SHOPIFY_SHOP: admin.env.SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN: 'shpat_fixed' },
      fetchImpl: (url, init) => {
        if (/oauth/.test(url)) return Promise.reject(new Error('should not ask for a token'));
        ok('a fixed token from an older app is sent as it is', init.headers['X-Shopify-Access-Token'] === 'shpat_fixed');
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ data: { orders: { nodes: admin.orders().slice(0, 1) } } }) });
      }
    });
    const fr = await call(fixed, 'POST', { order: '1001', contact: 'asha@example.com' });
    eq('and works without the grant', fr.body.found, true);

    const down = api.createHandler({ env: admin.env, fetchImpl: () => Promise.reject(new Error('offline')) });
    const dr = await call(down, 'POST', { order: '1001', contact: 'asha@example.com' });
    eq('Shopify not answering is a polite 502', [dr.status, /try again/i.test(dr.body.error)], [502, true]);
  }

  process.stdout.write('\n');
  if (failures.length) {
    failures.forEach((f) => process.stdout.write('  FAILED  ' + f + '\n'));
    process.stdout.write('\n  order api: ' + passed + ' passed, ' + failures.length + ' failed.\n\n');
    process.exit(1);
  }
  process.stdout.write('  order api: ' + passed + ' passed, 0 failed.\n\n');
}());
