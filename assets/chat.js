/* ============================================================================
 * Paws and Tails assistant: the chat window
 * ============================================================================
 * A button in the corner that opens a conversation. What it says and does
 * comes from assets/assistant.js (which reads the live store and places
 * orders through the same checkout as the site); this file draws it:
 *
 *   messages, quick replies, product cards, a size picker, the bag with
 *   - and +, an address form, the order summary with delivery and payment
 *   choices and one Place order button, the confirmation, the order card
 *   from the track page, and links.
 *
 * Buttons carry their action with them, so tapping one does exactly that
 * thing; typing works too. Cards that a newer one replaces stop working, so
 * an old summary can never place an order. The conversation is kept for the
 * visit, across pages.
 * ========================================================================== */
(function () {
  'use strict';

  var S = window.PTStorefront;
  var C = window.PTCatalogue;
  var A = window.PTAssist;
  var APP = window.PTApp;
  if (!S || !C || !A || !APP || !window.PTNlu) return;

  var esc = APP.esc;
  var KEY = 'pt_chat_v2';
  var ui = { open: false, busy: false, log: null, input: null, chips: null };
  var bot = A.create({
    S: S, C: C, collections: APP.loadCollections,
    shop: {
      place: function (p) { return APP.payAndPlace(p, { onStatus: status }); },
      savedAddress: APP.savedAddress,
      keepAddress: APP.keepAddress,
      setCart: APP.setCart,
      stateOfPin: APP.stateOfPin
    }
  });

  /* --------------------------------------------------------------- memory */

  function save() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        html: ui.log ? ui.log.innerHTML : '',
        chips: ui.chips ? ui.chips.innerHTML : '',
        open: ui.open,
        state: bot.state
      }));
    } catch (e) { /* storage blocked: the chat still works, it just starts fresh */ }
  }
  function load() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- icons */

  var PAW = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<ellipse cx="6.2" cy="9.6" rx="2.1" ry="2.6"/><ellipse cx="10" cy="6" rx="2.1" ry="2.7"/>' +
    '<ellipse cx="14.4" cy="6" rx="2.1" ry="2.7"/><ellipse cx="18" cy="9.8" rx="2.1" ry="2.6"/>' +
    '<path d="M12.2 11.2c-3.3 0-6.2 3.6-6.2 6.2 0 1.7 1.3 2.6 3 2.6 1.3 0 2.1-.6 3.2-.6s1.9.6 3.2.6c1.7 0 3-.9 3-2.6 0-2.6-2.9-6.2-6.2-6.2z"/></svg>';
  var SEND = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>';
  var RESTART = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>';
  var TICK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  /* ---------------------------------------------------------------- shell */

  function build() {
    var root = document.createElement('div');
    root.id = 'ptchat';
    root.innerHTML =
      '<button class="cl-launch" data-chat="open" aria-label="Ask Paws and Tails" aria-expanded="false">' +
        '<span class="paw">' + PAW + '</span><span class="cl-txt">Ask us</span></button>' +
      '<section class="cl-panel" role="dialog" aria-label="Paws and Tails assistant" hidden>' +
        '<header class="cl-head">' +
          '<span class="cl-avatar">' + PAW + '</span>' +
          '<div class="cl-title"><b>Paws &amp; Tails help</b><span><i class="live"></i>Orders, tracking and answers from our store</span></div>' +
          '<button class="cl-x cl-new" data-chat="restart" aria-label="Start a new chat" title="New chat">' + RESTART + '</button>' +
          '<button class="cl-x" data-chat="close" aria-label="Close chat">&times;</button>' +
        '</header>' +
        '<div class="cl-log" role="log" aria-live="polite"></div>' +
        '<div class="cl-chips"></div>' +
        '<form class="cl-form" autocomplete="off">' +
          '<input class="cl-input" type="text" maxlength="400" placeholder="Order, track, or ask anything" aria-label="Your message" enterkeyhint="send">' +
          '<button class="cl-send" type="submit" aria-label="Send">' + SEND + '</button>' +
        '</form>' +
      '</section>';
    document.body.appendChild(root);
    ui.root = root;
    ui.panel = root.querySelector('.cl-panel');
    ui.launch = root.querySelector('.cl-launch');
    ui.log = root.querySelector('.cl-log');
    ui.chips = root.querySelector('.cl-chips');
    ui.input = root.querySelector('.cl-input');

    root.querySelector('.cl-form').addEventListener('submit', function (e) {
      e.preventDefault();
      send(ui.input.value);
    });
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onFormSubmit, true);
    root.addEventListener('input', onFormInput);
    /* Pictures arrive after the text; keep the newest message in view. */
    ui.log.addEventListener('load', function () { if (ui.stick) scrollDown(); }, true);
    ui.log.addEventListener('scroll', function () {
      ui.stick = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 80;
    });
    ui.stick = true;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui.open && !document.querySelector('.razorpay-container, #mock-razorpay')) setOpen(false);
    });

    var was = load();
    if (was && was.html) {
      ui.log.innerHTML = was.html;
      ui.chips.innerHTML = was.chips || '';
      if (was.state) Object.keys(was.state).forEach(function (k) { bot.state[k] = was.state[k]; });
      ui.log.querySelectorAll('.cl-typing').forEach(function (n) { n.remove(); });
      if (was.open && window.innerWidth > 760) setOpen(true, true);
    }
  }

  function setOpen(open, quiet) {
    ui.open = open;
    ui.panel.hidden = !open;
    ui.root.classList.toggle('is-open', open);
    ui.launch.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.documentElement.classList.toggle('chat-open', open);
    if (open) {
      if (!ui.log.children.length) answer(bot.welcome());
      setTimeout(function () { if (window.innerWidth > 760 || !quiet) ui.input.focus({ preventScroll: true }); }, 30);
      scrollDown();
    }
    if (!quiet) save();
  }

  function restart() {
    bot.reset();
    ui.log.innerHTML = '';
    ui.chips.innerHTML = '';
    answer(bot.welcome());
    ui.input.focus({ preventScroll: true });
  }

  /* -------------------------------------------------------------- drawing */

  function scrollDown() { ui.log.scrollTop = ui.log.scrollHeight; ui.stick = true; }

  function bubble(cls, html) {
    var row = document.createElement('div');
    row.className = 'cl-row ' + cls;
    row.innerHTML = html;
    ui.log.appendChild(row);
    scrollDown();
    return row;
  }

  /** A button that does one thing when tapped. */
  function actBtn(cls, label, action, said, extra) {
    return '<button type="button" class="' + cls + '" data-act-json="' + esc(JSON.stringify(action)) + '"' +
      ' data-said="' + esc(said || label) + '"' + (extra || '') + '>' + label + '</button>';
  }

  function money(p) { return esc(APP.money(p)); }

  function productCard(p) {
    var price = '<span class="cp-price">' + (p.ranged ? 'from ' : '') + money(p.paise) + '</span>';
    var action = !p.available
      ? '<span class="cp-out">Sold out</span>'
      : p.quickVariant
        ? actBtn('cp-add', 'Add to bag', { t: 'add', v: p.quickVariant, title: p.title }, 'Add ' + p.title)
        : actBtn('cp-add alt', p.sizes > 1 ? 'Choose size' : 'Choose', { t: 'pick', h: p.handle }, p.title);
    return '<div class="cprod">' +
      '<a class="shot" href="#/p/' + esc(p.handle) + '" data-chat="nav" aria-label="' + esc(p.title) + '">' +
        (p.image ? '<img src="' + esc(APP.img(p.image, 200)) + '" alt="">' : '') + '</a>' +
      '<div class="cp-body">' +
        (p.brand ? '<small>' + esc(p.brand) + '</small>' : '') +
        '<a class="cp-name" href="#/p/' + esc(p.handle) + '" data-chat="nav">' + esc(p.title) + '</a>' +
        '<div class="cp-foot">' + price + action + '</div>' +
      '</div></div>';
  }

  function linkHtml(l) {
    var internal = /^#/.test(l.href);
    return '<a class="cl-link" href="' + esc(l.href) + '"' + (internal ? ' data-chat="nav"' : ' target="_blank" rel="noopener"') + '>' + esc(l.label) + '</a>';
  }

  function detailHtml(b) {
    var f = b.product;
    return '<div class="cl-card cl-detail" data-once="detail">' +
      '<div class="cd-top">' + (f.image ? '<span class="shot"><img src="' + esc(APP.img(f.image, 200)) + '" alt=""></span>' : '') +
        '<div><small>' + esc(f.brand || '') + '</small><b>' + esc(f.title) + '</b>' +
        '<a href="#/p/' + esc(f.handle) + '" data-chat="nav">Product details</a></div></div>' +
      '<div class="cd-sizes">' + f.variants.map(function (v) {
        return v.available
          ? actBtn('cd-size', '<span>' + esc(v.title) + '</span><span class="mono">' + money(v.paise) + '</span>',
              { t: 'variant', v: v.id, q: b.qty || 1 }, (b.qty > 1 ? b.qty + ' x ' : '') + v.title)
          : '<span class="cd-size off"><span>' + esc(v.title) + '</span><span>Sold out</span></span>';
      }).join('') + '</div>' +
    '</div>';
  }

  function bagHtml(b) {
    if (b.compact) {
      return '<div class="cl-card cl-bagmini"><span>Bag: ' + b.count + (b.count === 1 ? ' item' : ' items') + '</span>' +
        '<b class="mono">' + money(b.subtotal) + '</b></div>';
    }
    return '<div class="cl-card cl-bag" data-once="bag">' + b.lines.map(function (l) {
      return '<div class="cb-line">' +
        '<span class="shot">' + (l.image ? '<img src="' + esc(APP.img(l.image, 120)) + '" alt="">' : '') + '</span>' +
        '<div class="cb-t"><span>' + esc(l.title) + '</span>' + (l.variant ? '<small>' + esc(l.variant) + '</small>' : '') +
          (l.available === false ? '<em>Sold out now</em>' : '') +
          '<div class="cb-ctrl">' +
            actBtn('cb-step', '-', { t: 'qty', line: l.lineId, q: l.qty - 1, title: l.title }, 'One less ' + l.title, ' aria-label="One less"') +
            '<span class="mono">' + l.qty + '</span>' +
            actBtn('cb-step', '+', { t: 'qty', line: l.lineId, q: l.qty + 1, title: l.title }, 'One more ' + l.title, ' aria-label="One more"') +
            actBtn('cb-rm', 'Remove', { t: 'remove', line: l.lineId, title: l.title }, 'Remove ' + l.title) +
          '</div></div>' +
        '<span class="mono">' + money(l.paise) + '</span></div>';
    }).join('') +
      '<div class="cb-sum"><span>Subtotal</span><b class="mono">' + money(b.subtotal) + '</b></div>' +
    '</div>';
  }

  function field(name, label, value, opts) {
    opts = opts || {};
    return '<label class="ca-f' + (opts.wide ? ' wide' : '') + (opts.err ? ' bad' : '') + '"><span>' + label + (opts.optional ? ' <small>optional</small>' : '') + '</span>' +
      (opts.prefix ? '<span class="pre"><b>' + opts.prefix + '</b>' : '') +
      '<input name="' + name + '" value="' + esc(value || '') + '"' + (opts.mode ? ' inputmode="' + opts.mode + '"' : '') +
        (opts.auto ? ' autocomplete="' + opts.auto + '"' : '') + (opts.max ? ' maxlength="' + opts.max + '"' : '') + (opts.type ? ' type="' + opts.type + '"' : '') + '>' +
      (opts.prefix ? '</span>' : '') +
      (opts.err ? '<em>' + esc(opts.err) + '</em>' : '') + '</label>';
  }

  function addressHtml(b) {
    var a = b.prefill || {}, e = b.errors || {};
    var states = (C.states || []).map(function (s) {
      return '<option value="' + s[0] + '"' + (a.state === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>';
    }).join('');
    return '<form class="cl-card cl-addr" data-once="address" novalidate>' +
      field('name', 'Full name', a.name, { auto: 'name', max: 80, wide: true, err: e.name }) +
      field('phone', 'Mobile', a.phone, { prefix: '+91', mode: 'numeric', auto: 'tel-national', max: 14, wide: true, err: e.phone }) +
      field('address1', 'House or flat no., building', a.address1, { auto: 'address-line1', max: 120, wide: true, err: e.address1 }) +
      field('address2', 'Street, area or locality', a.address2, { auto: 'address-line2', max: 120, wide: true, err: e.address2 }) +
      field('landmark', 'Landmark', a.landmark, { max: 80, wide: true, optional: true }) +
      field('zip', 'Pincode', a.zip, { mode: 'numeric', auto: 'postal-code', max: 6, err: e.zip }) +
      field('city', 'Town or city', a.city, { auto: 'address-level2', max: 60, err: e.city }) +
      '<label class="ca-f wide' + (e.state ? ' bad' : '') + '"><span>State</span><select name="state" autocomplete="address-level1"><option value="">Choose</option>' + states + '</select>' +
        (e.state ? '<em>' + esc(e.state) + '</em>' : '') + '</label>' +
      field('email', 'Email, for the receipt', a.email, { auto: 'email', max: 120, wide: true, optional: true, type: 'email', err: e.email }) +
      '<button class="ca-go" type="submit">Continue</button>' +
    '</form>';
  }

  function addressLine(a) {
    var st = (C.states || []).filter(function (s) { return s[0] === a.state; })[0];
    return esc(a.address1) + (a.address2 ? ', ' + esc(a.address2) : '') + (a.landmark ? ', near ' + esc(a.landmark) : '') +
      ', ' + esc(a.city) + ' ' + esc(a.zip) + (st ? ', ' + esc(st[1]) : '');
  }

  function savedAddressHtml(b) {
    var a = b.address;
    return '<div class="cl-card cl-saved" data-once="address">' +
      '<div class="cs-a"><b>' + esc(a.name) + '</b>, +91 ' + esc(a.phone) + '<br>' + addressLine(a) + '</div>' +
      '<div class="cs-b">' + actBtn('cs-yes', 'Deliver here', { t: 'useSaved' }) + actBtn('cs-no', 'Use a different address', { t: 'newAddress' }) + '</div>' +
    '</div>';
  }

  function payChoiceHtml(b) {
    var opt = function (on, label, sub, action, said) {
      return on ? actBtn('pc-opt', '<b>' + label + '</b><small>' + esc(sub) + '</small>', action, said)
        : '<span class="pc-opt off"><b>' + label + '</b><small>' + esc(sub) + '</small></span>';
    };
    return '<div class="cl-card cl-paychoice" data-once="payChoice">' +
      opt(b.online, 'Pay online', b.online ? 'UPI, cards, netbanking, wallets' : 'Not switched on yet', { t: 'payMode', p: 'online' }, 'Pay online') +
      opt(b.cod.allowed, 'Cash on delivery', b.cod.why, { t: 'payMode', p: 'cod' }, 'Cash on delivery') +
    '</div>';
  }

  function summaryHtml(b) {
    var opt = function (on, label, action, said, sub, off) {
      return off ? '<span class="co-opt off"><span>' + label + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></span>'
        : actBtn('co-opt' + (on ? ' on' : ''), '<i></i><span>' + label + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>', action, said, on ? ' aria-pressed="true"' : ' aria-pressed="false"');
    };
    var place = b.payment === 'online' ? 'Pay ' + APP.money(b.total) + ' securely' : b.payment === 'cod' ? 'Place order, pay ' + APP.money(b.total) + ' on delivery' : 'Choose how to pay';
    return '<div class="cl-card cl-sum" data-once="summary" data-ref="' + b.ref + '">' +
      '<div class="cs-h">Order summary</div>' +
      '<div class="cs-items">' + b.items.map(function (i) {
        return '<div><span>' + esc(i.title) + (i.variantTitle ? ' <small>' + esc(i.variantTitle) + '</small>' : '') + ' x' + i.qty + '</span><span class="mono">' + money(i.unitPaise * i.qty) + '</span></div>';
      }).join('') + '</div>' +
      '<div class="cs-h">Deliver to</div><div class="cs-addr"><b>' + esc(b.address.name) + '</b>, +91 ' + esc(b.address.phone) + '<br>' + addressLine(b.address) + '</div>' +
      '<div class="cs-h">Delivery</div><div class="cs-opts">' + b.rates.map(function (r) {
        return opt(r.handle === b.rate, esc(r.title) + ' <b class="mono">' + (r.paise ? money(r.paise) : 'Free') + '</b>', { t: 'rate', r: r.handle }, r.title);
      }).join('') + (b.eta ? '<p class="cs-eta">Expected ' + esc(b.eta) + '</p>' : '') + '</div>' +
      '<div class="cs-h">Payment</div><div class="cs-opts">' +
        (b.online ? opt(b.payment === 'online', 'Pay now', { t: 'pay', p: 'online' }, 'Pay online', 'UPI, cards, netbanking, wallets') : '') +
        opt(b.payment === 'cod', 'Cash on delivery', { t: 'pay', p: 'cod' }, 'Cash on delivery', b.cod.allowed ? 'Pay when it arrives' : b.cod.why, !b.cod.allowed) +
      '</div>' +
      '<div class="cs-tot">' +
        '<div><span>Subtotal</span><span class="mono">' + money(b.subtotal) + '</span></div>' +
        '<div><span>Delivery</span><span class="mono">' + (b.shipping ? money(b.shipping) : 'Free') + '</span></div>' +
        (b.tax ? '<div class="fine"><span>' + (b.taxesIncluded ? 'Includes GST' : 'GST') + '</span><span class="mono">' + money(b.tax) + '</span></div>' : '') +
        '<div class="grand"><span>Total</span><span class="mono">' + money(b.total) + '</span></div>' +
      '</div>' +
      (b.payment ? actBtn('cs-place', esc(place), { t: 'place', ref: b.ref }, b.payment === 'online' ? 'Pay ' + APP.money(b.total) : 'Place order') : '<button class="cs-place" type="button" disabled>Choose how to pay</button>') +
      '<p class="cs-fine">' + (b.online ? 'Payments by Razorpay; card and UPI details never reach us. ' : '') + 'Nothing is charged until you tap the button.</p>' +
    '</div>';
  }

  function placedHtml(b) {
    var o = b.order;
    var num = String(o.name).replace(/^#/, '');
    return '<div class="cl-card cl-placed">' +
      '<span class="pl-tick">' + TICK + '</span>' +
      '<div><small>Order placed</small><b>' + esc(o.name) + '</b>' +
        '<span>' + (o.payment === 'online' ? 'Paid ' + money(o.total) : 'Pay ' + money(o.total) + ' on delivery') + '</span>' +
        (b.eta ? '<span>Expected ' + esc(b.eta) + (b.city ? ' in ' + esc(b.city) : '') + '</span>' : '') +
        '<a href="#/track/' + esc(num) + '" data-chat="nav">Track this order</a></div>' +
    '</div>';
  }

  function blockHtml(b) {
    if (b.type === 'text') return '<div class="cl-msg">' + esc(b.text) + (b.note ? '<span class="cl-note">' + esc(b.note) + '</span>' : '') + '</div>';
    if (b.type === 'products') return '<div class="cl-cards">' + b.items.map(productCard).join('') + (b.more ? linkHtml(b.more) : '') + '</div>';
    if (b.type === 'detail') return detailHtml(b);
    if (b.type === 'bag') return bagHtml(b);
    if (b.type === 'address') return addressHtml(b);
    if (b.type === 'savedAddress') return savedAddressHtml(b);
    if (b.type === 'summary') return summaryHtml(b);
    if (b.type === 'payChoice') return payChoiceHtml(b);
    if (b.type === 'placed') return placedHtml(b);
    if (b.type === 'order') return '<div class="cl-order">' + APP.orderCardHtml(b.order, b.eta, true) + '</div>';
    if (b.type === 'links') return '<div class="cl-links">' + b.links.map(linkHtml).join('') + '</div>';
    return '';
  }

  /** Cards that a newer answer replaces stop working: an old summary can
   *  never place an order, an old size picker never adds twice. */
  function retire(kinds) {
    ui.log.querySelectorAll('[data-once]').forEach(function (n) {
      if (!kinds || kinds.indexOf(n.getAttribute('data-once')) >= 0) {
        n.classList.add('used');
        n.querySelectorAll('button, input, select').forEach(function (x) { x.disabled = true; });
      }
    });
  }

  function answer(res) {
    var kinds = (res.blocks || []).map(function (b) { return b.type === 'savedAddress' ? 'address' : b.type; });
    retire(['summary', 'address', 'detail', 'bag', 'payChoice'].filter(function (k) { return kinds.indexOf(k) >= 0; }).concat(kinds.indexOf('placed') >= 0 ? ['summary', 'address', 'bag'] : []));
    var first = null;
    (res.blocks || []).forEach(function (b) {
      var html = blockHtml(b);
      if (html) { var row = bubble('bot' + (b.type !== 'text' ? ' wide' : ''), html); if (!first) first = row; }
      if (b.type === 'order' && bot.state.order && bot.state.contact) APP.rememberOrder(bot.state.order, bot.state.contact);
    });
    ui.chips.innerHTML = (res.chips || []).map(function (c) {
      if (c.href) return '<a class="cl-chip" href="' + esc(c.href) + '" data-chat="nav">' + esc(c.label) + '</a>';
      if (c.act) return actBtn('cl-chip' + (c.primary ? ' primary' : ''), esc(c.label), c.act, c.label);
      return '<button class="cl-chip" type="button" data-say="' + esc(c.say) + '">' + esc(c.label) + '</button>';
    }).join('');
    /* A long answer (a summary, a form) opens at its start, so it is read
     * from the top; a short one simply sits at the bottom. */
    if (first && ui.log.scrollHeight - first.offsetTop > ui.log.clientHeight) {
      ui.log.scrollTop = Math.max(0, first.offsetTop - 12);
      ui.stick = false;
    } else {
      scrollDown();
    }
    save();
    var form = ui.log.querySelector('.cl-addr:not(.used) input');
    if (form && ui.open && window.innerWidth > 760 && !form.value) form.focus({ preventScroll: true });
  }

  function status(t) {
    var typing = ui.log.querySelector('.cl-typing .cl-msg');
    if (typing) typing.innerHTML = '<em>' + esc(t) + '</em>';
  }

  /** Runs a turn: shows what was said, waits for the answer, draws it. */
  function turn(said, work, waitingText) {
    if (ui.busy) return;
    ui.busy = true;
    ui.chips.innerHTML = '';
    if (said) bubble('me', '<div class="cl-msg">' + esc(said) + '</div>');
    var typing = bubble('bot cl-typing', '<div class="cl-msg">' + (waitingText ? '<em>' + esc(waitingText) + '</em>' : '<span></span><span></span><span></span>') + '</div>');
    var started = Date.now();
    work().then(function (res) {
      /* A beat of "typing" so an instant answer does not feel like a jump. */
      var wait = Math.max(0, 380 - (Date.now() - started));
      setTimeout(function () { typing.remove(); ui.busy = false; answer(res); }, wait);
    }, function () {
      typing.remove();
      ui.busy = false;
      answer({ blocks: [{ type: 'text', text: 'Something went wrong on my side. Try again, or talk to our team.' }], chips: [{ label: 'Talk to a person', say: 'Talk to a person' }] });
    });
  }

  function send(text) {
    text = String(text || '').trim();
    if (!text || ui.busy) return;
    ui.input.value = '';
    turn(text, function () { return bot.reply(text); });
  }

  function runAction(action, said, el) {
    if (ui.busy) return;
    var card = el && el.closest('[data-once]');
    if (card && card.classList.contains('used')) return;
    if (card && action.t !== 'rate' && action.t !== 'pay') { card.classList.add('used'); card.querySelectorAll('button, input, select').forEach(function (x) { x.disabled = true; }); }
    var waiting = action.t === 'place' ? 'Placing your order' : action.t === 'address' || action.t === 'useSaved' ? 'Working out delivery and total' : null;
    turn(said, function () { return bot.act(action); }, waiting);
  }

  /* --------------------------------------------------------------- events */

  function onClick(e) {
    var b = e.target.closest('[data-act-json]');
    if (b) {
      e.preventDefault();
      if (b.disabled) return;
      var action = null;
      try { action = JSON.parse(b.getAttribute('data-act-json')); } catch (x) { action = null; }
      if (action) runAction(action, b.getAttribute('data-said'), b);
      return;
    }
    var t = e.target.closest('[data-chat], [data-say]');
    if (!t) return;
    var say = t.getAttribute('data-say');
    if (say !== null) {
      e.preventDefault();
      /* A reply that needs one more detail (a pincode) is put in the box to finish. */
      if (/\s$/.test(say)) { ui.input.value = say; ui.input.focus(); return; }
      send(say);
      return;
    }
    var act = t.getAttribute('data-chat');
    if (act === 'open') { e.preventDefault(); setOpen(true); }
    else if (act === 'close') { e.preventDefault(); setOpen(false); }
    else if (act === 'restart') { e.preventDefault(); if (!ui.busy) restart(); }
    else if (act === 'nav' && window.innerWidth <= 760) { setOpen(false); }
  }

  function onFormSubmit(e) {
    var f = e.target.closest('.cl-addr');
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    if (f.classList.contains('used')) return;
    var a = {};
    ['name', 'phone', 'address1', 'address2', 'landmark', 'zip', 'city', 'state', 'email'].forEach(function (k) {
      var el = f.querySelector('[name="' + k + '"]');
      a[k] = el ? el.value.trim() : '';
    });
    runAction({ t: 'address', a: a }, 'Deliver to ' + [a.name, a.address1, a.city, a.zip].filter(Boolean).join(', '), f.querySelector('button'));
  }

  /* Pincode first: guess the state so one less box needs filling. */
  function onFormInput(e) {
    var f = e.target.closest('.cl-addr');
    if (!f) return;
    if (e.target.name === 'state') { e.target.dataset.touched = '1'; return; }
    if (e.target.name !== 'zip') return;
    var pin = e.target.value.replace(/\D/g, '');
    var st = f.querySelector('[name="state"]');
    if (pin.length === 6 && st && !st.dataset.touched) { var g = APP.stateOfPin(pin); if (g) st.value = g; }
  }

  /* Anything on the page can open the chat with data-act="chat". */
  document.addEventListener('click', function (e) {
    var open = e.target.closest('[data-act="chat"]');
    if (open) { e.preventDefault(); setOpen(true); }
  });

  build();
  window.PTChat = {
    open: function () { setOpen(true); },
    send: function (t) { setOpen(true); send(t); },
    restart: restart
  };
}());
