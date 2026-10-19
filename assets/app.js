/* ============================================================================
 * Paws and Tails storefront, interface layer
 * Routing, views and events. Every list, price and stock line on screen came
 * from a Storefront API call made moments earlier; this file holds no product
 * data of its own. The bag is the store's own cart, and Checkout leaves for
 * the store's checkout, which is what places the order.
 * ========================================================================== */
(function () {
  'use strict';

  var S = window.PTStorefront;
  var C = window.PTCatalogue;

  S.configure({ version: C.apiVersion, domain: C.domain, apiBase: window.PT_API_BASE || '', token: window.PT_TOKEN || '' });

  var app = document.getElementById('app');
  var state = { cart: null, drawer: false, menu: false, mega: false, sort: 'featured', toastTimer: null };

  /* ================================================================ HELPERS */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(p) { return S.money(p); }
  function img(url, w) { return S.sized(url, w); }

  /* The store's own product copy, with anything executable taken out. */
  function safeHtml(html) {
    var box = document.createElement('div');
    box.innerHTML = String(html || '');
    box.querySelectorAll('script, iframe, object, embed, link, style, form').forEach(function (n) { n.remove(); });
    box.querySelectorAll('*').forEach(function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var name = a.name.toLowerCase();
        if (name.indexOf('on') === 0) n.removeAttribute(a.name);
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
      });
    });
    return box.innerHTML;
  }

  function toast(message) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    if (state.toastTimer) clearTimeout(state.toastTimer);
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = message;
    document.body.appendChild(t);
    state.toastTimer = setTimeout(function () { t.remove(); }, 2600);
  }

  function skeletons(n, kind) {
    var one = '<div class="skel ' + (kind || 'tile') + '"><div class="bar"></div></div>';
    return new Array(n + 1).join(one);
  }

  function errorBlock(e, retryAttr) {
    var msg = (e && e.storefront && e.message) || 'Could not reach the store right now.';
    return '<div class="note"><b>' + esc(msg) + '</b>' +
      '<div><button class="btn quiet" ' + (retryAttr || 'data-act="reload"') + '>Try again</button></div></div>';
  }

  /* ============================================================== THE SHELL */

  function shelfByKey(key) {
    for (var i = 0; i < C.shelves.length; i++) if (C.shelves[i].key === key) return C.shelves[i];
    return null;
  }
  function aisleLabel(handle) {
    for (var i = 0; i < C.shelves.length; i++) {
      var as = C.shelves[i].aisles;
      for (var j = 0; j < as.length; j++) if (as[j].handle === handle) return as[j].label;
    }
    return handle;
  }

  function renderChrome() {
    var count = state.cart ? state.cart.count : 0;
    var navLinks = C.nav.map(function (n) {
      return '<a href="' + esc(n.href) + '">' + esc(n.label) + '</a>';
    }).join('');

    document.getElementById('chrome').innerHTML =
      '<div class="announce"><div class="wrap">' +
        '<a href="#/help">Questions? ' + esc(C.support.phoneLabel) + '</a>' +
        '<span class="mid">Pet food, pharmacy and everyday care, delivered across India</span>' +
        '<div><a href="' + esc(S.shopUrl(C.policies.account)) + '">Track an order</a></div>' +
      '</div></div>' +
      '<header class="site">' +
        '<div class="bar">' +
          '<button class="burger" data-act="menu" aria-label="Open menu"><span></span><span></span><span></span></button>' +
          '<nav class="primary" aria-label="Primary">' +
            '<button data-act="mega" aria-expanded="' + (state.mega ? 'true' : 'false') + '">Shop <span style="font-size:10px;color:var(--mute-2)">&#9662;</span></button>' +
            navLinks +
          '</nav>' +
          '<a class="wordmark" href="#/" aria-label="Paws and Tails home">paws<em>&amp;</em>tails</a>' +
          '<div class="tools">' +
            '<a class="text wide-only" href="#/brands">Brands</a>' +
            '<a href="#/search" aria-label="Search">' + icon('search') + '</a>' +
            '<a class="wide-only" href="#/saved" aria-label="Saved items">' + icon('heart') + '</a>' +
            '<button data-act="bag" aria-label="Open bag">' + icon('bag') +
              (count ? '<span class="pip">' + count + '</span>' : '') +
            '</button>' +
          '</div>' +
        '</div>' +
        (state.mega ? megaMenu() : '') +
      '</header>' +
      (state.menu ? mobileMenu() : '');
  }

  function megaMenu() {
    var cols = C.shelves.slice(0, 8).map(function (sh) {
      var links = sh.aisles.slice(0, 6).map(function (a) {
        return '<li><a href="#/shelf/' + esc(sh.key) + '/' + esc(a.handle) + '">' + esc(a.label) + '</a></li>';
      }).join('');
      return '<div><h3><a href="#/shelf/' + esc(sh.key) + '">' + esc(sh.name) + '</a></h3><ul>' + links + '</ul></div>';
    }).join('');
    return '<div class="mega"><div class="cols">' + cols +
      '<a class="feature" href="#/lane/dogs">' +
        '<img src="assets/img/dog.webp" alt="A dog on a leash in a garden">' +
        '<div class="cap"><span class="eyebrow" style="color:rgba(255,255,255,.9)">Everything canine</span><b>For dogs</b></div>' +
      '</a>' +
      '</div></div>';
  }

  function mobileMenu() {
    var items = C.shelves.map(function (sh) {
      return '<a href="#/shelf/' + esc(sh.key) + '" style="font-size:17px;color:var(--ink);padding:14px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between">' +
        '<span>' + esc(sh.name) + '</span><span style="color:var(--mute-3)">&rarr;</span></a>';
    }).join('');
    return '<div class="sheet" style="position:fixed;inset:0;z-index:80;background:var(--cream);overflow-y:auto">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;height:66px;padding:0 20px;border-bottom:1px solid var(--line)">' +
        '<span class="wordmark" style="font-size:25px">paws<em>&amp;</em>tails</span>' +
        '<button data-act="menu" aria-label="Close menu" style="width:44px;height:44px;border:0;background:none;font-size:26px;cursor:pointer;color:var(--ink)">&times;</button>' +
      '</div>' +
      '<nav style="display:flex;flex-direction:column;padding:12px 20px 40px">' +
        '<a href="#/lane/dogs" class="serif" style="font-size:26px;color:var(--ink);padding:12px 0;border-bottom:1px solid var(--line)">For dogs</a>' +
        '<a href="#/lane/cats" class="serif" style="font-size:26px;color:var(--ink);padding:12px 0;border-bottom:1px solid var(--line)">For cats</a>' +
        items +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px">' +
          '<a href="#/brands" style="padding:14px;background:var(--sand);color:var(--ink);font-size:15px">Brands</a>' +
          '<a href="#/saved" style="padding:14px;background:var(--sand);color:var(--ink);font-size:15px">Saved</a>' +
          '<a href="#/search" style="padding:14px;background:var(--sand);color:var(--ink);font-size:15px">Search</a>' +
          '<a href="#/help" style="padding:14px;background:var(--sand);color:var(--ink);font-size:15px">Help</a>' +
        '</div>' +
      '</nav></div>';
  }

  function icon(name) {
    var common = 'width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    if (name === 'search') return '<svg ' + common + '><circle cx="11" cy="11" r="7"></circle><path d="M16.5 16.5L21 21"></path></svg>';
    if (name === 'heart') return '<svg ' + common + '><path d="M12 20s-7-4.4-7-9.3A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.7C19 15.6 12 20 12 20z"></path></svg>';
    if (name === 'bag') return '<svg ' + common + '><path d="M6 8h12l-1 12H7L6 8z"></path><path d="M9 8V6a3 3 0 0 1 6 0v2"></path></svg>';
    return '';
  }

  function renderFooter() {
    var shelves = C.shelves.slice(0, 6).map(function (sh) {
      return '<li><a href="#/shelf/' + esc(sh.key) + '">' + esc(sh.name) + '</a></li>';
    }).join('');
    document.getElementById('foot').innerHTML =
      '<footer class="site"><div class="cols">' +
        '<div>' +
          '<div class="wordmark" style="color:var(--plum)">paws<em>&amp;</em>tails</div>' +
          '<p style="margin-top:12px;max-width:34ch;color:var(--mute);font-size:14px">' +
            'Food, medicine, supplements and everyday care for dogs, cats, birds and small pets.</p>' +
        '</div>' +
        '<div><h4>Shop</h4><ul>' + shelves + '</ul></div>' +
        '<div><h4>Help</h4><ul>' +
          '<li><a href="#/help">Contact us</a></li>' +
          '<li><a href="' + esc(S.shopUrl(C.policies.shipping)) + '">Shipping</a></li>' +
          '<li><a href="' + esc(S.shopUrl(C.policies.refund)) + '">Returns</a></li>' +
          '<li><a href="' + esc(S.shopUrl(C.policies.account)) + '">Your account</a></li>' +
        '</ul></div>' +
        '<div><h4>Reach us</h4><ul>' +
          '<li><a href="tel:' + esc(C.support.phone) + '">' + esc(C.support.phoneLabel) + '</a></li>' +
          '<li><a href="mailto:' + esc(C.support.email) + '">' + esc(C.support.email) + '</a></li>' +
          '<li><a href="https://wa.me/' + esc(C.support.whatsapp) + '">WhatsApp</a></li>' +
        '</ul></div>' +
      '</div>' +
      '<div class="legal"><span>Paws and Tails, ' + esc(C.domain) + '</span>' +
        '<span>Prices and stock come from our store in real time.</span></div>' +
      '</footer>';
  }

  /* ================================================================== TILES */

  function tileHtml(p) {
    var off = S.discountPercent(p);
    var saved = S.isSaved(p.handle);
    var shot = p.image
      ? '<img src="' + esc(img(p.image, 460)) + '" alt="' + esc(p.imageAlt) + '" loading="lazy">'
      : '<div class="blank">paws&amp;tails</div>';
    return '<div class="tile">' +
      (p.available ? (off ? '<span class="flag">' + off + '% off</span>' : '') : '<span class="flag out">Sold out</span>') +
      '<button class="heart' + (saved ? ' on' : '') + '" data-save="' + esc(p.handle) + '" aria-label="Save ' + esc(p.title) + '">' +
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="' + (saved ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-9.3A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.7C19 15.6 12 20 12 20z"></path></svg>' +
      '</button>' +
      '<a class="shot" href="#/p/' + esc(p.handle) + '" aria-label="' + esc(p.title) + '">' + shot + '</a>' +
      '<div class="body">' +
        (p.brand ? '<span class="brand">' + esc(p.brand) + '</span>' : '') +
        '<a class="name" href="#/p/' + esc(p.handle) + '">' + esc(p.title) + '</a>' +
        '<div class="price">' +
          '<span class="now">' + (p.ranged ? 'from ' : '') + money(p.paise) + '</span>' +
          (p.available && p.wasPaise ? '<span class="was">' + money(p.wasPaise) + '</span>' : '') +
          (p.available && off ? '<span class="off">' + off + '% off</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function tiles(list) { return list.map(tileHtml).join(''); }

  /* =================================================================== HOME */

  function viewHome() {
    var shelfCards = C.shelves.map(function (sh) {
      var n = sh.aisles.length;
      return '<a class="shelfcard" href="#/shelf/' + esc(sh.key) + '">' +
        '<b>' + esc(sh.name) + '</b>' +
        '<span>' + n + ' ' + (n === 1 ? 'aisle' : 'aisles') + '</span></a>';
    }).join('');

    app.innerHTML =
      '<section class="hero">' +
        '<img src="assets/img/hero.webp" alt="A dog resting on a doorstep">' +
        '<div class="veil"></div>' +
        '<div class="inner"><div>' +
          '<div class="eyebrow">Paws and Tails</div>' +
          '<h1>Everything for the animals you look after</h1>' +
          '<div class="ctas">' +
            '<a class="btn light" href="#/shelf/dog-food">Start shopping</a>' +
            '<a class="btn ghost" href="#/shelf/pharmacy">Pharmacy</a>' +
          '</div>' +
        '</div></div>' +
      '</section>' +
      '<div class="wrap">' +
        '<section class="band">' +
          '<div class="head"><h2>Shop by shelf</h2>' +
            '<a class="more" href="#/brands">All brands &rarr;</a></div>' +
          '<div class="shelfgrid">' + shelfCards + '</div>' +
          '<div class="feature2">' +
            '<a href="#/lane/dogs"><img src="assets/img/dog.webp" alt="A dog on a leash outdoors">' +
              '<div class="cap"><span>Food, treats, walks and grooming</span><b>For dogs</b></div></a>' +
            '<a href="#/lane/cats"><img src="assets/img/cat.webp" alt="A cat indoors">' +
              '<div class="cap"><span>Food, litter, play and care</span><b>For cats</b></div></a>' +
          '</div>' +
        '</section>' +
        C.homeRails.map(function (r, i) {
          return '<section class="band" id="rail' + i + '">' +
            '<div class="head"><h2>' + esc(r.title) + '</h2>' +
              '<a class="more" href="#/aisle/' + esc(r.handle) + '">See all &rarr;</a></div>' +
            '<div class="rail">' + skeletons(5) + '</div></section>';
        }).join('') +
      '</div>';

    C.homeRails.forEach(function (r, i) {
      S.collectionPage(r.handle, { sort: 'featured' }).then(function (page) {
        var host = document.querySelector('#rail' + i + ' .rail');
        if (!host) return;
        if (!page.products.length) {
          var band = document.getElementById('rail' + i);
          if (band) band.remove();
          return;
        }
        host.innerHTML = tiles(page.products.slice(0, 10));
      }).catch(function () {
        var band = document.getElementById('rail' + i);
        if (band) band.remove();
      });
    });
  }

  /* =================================================================== LIST
   * One view for every listing: a shelf, a lane, a single aisle, a brand.
   * Each is a title, an optional row of aisles, and a grid that pages. */

  var list = { source: null, cursor: null, busy: false, items: [] };

  function viewList(source) {
    list = { source: source, cursor: null, busy: false, items: [] };
    var chips = (source.aisles || []).map(function (a) {
      var on = a.handle === source.handle;
      return '<a class="chip' + (on ? ' on' : '') + '" href="' + esc(source.chipHref(a.handle)) + '">' + esc(a.label) + '</a>';
    }).join('');

    app.innerHTML = '<div class="wrap">' +
      '<div class="listhead">' +
        '<div><div class="eyebrow">' + esc(source.eyebrow || '') + '</div>' +
          '<h1 id="listTitle">' + esc(source.title) + '</h1></div>' +
        '<div style="display:flex;align-items:center;gap:14px">' +
          '<span class="count" id="listCount"></span>' +
          '<select class="sort" data-act="sort" aria-label="Sort">' +
            Object.keys(S.sorts).map(function (k) {
              return '<option value="' + k + '"' + (k === state.sort ? ' selected' : '') + '>' + esc(S.sorts[k].label) + '</option>';
            }).join('') +
          '</select>' +
        '</div>' +
      '</div>' +
      (chips ? '<div class="chips">' + chips + '</div>' : '') +
      '<div class="grid" id="listGrid">' + skeletons(8) + '</div>' +
      '<div id="listMore" style="padding:28px 0 0;display:flex;justify-content:center"></div>' +
      '<div id="listNote" style="padding:18px 0 0"></div>' +
      '</div>';
    loadList(true);
  }

  function loadList(first) {
    if (list.busy) return;
    list.busy = true;
    var src = list.source;
    var more = document.getElementById('listMore');
    if (!first && more) more.innerHTML = '<span class="count">Loading...</span>';

    src.fetch({ sort: state.sort, after: list.cursor }).then(function (page) {
      list.busy = false;
      var grid = document.getElementById('listGrid');
      if (!grid) return;
      if (page.missing) {
        app.querySelector('.wrap').innerHTML =
          '<div class="empty"><h1>That aisle is not on the shelf</h1>' +
          '<p>The store does not list this collection any more.</p>' +
          '<a class="btn" href="#/">Back to the front</a></div>';
        return;
      }
      if (page.title && src.useApiTitle) {
        var h = document.getElementById('listTitle');
        if (h) h.textContent = page.title;
      }
      list.items = list.items.concat(page.products);
      list.cursor = page.cursor;
      grid.innerHTML = list.items.length ? tiles(list.items) : '';
      var count = document.getElementById('listCount');
      if (count) {
        count.textContent = list.items.length
          ? list.items.length + (page.hasMore ? '+' : '') + ' ' + (list.items.length === 1 ? 'item' : 'items')
          : '';
      }
      if (!list.items.length) {
        grid.innerHTML = '';
        document.getElementById('listNote').innerHTML =
          '<div class="note"><b>Nothing in this aisle right now</b>' +
          '<div>The store has no products listed here at the moment.</div></div>';
      }
      if (more) {
        more.innerHTML = page.hasMore
          ? '<button class="btn quiet" data-act="more">Show more</button>'
          : '';
      }
      /* A short aisle leaves the page looking half built. Where it came from
       * a shelf, the rest of that shelf is the natural thing to offer next. */
      if (!page.hasMore && list.items.length < 10 && src.aisles && src.aisles.length > 1) {
        var others = src.aisles.filter(function (a) { return a.handle !== src.handle; }).slice(0, 8);
        document.getElementById('listNote').innerHTML =
          '<section class="band" style="padding-top:34px"><div class="head"><h2>Also on this shelf</h2></div>' +
          '<div class="shelfgrid">' + others.map(function (a) {
            return '<a class="shelfcard" href="' + esc(src.chipHref(a.handle)) + '"><b>' + esc(a.label) + '</b>' +
              '<span>See the aisle</span></a>';
          }).join('') + '</div></section>';
      }
    }).catch(function (e) {
      list.busy = false;
      var grid = document.getElementById('listGrid');
      if (first && grid) grid.innerHTML = '';
      var note = document.getElementById('listNote');
      if (note) note.innerHTML = errorBlock(e, 'data-act="retryList"');
      var m = document.getElementById('listMore');
      if (m) m.innerHTML = '';
    });
  }

  function shelfSource(shelf, handle) {
    var h = handle || shelf.aisles[0].handle;
    return {
      title: shelf.name, eyebrow: 'Shelf', aisles: shelf.aisles, handle: h, useApiTitle: false,
      chipHref: function (x) { return '#/shelf/' + shelf.key + '/' + x; },
      fetch: function (o) { return S.collectionPage(h, o); }
    };
  }
  function laneSource(key, lane, handle) {
    var h = handle || lane.aisles[0].handle;
    return {
      title: lane.name, eyebrow: 'Paws and Tails', aisles: lane.aisles, handle: h, useApiTitle: false,
      chipHref: function (x) { return '#/lane/' + key + '/' + x; },
      fetch: function (o) { return S.collectionPage(h, o); }
    };
  }
  function aisleSource(handle) {
    return {
      title: aisleLabel(handle), eyebrow: 'Aisle', aisles: null, handle: handle, useApiTitle: true,
      chipHref: function () { return '#/aisle/' + handle; },
      fetch: function (o) { return S.collectionPage(handle, o); }
    };
  }
  function brandSource(name) {
    return {
      title: name, eyebrow: 'Brand', aisles: null, handle: null, useApiTitle: false,
      chipHref: function () { return '#/brand/' + encodeURIComponent(name); },
      fetch: function (o) { return S.brandPage(name, o); }
    };
  }

  function viewBrands() {
    app.innerHTML = '<div class="wrap">' +
      '<div class="listhead"><div><div class="eyebrow">Paws and Tails</div><h1>Brands</h1></div></div>' +
      '<div class="shelfgrid">' + C.brands.map(function (b) {
        return '<a class="shelfcard" href="#/brand/' + esc(encodeURIComponent(b)) + '"><b>' + esc(b) + '</b>' +
          '<span>Shop the range</span></a>';
      }).join('') + '</div>' +
      '<div style="padding:28px 0 0"><p style="color:var(--mute);font-size:14px;max-width:60ch">' +
      'Searching by name finds any brand the store carries, including ones not listed here.</p></div>' +
      '</div>';
  }

  /* ================================================================ PRODUCT */

  var pdp = { product: null, variantIndex: 0, imageIndex: 0, qty: 1, adding: false };

  function viewProduct(handle) {
    app.innerHTML = '<div class="wrap"><div class="pdp">' +
      '<div class="skel" style="aspect-ratio:1/1"><div class="bar"></div></div>' +
      '<div style="display:grid;gap:14px;align-content:start;padding-top:8px">' +
        '<div class="skel" style="height:22px;width:40%"><div class="bar"></div></div>' +
        '<div class="skel" style="height:54px"><div class="bar"></div></div>' +
        '<div class="skel" style="height:30px;width:50%"><div class="bar"></div></div>' +
        '<div class="skel" style="height:52px"><div class="bar"></div></div>' +
      '</div></div></div>';

    S.product(handle).then(function (p) {
      if (!p) {
        app.innerHTML = '<div class="wrap"><div class="empty"><h1>Not on the shelf</h1>' +
          '<p>The store no longer lists this product.</p>' +
          '<a class="btn" href="#/">Back to the front</a></div></div>';
        return;
      }
      pdp = { product: p, variantIndex: firstSellable(p), imageIndex: 0, qty: 1, adding: false };
      drawProduct();
      S.recommendations(p.id).then(function (recs) {
        var host = document.getElementById('recs');
        if (!host || !recs.length) return;
        host.innerHTML = '<section class="band"><div class="head"><h2>Goes with this</h2></div>' +
          '<div class="rail">' + tiles(recs.slice(0, 10)) + '</div></section>';
      });
    }).catch(function (e) {
      app.innerHTML = '<div class="wrap" style="padding-top:40px">' + errorBlock(e) + '</div>';
    });
  }

  function firstSellable(p) {
    for (var i = 0; i < p.variants.length; i++) if (p.variants[i].available) return i;
    return 0;
  }

  function stockLine(v) {
    if (!v) return '';
    if (!v.available) return '<div class="stock out">Sold out. Ask us when it is back.</div>';
    if (v.backorder) return '<div class="stock">Made to order, dispatched when it arrives.</div>';
    if (v.stock !== null && v.stock > 0 && v.stock <= 5) {
      return '<div class="stock low">Only ' + v.stock + ' left at the store.</div>';
    }
    return '<div class="stock">In stock at the store.</div>';
  }

  function drawProduct() {
    var p = pdp.product;
    var v = p.variants[pdp.variantIndex] || null;
    var images = p.images.length ? p.images : [{ url: null, alt: p.title }];
    if (v && v.image) {
      var at = -1;
      images.forEach(function (im, i) { if (im.url === v.image) at = i; });
      if (at >= 0) pdp.imageIndex = at;
    }
    var main = images[Math.min(pdp.imageIndex, images.length - 1)];
    var off = v && v.wasPaise ? Math.round(((v.wasPaise - v.paise) / v.wasPaise) * 100) : 0;
    var multi = p.variants.length > 1;
    var saved = S.isSaved(p.handle);

    app.innerHTML = '<div class="wrap">' +
      '<div style="padding:22px 0 0;font-size:13px;color:var(--mute-2)">' +
        '<a href="#/" style="color:var(--mute-2)">Home</a> / ' +
        (p.brand ? '<a href="#/brand/' + esc(encodeURIComponent(p.brand)) + '" style="color:var(--mute-2)">' + esc(p.brand) + '</a> / ' : '') +
        '<span>' + esc(p.title) + '</span>' +
      '</div>' +
      '<div class="pdp">' +
        '<div class="gallery">' +
          '<div class="main">' + (main.url
            ? '<img src="' + esc(img(main.url, 1100)) + '" alt="' + esc(main.alt) + '">'
            : '<div style="display:grid;place-items:center;height:100%;font-family:var(--serif);font-size:38px;color:var(--mute-3)">paws&amp;tails</div>') +
          '</div>' +
          (images.length > 1 ? '<div class="thumbs">' + images.map(function (im, i) {
            return '<button data-shot="' + i + '" class="' + (i === pdp.imageIndex ? 'on' : '') + '" aria-label="Picture ' + (i + 1) + '">' +
              '<img src="' + esc(img(im.url, 160)) + '" alt=""></button>';
          }).join('') + '</div>' : '') +
        '</div>' +
        '<div class="info">' +
          (p.brand ? '<div class="brandline"><a href="#/brand/' + esc(encodeURIComponent(p.brand)) + '">' + esc(p.brand) + '</a></div>' : '') +
          '<h1>' + esc(p.title) + '</h1>' +
          '<div class="pricing">' +
            '<span class="now">' + (v ? money(v.paise) : '') + '</span>' +
            (v && v.wasPaise ? '<span class="was">' + money(v.wasPaise) + '</span>' : '') +
            (off ? '<span class="off">' + off + '% off</span>' : '') +
          '</div>' +
          stockLine(v) +
          (multi ? '<div class="opt">' +
            '<span class="label">' + esc(p.optionNames[0] || 'Choose') + '</span>' +
            '<div class="picks">' + p.variants.map(function (x, i) {
              return '<button class="pick' + (i === pdp.variantIndex ? ' on' : '') + (x.available ? '' : ' gone') + '" data-var="' + i + '">' +
                '<span>' + esc(x.title || 'One size') + '</span><span class="p">' + money(x.paise) + '</span></button>';
            }).join('') + '</div></div>' : '') +
          '<div class="qtyrow">' +
            '<div class="stepper">' +
              '<button data-act="qtyDown" aria-label="One fewer">&minus;</button>' +
              '<span id="qty">' + pdp.qty + '</span>' +
              '<button data-act="qtyUp" aria-label="One more">+</button>' +
            '</div>' +
            '<button class="btn" style="flex:1" data-act="add"' + (v && v.available ? '' : ' disabled') + '>' +
              (v && v.available ? 'Add to bag' : 'Sold out') + '</button>' +
          '</div>' +
          (v && v.available ? '<button class="btn quiet wide" data-act="buy">Buy it now</button>' : '') +
          '<button class="btn quiet wide" data-save="' + esc(p.handle) + '">' + (saved ? 'Saved' : 'Save for later') + '</button>' +
          (p.descriptionHtml ? '<details class="expand"><summary><span class="plus">+</span> Product details</summary>' +
            '<div class="inner">' + safeHtml(p.descriptionHtml) + '</div></details>' : '') +
          '<details class="expand"><summary><span class="plus">+</span> Delivery and returns</summary>' +
            '<div class="inner">Delivery is charged by weight and address, and is shown on the checkout page before you pay. ' +
            'See <a href="' + esc(S.shopUrl(C.policies.shipping)) + '">shipping</a> and ' +
            '<a href="' + esc(S.shopUrl(C.policies.refund)) + '">returns</a> for the full terms.</div></details>' +
          '<details class="expand"><summary><span class="plus">+</span> Ask about this product</summary>' +
            '<div class="inner">Call <a href="tel:' + esc(C.support.phone) + '">' + esc(C.support.phoneLabel) + '</a>, ' +
            'message us on <a href="https://wa.me/' + esc(C.support.whatsapp) + '">WhatsApp</a>, ' +
            'or write to <a href="mailto:' + esc(C.support.email) + '">' + esc(C.support.email) + '</a>.</div></details>' +
        '</div>' +
      '</div>' +
      '<div id="recs"></div>' +
      '</div>';
  }

  /* ================================================================= SEARCH */

  var searchTimer = null;

  function viewSearch(q) {
    app.innerHTML = '<div class="wrap"><div class="searchwrap">' +
      '<div class="searchbox">' +
        '<span style="color:var(--mute-3)">' + icon('search') + '</span>' +
        '<input id="q" type="search" placeholder="Search the store" value="' + esc(q || '') + '" autocomplete="off" aria-label="Search the store">' +
      '</div>' +
      '<div class="suggests" id="sug"></div>' +
      '</div><div id="results"></div></div>';
    var input = document.getElementById('q');
    input.focus();
    input.addEventListener('input', function () { onType(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); go('#/search/' + encodeURIComponent(input.value.trim())); }
    });
    if (q) { runSearch(q); onType(q); }
  }

  function onType(value) {
    if (searchTimer) clearTimeout(searchTimer);
    var v = String(value || '').trim();
    if (v.length < 2) { document.getElementById('sug').innerHTML = ''; return; }
    searchTimer = setTimeout(function () {
      S.suggest(v).then(function (r) {
        var host = document.getElementById('sug');
        if (!host) return;
        var rows = r.collections.slice(0, 3).map(function (c) {
          return '<a href="#/aisle/' + esc(c.handle) + '"><span class="shot" style="display:grid;place-items:center;color:var(--mute-3)">&rarr;</span>' +
            '<span><span class="kind">Aisle</span><br>' + esc(c.title) + '</span></a>';
        }).concat(r.products.slice(0, 6).map(function (p) {
          return '<a href="#/p/' + esc(p.handle) + '">' +
            '<span class="shot">' + (p.image ? '<img src="' + esc(img(p.image, 120)) + '" alt="">' : '') + '</span>' +
            '<span>' + (p.brand ? '<span class="kind">' + esc(p.brand) + '</span><br>' : '') + esc(p.title) + '</span>' +
            '<span class="amt">' + money(p.paise) + '</span></a>';
        }));
        host.innerHTML = rows.join('');
      });
    }, 180);
  }

  function runSearch(q) {
    var host = document.getElementById('results');
    host.innerHTML = '<section class="band"><div class="grid">' + skeletons(8) + '</div></section>';
    S.searchAll(q).then(function (page) {
      if (!page.products.length) {
        host.innerHTML = '<div class="empty"><h1>Nothing matched</h1>' +
          '<p>No product in the store answers to "' + esc(q) + '". Try a brand, or the shelf it would sit on.</p>' +
          '<a class="btn" href="#/">Browse the shelves</a></div>';
        return;
      }
      list = {
        source: {
          title: q, eyebrow: 'Search', aisles: null, handle: null, useApiTitle: false,
          chipHref: function () { return '#/search/' + encodeURIComponent(q); },
          fetch: function (o) { return S.searchAll(q, o); }
        },
        cursor: page.cursor, busy: false, items: page.products
      };
      host.innerHTML = '<section class="band">' +
        '<div class="head"><h2>' + page.total + ' ' + (page.total === 1 ? 'result' : 'results') + ' for "' + esc(q) + '"</h2></div>' +
        '<div class="grid" id="listGrid">' + tiles(page.products) + '</div>' +
        '<div id="listMore" style="padding:28px 0 0;display:flex;justify-content:center">' +
          (page.hasMore ? '<button class="btn quiet" data-act="more">Show more</button>' : '') +
        '</div><div id="listNote"></div></section>';
    }).catch(function (e) {
      host.innerHTML = '<div class="wrap" style="padding-top:30px">' + errorBlock(e) + '</div>';
    });
  }

  /* ================================================================== SAVED */

  function viewSaved() {
    var handles = S.saved();
    if (!handles.length) {
      app.innerHTML = '<div class="wrap"><div class="empty"><h1>Nothing saved yet</h1>' +
        '<p>The heart on any product keeps it here, on this device.</p>' +
        '<a class="btn" href="#/">Find something</a></div></div>';
      return;
    }
    app.innerHTML = '<div class="wrap">' +
      '<div class="listhead"><div><div class="eyebrow">On this device</div><h1>Saved</h1></div></div>' +
      '<div class="grid" id="savedGrid">' + skeletons(Math.min(handles.length, 8)) + '</div></div>';
    S.savedProducts().then(function (items) {
      var host = document.getElementById('savedGrid');
      if (!host) return;
      host.innerHTML = items.length ? tiles(items)
        : '<div class="note"><b>These are no longer listed</b><div>The store has removed what was saved here.</div></div>';
    });
  }

  /* ==================================================================== BAG */

  function lineHtml(l) {
    var warn = !l.available ? 'Sold out since it went in the bag'
      : (l.stock !== null && l.stock < l.qty ? 'Only ' + l.stock + ' left at the store' : '');
    return '<div class="line">' +
      '<a class="shot" href="#/p/' + esc(l.handle) + '">' +
        (l.image ? '<img src="' + esc(img(l.image, 170)) + '" alt="">' : '') + '</a>' +
      '<div>' +
        '<a class="name" href="#/p/' + esc(l.handle) + '" style="color:var(--ink)">' + esc(l.title) + '</a>' +
        (l.variantTitle ? '<div class="vari">' + esc(l.variantTitle) + '</div>' : '') +
        '<div class="ctrl">' +
          '<div class="stepper">' +
            '<button data-line-down="' + esc(l.lineId) + '" aria-label="One fewer">&minus;</button>' +
            '<span>' + l.qty + '</span>' +
            '<button data-line-up="' + esc(l.lineId) + '" aria-label="One more">+</button>' +
          '</div>' +
          '<button class="drop" data-line-drop="' + esc(l.lineId) + '">Remove</button>' +
        '</div>' +
        (warn ? '<div class="warn">' + esc(warn) + '</div>' : '') +
      '</div>' +
      '<div class="amt">' + money(l.linePaise !== null ? l.linePaise : l.paise * l.qty) + '</div>' +
    '</div>';
  }

  function totalsHtml(cart) {
    return '<div class="totals">' +
      '<div class="row"><span>Subtotal</span><span class="v">' + money(cart.subtotalPaise) + '</span></div>' +
      '<div class="fineprint">Delivery and taxes are worked out at checkout, by the store.</div>' +
    '</div>';
  }

  function renderDrawer() {
    var host = document.getElementById('drawer');
    if (!state.drawer) { host.innerHTML = ''; return; }
    var cart = state.cart;
    var body;
    if (!cart || !cart.lines.length) {
      body = '<div class="lines"><div style="padding:40px 0;display:grid;gap:14px;justify-items:start">' +
        '<b class="serif" style="font-size:22px">Your bag is empty</b>' +
        '<p style="color:var(--mute);font-size:14px">Nothing in it yet.</p>' +
        '<a class="btn quiet" href="#/" data-act="closeBag">Start shopping</a></div></div>';
    } else {
      body = '<div class="lines">' + cart.lines.map(lineHtml).join('') + '</div>' +
        '<div class="foot">' + totalsHtml(cart) +
          '<button class="btn wide" data-act="checkout">Checkout securely</button>' +
          '<a href="#/bag" data-act="closeBag" style="text-align:center;font-size:13.5px">View the full bag</a>' +
        '</div>';
    }
    host.innerHTML = '<div class="drawer-veil" data-act="closeBag"></div>' +
      '<aside class="drawer" role="dialog" aria-label="Your bag">' +
        '<div class="top"><b>Your bag' + (cart && cart.count ? ' (' + cart.count + ')' : '') + '</b>' +
          '<button data-act="closeBag" aria-label="Close">&times;</button></div>' +
        body +
      '</aside>';
  }

  function viewBag() {
    var cart = state.cart;
    if (!cart || !cart.lines.length) {
      app.innerHTML = '<div class="wrap"><div class="empty"><h1>Your bag is empty</h1>' +
        '<p>Once something is in it, this is where it waits.</p>' +
        '<a class="btn" href="#/">Start shopping</a></div></div>';
      return;
    }
    app.innerHTML = '<div class="wrap">' +
      '<div class="listhead"><div><div class="eyebrow">' + cart.count + ' ' + (cart.count === 1 ? 'item' : 'items') + '</div>' +
        '<h1>Your bag</h1></div></div>' +
      '<div class="bagpage">' +
        '<div>' + cart.lines.map(lineHtml).join('') + '</div>' +
        '<div class="panel">' + totalsHtml(cart) +
          '<button class="btn wide" data-act="checkout">Checkout securely</button>' +
          '<a href="#/" style="text-align:center;font-size:13.5px">Keep shopping</a>' +
          '<p style="font-size:12.5px;color:var(--mute-2);border-top:1px solid var(--line);padding-top:12px;margin-top:4px">' +
          'Checkout, payment and your order are handled by our store on ' + esc(C.domain) + '.</p>' +
        '</div>' +
      '</div></div>';
  }

  /* =================================================================== HELP */

  function viewHelp() {
    app.innerHTML = '<div class="wrap">' +
      '<div class="listhead"><div><div class="eyebrow">Paws and Tails</div><h1>Help</h1></div></div>' +
      '<div class="contactgrid">' +
        '<a href="tel:' + esc(C.support.phone) + '"><b>Call</b><span>' + esc(C.support.phoneLabel) + '</span></a>' +
        '<a href="https://wa.me/' + esc(C.support.whatsapp) + '"><b>WhatsApp</b><span>Message us about an order</span></a>' +
        '<a href="mailto:' + esc(C.support.email) + '"><b>Email</b><span>' + esc(C.support.email) + '</span></a>' +
        '<a href="' + esc(S.shopUrl(C.policies.account)) + '"><b>Your orders</b><span>Track or reorder</span></a>' +
      '</div>' +
      '<section class="band" style="padding-top:34px"><div style="display:grid;gap:10px;max-width:70ch">' +
        '<details class="expand"><summary><span class="plus">+</span> When will my order arrive?</summary>' +
          '<div class="inner">Delivery time and charge depend on weight and address, and both are shown at checkout before you pay. ' +
          'Full terms are on our <a href="' + esc(S.shopUrl(C.policies.shipping)) + '">shipping page</a>.</div></details>' +
        '<details class="expand"><summary><span class="plus">+</span> Can I return something?</summary>' +
          '<div class="inner">See our <a href="' + esc(S.shopUrl(C.policies.refund)) + '">returns page</a> for what can be sent back and in what condition.</div></details>' +
        '<details class="expand"><summary><span class="plus">+</span> Do you need a prescription?</summary>' +
          '<div class="inner">Some medicines and vet diets are confirmed with you before dispatch. ' +
          'If you are unsure, call <a href="tel:' + esc(C.support.phone) + '">' + esc(C.support.phoneLabel) + '</a> and ask before ordering.</div></details>' +
        '<details class="expand"><summary><span class="plus">+</span> Are the prices here the shop prices?</summary>' +
          '<div class="inner">Yes. Every price, picture and stock line on this site is read from our store as the page loads, ' +
          'so what you see is what the store holds right now.</div></details>' +
      '</div></section></div>';
  }

  /* ================================================================== CART
   * Every change goes to the store and the answer redraws the screen, so the
   * bag on screen is the bag Shopify holds, never a local guess. */

  function refreshCart(quiet) {
    return S.cartGet({ quiet: true }).then(function (cart) {
      state.cart = cart;
      renderChrome();
      if (state.drawer) renderDrawer();
      if (route().page === 'bag' && !quiet) viewBag();
      return cart;
    });
  }

  function addToBag(variantId, qty, thenCheckout) {
    if (pdp.adding) return;
    pdp.adding = true;
    var button = document.querySelector('[data-act="' + (thenCheckout ? 'buy' : 'add') + '"]');
    if (button) { button.disabled = true; button.textContent = thenCheckout ? 'One moment' : 'Adding...'; }
    S.cartAdd(variantId, qty).then(function (cart) {
      state.cart = cart;
      pdp.adding = false;
      renderChrome();
      if (thenCheckout) {
        if (cart && cart.checkoutUrl) { window.location.href = cart.checkoutUrl; return; }
        toast('Could not open checkout. Try the bag.');
      }
      if (button) { button.disabled = false; button.textContent = 'Add to bag'; }
      state.drawer = true;
      renderDrawer();
    }).catch(function (e) {
      pdp.adding = false;
      if (button) { button.disabled = false; button.textContent = thenCheckout ? 'Buy it now' : 'Add to bag'; }
      toast((e && e.storefront && e.message) || 'Could not add that right now.');
    });
  }

  function checkout() {
    var cart = state.cart;
    if (!cart || !cart.lines.length) { toast('The bag is empty.'); return; }
    if (!cart.checkoutUrl) { toast('Checkout is not available right now.'); return; }
    var btn = document.querySelector('[data-act="checkout"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening checkout'; }
    window.location.href = cart.checkoutUrl;
  }

  /* ================================================================ ROUTING */

  function route() {
    var raw = String(window.location.hash || '').replace(/^#\/?/, '');
    var parts = raw.split('/').filter(function (s) { return s.length; }).map(decodeURIComponent);
    if (!parts.length) return { page: 'home', parts: [] };
    var p0 = parts[0];
    if (p0 === 'shelf' && shelfByKey(parts[1])) return { page: 'shelf', parts: parts };
    if (p0 === 'lane' && C.lanes[parts[1]]) return { page: 'lane', parts: parts };
    if (p0 === 'aisle' && parts[1]) return { page: 'aisle', parts: parts };
    if (p0 === 'brand' && parts[1]) return { page: 'brand', parts: parts };
    if (p0 === 'brands') return { page: 'brands', parts: parts };
    if (p0 === 'p' && parts[1]) return { page: 'product', parts: parts };
    if (p0 === 'search') return { page: 'search', parts: parts };
    if (p0 === 'saved') return { page: 'saved', parts: parts };
    if (p0 === 'bag') return { page: 'bag', parts: parts };
    if (p0 === 'help') return { page: 'help', parts: parts };
    return { page: 'missing', parts: parts };
  }

  function go(hash) {
    if (window.location.hash === hash) draw();
    else window.location.hash = hash;
  }

  function draw() {
    var r = route();
    state.menu = false;
    state.mega = false;
    renderChrome();
    document.title = titleFor(r);
    if (r.page === 'home') viewHome();
    else if (r.page === 'shelf') viewList(shelfSource(shelfByKey(r.parts[1]), r.parts[2]));
    else if (r.page === 'lane') viewList(laneSource(r.parts[1], C.lanes[r.parts[1]], r.parts[2]));
    else if (r.page === 'aisle') viewList(aisleSource(r.parts[1]));
    else if (r.page === 'brand') viewList(brandSource(r.parts[1]));
    else if (r.page === 'brands') viewBrands();
    else if (r.page === 'product') viewProduct(r.parts[1]);
    else if (r.page === 'search') viewSearch(r.parts[1] || '');
    else if (r.page === 'saved') viewSaved();
    else if (r.page === 'bag') viewBag();
    else if (r.page === 'help') viewHelp();
    else {
      app.innerHTML = '<div class="wrap"><div class="empty"><h1>This page is not here</h1>' +
        '<p>The link may be old, or mistyped.</p><a class="btn" href="#/">Back to the front</a></div></div>';
    }
    window.scrollTo(0, 0);
  }

  function titleFor(r) {
    var base = 'Paws and Tails';
    if (r.page === 'home') return base + ', pet food, pharmacy and care';
    if (r.page === 'shelf') { var s = shelfByKey(r.parts[1]); return (s ? s.name : 'Shop') + ' | ' + base; }
    if (r.page === 'lane') return C.lanes[r.parts[1]].name + ' | ' + base;
    if (r.page === 'aisle') return aisleLabel(r.parts[1]) + ' | ' + base;
    if (r.page === 'brand') return r.parts[1] + ' | ' + base;
    if (r.page === 'product') return 'Product | ' + base;
    if (r.page === 'search') return 'Search | ' + base;
    if (r.page === 'bag') return 'Your bag | ' + base;
    return base;
  }

  /* ================================================================= EVENTS */

  document.addEventListener('click', function (e) {
    var save = e.target.closest('[data-save]');
    if (save) {
      e.preventDefault();
      var handle = save.getAttribute('data-save');
      var now = S.toggleSaved(handle);
      toast(now ? 'Saved' : 'Removed from saved');
      if (route().page === 'saved') { viewSaved(); return; }
      save.classList.toggle('on', now);
      if (save.classList.contains('btn')) save.textContent = now ? 'Saved' : 'Save for later';
      else {
        var path = save.querySelector('svg');
        if (path) path.setAttribute('fill', now ? 'currentColor' : 'none');
      }
      return;
    }

    var shot = e.target.closest('[data-shot]');
    if (shot) { pdp.imageIndex = Number(shot.getAttribute('data-shot')); drawProduct(); return; }

    var vari = e.target.closest('[data-var]');
    if (vari) { pdp.variantIndex = Number(vari.getAttribute('data-var')); pdp.qty = 1; drawProduct(); return; }

    var up = e.target.closest('[data-line-up]');
    var down = e.target.closest('[data-line-down]');
    var drop = e.target.closest('[data-line-drop]');
    if (up || down || drop) {
      e.preventDefault();
      var id = (up || down || drop).getAttribute(up ? 'data-line-up' : down ? 'data-line-down' : 'data-line-drop');
      var line = null;
      (state.cart ? state.cart.lines : []).forEach(function (l) { if (l.lineId === id) line = l; });
      if (!line) return;
      var work = drop ? S.cartRemove(id) : S.cartSetQty(id, line.qty + (up ? 1 : -1));
      work.then(function (cart) {
        state.cart = cart;
        renderChrome();
        if (state.drawer) renderDrawer();
        if (route().page === 'bag') viewBag();
        if (drop) toast('Removed');
      }).catch(function (err) {
        toast((err && err.storefront && err.message) || 'Could not change the bag.');
      });
      return;
    }

    var act = e.target.closest('[data-act]');
    if (!act) return;
    var name = act.getAttribute('data-act');

    if (name === 'bag') { e.preventDefault(); state.drawer = true; refreshCart(true).then(renderDrawer); renderDrawer(); }
    else if (name === 'closeBag') { state.drawer = false; renderDrawer(); }
    else if (name === 'menu') { e.preventDefault(); state.menu = !state.menu; renderChrome(); }
    else if (name === 'mega') { e.preventDefault(); state.mega = !state.mega; renderChrome(); }
    else if (name === 'add') { e.preventDefault(); var v = pdp.product.variants[pdp.variantIndex]; if (v) addToBag(v.id, pdp.qty, false); }
    else if (name === 'buy') { e.preventDefault(); var b = pdp.product.variants[pdp.variantIndex]; if (b) addToBag(b.id, pdp.qty, true); }
    else if (name === 'checkout') { e.preventDefault(); checkout(); }
    else if (name === 'qtyUp' || name === 'qtyDown') {
      e.preventDefault();
      pdp.qty = Math.max(1, pdp.qty + (name === 'qtyUp' ? 1 : -1));
      var cell = document.getElementById('qty');
      if (cell) cell.textContent = pdp.qty;
    }
    else if (name === 'more') { e.preventDefault(); loadList(false); }
    else if (name === 'retryList') { e.preventDefault(); document.getElementById('listNote').innerHTML = ''; loadList(list.items.length === 0); }
    else if (name === 'reload') { e.preventDefault(); draw(); }
  });

  document.addEventListener('change', function (e) {
    var sort = e.target.closest('[data-act="sort"]');
    if (!sort) return;
    state.sort = sort.value;
    if (list.source) viewList(list.source);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (state.drawer) { state.drawer = false; renderDrawer(); }
    else if (state.menu || state.mega) { state.menu = false; state.mega = false; renderChrome(); }
  });

  window.addEventListener('hashchange', draw);

  /* ==================================================================== BOOT */

  renderChrome();
  renderFooter();
  draw();
  refreshCart(true);
}());
