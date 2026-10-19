#!/usr/bin/env node
/* ============================================================================
 * Browser tests for the Paws and Tails storefront
 * ============================================================================
 * Drives a real Chromium against the mock store, the way a shopper meets the
 * site: menus built from the store's collections, the whole catalogue
 * browsable, search from any page, every product addable, and Checkout
 * leaving for the store. The mock answers the same operations as the live
 * store; nothing here can reach pawsandtails24.com or place an order.
 *
 *   node test/test-ui.js            (add --headed to watch it)
 * ========================================================================== */
'use strict';

const path = require('path');
const { chromium } = require('playwright');
const mock = require('./mock-store.js');

const PORT = 4219;
const BASE = 'http://localhost:' + PORT;
const HEADED = process.argv.indexOf('--headed') >= 0;

let passed = 0;
const failures = [];
function ok(what, cond) { if (cond) passed++; else failures.push(what); }
function eq(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else failures.push(what + '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want));
}
function section(name) { process.stdout.write('\n  ' + name + '\n'); }

(async function run() {
  await new Promise((resolve) => mock.server.listen(PORT, resolve));
  const products = mock.products;
  const good = products.find((p) => p.availableForSale && p.variants.length > 1 && p.variants.every((v) => v.availableForSale));
  const soldOut = products.find((p) => !p.availableForSale);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const apiCalls = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('request', (r) => { if (r.url().indexOf('/api/') >= 0) apiCalls.push(r.method() + ' ' + r.url()); });

  try {
    /* ------------------------------------------------------------------ home */
    section('the front page');
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    eq('the page is pure white', await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
    ok('the header is white too', /255, 255, 255/.test(await page.evaluate(() => getComputedStyle(document.querySelector('header.site')).backgroundColor)));
    ok('the hero carries a headline', (await page.locator('.hero h1').textContent()).length > 10);
    ok('on a computer the header has the search box', await page.locator('.hsearch').isVisible());
    ok('and not a second search icon beside it', !(await page.locator('.msearch').isVisible()));
    ok('every call is a POST to the API path', apiCalls.length > 0 && apiCalls.every((c) => /^POST .*\/api\/\d{4}-\d{2}\/graphql\.json$/.test(c)));
    await page.waitForSelector('#railBest .tile', { timeout: 10000 });
    ok('best sellers come from the whole store', (await page.locator('#railBest .tile').count()) > 0);
    await page.waitForSelector('#homeCols .shelfcard', { timeout: 10000 });
    eq('the front page shows the first twelve collections', await page.locator('#homeCols .shelfcard').count(), 12);
    ok('the rest are behind a + expander', /Show all 22 collections/.test(await page.locator('[data-act="moreCols"]').textContent()));
    await page.locator('[data-act="moreCols"]').click();
    eq('opening it shows every collection the store has with products', await page.locator('#homeCols .shelfcard').count(), 22);
    const titles = await page.locator('#homeCols .shelfcard b').allTextContents();
    ok('the system home collection is hidden', titles.indexOf('Home page') < 0);
    ok('an empty collection is left out', titles.indexOf('Retired range') < 0);
    await page.waitForSelector('#railNew .tile', { timeout: 10000 });
    ok('new in fills from the whole store', (await page.locator('#railNew .tile').count()) > 0);

    /* ------------------------------------------------------------------ menu */
    section('collections menu');
    await page.locator('#megaBtn').click();
    await page.waitForSelector('.mega ul a');
    eq('the menu lists the live collections', await page.locator('.mega ul a').count(), 22);
    await page.locator('.mega ul a', { hasText: 'Dog Food' }).first().click();
    await page.waitForSelector('#listGrid .tile', { timeout: 10000 });
    eq('a collection opens with the store title', await page.locator('#listTitle').textContent(), 'Dog Food');
    ok('the menu closed on the way', (await page.locator('.mega').count()) === 0);

    /* -------------------------------------------------------------- shop all */
    section('shop all');
    await page.goto(BASE + '/#/all', { waitUntil: 'networkidle' });
    await page.waitForSelector('#listGrid .tile', { timeout: 10000 });
    eq('the first page of everything', await page.locator('#listGrid .tile').count(), 24);
    await page.locator('[data-act="more"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#listGrid .tile').length > 24, null, { timeout: 10000 });
    eq('show more pages on through the catalogue', await page.locator('#listGrid .tile').count(), 48);
    let guard = 0;
    while ((await page.locator('[data-act="more"]').count()) && guard++ < 10) {
      const before = await page.locator('#listGrid .tile').count();
      await page.locator('[data-act="more"]').click();
      await page.waitForFunction((n) => document.querySelectorAll('#listGrid .tile').length > n, before, { timeout: 10000 });
    }
    eq('every product in the store is reachable from shop all', await page.locator('#listGrid .tile').count(), products.length);

    /* --------------------------------------------------------- global search */
    section('search from the header, on any page');
    await page.goto(BASE + '/#/c/dog-food', { waitUntil: 'networkidle' });
    await page.locator('#hq').fill('royal');
    await page.waitForSelector('#hsug .sugs a[href^="#/p/"]', { timeout: 10000 });
    ok('typing shows products', (await page.locator('#hsug a[href^="#/p/"]').count()) > 0);
    ok('and the matching collection', (await page.locator('#hsug a[href="#/c/royal-canin-dog-food"]').count()) === 1);
    ok('the typed word is marked in the results', (await page.locator('#hsug mark').count()) > 0);
    ok('there is a way to every result', (await page.locator('#hsug .seeall').count()) === 1);
    /* Counting links is not enough: a stray header rule once squeezed every
     * row into a 42 px column. Measure them. */
    const rows = await page.locator('#hsug .sugs a').evaluateAll((as) => as.map((a) => {
      const r = a.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }));
    const box = await page.locator('#hsug').evaluate((el) => Math.round(el.getBoundingClientRect().width));
    ok('every suggestion row spans the dropdown (' + rows.map((r) => r.w).join(',') + ' in ' + box + ')',
      rows.length > 0 && rows.every((r) => r.w >= box - 30));
    ok('every suggestion row is a single tidy line or two (' + rows.map((r) => r.h).join(',') + ')',
      rows.every((r) => r.h <= 72));

    await page.locator('#hq').press('ArrowDown');
    const firstHref = await page.locator('#hsug .sugs a').first().getAttribute('href');
    await page.locator('#hq').press('Enter');
    await page.waitForFunction((h) => location.hash === h, firstHref, { timeout: 5000 });
    ok('arrow down and enter opens the highlighted result', true);
    await page.waitForSelector('.pdp h1', { timeout: 10000 });

    await page.locator('#hq').fill('premium');
    await page.waitForSelector('#hsug .sugs a', { timeout: 10000 });
    await page.locator('#hq').press('Enter');
    await page.waitForSelector('#listGrid .tile', { timeout: 10000 });
    eq('enter with nothing chosen runs the full search', await page.evaluate(() => location.hash), '#/search/premium');
    ok('with a count of results', /\d+ results? for "premium"/.test(await page.locator('#results .head h2').textContent()));

    /* A brand is in the catalogue but not in product titles, so the store
     * search finds nothing. The shop must still find it. */
    const brand = products[0].vendor;
    await page.locator('#hq').fill(brand.slice(0, 5));
    await page.waitForSelector('#hsug a[href^="#/p/"]', { timeout: 10000 });
    ok('half a brand name still finds its products as you type', (await page.locator('#hsug a[href^="#/p/"]').count()) > 0);
    await page.goto(BASE + '/#/search/' + encodeURIComponent(brand), { waitUntil: 'networkidle' });
    await page.waitForSelector('#listGrid .tile', { timeout: 10000 });
    ok('the full search falls back to the catalogue and finds the brand', (await page.locator('#listGrid .tile').count()) > 0);
    const brands = await page.locator('#listGrid .tile .brand').allTextContents();
    ok('and everything it found is that brand', brands.length > 0 && brands.every((b) => b.toLowerCase() === brand.toLowerCase()));

    await page.goto(BASE + '/#/search/zzqqxx', { waitUntil: 'networkidle' });
    await page.waitForSelector('.empty h1', { timeout: 10000 });
    ok('a search that matches nothing says so and offers a way on', (await page.locator('.empty a[href="#/all"]').count()) === 1);

    await page.locator('#hq').fill('dog food');
    await page.waitForSelector('#hsug .sugs', { timeout: 10000 });
    await page.locator('#bagBtn').click();
    await page.waitForSelector('.drawer');
    eq('the search box keeps its text while the rest of the page changes', await page.locator('#hq').inputValue(), 'dog food');
    await page.keyboard.press('Escape');

    /* --------------------------------------------------------------- product */
    section('a product');
    await page.goto(BASE + '/#/p/' + good.handle, { waitUntil: 'networkidle' });
    await page.waitForSelector('.pdp h1');
    eq('the product title is the store title', await page.locator('.pdp h1').textContent(), good.title);
    const shown = await page.locator('.pdp .pricing .now').textContent();
    eq('the price is the store price', shown, '₹' + Number(good.variants[0].price.amount).toLocaleString('en-IN', { maximumFractionDigits: 0 }));
    ok('the sizes are offered', (await page.locator('.pick').count()) === good.variants.length);
    ok('details sit behind + expanders, closed', (await page.locator('details.expand').count()) >= 2 && (await page.locator('details.expand[open]').count()) === 0);
    await page.locator('.pick').nth(1).click();
    ok('another size changes the price', (await page.locator('.pdp .pricing .now').textContent()) !== shown);

    /* ------------------------------------------------------------------- bag */
    section('the bag');
    await page.locator('[data-act="add"]').click();
    await page.waitForSelector('.drawer .line', { timeout: 10000 });
    eq('the bag holds what was added', await page.locator('.drawer .line').count(), 1);
    eq('the header counts it', (await page.locator('.pip').textContent()).trim(), '1');
    await page.locator('[data-line-up]').click();
    await page.waitForFunction(() => (document.querySelector('.pip') || {}).textContent === '2', null, { timeout: 10000 });
    ok('one more makes two', true);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => (document.querySelector('.pip') || {}).textContent === '2', null, { timeout: 10000 });
    ok('the bag survives a reload, because the store holds it', true);
    await page.goto(BASE + '/#/bag', { waitUntil: 'networkidle' });
    await page.waitForSelector('.bagpage .line');
    await page.locator('[data-line-drop]').click();
    await page.waitForSelector('.empty h1', { timeout: 10000 });
    eq('removing empties the bag and the count', await page.locator('.pip').count(), 0);

    /* ----------------------------------------------------- every item buyable */
    section('anything in the store can be bought');
    const sample = products.filter((p) => p.availableForSale).filter((_, i) => i % 9 === 0).slice(0, 6);
    for (const p of sample) {
      await page.goto(BASE + '/#/p/' + p.handle, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-act="add"]');
      const disabled = await page.locator('[data-act="add"]').isDisabled();
      ok('can add ' + p.handle, !disabled);
      if (!disabled) {
        await page.locator('[data-act="add"]').click();
        await page.waitForSelector('.drawer .line', { timeout: 10000 });
        await page.keyboard.press('Escape');
      }
    }
    eq('every one of them is in the bag', (await page.locator('.pip').textContent()).trim(), String(sample.length));

    /* -------------------------------------------------------------- checkout */
    section('checkout');
    await page.locator('#bagBtn').click();
    await page.waitForSelector('[data-act="checkout"]');
    await page.locator('[data-act="checkout"]').click();
    await page.waitForURL(/mock-checkout/, { timeout: 10000 });
    ok('checkout leaves for the cart own checkout', /\/mock-checkout\//.test(page.url()));

    /* -------------------------------------------------------------- sold out */
    section('sold out');
    await page.goto(BASE + '/#/p/' + soldOut.handle, { waitUntil: 'networkidle' });
    await page.waitForSelector('.pdp h1');
    ok('a sold out product says so', (await page.locator('.pdp .stock.out').count()) === 1);
    ok('and cannot be added', await page.locator('[data-act="add"]').isDisabled());

    /* ------------------------------------------------------------------ saved */
    section('saved items');
    await page.goto(BASE + '/#/c/dog-food', { waitUntil: 'networkidle' });
    await page.waitForSelector('#listGrid .tile');
    await page.locator('#listGrid .tile .heart').first().click();
    await page.goto(BASE + '/#/saved', { waitUntil: 'networkidle' });
    await page.waitForSelector('#savedGrid .tile', { timeout: 10000 });
    ok('the saved page reads the product back live', (await page.locator('#savedGrid .tile').count()) === 1);

    /* ------------------------------------------------------------------ phone */
    section('on a phone');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    ok('the header search gives way to an icon', !(await page.locator('.hsearch').isVisible()) && (await page.locator('.msearch').isVisible()));
    await page.locator('.msearch').click();
    await page.waitForSelector('#q');
    await page.locator('#q').fill('royal');
    await page.waitForSelector('#sug .sugs a[href^="#/p/"]', { timeout: 10000 });
    ok('search on a phone suggests as you type', (await page.locator('#sug .sugs a').count()) > 0);
    const phoneRows = await page.locator('#sug .sugs a').evaluateAll((as) => as.map((a) => Math.round(a.getBoundingClientRect().width)));
    ok('phone suggestion rows use the width of the screen (' + phoneRows.join(',') + ')', phoneRows.every((w) => w >= 300));
    await page.locator('.burger').click();
    await page.waitForSelector('.sheet nav a');
    ok('the menu lists the live collections', (await page.locator('.sheet nav a[href^="#/c/"]').count()) === 22);
    const spill = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok('nothing spills sideways on a 390 point screen', spill <= 1);

    /* ------------------------------------------------------------- old links */
    section('old links');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE + '/#/shelf/pharmacy/deworming', { waitUntil: 'networkidle' });
    await page.waitForSelector('#listGrid .tile', { timeout: 10000 });
    eq('an old shelf link lands on its collection', await page.locator('#listTitle').textContent(), 'Deworming');
    await page.goto(BASE + '/#/nonsense/x', { waitUntil: 'networkidle' });
    ok('an unknown route says so rather than sitting blank', (await page.locator('.empty h1').count()) === 1);

    section('console');
    eq('nothing was logged as an error' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''), consoleErrors.length, 0);
  } catch (e) {
    failures.push('the run stopped: ' + (e && e.message));
    try { await page.screenshot({ path: path.join(__dirname, 'failure.png') }); } catch (x) { /* ignore */ }
  }

  await browser.close();
  mock.server.close();

  process.stdout.write('\n');
  if (failures.length) {
    failures.forEach((f) => process.stdout.write('  FAILED  ' + f + '\n'));
    process.stdout.write('\n  browser: ' + passed + ' passed, ' + failures.length + ' failed.\n\n');
    process.exit(1);
  }
  process.stdout.write('  browser: ' + passed + ' passed, 0 failed.\n\n');
}());
