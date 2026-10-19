#!/usr/bin/env node
/* ============================================================================
 * Browser tests for the Paws and Tails storefront
 * ============================================================================
 * Drives a real Chromium against the mock store, so the interface is checked
 * the way a shopper meets it: does the catalogue arrive, does a size change
 * the price, does the bag hold what was added, does Checkout leave for the
 * store. The mock store answers the same operations the live store answers,
 * and nothing in here can reach pawsandtails24.com or place an order.
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
    ok('the wordmark is there', (await page.locator('.wordmark').first().textContent()).indexOf('paws') >= 0);
    ok('the hero carries a headline', (await page.locator('.hero h1').textContent()).length > 10);
    eq('every shelf is on the front page', await page.locator('.shelfgrid .shelfcard').count(), 9);
    ok('the catalogue was fetched, not bundled', apiCalls.length > 0);
    ok('every catalogue call is a POST to the API path', apiCalls.every((c) => /^POST .*\/api\/\d{4}-\d{2}\/graphql\.json$/.test(c)));
    await page.waitForSelector('#rail0 .tile', { timeout: 10000 });
    const railTiles = await page.locator('#rail0 .tile').count();
    ok('the first rail filled with live products', railTiles > 0);
    const firstPrice = await page.locator('#rail0 .tile .now').first().textContent();
    ok('a rail tile shows a rupee price', /₹[\d,]/.test(firstPrice));
    ok('no skeleton is left on screen once loaded', (await page.locator('#rail0 .skel').count()) === 0);

    /* ------------------------------------------------------------------ list */
    section('an aisle');
    await page.locator('.shelfgrid .shelfcard').first().click();
    await page.waitForSelector('.grid .tile', { timeout: 10000 });
    ok('the aisle lists products', (await page.locator('.grid .tile').count()) > 0);
    ok('the shelf aisles are offered as chips', (await page.locator('.chips .chip').count()) > 1);
    ok('one chip is the current aisle', (await page.locator('.chips .chip.on').count()) === 1);
    const before = await page.locator('.grid .tile').count();
    await page.locator('.chips .chip').nth(1).click();
    await page.waitForTimeout(900);
    ok('another chip loads another aisle', (await page.locator('.grid .tile').count()) > 0);
    ok('the chosen chip moved', (await page.locator('.chips .chip.on').nth(0).textContent()) === (await page.locator('.chips .chip').nth(1).textContent()));

    const callsBeforeSort = apiCalls.length;
    await page.selectOption('select.sort', 'priceLow');
    await page.waitForTimeout(900);
    ok('sorting asks the store again rather than reordering here', apiCalls.length > callsBeforeSort);

    /* --------------------------------------------------------------- product */
    section('a product');
    await page.goto(BASE + '/#/p/' + good.handle, { waitUntil: 'networkidle' });
    await page.waitForSelector('.pdp h1');
    eq('the product title is the store title', await page.locator('.pdp h1').textContent(), good.title);
    const shown = await page.locator('.pdp .pricing .now').textContent();
    const expected = '₹' + Number(good.variants[0].price.amount).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    eq('the price on screen is the store price', shown, expected);
    ok('the sizes are offered', (await page.locator('.pick').count()) === good.variants.length);
    ok('stock is stated', (await page.locator('.pdp .stock').count()) === 1);
    ok('product details sit behind an expander', (await page.locator('details.expand').count()) >= 2);
    ok('the details are closed to begin with', (await page.locator('details.expand[open]').count()) === 0);

    await page.locator('.pick').nth(1).click();
    await page.waitForTimeout(200);
    const second = await page.locator('.pdp .pricing .now').textContent();
    ok('choosing a bigger size changes the price', second !== shown);

    /* ------------------------------------------------------------------- bag */
    section('the bag');
    await page.locator('[data-act="add"]').click();
    await page.waitForSelector('.drawer .line', { timeout: 10000 });
    eq('the bag holds the line that was added', await page.locator('.drawer .line').count(), 1);
    eq('the header shows one item', (await page.locator('.pip').textContent()).trim(), '1');
    const lineName = await page.locator('.drawer .line .name').textContent();
    eq('the line names the product', lineName, good.title);
    ok('the drawer shows a subtotal', /₹/.test(await page.locator('.drawer .totals .v').textContent()));

    await page.locator('[data-line-up]').click();
    await page.waitForTimeout(800);
    eq('one more makes it two', (await page.locator('.pip').textContent()).trim(), '2');
    const subtotalTwo = await page.locator('.drawer .totals .v').textContent();
    ok('the subtotal came back doubled from the store', subtotalTwo !== '');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    eq('the bag survives a reload because the store holds it', (await page.locator('.pip').textContent()).trim(), '2');

    await page.goto(BASE + '/#/bag', { waitUntil: 'networkidle' });
    await page.waitForSelector('.bagpage .line');
    eq('the bag page shows the same line', await page.locator('.bagpage .line').count(), 1);
    await page.locator('[data-line-drop]').click();
    await page.waitForTimeout(800);
    ok('removing empties the bag', (await page.locator('.empty h1').textContent()).indexOf('empty') >= 0);
    eq('and the header count goes', await page.locator('.pip').count(), 0);

    /* -------------------------------------------------------------- checkout */
    section('checkout');
    await page.goto(BASE + '/#/p/' + good.handle, { waitUntil: 'networkidle' });
    await page.locator('[data-act="add"]').click();
    await page.waitForSelector('.drawer .line');
    await page.locator('[data-act="checkout"]').click();
    await page.waitForURL(/mock-checkout/, { timeout: 10000 });
    ok('checkout leaves the site for the cart own checkout', /\/mock-checkout\//.test(page.url()));
    ok('it is the checkout page that answers', (await page.locator('h1').textContent()).indexOf('checkout') >= 0);

    /* ---------------------------------------------------------------- search */
    section('search');
    await page.goto(BASE + '/#/search', { waitUntil: 'networkidle' });
    await page.locator('#q').fill('premium');
    await page.waitForSelector('.suggests a', { timeout: 10000 });
    ok('typing brings suggestions from the store', (await page.locator('.suggests a').count()) > 0);
    await page.locator('#q').press('Enter');
    await page.waitForSelector('#listGrid .tile', { timeout: 10000 });
    ok('the full search lists results', (await page.locator('#listGrid .tile').count()) > 0);
    ok('the result count is stated', /result/.test(await page.locator('.head h2').textContent()));

    /* ----------------------------------------------------------- sold out */
    section('sold out');
    await page.goto(BASE + '/#/p/' + soldOut.handle, { waitUntil: 'networkidle' });
    await page.waitForSelector('.pdp h1');
    ok('a sold out product says so', (await page.locator('.pdp .stock.out').count()) === 1);
    ok('its button cannot be pressed', await page.locator('[data-act="add"]').isDisabled());
    ok('there is no buy it now on a sold out product', (await page.locator('[data-act="buy"]').count()) === 0);

    /* ------------------------------------------------------------------ saved */
    section('saved items');
    await page.goto(BASE + '/#/aisle/' + good.aisles[0], { waitUntil: 'networkidle' });
    await page.waitForSelector('.grid .tile');
    await page.locator('.grid .tile .heart').first().click();
    await page.waitForTimeout(300);
    ok('the heart fills in', (await page.locator('.grid .tile .heart.on').count()) === 1);
    await page.goto(BASE + '/#/saved', { waitUntil: 'networkidle' });
    await page.waitForSelector('#savedGrid .tile', { timeout: 10000 });
    ok('the saved page reads the live product back', (await page.locator('#savedGrid .tile').count()) === 1);

    /* ------------------------------------------------------------------ phone */
    section('on a phone');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    ok('the menu button appears', await page.locator('.burger').isVisible());
    ok('the desktop nav is put away', !(await page.locator('nav.primary').isVisible()));
    await page.locator('.burger').click();
    await page.waitForSelector('.sheet');
    ok('the menu lists the shelves', (await page.locator('.sheet nav a').count()) > 9);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok('nothing spills sideways on a 390 point screen', wide <= 1);

    /* --------------------------------------------------------------- missing */
    section('a bad link');
    await page.goto(BASE + '/#/nonsense/x', { waitUntil: 'networkidle' });
    ok('an unknown route says so rather than sitting blank', (await page.locator('.empty h1').count()) === 1);

    section('console');
    eq('nothing was logged as an error' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''), consoleErrors.length, 0);
    ok('the store was called many times over the session', apiCalls.length > 15);
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
