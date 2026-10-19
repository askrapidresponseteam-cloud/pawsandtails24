/* ============================================================================
 * Paws and Tails storefront, interface layer
 * ============================================================================
 * A reskin over the store, not a catalogue of its own. Collections, products,
 * prices, pictures and stock all come from the store as the page loads, so
 * whatever Shopify lists is what this shop lists, and every one of those
 * products can be put in the bag. The bag is the store's own cart and Checkout
 * is the store's own checkout, which is what places the order.
 *
 * The header is built once. Its parts (the bag count, the menus) are redrawn
 * in place, so the search box keeps its text and focus while the rest of the
 * page changes around it.
 * ========================================================================== */
(function () {
  'use strict';

  var S = window.PTStorefront;
  var C = window.PTCatalogue;

  S.configure({ version: C.apiVersion, domain: C.domain, apiBase: window.PT_API_BASE || '', token: window.PT_TOKEN || '' });

  var app = document.getElementById('app');
  var state = {
    cart: null, drawer: false, menu: false, mega: false, sort: 'featured',
    cols: null, colsLoading: null, toastTimer: null
  };

  /* ================================================================ HELPERS */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(p) { return S.money(p); }
  function img(url, w) { return S.sized(url, w); }
  function enc(s) { return encodeURIComponent(s); }

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

  function icon(name, size) {
    var s = size || 19;
    var common = 'width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    if (name === 'search') return '<svg ' + common + '><circle cx="11" cy="11" r="7"></circle><path d="M16.5 16.5L21 21"></path></svg>';
    if (name === 'heart') return '<svg ' + common + '><path d="M12 20s-7-4.4-7-9.3A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.7C19 15.6 12 20 12 20z"></path></svg>';
    if (name === 'bag') return '<svg ' + common + '><path d="M6 8h12l-1 12H7L6 8z"></path><path d="M9 8V6a3 3 0 0 1 6 0v2"></path></svg>';
    return '';
  }

  /* =========================================================== COLLECTIONS
   * Read from the store once per visit. The menus, the front page and the
   * "more like this" tails all draw from this one list. */

  function loadCollections() {
    if (state.cols) return Promise.resolve(state.cols);
    if (state.colsLoading) return state.colsLoading;
    state.colsLoading = S.collections().then(function (list) {
      var hidden = C.hidden || [];
      state.cols = list.filter(function (c) {
        return c.hasProducts && hidden.indexOf(c.handle) < 0;
      });
      return state.cols;
    }).catch(function () {
      state.colsLoading = null;
      return [];
    });
    return state.colsLoading;
  }

  function colByHandle(handle) {
    var list = state.cols || [];
    for (var i = 0; i < list.length; i++) if (list[i].handle === handle) return list[i];
    return null;
  }

  function colCard(c) {
    if (c.image) {
      return '<a class="shelfcard pic" href="#/c/' + esc(c.handle) + '">' +
        '<div class="ph"><img src="' + esc(img(c.image, 420)) + '" alt="" loading="lazy"></div>' +
        '<div class="tx"><b>' + esc(c.title) + '</b><span>Shop the collection</span></div></a>';
    }
    return '<a class="shelfcard" href="#/c/' + esc(c.handle) + '"><b>' + esc(c.title) + '</b>' +
      '<span>Shop the collection</span></a>';
  }

  /* ================================================================ CHROME */

  function buildChrome() {
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
            '<a href="#/all">Shop all</a>' +
            '<button data-act="mega" id="megaBtn" aria-expanded="false">Collections <span style="font-size:10px;color:var(--mute-2)">&#9662;</span></button>' +
            '<a href="#/brands">Brands</a>' +
            '<a href="#/help">Help</a>' +
          '</nav>' +
          '<a class="wordmark" href="#/" aria-label="Paws and Tails home">paws<em>&amp;</em>tails</a>' +
          '<div class="tools">' +
            '<form class="hsearch" role="search" autocomplete="off" onsubmit="return false">' +
              '<span class="glass">' + icon('search', 17) + '</span>' +
              '<input id="hq" type="search" placeholder="Search products, brands, collections" aria-label="Search the shop" autocomplete="off" spellcheck="false">' +
              '<div class="hsug" id="hsug" hidden></div>' +
            '</form>' +
            '<a class="msearch" href="#/search" aria-label="Search">' + icon('search') + '</a>' +
            '<a class="wide-only" href="#/saved" aria-label="Saved items">' + icon('heart') + '</a>' +
            '<button data-act="bag" aria-label="Open bag" id="bagBtn">' + icon('bag') + '</button>' +
          '</div>' +
        '</div>' +
        '<div id="megaSlot"></div>' +
      '</header>' +
      '<div id="menuSlot"></div>';

    attachSearch(document.getElementById('hq'), document.getElementById('hsug'), { dropdown: true });
  }

  function updatePip() {
    var btn = document.getElementById('bagBtn');
    if (!btn) return;
    var count = state.cart ? state.cart.count : 0;
    var pip = btn.querySelector('.pip');
    if (!count) { if (pip) pip.remove(); return; }
    if (!pip) { pip = document.createElement('span'); pip.className = 'pip'; btn.appendChild(pip); }
    pip.textContent = String(count);
  }

  function renderMega() {
    var slot = document.getElementById('megaSlot');
    var btn = document.getElementById('megaBtn');
    if (btn) btn.setAttribute('aria-expanded', state.mega ? 'true' : 'false');
    if (!slot) return;
    if (!state.mega) { slot.innerHTML = ''; return; }
    var cols = state.cols;
    if (!cols) {
      slot.innerHTML = '<div class="mega"><div class="cols"><div class="count">Loading collections...</div></div></div>';
      loadCollections().then(function () { if (state.mega) renderMega(); });
      return;
    }
    var shown = cols.slice(0, 28);
    var per = Math.ceil(shown.length / 4) || 1;
    var columns = [0, 1, 2, 3].map(function (i) {
      return '<ul>' + shown.slice(i * per, (i + 1) * per).map(function (c) {
        return '<li><a href="#/c/' + esc(c.handle) + '">' + esc(c.title) + '</a></li>';
      }).join('') + '</ul>';
    }).join('');
    slot.innerHTML = '<div class="mega"><div class="cols">' + columns +
      '<a class="feature" href="#/search/' + enc('dog') + '">' +
        '<img src="assets/img/dog.webp" alt="A dog on a leash in a garden">' +
        '<div class="cap"><span class="eyebrow" style="color:rgba(255,255,255,.9)">' +
          (cols.length > shown.length ? cols.length + ' collections' : 'Everything canine') + '</span>' +
          '<b>For dogs</b></div>' +
      '</a>' +
      '<div style="grid-column:1 / span 4"><a href="#/collections" style="font-size:14px">See every collection &rarr;</a></div>' +
      '</div></div>';
  }

  function renderMenu() {
    var slot = document.getElementById('menuSlot');
    if (!slot) return;
    if (!state.menu) { slot.innerHTML = ''; return; }
    var cols = (state.cols || []).slice(0, 40);
    var items = cols.map(function (c) {
      return '<a href="#/c/' + esc(c.handle) + '" style="font-size:16px;color:var(--ink);padding:13px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between">' +
        '<span>' + esc(c.title) + '</span><span style="color:var(--mute-3)">&rarr;</span></a>';
    }).join('');
    slot.innerHTML = '<div class="sheet" style="position:fixed;inset:0;z-index:80;background:#fff;overflow-y:auto">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;height:66px;padding:0 20px;border-bottom:1px solid var(--line)">' +
        '<span class="wordmark" style="font-size:25px">paws<em>&amp;</em>tails</span>' +
        '<button data-act="menu" aria-label="Close menu" style="width:44px;height:44px;border:0;background:none;font-size:26px;cursor:pointer;color:var(--ink)">&times;</button>' +
      '</div>' +
      '<nav style="display:flex;flex-direction:column;padding:12px 20px 40px">' +
        '<a href="#/search" class="serif" style="font-size:26px;color:var(--ink);padding:12px 0;border-bottom:1px solid var(--line)">Search</a>' +
        '<a href="#/all" class="serif" style="font-size:26px;color:var(--ink);padding:12px 0;border-bottom:1px solid var(--line)">Shop all</a>' +
        (items || '<span class="count" style="padding:14px 0">Loading collections...</span>') +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px">' +
          '<a href="#/brands" style="padding:14px;background:var(--sand);color:var(--ink);font-size:15px">Brands</a>' +
          '<a href="#/saved" style="padding:14px;background:var(--sand);color:var(--ink);font-size:15px">Saved</a>' +
          '<a href="#/bag" style="padding:14px;background:var(--sand);color:var(--ink);font-size:15px">Bag</a>' +
          '<a href="#/help" style="padding:14px;background:var(--sand);color:var(--ink);font-size:15px">Help</a>' +
        '</div>' +
      '</nav></div>';
    if (!state.cols) loadCollections().then(function () { if (state.menu) renderMenu(); });
  }

  function renderFooter() {
    document.getElementById('foot').innerHTML =
      '<footer class="site"><div class="cols">' +
        '<div>' +
          '<div class="wordmark" style="color:var(--plum)">paws<em>&amp;</em>tails</div>' +
          '<p style="margin-top:12px;max-width:34ch;color:var(--mute);font-size:14px">' +
            'Food, medicine, supplements and everyday care for dogs, cats, birds and small pets.</p>' +
        '</div>' +
        '<div><h4>Shop</h4><ul>' +
          '<li><a href="#/all">Shop all</a></li>' +
          '<li><a href="#/collections">Collections</a></li>' +
          '<li><a href="#/brands">Brands</a></li>' +
          '<li><a href="#/search">Search</a></li>' +
        '</ul></div>' +
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

  /* ================================================================= SEARCH
   * One engine behind the header box and the search page. Every keystroke is
   * numbered and only the newest answer is drawn, so a slow reply for "dro"
   * can never overwrite the reply for "drools". Collections and brands are
   * matched here, instantly, from what the store already sent; products come
   * from the store's own prediction, or a prefix match when it has none. */

  function highlight(text, q) {
    var t = esc(text);
    var words = String(q || '').trim().split(/\s+/).filter(function (w) { return w.length > 1; })
      .map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    if (!words.length) return t;
    try {
      return t.replace(new RegExp('(' + words.map(esc).join('|') + ')', 'gi'), '<mark>$1</mark>');
    } catch (e) { return t; }
  }

  function localMatches(q) {
    var n = String(q || '').trim().toLowerCase();
    if (n.length < 2) return { cols: [], brands: [] };
    var words = n.split(/\s+/);
    function hit(s) {
      var h = String(s || '').toLowerCase();
      return words.every(function (w) { return h.indexOf(w) >= 0; });
    }
    return {
      cols: (state.cols || []).filter(function (c) { return hit(c.title); }).slice(0, 4),
      brands: (C.brands || []).filter(hit).slice(0, 3)
    };
  }

  function suggestHtml(q, r, local) {
    var seen = {};
    var cols = local.cols.concat((r && r.collections) || []).filter(function (c) {
      if (seen[c.handle] || (C.hidden || []).indexOf(c.handle) >= 0) return false;
      seen[c.handle] = true;
      return true;
    }).slice(0, 4);
    var products = (r && r.products) || [];
    var out = [];
    if (products.length) {
      out.push('<div class="grp">Products</div>');
      products.slice(0, 7).forEach(function (p) {
        out.push('<a href="#/p/' + esc(p.handle) + '">' +
          '<span class="thumb">' + (p.image ? '<img src="' + esc(img(p.image, 100)) + '" alt="">' : '') + '</span>' +
          '<span class="txt">' + (p.brand ? '<small>' + esc(p.brand) + '</small>' : '') + highlight(p.title, q) + '</span>' +
          (p.available
            ? '<span class="amt">' + (p.ranged ? 'from ' : '') + money(p.paise) + '</span>'
            : '<span class="amt out">Sold out</span>') +
          '</a>');
      });
    }
    if (cols.length) {
      out.push('<div class="grp">Collections</div>');
      cols.forEach(function (c) {
        out.push('<a href="#/c/' + esc(c.handle) + '"><span class="thumb">&rarr;</span>' +
          '<span class="txt">' + highlight(c.title, q) + '</span></a>');
      });
    }
    if (local.brands.length) {
      out.push('<div class="grp">Brands</div>');
      local.brands.forEach(function (b) {
        out.push('<a href="#/brand/' + esc(enc(b)) + '"><span class="thumb">&rarr;</span>' +
          '<span class="txt">' + highlight(b, q) + '</span></a>');
      });
    }
    if (!out.length) {
      return '<div class="sugs"><div class="none">Nothing in the store matches "' + esc(q) + '" yet. ' +
        'Try a brand, or fewer words.</div></div>';
    }
    out.push('<a class="seeall" href="#/search/' + esc(enc(q)) + '">See all results for "' + esc(q) + '" &rarr;</a>');
    return '<div class="sugs">' + out.join('') + '</div>';
  }

  function attachSearch(input, host, opts) {
    opts = opts || {};
    var seq = 0;
    var timer = null;
    var active = -1;

    function open() { if (opts.dropdown) host.hidden = false; }
    function close() { if (opts.dropdown) { host.hidden = true; } active = -1; }
    function links() { return Array.prototype.slice.call(host.querySelectorAll('.sugs a')); }
    function mark(i) {
      var ls = links();
      ls.forEach(function (a, j) { a.classList.toggle('on', j === i); });
      active = i;
      if (ls[i] && ls[i].scrollIntoView) ls[i].scrollIntoView({ block: 'nearest' });
    }

    function run() {
      var q = input.value.trim();
      var mine = ++seq;
      if (q.length < 2) {
        host.innerHTML = '';
        close();
        return;
      }
      var local = localMatches(q);
      /* Collections and brands are already here, so they show at once. */
      host.innerHTML = suggestHtml(q, null, local).replace('<div class="none">', '<div class="busy">')
        .replace(/Nothing in the store matches[^<]*/, 'Searching the store...');
      open();
      active = -1;
      S.suggest(q).then(function (r) {
        if (mine !== seq) return;
        host.innerHTML = suggestHtml(q, r, localMatches(q));
        open();
        active = -1;
      });
    }

    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 160);
    });
    input.addEventListener('focus', function () {
      if (input.value.trim().length >= 2 && host.innerHTML) open();
    });
    input.addEventListener('keydown', function (e) {
      var ls = links();
      if (e.key === 'ArrowDown') { e.preventDefault(); if (ls.length) mark(Math.min(active + 1, ls.length - 1)); open(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (ls.length) mark(Math.max(active - 1, 0)); }
      else if (e.key === 'Escape') { close(); input.blur(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (timer) clearTimeout(timer);
        if (active >= 0 && ls[active]) { window.location.hash = ls[active].getAttribute('href'); }
        else if (input.value.trim()) { go('#/search/' + enc(input.value.trim())); }
        close();
        if (opts.dropdown) input.blur();
      }
    });
    if (opts.dropdown) {
      document.addEventListener('mousedown', function (e) {
        if (!host.hidden && !e.target.closest('.hsearch')) close();
      });
      host.addEventListener('click', function (e) { if (e.target.closest('a')) close(); });
      window.addEventListener('hashchange', close);
    }
    return { run: run, close: close };
  }

  /* ================================================================== TILES */

  function tileHtml(p) {
    var off = p.available ? S.discountPercent(p) : 0;
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
          (off ? '<span class="off">' + off + '% off</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function tiles(list) { return list.map(tileHtml).join(''); }

  function railInto(id, fetcher) {
    fetcher().then(function (page) {
      var host = document.querySelector('#' + id + ' .rail');
      if (!host) return;
      if (!page.products.length) { var band = document.getElementById(id); if (band) band.remove(); return; }
      host.innerHTML = tiles(page.products.slice(0, 12));
    }).catch(function () {
      var band = document.getElementById(id);
      if (band) band.remove();
    });
  }

  /* =================================================================== HOME */

  function viewHome() {
    app.innerHTML =
      '<section class="hero">' +
        '<img src="assets/img/hero.webp" alt="A dog resting on a doorstep">' +
        '<div class="veil"></div>' +
        '<div class="inner"><div>' +
          '<div class="eyebrow">Paws and Tails</div>' +
          '<h1>Everything for the animals you look after</h1>' +
          '<div class="ctas">' +
            '<a class="btn light" href="#/all">Shop all</a>' +
            '<a class="btn ghost" href="#/collections">Collections</a>' +
          '</div>' +
        '</div></div>' +
      '</section>' +
      '<div class="wrap">' +
        '<section class="band" id="railBest">' +
          '<div class="head"><h2>Best sellers</h2><a class="more" href="#/all">Shop all &rarr;</a></div>' +
          '<div class="rail">' + skeletons(5) + '</div></section>' +
        '<section class="band">' +
          '<div class="head"><h2>Shop by collection</h2><a class="more" href="#/collections">All collections &rarr;</a></div>' +
          '<div class="shelfgrid" id="homeCols">' + skeletons(6, 'shelf') + '</div>' +
          '<div id="homeColsMore"></div>' +
          '<div class="feature2">' +
            '<a href="#/search/' + enc('dog') + '"><img src="assets/img/dog.webp" alt="A dog on a leash outdoors">' +
              '<div class="cap"><span>Food, treats, walks and grooming</span><b>For dogs</b></div></a>' +
            '<a href="#/search/' + enc('cat') + '"><img src="assets/img/cat.webp" alt="A cat indoors">' +
              '<div class="cap"><span>Food, litter, play and care</span><b>For cats</b></div></a>' +
          '</div>' +
        '</section>' +
        '<section class="band" id="railNew">' +
          '<div class="head"><h2>New in</h2><a class="more" href="#/all">See everything &rarr;</a></div>' +
          '<div class="rail">' + skeletons(5) + '</div></section>' +
      '</div>';

    railInto('railBest', function () { return S.allProducts({ sort: 'featured' }); });
    railInto('railNew', function () { return S.allProducts({ sort: 'newest' }); });

    loadCollections().then(function (cols) {
      var host = document.getElementById('homeCols');
      if (!host) return;
      if (!cols.length) {
        host.outerHTML = '<div class="note"><b>The full range is one click away</b>' +
          '<div><a class="btn quiet" href="#/all">Shop all products</a></div></div>';
        return;
      }
      var first = cols.slice(0, 12);
      host.innerHTML = first.map(colCard).join('');
      if (cols.length > first.length) {
        document.getElementById('homeColsMore').innerHTML =
          '<div style="padding:16px 0 0"><button class="btn quiet" data-act="moreCols">+ Show all ' + cols.length + ' collections</button></div>';
      }
    });
  }

  function viewCollections() {
    app.innerHTML = '<div class="wrap">' +
      '<div class="listhead"><div><div class="eyebrow">Paws and Tails</div><h1>Collections</h1></div>' +
        '<span class="count" id="colCount"></span></div>' +
      '<div class="shelfgrid" id="allCols">' + skeletons(12, 'shelf') + '</div></div>';
    loadCollections().then(function (cols) {
      var host = document.getElementById('allCols');
      if (!host) return;
      document.getElementById('colCount').textContent = cols.length ? cols.length + ' collections' : '';
      host.innerHTML = cols.length ? cols.map(colCard).join('')
        : '<div class="note"><b>Collections could not be read just now</b>' +
          '<div><a class="btn quiet" href="#/all">Shop all products instead</a></div></div>';
    });
  }

  /* =================================================================== LIST
   * One view for every listing: everything, a collection, a brand, a search. */

  var list = { source: null, cursor: null, busy: false, items: [], mode: null };

  function viewList(source) {
    list = { source: source, cursor: null, busy: false, items: [], mode: null };
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
      (source.intro || '') +
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

    src.fetch({ sort: state.sort, after: list.cursor, mode: list.mode }).then(function (page) {
      list.busy = false;
      var grid = document.getElementById('listGrid');
      if (!grid) return;
      if (page.missing) {
        app.querySelector('.wrap').innerHTML =
          '<div class="empty"><h1>That collection is not in the shop</h1>' +
          '<p>The store does not list it any more.</p>' +
          '<a class="btn" href="#/all">Shop everything</a></div>';
        return;
      }
      if (page.title && src.useApiTitle) {
        var h = document.getElementById('listTitle');
        if (h) h.textContent = page.title;
      }
      if (page.mode) list.mode = page.mode;
      list.items = list.items.concat(page.products);
      list.cursor = page.cursor;
      grid.innerHTML = list.items.length ? tiles(list.items) : '';
      var count = document.getElementById('listCount');
      if (count) {
        var n = typeof page.total === 'number' && src.showTotal ? page.total : list.items.length;
        count.textContent = list.items.length
          ? n + (page.hasMore && !(typeof page.total === 'number' && src.showTotal) ? '+' : '') + ' ' + (n === 1 ? 'item' : 'items')
          : '';
      }
      if (more) more.innerHTML = page.hasMore ? '<button class="btn quiet" data-act="more">Show more</button>' : '';

      var note = document.getElementById('listNote');
      if (!list.items.length) {
        note.innerHTML = src.emptyHtml ? src.emptyHtml()
          : '<div class="note"><b>Nothing here right now</b><div>The store has no products listed here at the moment.</div>' +
            '<div><a class="btn quiet" href="#/all">Shop everything</a></div></div>';
      } else if (!page.hasMore && list.items.length < 10 && first) {
        /* A short list should not end the page in white space. */
        loadCollections().then(function (cols) {
          var others = cols.filter(function (c) { return c.handle !== src.handle; }).slice(0, 8);
          if (!others.length || !document.getElementById('listNote')) return;
          document.getElementById('listNote').innerHTML =
            '<section class="band" style="padding-top:34px"><div class="head"><h2>Keep browsing</h2>' +
            '<a class="more" href="#/collections">All collections &rarr;</a></div>' +
            '<div class="shelfgrid">' + others.map(colCard).join('') + '</div></section>';
        });
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

  function allSource() {
    return {
      title: 'Shop all', eyebrow: 'Everything in the store', handle: null,
      fetch: function (o) { return S.allProducts(o); }
    };
  }
  function collectionSource(handle) {
    var c = colByHandle(handle);
    return {
      title: c ? c.title : 'Collection', eyebrow: 'Collection', handle: handle, useApiTitle: true,
      fetch: function (o) { return S.collectionPage(handle, o); }
    };
  }
  function brandSource(name) {
    return {
      title: name, eyebrow: 'Brand', handle: null,
      fetch: function (o) { return S.brandPage(name, o); },
      emptyHtml: function () {
        return '<div class="note"><b>Nothing listed under ' + esc(name) + ' right now</b>' +
          '<div><a class="btn quiet" href="#/search/' + esc(enc(name)) + '">Search for ' + esc(name) + ' instead</a></div></div>';
      }
    };
  }

  function viewBrands() {
    app.innerHTML = '<div class="wrap">' +
      '<div class="listhead"><div><div class="eyebrow">Paws and Tails</div><h1>Brands</h1></div></div>' +
      '<div class="shelfgrid">' + C.brands.map(function (b) {
        return '<a class="shelfcard" href="#/brand/' + esc(enc(b)) + '"><b>' + esc(b) + '</b>' +
          '<span>Shop the range</span></a>';
      }).join('') + '</div>' +
      '<div style="padding:24px 0 0"><p style="color:var(--mute);font-size:14px;max-width:60ch">' +
      'Any other brand the store carries is one search away, from the box at the top of every page.</p></div>' +
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
        app.innerHTML = '<div class="wrap"><div class="empty"><h1>Not in the shop</h1>' +
          '<p>The store no longer lists this product.</p>' +
          '<a class="btn" href="#/all">Shop everything</a></div></div>';
        return;
      }
      pdp = { product: p, variantIndex: firstSellable(p), imageIndex: 0, qty: 1, adding: false };
      document.title = p.title + ' | Paws and Tails';
      drawProduct();
      S.recommendations(p.id).then(function (recs) {
        var host = document.getElementById('recs');
        if (!host || !recs.length) return;
        host.innerHTML = '<section class="band"><div class="head"><h2>Goes with this</h2></div>' +
          '<div class="rail">' + tiles(recs.slice(0, 10)) + '</div></section>';
      });
    }).catch(function (e) {
      app.innerHTML = '<div class="wrap" style="padding-top:40px">' + errorBlock(e) +
        '<p style="padding-top:14px;font-size:14px;color:var(--mute)">Or open <a href="' +
        esc(S.shopUrl('/products/' + handle)) + '">this product on ' + esc(C.domain) + '</a>.</p></div>';
    });
  }

  function firstSellable(p) {
    for (var i = 0; i < p.variants.length; i++) if (p.variants[i].available) return i;
    return 0;
  }

  function stockLine(v) {
    if (!v) return '';
    if (!v.available) return '<div class="stock out">Sold out right now. Call us and we will tell you when it is back.</div>';
    if (v.backorder) return '<div class="stock">Available to order, dispatched when it arrives.</div>';
    if (v.stock !== null && v.stock > 0 && v.stock <= 5) {
      return '<div class="stock low">Only ' + v.stock + ' left.</div>';
    }
    return '<div class="stock">In stock.</div>';
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
        (p.brand ? '<a href="#/brand/' + esc(enc(p.brand)) + '" style="color:var(--mute-2)">' + esc(p.brand) + '</a> / ' : '') +
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
          (p.brand ? '<div class="brandline"><a href="#/brand/' + esc(enc(p.brand)) + '">' + esc(p.brand) + '</a></div>' : '') +
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
              '<button data-act="qtyDown" aria-label="One fewer">-</button>' +
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

  /* ============================================================ SEARCH PAGE */

  function viewSearch(q) {
    app.innerHTML = '<div class="wrap"><div class="searchwrap">' +
      '<div class="searchbox">' +
        '<span style="color:var(--mute-3)">' + icon('search') + '</span>' +
        '<input id="q" type="search" placeholder="Search products, brands, collections" value="' + esc(q || '') + '" autocomplete="off" spellcheck="false" aria-label="Search the shop">' +
      '</div>' +
      '<div id="sug" style="margin-top:12px"></div>' +
      '</div><div id="results"></div></div>';
    var input = document.getElementById('q');
    var engine = attachSearch(input, document.getElementById('sug'), { dropdown: false });
    var head = document.getElementById('hq');
    if (head && q) head.value = q;
    if (q) runSearch(q);
    else { input.focus(); }
    engine.close();
  }

  function runSearch(q) {
    var host = document.getElementById('results');
    host.innerHTML = '<section class="band"><div class="grid">' + skeletons(8) + '</div></section>';
    list = {
      source: {
        title: q, eyebrow: 'Search', handle: null, showTotal: true,
        fetch: function (o) { return S.searchAll(q, o); }
      },
      cursor: null, busy: false, items: [], mode: null
    };
    S.searchAll(q, { sort: state.sort }).then(function (page) {
      if (!page.products.length) {
        host.innerHTML = '<div class="empty"><h1>Nothing matched "' + esc(q) + '"</h1>' +
          '<p>Try a brand, a shorter word, or browse everything.</p>' +
          '<div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="#/all">Shop all</a>' +
          '<a class="btn quiet" href="#/collections">Collections</a></div></div>';
        return;
      }
      list.items = page.products;
      list.cursor = page.cursor;
      list.mode = page.mode;
      var total = typeof page.total === 'number' ? page.total : null;
      host.innerHTML = '<section class="band" style="padding-top:34px">' +
        '<div class="head"><h2>' + (total !== null ? total + ' ' + (total === 1 ? 'result' : 'results') : 'Results') +
          ' for "' + esc(q) + '"</h2>' +
          '<select class="sort" data-act="searchSort" aria-label="Sort">' +
            Object.keys(S.sorts).filter(function (k) { return k !== 'newest'; }).map(function (k) {
              return '<option value="' + k + '"' + (k === state.sort ? ' selected' : '') + '>' + esc(S.sorts[k].label) + '</option>';
            }).join('') +
          '</select></div>' +
        '<div class="grid" id="listGrid">' + tiles(page.products) + '</div>' +
        '<div id="listMore" style="padding:28px 0 0;display:flex;justify-content:center">' +
          (page.hasMore ? '<button class="btn quiet" data-act="more">Show more</button>' : '') +
        '</div><div id="listNote"></div></section>';
    }).catch(function (e) {
      host.innerHTML = '<div style="padding-top:30px">' + errorBlock(e) + '</div>';
    });
  }

  /* ================================================================== SAVED */

  function viewSaved() {
    var handles = S.saved();
    if (!handles.length) {
      app.innerHTML = '<div class="wrap"><div class="empty"><h1>Nothing saved yet</h1>' +
        '<p>The heart on any product keeps it here, on this device.</p>' +
        '<a class="btn" href="#/all">Find something</a></div></div>';
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
      : (l.stock !== null && l.stock < l.qty ? 'Only ' + l.stock + ' left' : '');
    return '<div class="line">' +
      '<a class="shot" href="#/p/' + esc(l.handle) + '">' +
        (l.image ? '<img src="' + esc(img(l.image, 170)) + '" alt="">' : '') + '</a>' +
      '<div>' +
        '<a class="name" href="#/p/' + esc(l.handle) + '" style="color:var(--ink)">' + esc(l.title) + '</a>' +
        (l.variantTitle ? '<div class="vari">' + esc(l.variantTitle) + '</div>' : '') +
        '<div class="ctrl">' +
          '<div class="stepper">' +
            '<button data-line-down="' + esc(l.lineId) + '" aria-label="One fewer">-</button>' +
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
        '<a class="btn quiet" href="#/all" data-act="closeBag">Start shopping</a></div></div>';
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
        '<a class="btn" href="#/all">Start shopping</a></div></div>';
      return;
    }
    app.innerHTML = '<div class="wrap">' +
      '<div class="listhead"><div><div class="eyebrow">' + cart.count + ' ' + (cart.count === 1 ? 'item' : 'items') + '</div>' +
        '<h1>Your bag</h1></div></div>' +
      '<div class="bagpage">' +
        '<div>' + cart.lines.map(lineHtml).join('') + '</div>' +
        '<div class="panel">' + totalsHtml(cart) +
          '<button class="btn wide" data-act="checkout">Checkout securely</button>' +
          '<a href="#/all" style="text-align:center;font-size:13.5px">Keep shopping</a>' +
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
        '<details class="expand"><summary><span class="plus">+</span> Are these the store prices?</summary>' +
          '<div class="inner">Yes. Every product, price and stock line here is read from our store as the page loads, ' +
          'and checkout happens on the store itself.</div></details>' +
      '</div></section></div>';
  }

  /* ================================================================== CART */

  function refreshCart() {
    return S.cartGet({ quiet: true }).then(function (cart) {
      state.cart = cart;
      updatePip();
      if (state.drawer) renderDrawer();
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
      updatePip();
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
    var parts = raw.split('/').filter(function (s) { return s.length; }).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
    if (!parts.length) return { page: 'home', parts: [] };
    var p0 = parts[0];
    if (p0 === 'all') return { page: 'all', parts: parts };
    if (p0 === 'collections') return { page: 'collections', parts: parts };
    if ((p0 === 'c' || p0 === 'aisle') && parts[1]) return { page: 'collection', parts: parts, handle: parts[1] };
    /* Older links: a shelf or lane page, with or without an aisle. */
    if ((p0 === 'shelf' || p0 === 'lane') && parts[2]) return { page: 'collection', parts: parts, handle: parts[2] };
    if (p0 === 'shelf' || p0 === 'lane') return { page: 'collections', parts: parts };
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

  var TITLES = {
    home: 'Paws and Tails, pet food, pharmacy and care', all: 'Shop all', collections: 'Collections',
    brands: 'Brands', search: 'Search', saved: 'Saved', bag: 'Your bag', help: 'Help'
  };

  function draw() {
    var r = route();
    if (state.menu || state.mega) { state.menu = false; state.mega = false; renderMenu(); renderMega(); }
    document.title = r.page === 'home' ? TITLES.home : (TITLES[r.page] || 'Paws and Tails') + ' | Paws and Tails';
    if (r.page !== 'search') { var hq = document.getElementById('hq'); if (hq && document.activeElement !== hq) hq.value = ''; }

    if (r.page === 'home') viewHome();
    else if (r.page === 'all') viewList(allSource());
    else if (r.page === 'collections') viewCollections();
    else if (r.page === 'collection') viewList(collectionSource(r.handle));
    else if (r.page === 'brand') { document.title = r.parts[1] + ' | Paws and Tails'; viewList(brandSource(r.parts[1])); }
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
        var svg = save.querySelector('svg');
        if (svg) svg.setAttribute('fill', now ? 'currentColor' : 'none');
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
        updatePip();
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

    if (name === 'bag') { e.preventDefault(); state.drawer = true; renderDrawer(); refreshCart(); }
    else if (name === 'closeBag') { state.drawer = false; renderDrawer(); }
    else if (name === 'menu') { e.preventDefault(); state.menu = !state.menu; renderMenu(); }
    else if (name === 'mega') { e.preventDefault(); state.mega = !state.mega; renderMega(); }
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
    else if (name === 'moreCols') {
      e.preventDefault();
      var hostCols = document.getElementById('homeCols');
      if (hostCols && state.cols) hostCols.innerHTML = state.cols.map(colCard).join('');
      act.parentNode.remove();
    }
    else if (name === 'retryList') { e.preventDefault(); document.getElementById('listNote').innerHTML = ''; loadList(list.items.length === 0); }
    else if (name === 'reload') { e.preventDefault(); draw(); }
  });

  document.addEventListener('change', function (e) {
    var sort = e.target.closest('[data-act="sort"]');
    if (sort) { state.sort = sort.value; if (list.source) viewList(list.source); return; }
    var ss = e.target.closest('[data-act="searchSort"]');
    if (ss) { state.sort = ss.value; var r = route(); if (r.parts[1]) runSearch(r.parts[1]); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && !/input|textarea|select/i.test((document.activeElement || {}).tagName || '')) {
      var hq = document.getElementById('hq');
      if (hq && hq.offsetParent !== null) { e.preventDefault(); hq.focus(); }
      return;
    }
    if (e.key !== 'Escape') return;
    if (state.drawer) { state.drawer = false; renderDrawer(); }
    else if (state.menu || state.mega) { state.menu = false; state.mega = false; renderMenu(); renderMega(); }
  });

  window.addEventListener('hashchange', draw);

  /* ==================================================================== BOOT */

  buildChrome();
  renderFooter();
  draw();
  refreshCart();
  loadCollections();
}());
