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

/* In the page: for each placed product picture under `scope`, the product's
 * longer side and its centre, as shares of its frame. */
function pictureGeometry(scope) {
  return Array.from(document.querySelectorAll(scope)).map(function (img) {
    var m = window.PTFit.known[window.PTFit.keyOf(img.getAttribute('src'))];
    /* Measured against the frame's inside, the box the picture is placed in. */
    var el = img.parentElement, o = el.getBoundingClientRect();
    var f = { left: o.left + el.clientLeft, top: o.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
    f.right = f.left + f.width; f.bottom = f.top + f.height;
    var r = img.getBoundingClientRect();
    if (!m || !img.classList.contains('fit')) return { placed: false, src: img.getAttribute('src') };
    var bw = (m.x1 - m.x0) * r.width, bh = (m.y1 - m.y0) * r.height;
    return {
      placed: true, photo: !!m.photo, src: img.getAttribute('src'),
      side: Math.max(bw / f.width, bh / f.height),
      cx: (r.left + (m.x0 + m.x1) / 2 * r.width - f.left) / f.width,
      cy: (r.top + (m.y0 + m.y1) / 2 * r.height - f.top) / f.height,
      covers: r.left <= f.left + 0.5 && r.top <= f.top + 0.5 && r.right >= f.right - 0.5 && r.bottom >= f.bottom - 0.5,
      shown: getComputedStyle(img).opacity === '1'
    };
  });
}
function sameSize(list, share) {
  var bad = list.filter(function (g) {
    if (!g.placed || !g.shown) return true;
    if (g.photo) return !g.covers;
    return Math.abs(g.side - share) > 0.015 || Math.abs(g.cx - 0.5) > 0.015 || Math.abs(g.cy - 0.5) > 0.015;
  });
  return bad.map(function (g) { return g.src + (g.placed ? ' side ' + g.side.toFixed(3) + ' at ' + g.cx.toFixed(3) + ',' + g.cy.toFixed(3) : ' not placed'); });
}
async function waitPictures(page, scope) {
  await page.waitForFunction((sel) => {
    const imgs = document.querySelectorAll(sel);
    return imgs.length > 0 && Array.from(imgs).every((i) => i.classList.contains('fit-done') && getComputedStyle(i).opacity === '1');
  }, scope, { timeout: 15000 });
}

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
  /* The rule above all: a shopper never leaves this site. Every request and
   * every page any tab loads, for the whole run, must be on the site itself. */
  const offsite = [];
  function guardSite(ctx) {
    ctx.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(BASE) && !/^(data|blob|about):/.test(u)) offsite.push(u);
    });
  }
  guardSite(context);
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

    /* ------------------------------------------------------- product pictures */
    section('every product picture at the same size');
    await waitPictures(page, '#listGrid .tile .shot img');
    const grid = await page.evaluate(pictureGeometry, '#listGrid .tile .shot img');
    eq('every tile in shop all has its picture', grid.length, products.length);
    const kinds = new Set(grid.map((g) => (g.src.match(/mock-img\/([a-z]+)/) || [])[1]));
    ok('the pictures include tiny, tight, tall, cut-out, off-centre and photographs', ['tiny', 'huge', 'tall', 'cutout', 'corner', 'photo'].every((k) => kinds.has(k)));
    const gridBad = sameSize(grid, 0.76);
    eq('every product fills the same share of its tile, centred' + (gridBad.length ? ': ' + gridBad.slice(0, 3).join(' | ') : ''), gridBad.length, 0);
    const sides = grid.filter((g) => !g.photo).map((g) => g.side);
    ok('largest and smallest product differ by under 2 percent of the tile (' + Math.min.apply(null, sides).toFixed(3) + ' to ' + Math.max.apply(null, sides).toFixed(3) + ')',
      Math.max.apply(null, sides) - Math.min.apply(null, sides) < 0.02);
    ok('photographs fill their tile', grid.filter((g) => g.photo).length > 0 && grid.filter((g) => g.photo).every((g) => g.covers));
    const heartRoom = await page.evaluate(() => {
      const t = document.querySelector('#listGrid .tile');
      return (t.querySelector('.shot').getBoundingClientRect().width * 0.12) > 20;
    });
    ok('the product keeps clear of the tile edges', heartRoom);
    await page.goto(BASE + '/#/c/dog-food', { waitUntil: 'networkidle' });
    await page.waitForSelector('#listGrid .tile');
    const instant = await page.evaluate(() => Array.from(document.querySelectorAll('#listGrid .tile .shot img')).every((i) => i.classList.contains('fit-done')));
    ok('pictures measured once are placed at once on the next page', instant);

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

    /* As in the live store, every product is listed under the store's own
     * name and the brand is only in the title. Searching a brand must find
     * that brand, and tiles must show it rather than the store's name. */
    const brand = products[0].brand;
    await page.locator('#hq').fill(brand.slice(0, 5));
    await page.waitForSelector('#hsug a[href^="#/p/"]', { timeout: 10000 });
    ok('half a brand name still finds its products as you type', (await page.locator('#hsug a[href^="#/p/"]').count()) > 0);
    await page.goto(BASE + '/#/search/' + encodeURIComponent(brand), { waitUntil: 'networkidle' });
    await page.waitForSelector('#listGrid .tile', { timeout: 10000 });
    ok('the full search falls back to the catalogue and finds the brand', (await page.locator('#listGrid .tile').count()) > 0);
    const brands = await page.locator('#listGrid .tile .brand').allTextContents();
    ok('and everything it found is that brand', brands.length > 0 && brands.every((b) => b.toLowerCase() === brand.toLowerCase()));
    ok('no tile shows the store\'s own name as the brand', brands.every((b) => !/paws/i.test(b)));
    await page.goto(BASE + '/#/brand/' + encodeURIComponent(brand), { waitUntil: 'networkidle' });
    await page.waitForSelector('#listGrid .tile', { timeout: 10000 });
    const onPage = await page.locator('#listGrid .tile .brand').allTextContents();
    eq('a brand page lists that brand, read from titles', [onPage.length > 0, onPage.every((b) => b === brand)], [true, true]);

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
    await waitPictures(page, '.gallery .main img, .gallery .thumbs img');
    eq('the big picture shows the product at the set size', sameSize(await page.evaluate(pictureGeometry, '.gallery .main img'), 0.82), []);
    eq('the small pictures under it match each other', sameSize(await page.evaluate(pictureGeometry, '.gallery .thumbs img'), 0.86), []);
    await page.locator('.gallery .thumbs button').nth(1).click();
    await waitPictures(page, '.gallery .main img');
    eq('another picture chosen shows at the same size', sameSize(await page.evaluate(pictureGeometry, '.gallery .main img'), 0.82), []);

    /* ------------------------------------------------------------------- bag */
    section('the bag');
    await page.locator('[data-act="add"]').click();
    await page.waitForSelector('.drawer .line', { timeout: 10000 });
    eq('the bag holds what was added', await page.locator('.drawer .line').count(), 1);
    eq('the header counts it', (await page.locator('.pip').textContent()).trim(), '1');
    await waitPictures(page, '.drawer .line .shot img');
    eq('the bag shows its product at the set size', sameSize(await page.evaluate(pictureGeometry, '.drawer .line .shot img'), 0.86), []);
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
    section('checkout, on this site');
    {
      const coText = async () => (await page.locator('#coNote').textContent()) || '';
      await page.locator('#bagBtn').click();
      await page.waitForSelector('.drawer a[href="#/checkout"]');
      await page.locator('.drawer a[href="#/checkout"]').click();
      await page.waitForSelector('#coForm');
      ok('Checkout opens a page here, not the store', /#\/checkout$/.test(page.url()));
      ok('it starts with the address; delivery and payment wait', await page.locator('#coS2').isHidden() && await page.locator('#coS3').isHidden());
      await page.locator('#coNext').click();
      const errs = await page.locator('.cof .err:not(:empty)').count();
      ok('Continue with nothing filled in points at every box that needs it (' + errs + ')', errs === 6);

      await page.locator('#coName').fill('Asha Rao');
      await page.locator('#coPhone').fill('98450 12345');
      await page.locator('#coEmail').fill('asha@example.com');
      await page.locator('#coAddr1').fill('12 Temple Road');
      await page.locator('#coZip').fill('960001');
      await page.locator('#coCity').fill('Faraway');
      await page.locator('#coState').selectOption('KA');
      await page.locator('#coNext').click();
      await page.waitForFunction(() => /cannot deliver/.test((document.getElementById('coNote') || {}).textContent || ''), null, { timeout: 10000 });
      ok('a pincode the store does not deliver to says so before anything is paid', /960001/.test(await coText()));

      await page.locator('#coZip').fill('576101');
      await page.locator('#coCity').fill('Udupi');
      await page.locator('#coNext').click();
      await page.waitForSelector('#coS3:not([hidden]) #coPlace', { timeout: 10000 });
      ok('then delivery and payment open', await page.locator('#coS2').isVisible() && await page.locator('#coS3').isVisible());
      ok('the address folds into one line with Change', /Asha Rao/.test(await page.locator('#coSum1').textContent()) && await page.locator('[data-act="coEdit"]').isVisible());
      ok('delivery options come from the store', (await page.locator('input[name="coRate"]').count()) === 2);
      ok('with an expected date', /Expected (between|by)/.test(await page.locator('#coEta').textContent()));
      const totalOf = async () => Number(((await page.locator('.corows .tot .mono').textContent()) || '').replace(/[^\d]/g, ''));
      const standard = await totalOf();
      await page.locator('input[name="coRate"]').nth(1).check();
      await page.waitForFunction((t) => Number(((document.querySelector('.corows .tot .mono') || {}).textContent || '').replace(/[^\d]/g, '')) !== t, standard, { timeout: 10000 });
      ok('choosing express re-prices the total from the store', (await totalOf()) > standard);
      ok('pay online is offered first', await page.locator('input[name="coPayBy"][value="online"]').isChecked());
      ok('the button says the amount', new RegExp('Pay ₹').test(await page.locator('#coPlace').textContent()));

      await page.locator('#coPlace').click();
      await page.waitForSelector('#mock-razorpay', { timeout: 10000 });
      ok('Razorpay opens on this page', /#\/checkout$/.test(page.url()));
      await page.locator('#mrzp-close').click();
      await page.waitForFunction(() => /not completed/.test((document.getElementById('coNote') || {}).textContent || ''), null, { timeout: 10000 });
      ok('closing it says nothing was charged', /Nothing was charged/.test(await coText()));
      await page.waitForFunction(() => !document.getElementById('coPlace').disabled, null, { timeout: 10000 });
      await page.waitForTimeout(300);
      ok('and the unpaid draft is cleared from the store', (mock.admin.stats.draftsDeleted || 0) >= 1);
      eq('no order was placed', mock.admin.placed.length, 0);

      await page.locator('#coPlace').click();
      await page.waitForSelector('#mock-razorpay', { timeout: 10000 });
      await page.locator('#mrzp-pay').click();
      await page.waitForSelector('.thanks', { timeout: 15000 });
      const placedName = mock.admin.placed[mock.admin.placed.length - 1].name;
      ok('paying places the order and says thank you, on this site', new RegExp('#/thanks/' + placedName.slice(1) + '$').test(page.url()));
      ok('with the order number and the amount paid', new RegExp(placedName).test(await page.locator('.thanks').textContent()) && /Paid ₹/.test(await page.locator('.thanks').textContent()));
      eq('in the store as paid', mock.admin.placed[mock.admin.placed.length - 1].displayFinancialStatus, 'PAID');
      eq('the bag is empty again', await page.locator('.pip').count(), 0);
      await page.locator('.thanks a', { hasText: 'Track this order' }).click();
      await page.waitForSelector('.ocard', { timeout: 10000 });
      ok('Track this order shows it straight away, no questions', new RegExp(placedName).test(await page.locator('.ohead').textContent()));

      section('cash on delivery');
      const one = products.find((p) => p.availableForSale && p.variants.length === 1);
      await page.goto(BASE + '/#/p/' + one.handle, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-act="buy"]');
      await page.locator('[data-act="buy"]').click();
      await page.waitForSelector('#coForm', { timeout: 10000 });
      ok('Buy it now goes straight to checkout here', /#\/checkout$/.test(page.url()));
      eq('the address from last time is filled in', await page.locator('#coName').inputValue(), 'Asha Rao');
      await page.locator('#coNext').click();
      await page.waitForSelector('#coS3:not([hidden]) #coPlace', { timeout: 10000 });
      await page.locator('input[name="coPayBy"][value="cod"]').check();
      ok('cash on delivery says what to pay on arrival', /on delivery/.test(await page.locator('#coPlace').textContent()));
      await page.locator('#coPlace').click();
      await page.waitForSelector('.thanks', { timeout: 15000 });
      ok('the order is placed with no payment window', /in cash when it arrives/.test(await page.locator('.thanks').textContent()));
      eq('in the store as payment pending', mock.admin.placed[mock.admin.placed.length - 1].displayFinancialStatus, 'PENDING');

      section('store pages, shown here');
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      eq('the footer\'s shipping link stays on the site', await page.locator('footer a', { hasText: 'Shipping' }).getAttribute('href'), '#/policy/shipping');
      await page.locator('footer a', { hasText: 'Shipping' }).click();
      await page.waitForSelector('.polbody', { timeout: 10000 });
      ok('and shows the store\'s shipping page', /dispatched within/.test(await page.locator('.polbody').textContent()));
      await page.goto(BASE + '/#/p/' + good.handle, { waitUntil: 'networkidle' });
      await page.waitForSelector('details.expand');
      const links = await page.locator('details.expand .inner a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      ok('links in product text to the store become this site\'s pages (' + links.join(', ') + ')',
        links.length >= 2 && links.every((h) => /^(#\/|tel:|mailto:|https:\/\/wa\.me)/.test(h)));
      ok('and a link with no page here becomes plain text', !(await page.locator('details.expand .inner a', { hasText: 'your cart' }).count()));
    }

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

    /* ------------------------------------------------- add from a listing */
    section('add to the bag straight from a listing');
    {
      const pipNow = async () => Number((await page.locator('.pip').count()) ? (await page.locator('.pip').textContent()) : 0);
      await page.goto(BASE + '/#/c/deworming', { waitUntil: 'networkidle' });
      await page.waitForSelector('#listGrid .tile');
      const single = mock.products.filter((p) => p.aisles.indexOf('deworming') >= 0 && p.availableForSale && p.variants.length === 1);
      const multi = mock.products.filter((p) => p.aisles.indexOf('deworming') >= 0 && p.availableForSale && p.variants.length > 1);
      eq('one-size products get Add to bag', await page.locator('#listGrid [data-quick]').count(), single.length);
      eq('products with sizes get Choose size instead', await page.locator('#listGrid a.tadd', { hasText: 'Choose size' }).count(), multi.length);
      const before = await pipNow();
      await page.locator('#listGrid [data-quick]').first().click();
      await page.waitForFunction((n) => Number((document.querySelector('.pip') || {}).textContent || 0) === n + 1, before, { timeout: 10000 });
      ok('one tap puts it in the bag and the count goes up', true);
      ok('the button says it is in the bag', /In your bag|Add another/.test(await page.locator('#listGrid [data-quick]').first().textContent()));
      ok('and the page stays where it was', /#\/c\/deworming$/.test(page.url()));
    }

    /* --------------------------------------------------------- track an order */
    section('track an order');
    {
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      eq('the header link opens the track page', await page.locator('.announce a', { hasText: 'Track an order' }).getAttribute('href'), '#/track');
      /* As a new visitor: nothing remembered from the orders placed above. */
      await page.evaluate(() => { try { sessionStorage.removeItem('pt_track'); } catch (e) { /* ignore */ } });
      await page.goto(BASE + '/#/track', { waitUntil: 'networkidle' });
      ok('it starts with just the two boxes', (await page.locator('#trackForm input').count()) === 2 && (await page.locator('.ocard').count()) === 0);
      await page.locator('#tOrder').fill('#1002');
      await page.locator('#tContact').fill('someone@else.com');
      await page.locator('#tGo').click();
      await page.waitForSelector('#trackOut .note', { timeout: 10000 });
      ok('a contact that does not match is "not found"', /could not find/i.test(await page.locator('#trackOut').textContent()));
      await page.locator('#tContact').fill('98765 43210');
      await page.locator('#tGo').click();
      await page.waitForSelector('.ocard', { timeout: 10000 });
      eq('the order and where it is', [await page.locator('.ohead .eyebrow').textContent(), await page.locator('.ohead b.serif').textContent()], ['Order #1002', 'On its way']);
      ok('the courier\'s expected date', /Courier expects/i.test(await page.locator('.oeta').textContent()));
      eq('the third of five steps is current', await page.locator('.osteps li').evaluateAll((ls) => ls.map((l) => l.className)), ['done', 'done', 'now', '', '']);
      eq('the courier tracking link opens in a new tab', [await page.locator('.oship a').getAttribute('href'), await page.locator('.oship a').getAttribute('target')],
        ['https://www.bluedart.com/tracking?awb=BD99887766', '_blank']);
      ok('the items wait behind a + expander', (await page.locator('.ocard details.expand:not([open])').count()) === 1);
      const shown = await page.locator('.ocard').textContent();
      ok('no email or phone on the page', !/9876543210|@/.test(shown));
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.ocard', { timeout: 10000 });
      ok('a refresh shows it again without asking', /#1002/.test(await page.locator('.ohead').textContent()));
      await page.goto(BASE + '/#/track/1001', { waitUntil: 'networkidle' });
      eq('a link to another order fills in its number and asks for its contact', [await page.locator('#tOrder').inputValue(), await page.locator('#tContact').inputValue()], ['#1001', '']);
      await page.locator('#tContact').fill('asha@example.com');
      await page.locator('#tGo').click();
      await page.waitForSelector('.ocard.st-delivered', { timeout: 10000 });
      ok('a delivered order says when', /Delivered/.test(await page.locator('.oeta').textContent()));
      await page.locator('#tOrder').fill('#1003');
      await page.locator('#tContact').fill('ravi@example.com');
      await page.locator('#tGo').click();
      await page.waitForSelector('.ocard.st-placed', { timeout: 10000 });
      ok('a new order shows an expected range from the shipping page', /Expected/.test(await page.locator('.oeta').textContent()) && /shipping page/i.test(await page.locator('.ocard').textContent()));
    }

    /* ------------------------------------------------------------- assistant */
    section('the assistant');
    {
      await page.goto(BASE + '/#/c/dog-food', { waitUntil: 'networkidle' });
      await page.evaluate(() => { try { sessionStorage.removeItem('pt_chat_v2'); } catch (e) { /* ignore */ } });
      await page.reload({ waitUntil: 'networkidle' });
      ok('a button in the corner opens it', await page.locator('.cl-launch').isVisible());
      await page.locator('.cl-launch').click();
      await page.waitForSelector('.cl-panel:not([hidden]) .cl-row.bot');
      ok('it says what it can do', /place your order/i.test(await page.locator('.cl-log').textContent()) && /track/i.test(await page.locator('.cl-log').textContent()));
      ok('with quick replies', (await page.locator('.cl-chip').count()) >= 3);
      await page.locator('.cl-chip', { hasText: 'Best deworming' }).click();
      await page.waitForSelector('.cprod', { timeout: 10000 });
      const prices = await page.locator('.cprod .cp-price').allTextContents();
      ok('best deworming under 500: cards, each under ₹500 (' + prices.join(', ') + ')',
        prices.length > 0 && prices.length <= 3 && prices.every((t) => Number(t.replace(/[^\d]/g, '')) <= 500));
      ok('ranked by what sells, and says so', /sells most/i.test(await page.locator('.cl-log').textContent()));
      const pipBefore = Number(await page.locator('.pip').textContent());
      await page.locator('.cprod button.cp-add:not(.alt)').first().click();
      await page.waitForFunction((n) => Number((document.querySelector('.pip') || {}).textContent || 0) === n + 1, pipBefore, { timeout: 10000 });
      ok('a card goes straight into the bag', true);
      await page.waitForFunction(() => !document.querySelector('.cl-typing'), null, { timeout: 10000 });
      ok('and the chat says so, with the bag total', /Added/.test(await page.locator('.cl-row.bot').nth(-2).textContent()) && (await page.locator('.cl-bagmini').count()) === 1);

      const say = async (t) => {
        const n = await page.locator('.cl-row.bot').count();
        await page.locator('.cl-input').fill(t);
        await page.locator('.cl-input').press('Enter');
        await page.waitForFunction((k) => document.querySelectorAll('.cl-row.bot:not(.cl-typing)').length > k && !document.querySelector('.cl-typing'), n, { timeout: 10000 });
        return (await page.locator('.cl-row.bot').last().textContent()) || '';
      };
      ok('"where is my order" asks for the number', /order number/i.test(await say('where is my order')));
      ok('then for the phone or email', /phone number or email/i.test(await say('#1002')));
      await say('98765 43210');
      await page.waitForSelector('.cl-order .ocard', { timeout: 10000 });
      ok('then shows the order card', /On its way/.test(await page.locator('.cl-order').last().textContent()));
      ok('and says when, in words', /courier expects/i.test(await page.locator('.cl-log').textContent()));
      ok('"when will it arrive" uses our shipping page', /should reach/i.test(await say('when will it arrive if i order today to 560001')));
      ok('"talk to a person" gives WhatsApp, phone and email', (await (async () => { await say('talk to a person'); return page.locator('.cl-row.bot').last().locator('a[href^="https://wa.me"], a[href^="tel:"], a[href^="mailto:"]').count(); })()) === 3);

      await page.locator('.cl-chip', { hasText: 'Track my order' }).click();
      await page.waitForTimeout(600);
      const kept = await page.locator('.cl-row').count();
      await page.goto(BASE + '/#/all', { waitUntil: 'networkidle' });
      await page.waitForSelector('#ptchat', { state: 'attached' });
      ok('the conversation survives moving to another page', (await page.locator('.cl-row').count()) >= kept - 1 && (await page.locator('.cl-row').count()) > 5);
      await page.keyboard.press('Escape');
      ok('Escape closes it', await page.locator('.cl-panel').isHidden());
      ok('and the button comes back', await page.locator('.cl-launch').isVisible());
    }

    /* ---------------------------------------------- ordering in the chat */
    section('ordering in the chat');
    {
      const chatSay = async (t) => {
        const n = await page.locator('.cl-row.bot:not(.cl-typing)').count();
        await page.locator('.cl-input').fill(t);
        await page.locator('.cl-input').press('Enter');
        await page.waitForFunction((k) => document.querySelectorAll('.cl-row.bot:not(.cl-typing)').length > k && !document.querySelector('.cl-typing'), n, { timeout: 15000 });
      };
      const chatTap = async (loc) => {
        const n = await page.locator('.cl-row.bot:not(.cl-typing)').count();
        await loc.click();
        await page.waitForFunction((k) => document.querySelectorAll('.cl-row.bot:not(.cl-typing)').length > k && !document.querySelector('.cl-typing'), n, { timeout: 15000 });
      };
      await page.evaluate(() => { try { localStorage.removeItem('pt_address'); } catch (e) { /* ignore */ } });
      await page.goto(BASE + '/#/c/dog-food', { waitUntil: 'networkidle' });
      if (await page.locator('.cl-panel').isHidden()) await page.locator('.cl-launch').click();
      await page.locator('.cl-new').click();
      ok('New chat starts the conversation again', (await page.locator('.cl-row').count()) === 1);
      await page.evaluate(() => window.PTStorefront.forgetCart());
      await page.reload({ waitUntil: 'networkidle' });
      if (await page.locator('.cl-panel').isHidden()) await page.locator('.cl-launch').click();
      const placedBefore = mock.admin.placed.length;

      await chatSay('can you place an order for acana');
      const names = await page.locator('.cl-row.bot').last().locator('.cprod .cp-name').allTextContents();
      ok('the request from the screenshot finds Acana (' + names.length + ')', names.length >= 2 && names.every((t) => /^Acana /.test(t)));
      await chatTap(page.locator('.cl-row.bot').last().locator('.cprod .cp-add').nth(1));
      ok('Choose size shows the sizes in the chat', (await page.locator('.cl-detail:not(.used) .cd-size').count()) >= 2);
      await chatTap(page.locator('.cl-detail:not(.used) .cd-size').nth(1));
      ok('a size goes into the bag', /Added .*\(1 kg\)/.test(await page.locator('.cl-log').textContent()) && Number(await page.locator('.pip').textContent()) === 1);
      ok('and that size picker stops working', (await page.locator('.cl-detail.used').count()) >= 1);
      await chatSay('make it 2');
      eq('"make it 2" updates the header count too', Number(await page.locator('.pip').textContent()), 2);

      await chatTap(page.locator('.cl-chip', { hasText: 'Checkout' }));
      ok('Checkout opens an address form in the chat', (await page.locator('.cl-addr:not(.used)').count()) === 1);
      await chatTap(page.locator('.cl-addr:not(.used) .ca-go'));
      ok('Continue with nothing filled in marks what is missing', (await page.locator('.cl-addr:not(.used) .ca-f.bad').count()) >= 5);
      const f = page.locator('.cl-addr:not(.used)');
      await f.locator('[name=name]').fill('Asha Rao');
      await f.locator('[name=phone]').fill('98450 12345');
      await f.locator('[name=address1]').fill('12 Temple Road');
      await f.locator('[name=zip]').fill('576101');
      eq('the pincode fills the state', await f.locator('[name=state]').inputValue(), 'KA');
      await f.locator('[name=city]').fill('Udupi');
      await chatTap(f.locator('.ca-go'));
      const sum = page.locator('.cl-sum:not(.used)');
      ok('then the order summary, priced by the store', (await sum.count()) === 1 && /Total/.test(await sum.textContent()));
      ok('it opens at its start, so it is read from the top', await page.evaluate(() => {
        const log = document.querySelector('.cl-log'); const rows = log.querySelectorAll('.cl-row.bot');
        const first = rows[rows.length - 2]; return first.offsetTop - log.scrollTop < 40 && first.offsetTop - log.scrollTop > -5;
      }));
      const total1 = await sum.locator('.grand .mono').textContent();
      await chatTap(sum.locator('.co-opt', { hasText: 'Express' }));
      const sum2 = page.locator('.cl-sum:not(.used)');
      ok('choosing express re-prices it', (await sum2.locator('.grand .mono').textContent()) !== total1);
      ok('and the old summary can no longer be used', await page.locator('.cl-sum.used .cs-place').first().isDisabled());
      await chatTap(sum2.locator('.co-opt', { hasText: 'Cash on delivery' }));
      ok('the button says what will happen', /on delivery/.test(await page.locator('.cl-sum:not(.used) .cs-place').textContent()));
      eq('nothing is placed before the button', mock.admin.placed.length, placedBefore);
      await chatTap(page.locator('.cl-sum:not(.used) .cs-place'));
      await page.waitForSelector('.cl-placed', { timeout: 15000 });
      const placedName = mock.admin.placed[mock.admin.placed.length - 1].name;
      ok('the order is placed, in the chat', new RegExp(placedName).test(await page.locator('.cl-placed').last().textContent()));
      eq('cash on delivery, in the store', mock.admin.placed[mock.admin.placed.length - 1].displayFinancialStatus, 'PENDING');
      eq('the bag in the header is empty', await page.locator('.pip').count(), 0);
      ok('and the chat stayed on this page', /#\/c\/dog-food$/.test(page.url()));

      const one = products.find((p) => p.availableForSale && p.variants.length === 1);
      await chatSay('buy ' + one.title);
      await chatTap(page.locator('.cl-chip', { hasText: 'Checkout' }));
      ok('next time the address is offered as saved', (await page.locator('.cl-saved:not(.used)').count()) === 1);
      await chatTap(page.locator('.cl-saved:not(.used) .cs-yes'));
      await page.locator('.cl-sum:not(.used) .cs-place').click();
      await page.waitForSelector('#mock-razorpay', { timeout: 10000 });
      ok('paying online opens Razorpay over the chat', /Pay Rs/.test(await page.locator('#mock-razorpay').textContent()));
      await page.locator('#mrzp-pay').click();
      await page.waitForSelector('.cl-placed >> nth=1', { timeout: 15000 });
      eq('paid, in the store', mock.admin.placed[mock.admin.placed.length - 1].displayFinancialStatus, 'PAID');
      ok('the chat says it was paid', /Paid/.test(await page.locator('.cl-placed').last().textContent()));
    }

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
    await page.goto(BASE + '/#/all', { waitUntil: 'networkidle' });
    await page.waitForSelector('#listGrid .tile');
    await waitPictures(page, '#listGrid .tile .shot img');
    const phoneGrid = sameSize(await page.evaluate(pictureGeometry, '#listGrid .tile .shot img'), 0.70);
    eq('on a phone every product is the same size too, clear of the heart' + (phoneGrid.length ? ': ' + phoneGrid.slice(0, 2).join(' | ') : ''), phoneGrid.length, 0);
    if (await page.locator('.cl-panel').isHidden()) await page.locator('.cl-launch').click();
    await page.waitForSelector('.cl-panel:not([hidden])');
    const panel = await page.locator('.cl-panel').boundingBox();
    ok('on a phone the assistant fills the screen', panel && Math.round(panel.width) === 390 && Math.round(panel.height) >= 800);
    await page.locator('.cl-x[data-chat="close"]').click();
    ok('and closes back to the page', await page.locator('.cl-panel').isHidden());
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

    section('if photos cannot be measured');
    {
      /* The measuring copy is a CORS request; refuse it the way a server
       * without CORS headers would. The pictures themselves still load. */
      const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      guardSite(ctx2);
      const p2 = await ctx2.newPage();
      await p2.route('**/mock-img/**', async (route) => {
        const h = await route.request().allHeaders();
        if (h.origin) route.abort(); else route.continue();
      });
      await p2.goto(BASE + '/#/c/dog-food', { waitUntil: 'networkidle' });
      await p2.waitForSelector('#listGrid .tile');
      await p2.waitForFunction(() => Array.from(document.querySelectorAll('#listGrid .tile .shot img'))
        .every((i) => i.classList.contains('fit-done') && getComputedStyle(i).opacity === '1'), null, { timeout: 10000 });
      const fallback = await p2.evaluate(() => Array.from(document.querySelectorAll('#listGrid .tile .shot img'))
        .map((i) => ({ placed: i.classList.contains('fit'), loaded: i.naturalWidth > 0 })));
      ok('photos that cannot be measured still show, as they were', fallback.length > 0 && fallback.every((f) => !f.placed && f.loaded));
      await ctx2.close();
    }

    section('never off the site');
    eq('no request or page, in any tab, left this site' + (offsite.length ? ': ' + offsite.slice(0, 3).join(' | ') : ''), offsite.length, 0);

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
