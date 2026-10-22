/* ============================================================================
 * Paws and Tails assistant: the chat window
 * ============================================================================
 * A small button in the corner that opens a conversation. What it says comes
 * from assets/assistant.js, which reads the live store; this file only draws
 * it: messages, product cards that go straight into the bag, the order card
 * from the track page, links and quick replies. The conversation is kept for
 * the visit, so moving between pages does not lose it.
 * ========================================================================== */
(function () {
  'use strict';

  var S = window.PTStorefront;
  var C = window.PTCatalogue;
  var A = window.PTAssist;
  var APP = window.PTApp;
  if (!S || !C || !A || !APP) return;

  var esc = APP.esc;
  var KEY = 'pt_chat';
  var bot = A.create({ S: S, C: C, collections: APP.loadCollections });
  var ui = { open: false, busy: false, log: null, input: null, chips: null };

  /* --------------------------------------------------------------- memory */

  function save() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({
        html: ui.log ? ui.log.innerHTML : '',
        chips: ui.chips ? ui.chips.innerHTML : '',
        open: ui.open,
        state: { pending: bot.state.pending, order: bot.state.order, contact: bot.state.contact, lastOrder: bot.state.lastOrder }
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
          '<div class="cl-title"><b>Paws &amp; Tails help</b><span><i class="live"></i>Answers from our store, live</span></div>' +
          '<button class="cl-x" data-chat="close" aria-label="Close chat">&times;</button>' +
        '</header>' +
        '<div class="cl-log" role="log" aria-live="polite"></div>' +
        '<div class="cl-chips"></div>' +
        '<form class="cl-form" autocomplete="off">' +
          '<input class="cl-input" type="text" maxlength="400" placeholder="Ask about an order or a product" aria-label="Your message" enterkeyhint="send">' +
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
    /* Pictures arrive after the text; keep the newest message in view. */
    ui.log.addEventListener('load', function () { if (ui.stick) scrollDown(); }, true);
    ui.log.addEventListener('scroll', function () {
      ui.stick = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 80;
    });
    ui.stick = true;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ui.open) setOpen(false); });

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

  function productCard(p) {
    var price = '<span class="cp-price">' + (p.ranged ? 'from ' : '') + esc(APP.money(p.paise)) + '</span>';
    var action = !p.available
      ? '<span class="cp-out">Sold out</span>'
      : p.quickVariant
        ? '<button class="cp-add" data-quick="' + esc(p.quickVariant) + '" data-title="' + esc(p.title) + '">Add to bag</button>'
        : '<a class="cp-add alt" href="#/p/' + esc(p.handle) + '" data-chat="nav">' + (p.sizes > 1 ? 'Choose size' : 'View') + '</a>';
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

  function blockHtml(b) {
    if (b.type === 'text') {
      return '<div class="cl-msg">' + esc(b.text) + (b.note ? '<span class="cl-note">' + esc(b.note) + '</span>' : '') + '</div>';
    }
    if (b.type === 'products') {
      return '<div class="cl-cards">' + b.items.map(productCard).join('') +
        (b.more ? linkHtml(b.more) : '') + '</div>';
    }
    if (b.type === 'order') return '<div class="cl-order">' + APP.orderCardHtml(b.order, b.eta, true) + '</div>';
    if (b.type === 'links') return '<div class="cl-links">' + b.links.map(linkHtml).join('') + '</div>';
    return '';
  }

  function answer(res) {
    (res.blocks || []).forEach(function (b) {
      var html = blockHtml(b);
      if (html) bubble('bot', html);
      if (b.type === 'order' && bot.state.order && bot.state.contact) APP.rememberOrder(bot.state.order, bot.state.contact);
    });
    ui.chips.innerHTML = (res.chips || []).map(function (c, i) {
      return c.href
        ? '<a class="cl-chip" href="' + esc(c.href) + '" data-chat="nav">' + esc(c.label) + '</a>'
        : '<button class="cl-chip" type="button" data-say="' + esc(c.say) + '">' + esc(c.label) + '</button>';
    }).join('');
    scrollDown();
    save();
  }

  function send(text) {
    text = String(text || '').trim();
    if (!text || ui.busy) return;
    ui.input.value = '';
    ui.chips.innerHTML = '';
    bubble('me', '<div class="cl-msg">' + esc(text) + '</div>');
    ui.busy = true;
    var typing = bubble('bot cl-typing', '<div class="cl-msg"><span></span><span></span><span></span></div>');
    var started = Date.now();
    bot.reply(text).then(function (res) {
      /* A beat of "typing" so an instant answer does not feel like a jump. */
      var wait = Math.max(0, 420 - (Date.now() - started));
      setTimeout(function () {
        typing.remove();
        ui.busy = false;
        answer(res);
      }, wait);
    }).catch(function () {
      typing.remove();
      ui.busy = false;
      answer({ blocks: [{ type: 'text', text: 'Something went wrong on my side. Try again, or talk to our team.' }], chips: [{ label: 'Talk to a person', say: 'Talk to a person' }] });
    });
  }

  function onClick(e) {
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
    else if (act === 'nav' && window.innerWidth <= 760) { setOpen(false); }
  }

  /* Anything on the page can open the chat with data-act="chat". */
  document.addEventListener('click', function (e) {
    var open = e.target.closest('[data-act="chat"]');
    if (open) { e.preventDefault(); setOpen(true); }
  });

  build();
  window.PTChat = { open: function () { setOpen(true); }, send: function (t) { setOpen(true); send(t); } };
}());
