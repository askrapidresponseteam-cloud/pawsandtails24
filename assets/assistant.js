/* ============================================================================
 * Paws and Tails assistant: the conversation
 * ============================================================================
 * No language model. Every answer is built from the store itself: products,
 * prices and stock from the live catalogue, delivery times and charges from
 * the store's own shipping page, returns from its returns page, orders from
 * the order lookup, and new orders through the same checkout as the site.
 * Reading what was typed is assets/nlu.js; this file decides what to do.
 *
 * It can:
 *   - recommend ("best deworming under 500") and answer product questions
 *     ("what sizes does Acana puppy come in")
 *   - take an order end to end: find the product, ask the size if needed,
 *     add to the bag, change or remove items, take the address (or use the
 *     saved one), show delivery options, total and payment, and place the
 *     order only when the shopper confirms that exact total; online payment
 *     opens Razorpay on the page, or cash on delivery
 *   - order the same again from a past order
 *   - track an order, give delivery dates by pincode, answer shipping,
 *     payment and returns questions from the store's own pages
 *   - hand over to a person on WhatsApp with the conversation filled in
 *
 * Also used by the track and checkout pages for expected dates, so all agree.
 * Loadable in a browser (window.PTAssist) and in node, where the tests drive
 * it against the mock store.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./nlu.js'));
  else root.PTAssist = factory(root.PTNlu);
}(typeof self !== 'undefined' ? self : this, function (N) {
  'use strict';

  var DASHES = '\\-\u2010\u2011\u2012\u2013\u2014';
  var RUPEE = '\u20b9';
  var DAY = 24 * 60 * 60 * 1000;

  /* ================================================================== TEXT */

  function lower(s) { return String(s || '').toLowerCase(); }

  /** Words of a message, lower case, rupee signs and commas in numbers kept
   *  readable for the price rules. */
  function words(s) {
    return lower(s).replace(new RegExp('[' + DASHES + ']', 'g'), ' ')
      .replace(/[^a-z0-9@.#\u20b9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  }

  function stem(w) {
    w = lower(w);
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }

  function sentences(text) {
    /* Split after . ! ? without lookbehind, which older Safari cannot read.
     * A full stop inside a number ("Rs 4.50") or after "Rs" does not end one. */
    var out = [];
    String(text || '').split(/\n+/).forEach(function (line) {
      var buf = '';
      var parts = line.split(/([.!?])(\s+)/);
      for (var i = 0; i < parts.length; i += 3) {
        buf += parts[i] + (parts[i + 1] || '');
        if (parts[i + 1] && !/\b(rs|no|approx|e\.g|i\.e)$/i.test(parts[i])) { out.push(buf.trim()); buf = ''; }
        else if (parts[i + 1]) buf += parts[i + 2] || ' ';
      }
      if (buf.trim()) out.push(buf.trim());
    });
    return out.filter(function (s) { return s.length > 3; });
  }

  /** The sentences of a policy that best answer a question, by how many of
   *  the given words they contain. */
  function pickSentences(text, keys, max) {
    var scored = sentences(text).map(function (s, i) {
      var l = lower(s);
      var score = keys.reduce(function (n, k) { return n + (l.indexOf(k) >= 0 ? 1 : 0); }, 0);
      return { s: s, i: i, score: score };
    }).filter(function (x) { return x.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    return scored.slice(0, max || 2).sort(function (a, b) { return a.i - b.i; }).map(function (x) { return x.s; });
  }

  /* ============================================================= DELIVERY */

  var METRO_PINS = {
    '110': 'Delhi', '400': 'Mumbai', '700': 'Kolkata', '600': 'Chennai', '560': 'Bengaluru',
    '500': 'Hyderabad', '411': 'Pune', '380': 'Ahmedabad', '201': 'Noida', '122': 'Gurugram'
  };

  function regionOfPin(pin) {
    if (!pin) return null;
    var city = METRO_PINS[String(pin).slice(0, 3)];
    return city ? { metro: true, city: city } : { metro: false, city: null };
  }

  /** Delivery terms read from the shipping page:
   *  { dispatch: {min,max,business} | null, ranges: [{min,max,business,label}] }.
   *  Ranges are labelled "metro" or "rest" when the page says which places
   *  they apply to. */
  function parseDelivery(text) {
    var out = { dispatch: null, ranges: [] };
    var t = String(text || '');
    var RANGE = new RegExp('(?:(\\d{1,2})\\s*(?:[' + DASHES + ']|to)\\s*)?(\\d{1,3})\\s*(working|business|calendar)?\\s*(days?|hours?|hrs?)', 'gi');
    sentences(t).forEach(function (s) {
      var l = lower(s);
      var isDispatchSentence = /dispatch|processed|process|packed|ships? within|shipped within|ship out|handed over/.test(l);
      var isDeliverySentence = /deliver|reach|arriv|transit|takes|receive/.test(l);
      var found = [];
      var m;
      RANGE.lastIndex = 0;
      while ((m = RANGE.exec(s))) {
        var unitHours = /^h/i.test(m[4]);
        var b = Number(m[2]);
        var a = m[1] ? Number(m[1]) : b;
        if (unitHours) { a = Math.max(1, Math.ceil(a / 24)); b = Math.max(1, Math.ceil(b / 24)); }
        if (!b || b > 60) continue;
        /* "returned within 7 days", "refund in 5-7 days" are not delivery. */
        var before = l.slice(Math.max(0, m.index - 50), m.index);
        if (/return|refund|exchange|replace/.test(before)) continue;
        var upTo = !m[1] && /(within|up ?to|max(imum)?|no more than|at most)\s*$/.test(l.slice(Math.max(0, m.index - 14), m.index));
        found.push({ upTo: upTo, min: Math.min(a, b), max: Math.max(a, b), business: !!m[3] && !/calendar/i.test(m[3]) || /working|business/.test(l) && !/calendar/.test(l), at: m.index, end: m.index + m[0].length });
      }
      found.forEach(function (r, i) {
        var near = l.slice(Math.max(0, r.at - 50), r.at);
        var after = l.slice(r.end, i + 1 < found.length ? found[i + 1].at : l.length);
        var dispatchy = /dispatch|process|packed|ship(ped|s)? (out )?within|handed over/.test(near) ||
          (isDispatchSentence && !isDeliverySentence);
        var item = { min: r.min, max: r.max, business: r.business };
        if (r.upTo) item.upTo = true;
        if (dispatchy && !/deliver|reach|arriv|transit/.test(near)) {
          if (!out.dispatch) out.dispatch = item;
          return;
        }
        if (!isDeliverySentence && !/deliver|reach|arriv|transit/.test(near + after)) return;
        /* "3-5 days to metro cities and 5-8 days to the rest of India": the
         * words after a range say where it applies; the words before only
         * count when nothing follows. */
        var METRO = /metro|major cit|tier ?1|same city|local|within (the )?city/;
        var REST = /rest of|elsewhere|other (cities|places|areas|locations)|remote|north ?east|tier ?[23]|outside/;
        if (METRO.test(after)) item.label = 'metro';
        else if (REST.test(after)) item.label = 'rest';
        else if (REST.test(near)) item.label = 'rest';
        else if (METRO.test(near)) item.label = 'metro';
        out.ranges.push(item);
      });
    });
    return out;
  }

  /** Adds days to a date. Working days skip Sundays, when couriers here do
   *  not deliver. */
  function addDays(date, n, working) {
    var d = new Date(date.getTime());
    var left = n;
    while (left > 0) {
      d = new Date(d.getTime() + DAY);
      if (working && d.getDay() === 0) continue;
      left--;
    }
    return d;
  }

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(d) { return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function fmtRange(a, b) {
    if (!a) return '';
    if (!b || a.toDateString() === b.toDateString()) return fmtDay(a);
    return fmtDay(a) + ' and ' + fmtDay(b);
  }

  /** Expected arrival { from, to, basis, region } counted from `start`.
   *  terms: parseDelivery() of the shipping page; fallback: [min,max] days
   *  used only when the page gives no delivery time. `shipped` leaves out the
   *  dispatch time. */
  function estimate(terms, opts) {
    opts = opts || {};
    var start = opts.start ? new Date(opts.start) : new Date();
    var region = opts.region || null;
    var ranges = (terms && terms.ranges) || [];
    var basis = 'policy';
    var range = null;
    if (ranges.length) {
      var labelled = region ? ranges.filter(function (r) { return r.label === (region.metro ? 'metro' : 'rest'); }) : [];
      if (labelled.length) range = labelled[0];
      else if (ranges.length === 1 || !region) {
        range = {
          min: Math.min.apply(null, ranges.map(function (r) { return r.min; })),
          max: Math.max.apply(null, ranges.map(function (r) { return r.max; })),
          business: ranges.some(function (r) { return r.business; }),
          upTo: ranges.every(function (r) { return r.upTo; })
        };
      } else {
        range = ranges.filter(function (r) { return !r.label; })[0] || ranges[ranges.length - 1];
      }
    } else {
      var fb = opts.fallback || [3, 7];
      range = { min: fb[0], max: fb[1], business: true };
      basis = 'usual';
    }
    var lo = range.min, hi = range.max;
    if (!opts.shipped && terms && terms.dispatch && ranges.length) {
      lo += terms.dispatch.min;
      hi += terms.dispatch.max;
    }
    return {
      from: addDays(start, lo, range.business),
      to: addDays(start, hi, range.business),
      basis: basis,
      region: region,
      days: [lo, hi],
      working: !!range.business,
      upTo: !!range.upTo
    };
  }

  /** "by Thu 30 Oct" or "between Tue 27 Oct and Fri 30 Oct". */
  function fmtEta(eta) {
    if (!eta || !eta.to) return '';
    if (eta.upTo || !eta.from || eta.from.toDateString() === eta.to.toDateString()) return 'by ' + fmtDay(eta.to);
    return 'between ' + fmtRange(eta.from, eta.to);
  }

  /** When an order should arrive, from what the order itself says first and
   *  the shipping page second. */
  function orderEta(order, terms, fallback) {
    if (!order) return null;
    if (order.stage === 'cancelled') return null;
    var ships = order.shipments || [];
    if (order.stage === 'delivered') {
      var when = ships.map(function (s) { return s.deliveredAt; }).filter(Boolean).sort().pop();
      return when ? { delivered: new Date(when), basis: 'courier' } : null;
    }
    var courierDates = ships.map(function (s) { return s.estimatedAt; }).filter(Boolean).sort();
    if (courierDates.length) {
      var d = new Date(courierDates[courierDates.length - 1]);
      return { from: d, to: d, basis: 'courier' };
    }
    var region = regionOfPin(order.zip);
    var shippedAt = ships.map(function (s) { return s.shippedAt; }).filter(Boolean).sort()[0];
    if (shippedAt) return estimate(terms, { start: shippedAt, shipped: true, region: region, fallback: fallback });
    return estimate(terms, { start: order.placedAt || Date.now(), region: region, fallback: fallback });
  }

  /* ============================================================ THE ENGINE */

  var STATES_KEYS = null;

  /**
   * create(deps)
   *   S            the storefront client (assets/storefront.js)
   *   C            store facts (assets/catalogue.js)
   *   collections  () => Promise of the live collection list
   *   now          () => Date, for tests
   *   shop         what only the page can do:
   *                  place(params, hooks) -> Promise of the order result
   *                    (pays with Razorpay's popup, or cash on delivery)
   *                  savedAddress() / keepAddress(a)   the address on this device
   *                  setCart(cart)                     tell the page the bag changed
   *                  stateOfPin(pin)                   a first guess at the state
   * Returns { reply(text), act(action), welcome(), state, reset() }.
   * Every answer is { blocks: [...], chips: [...] }.
   */
  function create(deps) {
    var S = deps.S;
    var C = deps.C || {};
    var shop = deps.shop || {};
    var now = deps.now || function () { return new Date(); };
    var getCols = deps.collections || function () { return S.collections(); };
    var fallbackDays = (C.delivery && C.delivery.fallbackDays) || [3, 7];
    var vocab = N.baseVocabulary(C.brands || []);
    var state = fresh();
    var policyCache = null;

    function fresh() {
      return {
        pending: null,          /* what the last answer is waiting for */
        order: null, contact: null, lastOrder: null, after: null,
        shown: [],              /* products last shown, for "the second one" */
        focus: null,            /* the product whose size is being chosen */
        want: null,             /* { qty, size } carried into the choice */
        lastLine: null,         /* the variant last added, for "make it 3" */
        bagCount: 0,
        bagText: '',
        co: null,               /* checkout: { address, quote, rate, payment, ref } */
        ref: 0,
        history: []
      };
    }

    function policies() {
      if (!policyCache) {
        policyCache = S.policies({ shippingPath: C.policies && C.policies.shipping, refundPath: C.policies && C.policies.refund })
          .catch(function () { return { shipping: { text: '', url: '#/policy/shipping' }, refund: { text: '', url: '#/policy/returns' } }; });
      }
      return policyCache;
    }
    function terms() {
      return policies().then(function (p) { return parseDelivery(p.shipping.text); });
    }

    function text(t, note) { var b = { type: 'text', text: t }; if (note) b.note = note; return b; }
    function money(p) { return S.money(p); }
    function answer(blocks, chipList) { return { blocks: blocks, chips: chipList || [] }; }
    function done(blocks, chipList) { return Promise.resolve(answer(blocks, chipList)); }

    var CHIPS = {
      shop: { label: 'Order something', say: 'I want to order something' },
      track: { label: 'Track my order', say: 'Track my order' },
      when: { label: 'When will it arrive?', say: 'When will my order arrive if I order today?' },
      deworm: { label: 'Best deworming under ' + RUPEE + '500', say: 'Best deworming under 500' },
      person: { label: 'Talk to a person', say: 'Talk to a person' },
      returns: { label: 'Returns', say: 'What is the return policy?' },
      fee: { label: 'Shipping charges', say: 'What are the shipping charges?' },
      checkout: { label: 'Checkout', act: { t: 'checkout' } },
      bag: { label: 'View bag', act: { t: 'bag' } }
    };
    function chips() {
      return Array.prototype.slice.call(arguments).map(function (k) { return typeof k === 'string' ? CHIPS[k] : k; }).filter(Boolean);
    }

    function welcome() {
      return answer([text('Hi! I can find the right product, place your order right here, track a parcel, or tell you when it will arrive.')],
        chips('shop', 'track', 'deworm', 'person'));
    }

    /* --------------------------------------------------------------- bag */

    function remember(cart) {
      state.bagCount = cart ? cart.count : 0;
      state.bagText = cart && cart.lines.length ? cart.lines.map(function (l) {
        return '- ' + l.title + (l.variantTitle ? ' (' + l.variantTitle + ')' : '') + ' x' + l.qty;
      }).join('\n') : '';
      if (shop.setCart) shop.setCart(cart);
      return cart;
    }

    function loadBag() {
      if (!S.cartId()) { remember(null); return Promise.resolve(null); }
      return S.cartGet({ quiet: true }).then(remember);
    }

    function bagBlock(cart, compact) {
      return {
        type: 'bag', compact: !!compact, count: cart.count, subtotal: cart.subtotalPaise,
        lines: cart.lines.map(function (l) {
          return { lineId: l.lineId, variantId: l.variantId, title: l.title, variant: l.variantTitle, qty: l.qty, paise: l.linePaise !== null ? l.linePaise : l.paise * l.qty, image: l.image, handle: l.handle, available: l.available };
        })
      };
    }

    function itemWord(n) { return n + (n === 1 ? ' item' : ' items'); }

    /* ---------------------------------------------------------- contact */

    function whatsapp(textBody) {
      var s = C.support || {};
      return 'https://wa.me/' + s.whatsapp + (textBody ? '?text=' + encodeURIComponent(textBody) : '');
    }

    /** What a person picking this up needs: the order, the bag, the last
     *  few things asked. Goes into the WhatsApp message. */
    function handoffText(lead) {
      var parts = [lead || 'Hi Paws and Tails, I need some help.'];
      if (state.order) parts.push('Order: #' + String(state.order).replace(/^#/, ''));
      if (state.bagText) parts.push('In my bag:\n' + state.bagText);
      var asked = state.history.slice(-3);
      if (asked.length) parts.push('I asked: ' + asked.map(function (h) { return '"' + h + '"'; }).join(', '));
      return parts.join('\n');
    }

    function contactBlocks(lead, waText) {
      var s = C.support || {};
      var links = [];
      if (s.whatsapp) links.push({ label: 'WhatsApp us', href: whatsapp(waText || handoffText()) });
      if (s.phone) links.push({ label: 'Call ' + (s.phoneLabel || s.phone), href: 'tel:' + s.phone });
      if (s.email) links.push({ label: 'Email ' + s.email, href: 'mailto:' + s.email });
      var out = [];
      if (lead) out.push(text(lead));
      out.push({ type: 'links', links: links });
      return out;
    }

    /* ------------------------------------------------------------ orders */

    function orderSummary(o, eta) {
      var name = o.name || 'Your order';
      var ship = (o.shipments || [])[0] || {};
      var via = ship.courier ? ' with ' + ship.courier : '';
      if (o.stage === 'cancelled') return name + ' was cancelled. If you were charged, the refund goes back to how you paid.';
      if (o.stage === 'delivered') return name + ' was delivered' + (eta && eta.delivered ? ' on ' + fmtDay(eta.delivered) : '') + '.';
      if (o.stage === 'issue' || o.stage === 'attempted') {
        return name + ': the courier reports ' + (o.stage === 'attempted' ? 'a delivery attempt was missed' : 'a problem delivering it') +
          '. Use the tracking link to rebook, or talk to us and we will sort it out.';
      }
      var when = '';
      if (eta && eta.basis === 'courier') when = ' The courier expects to deliver it on ' + fmtDay(eta.from) + '.';
      else if (eta) when = ' It should reach you ' + fmtEta(eta) + '.';
      if (o.stage === 'out_for_delivery') return name + ' is out for delivery' + via + ' today.';
      if (o.stage === 'shipped') return name + ' is on its way' + via + '.' + when;
      if (o.stage === 'packed') return name + ' is being packed.' + when;
      return name + ' is confirmed and will be dispatched soon.' + when;
    }

    function lookupOrder() {
      var order = state.order, contact = state.contact;
      return Promise.all([S.orderLookup(order, contact), terms()]).then(function (r) {
        var res = r[0], t = r[1];
        state.pending = null;
        if (res.configured === false) {
          return answer([text('Order tracking here is still being connected to our store. Our team can check your order straight away.')]
            .concat(contactBlocks('', handoffText('Hi Paws and Tails, can you tell me where my order is?'))), chips('when'));
        }
        if (!res.found) {
          var tried = order;
          state.contact = null;
          state.pending = state.after === 'reorder' ? 'reorderContact' : 'contact';
          return answer([text('I could not find order #' + String(tried).replace(/^#/, '') + ' with that phone number or email. Both have to be the ones on the order. Try the other one, or check the number in your confirmation email.')],
            [{ label: 'Use a different order number', say: 'Track a different order' }, CHIPS.person]);
        }
        var o = res.order;
        state.lastOrder = o;
        if (state.after === 'reorder') { state.after = null; return reorderFrom(o); }
        var eta = orderEta(o, t, fallbackDays);
        var note = eta && eta.basis === 'usual' ? 'Estimated from our usual delivery times.' :
          eta && eta.basis === 'policy' ? 'Estimated from our shipping page' + (eta.region && eta.region.metro ? ' for ' + eta.region.city : '') + '.' : null;
        var next = o.stage === 'delivered' || o.stage === 'cancelled'
          ? [{ label: 'Order the same again', act: { t: 'reorder' } }, CHIPS.returns, CHIPS.person]
          : [{ label: 'Open the track page', href: '#/track/' + encodeURIComponent(o.name.replace(/^#/, '')) }, CHIPS.person];
        return answer([{ type: 'order', order: o, eta: eta }, text(orderSummary(o, eta), note)], next);
      }).catch(function (e) {
        state.pending = null;
        return answer([text((e && e.message) || 'I could not reach the order desk just now. Try again in a moment.')], chips('track', 'person'));
      });
    }

    function track(e, raw) {
      if (/different order|another order|other order/i.test(raw)) { state.order = null; state.contact = null; }
      if (e.orderNo) { if (e.orderNo !== state.order) state.contact = e.contact || null; state.order = e.orderNo; }
      if (e.contact) state.contact = e.contact;
      if (state.pending !== 'reorderContact') state.after = null;
      if (!state.order) {
        state.pending = 'order';
        return done([text('Sure. What is your order number? It is in your order confirmation email, like #1042.')]);
      }
      if (!state.contact) {
        state.pending = state.after === 'reorder' ? 'reorderContact' : 'contact';
        return done([text('Thanks. And the phone number or email used for order #' + String(state.order).replace(/^#/, '') + '?')]);
      }
      return lookupOrder();
    }

    /* ---------------------------------------------------------- delivery */

    function span(r) {
      var n = r.min === r.max ? (r.upTo ? 'up to ' : '') + r.max : r.min + ' to ' + r.max;
      return n + (r.business ? ' working' : '') + (r.max === 1 ? ' day' : ' days');
    }

    function delivery(e, raw) {
      var pin = e.pin;
      if (state.lastOrder && /\b(my|the|this|that) (order|parcel|package)\b|\bit\b/i.test(raw) && !pin) {
        return terms().then(function (t) {
          var o = state.lastOrder;
          return answer([text(orderSummary(o, orderEta(o, t, fallbackDays)))], chips('person'));
        });
      }
      if (/\b(my|the) (order|parcel|package)\b/i.test(raw) && !pin && !/if i order|order (it )?today|ordered today|order now/i.test(raw)) {
        return track(e, raw);
      }
      return terms().then(function (t) {
        var region = regionOfPin(pin);
        var eta = estimate(t, { start: now(), region: region, fallback: fallbackDays });
        var place = pin ? (region && region.metro ? region.city + ' (' + pin + ')' : pin) : 'you';
        var lead = 'Ordered today, it should reach ' + place + ' ' + fmtEta(eta) + '.';
        var detail = [];
        if (t.dispatch) detail.push('We dispatch within ' + span(t.dispatch) + '.');
        if (t.ranges.length > 1 && !pin) {
          detail.push(t.ranges.map(function (r) {
            return (r.label === 'metro' ? 'Metro cities: ' : r.label === 'rest' ? 'Rest of India: ' : '') + span(r) + ' on the way';
          }).join('. ') + '.');
        }
        var note = eta.basis === 'usual'
          ? 'That is our usual time; checkout shows the delivery options for your address.'
          : 'From our shipping page' + (pin ? '' : '; add your pincode for a closer date') + '.';
        return answer([text(lead + (detail.length ? ' ' + detail.join(' ') : ''), note)],
          pin ? chips('fee', 'shop') : [{ label: 'Delivery to my pincode', say: 'Delivery time to pincode ' }, CHIPS.fee, CHIPS.shop]);
      });
    }

    /* ------------------------------------------------- policy questions */

    function fromPolicy(which, keys, fallbackText, chipKeys) {
      return policies().then(function (p) {
        var src = p[which] || { text: '', url: '' };
        var picked = pickSentences(src.text, keys, 2);
        var blocks = [text(picked.length ? picked.join(' ') : fallbackText)];
        if (src.url) blocks.push({ type: 'links', links: [{ label: which === 'refund' ? 'Full returns policy' : 'Full shipping policy', href: src.url }] });
        return answer(blocks, chips.apply(null, chipKeys));
      });
    }

    /* ------------------------------------------------- finding products */

    function scoreCollection(col, topic, pet) {
      var hay = lower(col.title + ' ' + col.handle);
      var s = 0;
      if (topic && topic.match.some(function (m) { return hay.indexOf(m) >= 0; })) s += 4;
      if (pet) {
        var mine = N.PETS[pet.pet].some(function (w) { return hay.indexOf(w) >= 0; });
        var other = Object.keys(N.PETS).some(function (k) {
          return k !== pet.pet && N.PETS[k].some(function (w) { return new RegExp('(^|[^a-z])' + w).test(hay); });
        });
        if (mine) s += 2;
        if (pet.young && N.YOUNG.some(function (w) { return hay.indexOf(w) >= 0; })) s += 2;
        if (!pet.young && N.YOUNG.some(function (w) { return hay.indexOf(w) >= 0; })) s -= 1;
        if (other && !mine) s -= 3;
      }
      if (/^all /.test(lower(col.title))) s += 0.5;
      return s;
    }

    function pickCollection(cols, topic, pet) {
      if (!topic) return null;
      var best = null, bestScore = 3.5;
      (cols || []).forEach(function (c) {
        var s = scoreCollection(c, topic, pet);
        if (s > bestScore) { best = c; bestScore = s; }
      });
      return best;
    }

    function within(p, price) {
      if (p.paise === null || p.paise === undefined) return false;
      if (price.max !== undefined && p.paise > price.max) return false;
      if (price.min !== undefined && p.paise < price.min) return false;
      return true;
    }

    /** Up to four pages of a source, stopping once enough fit. */
    function gather(fetchPage, keep, enough) {
      var got = [], seen = [];
      function step(after, n) {
        return fetchPage(after).then(function (page) {
          page.products.forEach(function (p) { seen.push(p); if (keep(p)) got.push(p); });
          if (got.length >= enough || !page.hasMore || !page.cursor || n >= 3) return { kept: got, seen: seen };
          return step(page.cursor, n + 1);
        });
      }
      return step(null, 0);
    }

    function brandOnly(e) {
      if (!e.brand) return false;
      var rest = N.tokens(e.terms).filter(function (w) { return lower(e.brand).replace(/[^a-z0-9]+/g, ' ').split(' ').indexOf(w) < 0; });
      return !rest.length;
    }

    /** Products for what was asked: { picks, seen, what, more, ranked, col, search }. */
    function find(e, enough) {
      return getCols().then(function (cols) {
        var col = e.brand ? null : pickCollection(cols, e.topic, e.pet);
        var sort = e.cheap ? 'priceLow' : 'featured';
        var source, what, more, ranked, search = false;
        if (col) {
          source = function (after) { return S.collectionPage(col.handle, { sort: sort, after: after }); };
          what = col.title;
          more = { label: 'See all of ' + col.title, href: '#/c/' + encodeURIComponent(col.handle) };
          ranked = e.cheap ? 'cheap' : 'best';
        } else if (brandOnly(e) && !e.topic) {
          source = function (after) { return S.brandPage(e.brand, { sort: sort, after: after }); };
          what = e.brand;
          more = { label: 'See all ' + e.brand, href: '#/brand/' + encodeURIComponent(e.brand) };
          ranked = e.cheap ? 'cheap' : 'best';
        } else {
          var q = e.terms || (e.topic ? e.topic.label : '') || (e.pet ? e.pet.pet : '');
          if (!q) return null;
          source = function (after) { return S.searchAll(q, { after: after, sort: sort }); };
          what = '"' + q + '"';
          more = { label: 'See all results', href: '#/search/' + encodeURIComponent(q) };
          ranked = e.cheap ? 'cheap' : 'match';
          search = q;
        }
        var keep = function (p) {
          if (!p.available || !within(p, e.price)) return false;
          if (e.brand && search && p.brand && lower(p.brand) !== lower(e.brand)) return false;
          if (e.pet && !col) {
            var t = lower(p.title + ' ' + p.type);
            var other = Object.keys(N.PETS).some(function (k) { return k !== e.pet.pet && N.PETS[k].some(function (w) { return t.indexOf(w) >= 0; }); });
            if (other && !N.PETS[e.pet.pet].some(function (w) { return t.indexOf(w) >= 0; })) return false;
          }
          return true;
        };
        return gather(source, keep, enough || 3).then(function (r) {
          var picks = r.kept.slice();
          if (search) {
            /* Closest titles first; the store's order breaks ties. */
            picks = picks.map(function (p, i) { return { p: p, s: N.titleScore(search, p.title) + sizeBonus(p, e.size), i: i }; })
              .sort(function (a, b) { return b.s - a.s || a.i - b.i; })
              .map(function (x) { x.p._score = x.s; return x.p; });
          }
          if (e.cheap) picks.sort(function (a, b) { return a.paise - b.paise; });
          return { picks: picks, seen: r.seen, what: what, more: more, ranked: ranked, col: col, search: search };
        });
      });
    }

    function sizeBonus(p, size) {
      if (!size) return 0;
      return N.sizesIn(p.title).some(function (s) { return N.sameSize(s, size); }) ? 0.25 : 0;
    }

    function priceWords(price) {
      return price.max !== undefined && price.min !== undefined ? ' between ' + money(price.min) + ' and ' + money(price.max)
        : price.max !== undefined ? ' under ' + money(price.max) : price.min !== undefined ? ' above ' + money(price.min) : '';
    }

    function noneFound(r, e) {
      var pw = priceWords(e.price);
      var inStock = r.seen.filter(function (p) { return p.available && p.paise !== null; }).sort(function (a, b) { return a.paise - b.paise; });
      if (!r.seen.length) {
        return answer([text('I could not find ' + r.what + ' in the store. Try another word or a brand name, or our team can check for you.')],
          [CHIPS.deworm, { label: 'Browse everything', href: '#/all' }, CHIPS.person]);
      }
      if (pw && inStock.length) {
        state.shown = inStock.slice(0, 1);
        return answer([text('Nothing in ' + r.what + ' is' + pw + ' right now. The lowest price there is ' + money(inStock[0].paise) + ':'),
          { type: 'products', items: state.shown, more: r.more }], chips('person'));
      }
      return answer([text('Everything in ' + r.what + ' that fits is sold out at the moment.'),
        { type: 'products', items: r.seen.slice(0, 2), more: r.more }], chips('person'));
    }

    /** Browsing and recommendations: the best few, ready to add. */
    function products(e, raw) {
      return find(e, 3).then(function (r) {
        if (!r) {
          return answer([text('Tell me what you are looking for, and your budget if you have one. For example "Acana puppy 2kg", "cat food under 800" or "tick spray for my dog".')],
            chips('deworm', 'track', 'person'));
        }
        if (!r.picks.length) return noneFound(r, e);
        /* A question about one product ("sizes of Acana puppy") gets that
         * product's sizes, prices and stock. */
        if (r.search && N.RX.info.test(N.normalise(raw)) && r.picks[0]._score >= 1 && (!r.picks[1] || r.picks[1]._score < r.picks[0]._score)) {
          return pick(r.picks[0].handle, { qty: e.qty, size: e.size }, true);
        }
        var picks = r.picks.slice(0, 3);
        state.shown = picks;
        state.pending = 'pickProduct';
        var care = e.topic && e.topic.care ? 'Check the dose for your pet\'s weight on the pack or with your vet.' : null;
        var pw = priceWords(e.price);
        var lead = r.ranked === 'best' ? 'Our best-selling ' + (r.col ? lower(r.col.title) : r.what) + ' picks' + pw + ':'
          : r.ranked === 'cheap' ? 'The lowest priced ' + (r.col ? lower(r.col.title) : r.what) + pw + ':'
          : 'Here is what I found for ' + r.what + pw + ':';
        var note = r.ranked === 'best' ? 'Ranked by what sells most in our store, in stock now.' : null;
        if (care) note = note ? note + ' ' + care : care;
        return answer([text(lead, note), { type: 'products', items: picks, more: r.more }],
          e.cheap ? chips('checkout', 'when') : [
            { label: 'Something cheaper', say: (e.topic ? e.topic.label : (e.brand || e.terms || 'products')) + (e.pet ? ' for ' + e.pet.pet : '') + ' cheapest' },
            { label: 'Add the first one', say: 'Add the first one' }, CHIPS.when]);
      }).catch(storeDown);
    }

    function storeDown() {
      return answer([text('I could not reach the store just now. Try again in a moment.')], chips('person'));
    }

    /* ----------------------------------------------- ordering in the chat */

    /** "Order Acana", "buy 2 bags of acana puppy 2kg", "add the second one". */
    function buy(e, raw) {
      var want = { qty: e.qty, size: e.size, cheap: e.cheap };
      if (e.which !== null && state.shown.length && !e.terms) return pickShown(e.which, want);
      if (e.which === 'it' && state.focus && !e.terms) return pick(state.focus.handle, want);
      if (!e.terms && !e.topic && !e.brand) {
        if (state.bagCount) return checkout();
        state.pending = null;
        return done([text('Happy to. What would you like to order? Tell me the product, brand or what it is for, like "Acana puppy 2kg" or "deworming for my dog".')],
          chips('deworm', 'bag'));
      }
      return find(e, 4).then(function (r) {
        if (!r) return answer([text('What would you like to order?')], chips('deworm'));
        if (!r.picks.length) return noneFound(r, e);
        var top = r.picks[0];
        var clear = r.picks.length === 1 ||
          (r.search && top._score >= 1 && (!r.picks[1] || r.picks[1]._score < top._score));
        if (clear) return pick(top.handle, want);
        state.shown = r.picks.slice(0, 4);
        state.want = want;
        state.pending = 'pickProduct';
        var label = e.brand && r.ranked !== 'match' ? e.brand : r.what;
        return answer([text('Which ' + label + ' would you like? Here are ' + (r.ranked === 'best' ? 'our best sellers' : r.ranked === 'cheap' ? 'the lowest priced' : 'the closest matches') + ':'),
          { type: 'products', items: state.shown, more: r.more, pick: true }],
          [{ label: 'The first one', say: 'The first one' }, { label: 'The cheapest', say: 'The cheapest one' }]);
      }).catch(storeDown);
    }

    function pickShown(which, want) {
      var list = state.shown;
      if (want && want.cheap && which === null) {
        var cheapest = list.slice().sort(function (a, b) { return a.paise - b.paise; })[0];
        return pick(cheapest.handle, merge(state.want, want));
      }
      var i = which === 'it' ? 0 : which === -1 ? list.length - 1 : which;
      if (!list[i]) return done([text('I only showed ' + list.length + '. Which one would you like?')]);
      return pick(list[i].handle, merge(state.want, want));
    }

    function merge(a, b) {
      a = a || {}; b = b || {};
      return { qty: b.qty || a.qty || null, size: b.size || a.size || null, cheap: b.cheap || false };
    }

    /** A product chosen: its size next, or straight into the bag. */
    function pick(handle, want, justLooking) {
      want = want || {};
      return S.product(handle).then(function (p) {
        if (!p) return answer([text('That product is no longer in the store.')], chips('shop'));
        var vs = p.variants.map(function (v) { return { id: v.id, title: v.title || 'One size', paise: v.paise, wasPaise: v.wasPaise, available: v.available }; });
        state.focus = { handle: p.handle, title: p.title, brand: p.brand, image: (p.images[0] && p.images[0].url) || null, variants: vs };
        state.want = want;
        var sellable = vs.filter(function (v) { return v.available; });
        if (!sellable.length) {
          state.pending = null;
          return answer([text(p.title + ' is sold out right now. I can show you similar products, or our team can tell you when it is back.')],
            [{ label: 'Show similar', say: (p.brand ? p.brand + ' ' : '') + N.searchTerms(p.title).split(' ').slice(1, 3).join(' ') }, CHIPS.person]);
        }
        var chosen = null;
        if (sellable.length === 1 && !justLooking) chosen = sellable[0];
        else if (want.size) chosen = sellable.filter(function (v) { return N.sizesIn(v.title + ' ' + p.title).some(function (s) { return N.sameSize(s, want.size); }); })[0] || null;
        if (chosen && !justLooking) return addToBag(chosen, want.qty || 1);
        state.pending = 'pickSize';
        var lead = justLooking
          ? p.title + (sellable.length > 1 ? ' comes in ' + sellable.length + ' sizes. Tap one to add it to your bag.' : '. Tap to add it to your bag.')
          : want.size ? 'I don\'t see ' + want.size.text + ' for ' + p.title + '. Which size would you like?' : 'Which size of ' + p.title + '?';
        return answer([text(lead), { type: 'detail', product: state.focus, qty: want.qty || 1 }], [{ label: 'The smallest', say: 'the smallest' }, { label: 'The cheapest', say: 'the cheapest' }]);
      }).catch(storeDown);
    }

    function pickSize(e) {
      var f = state.focus;
      if (!f) return products(e, '');
      var sellable = f.variants.filter(function (v) { return v.available; });
      var t = N.normalise(e._raw || '');
      var chosen = null;
      if (e.size) chosen = sellable.filter(function (v) { return N.sizesIn(v.title).some(function (s) { return N.sameSize(s, e.size); }); })[0];
      else if (e.which !== null && e.which !== 'it') chosen = sellable[e.which === -1 ? sellable.length - 1 : e.which];
      else if (e.cheap || /\b(small|smallest)\b/.test(t)) chosen = sellable.slice().sort(function (a, b) { return a.paise - b.paise; })[0];
      else if (/\b(big|biggest|large|largest)\b/.test(t)) chosen = sellable.slice().sort(function (a, b) { return b.paise - a.paise; })[0];
      else if (sellable.length === 1) chosen = sellable[0];
      if (!chosen) {
        return done([text(e.size ? 'That size is not available. Choose one of these:' : 'Which size? Tap one:'), { type: 'detail', product: f, qty: (state.want && state.want.qty) || 1 }]);
      }
      return addToBag(chosen, e.qty || (state.want && state.want.qty) || 1);
    }

    function addToBag(v, qty) {
      var f = state.focus;
      qty = Math.max(1, Math.min(50, qty || 1));
      return S.cartAdd(v.id, qty).then(function (cart) {
        remember(cart);
        state.lastLine = v.id;
        state.pending = null;
        state.want = null;
        var name = (f ? f.title : 'It') + (v.title && v.title !== 'One size' && v.title !== 'Default Title' ? ' (' + v.title + ')' : '');
        return answer([
          text('Added ' + (qty > 1 ? qty + ' x ' : '') + name + ' to your bag.'),
          bagBlock(cart, true)
        ], [CHIPS.checkout, { label: 'Add more of it', say: 'one more' }, { label: 'Find something else', say: 'I want to order something else' }]);
      }).catch(function (err) {
        return answer([text((err && err.storefront && err.message) || 'I could not add that right now. Try again in a moment.')], chips('person'));
      });
    }

    /** From a product card or size button: straight into the bag. */
    function addVariant(variantId, qty, title) {
      var f = state.focus;
      var v = f && f.variants.filter(function (x) { return x.id === variantId; })[0];
      if (!v) { v = { id: variantId, title: '' }; state.focus = { title: title || 'It', variants: [v] }; }
      return addToBag(v, qty || 1);
    }

    function showBag() {
      return loadBag().then(function (cart) {
        state.pending = null;
        if (!cart || !cart.lines.length) {
          return answer([text('Your bag is empty. Tell me what you would like and I will add it.')], chips('deworm', 'shop'));
        }
        return answer([text('Your bag has ' + itemWord(cart.count) + ', ' + money(cart.subtotalPaise) + ' before delivery.'), bagBlock(cart)],
          [CHIPS.checkout, { label: 'Add something', say: 'I want to order something else' }]);
      }).catch(storeDown);
    }

    function lineFor(cart, e) {
      var lines = cart.lines;
      if (e.which !== null && e.which !== 'it') return lines[e.which === -1 ? lines.length - 1 : e.which] || null;
      var words = e.terms || '';
      if (words) {
        var scored = lines.map(function (l) { return { l: l, s: N.titleScore(words, l.title + ' ' + l.variantTitle) }; })
          .filter(function (x) { return x.s >= 0.5; }).sort(function (a, b) { return b.s - a.s; });
        if (scored.length === 1 || (scored.length > 1 && scored[0].s > scored[1].s)) return scored[0].l;
        if (scored.length > 1) return null;
      }
      if (state.lastLine) {
        var last = lines.filter(function (l) { return l.variantId === state.lastLine; })[0];
        if (last && (e.which === 'it' || !words)) return last;
      }
      return lines.length === 1 ? lines[0] : null;
    }

    function changeLine(e, raw) {
      return loadBag().then(function (cart) {
        if (!cart || !cart.lines.length) return answer([text('Your bag is empty.')], chips('shop'));
        var line = lineFor(cart, e);
        if (!line) return answer([text('Which item? Tap - or + on it, or Remove:'), bagBlock(cart)], [CHIPS.checkout]);
        var t = N.normalise(raw);
        var removing = N.RX.bagRemove.test(t);
        var qty = line.qty;
        if (removing) qty = 0;
        else if (/\b(one|1|two|2|three|3) more\b|\bincrease\b|\banother\b/.test(t)) qty = line.qty + (N.quantity(t.replace(/more/, 'pieces')) || 1);
        else if (/\bless\b|\breduce\b|\bone fewer\b/.test(t)) qty = Math.max(0, line.qty - 1);
        else if (e.qty) qty = e.qty;
        return setLine(line.lineId, qty, line.title);
      }).catch(storeDown);
    }

    function setLine(lineId, qty, title) {
      var work = qty <= 0 ? S.cartRemove(lineId) : S.cartSetQty(lineId, qty);
      return work.then(function (cart) {
        remember(cart);
        if (!cart || !cart.lines.length) return answer([text((title ? 'Removed ' + title + '. ' : '') + 'Your bag is empty now.')], chips('shop'));
        return answer([text(qty <= 0 ? 'Removed' + (title ? ' ' + title : '') + '.' : 'Updated' + (title ? ' ' + title : '') + ' to ' + qty + '.'), bagBlock(cart, true)], [CHIPS.checkout, CHIPS.bag]);
      }).catch(function (err) {
        return answer([text((err && err.storefront && err.message) || 'I could not change the bag right now.')], chips('bag'));
      });
    }

    function emptyBag(confirmed) {
      if (!confirmed) {
        state.pending = 'emptyBag';
        return done([text('Remove everything from your bag?')], [{ label: 'Yes, empty it', act: { t: 'emptyYes' } }, { label: 'No, keep it', act: { t: 'emptyNo' } }]);
      }
      state.pending = null;
      return loadBag().then(function (cart) {
        var lines = cart ? cart.lines : [];
        return lines.reduce(function (p, l) { return p.then(function () { return S.cartRemove(l.lineId); }); }, Promise.resolve())
          .then(function () { remember(null); return answer([text('Done. Your bag is empty.')], chips('shop')); });
      }).catch(storeDown);
    }

    /* ---------------------------------------------- checkout in the chat */

    function stateCodes() {
      if (!STATES_KEYS) STATES_KEYS = (C.states || []).map(function (s) { return s[0]; });
      return STATES_KEYS;
    }

    function checkAddress(a) {
      a = a || {};
      var clean = {
        name: String(a.name || '').replace(/\s+/g, ' ').trim(), phone: String(a.phone || '').replace(/\D/g, '').slice(-10),
        email: String(a.email || '').trim().toLowerCase(), address1: String(a.address1 || '').trim(), address2: String(a.address2 || '').trim(),
        zip: String(a.zip || '').replace(/\D/g, ''), city: String(a.city || '').trim(), state: String(a.state || '').toUpperCase()
      };
      if (!clean.state && clean.zip.length === 6 && shop.stateOfPin) clean.state = shop.stateOfPin(clean.zip) || '';
      var err = {};
      if (clean.name.length < 2) err.name = 'Enter your full name.';
      if (!/^[6-9]\d{9}$/.test(clean.phone)) err.phone = 'Enter a 10 digit mobile number.';
      if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) err.email = 'Check the email address.';
      if (clean.address1.length < 3) err.address1 = 'Enter the house, street or building.';
      if (!/^[1-9]\d{5}$/.test(clean.zip)) err.zip = 'Enter a 6 digit pincode.';
      if (clean.city.length < 2) err.city = 'Enter the town or city.';
      if (stateCodes().indexOf(clean.state) < 0) err.state = 'Choose the state.';
      return { address: clean, errors: err, ok: !Object.keys(err).length };
    }

    function cartLines(cart) { return cart.lines.map(function (l) { return { variantId: l.variantId, qty: l.qty }; }); }

    function checkout() {
      return loadBag().then(function (cart) {
        if (!cart || !cart.lines.length) {
          if (state.pending === 'pickSize' && state.focus) {
            return answer([text('First choose a size of ' + state.focus.title + ', then we can check out:'), { type: 'detail', product: state.focus, qty: (state.want && state.want.qty) || 1 }]);
          }
          state.pending = null;
          return answer([text('Your bag is empty. Tell me what you would like to order and I will add it.')], chips('deworm', 'shop'));
        }
        var known = (state.co && state.co.address) || (shop.savedAddress && shop.savedAddress());
        if (known && checkAddress(known).ok) {
          state.pending = 'savedAddress';
          state.co = { address: checkAddress(known).address };
          return answer([text('Let\'s place your order: ' + itemWord(cart.count) + ', ' + money(cart.subtotalPaise) + ' before delivery. Deliver to this address?'),
            { type: 'savedAddress', address: state.co.address }], []);
        }
        state.pending = 'address';
        return answer([text('Let\'s place your order: ' + itemWord(cart.count) + ', ' + money(cart.subtotalPaise) + ' before delivery. Where should it go?'),
          { type: 'address', prefill: known || {}, errors: {} }], []);
      }).catch(storeDown);
    }

    function askAddress(prefill, errors, lead) {
      state.pending = 'address';
      return done([text(lead || 'Where should it go?'), { type: 'address', prefill: prefill || {}, errors: errors || {} }]);
    }

    function useAddress(a) {
      var c = checkAddress(a);
      if (!c.ok) return askAddress(c.address, c.errors, 'A few details need fixing:');
      if (shop.keepAddress) shop.keepAddress(c.address);
      state.co = { address: c.address };
      return quote();
    }

    function quote(rate) {
      var co = state.co;
      return loadBag().then(function (cart) {
        if (!cart || !cart.lines.length) { state.co = null; state.pending = null; return answer([text('Your bag is empty now.')], chips('shop')); }
        return Promise.all([S.checkout('quote', { lines: cartLines(cart), address: co.address, rate: rate || co.rate }), terms()]).then(function (r) {
          var q = r[0];
          if (q.configured === false) {
            state.pending = null;
            return answer([text('Ordering online is being switched on. Send your bag to our team on WhatsApp and they will confirm it with you.')]
              .concat(contactBlocks('', 'Hi Paws and Tails, I would like to order:\n' + state.bagText + '\nDeliver to ' + co.address.city + ' ' + co.address.zip)), []);
          }
          if (!q.ok) {
            if (q.fields) return askAddress(co.address, q.fields, q.error);
            state.pending = null;
            return answer([text(q.error || 'I could not price the order.')].concat(q.unavailable ? [bagBlock(cart)] : []),
              q.unavailable ? [CHIPS.checkout] : [{ label: 'Use a different address', act: { t: 'newAddress' } }, CHIPS.person]);
          }
          co.quote = q;
          co.rate = q.rate;
          if (!co.payment || (co.payment === 'cod' && !q.cod.allowed) || (co.payment === 'online' && !q.online)) {
            co.payment = q.online ? 'online' : q.cod.allowed ? 'cod' : null;
          }
          co.eta = estimate(r[1], { start: now(), region: regionOfPin(co.address.zip), fallback: fallbackDays });
          return summary('Please check and confirm. Nothing is charged until you tap the button.');
        });
      }).catch(storeDown);
    }

    function summary(lead) {
      var co = state.co, q = co.quote;
      state.ref += 1;
      co.ref = state.ref;
      state.pending = 'confirm';
      return answer([text(lead), {
        type: 'summary', ref: co.ref, items: q.items, address: co.address, rates: q.rates, rate: co.rate, payment: co.payment,
        online: q.online, cod: q.cod, subtotal: q.subtotal, shipping: q.shipping, tax: q.tax, taxesIncluded: q.taxesIncluded,
        total: q.total, eta: co.eta ? fmtEta(co.eta) : ''
      }], [{ label: 'Change address', act: { t: 'newAddress' } }, { label: 'Not now', act: { t: 'cancelCheckout' } }]);
    }

    function setRate(handleOrSpeed) {
      var co = state.co;
      if (!co || !co.quote) return checkout();
      var rates = co.quote.rates;
      var r = rates.filter(function (x) { return x.handle === handleOrSpeed; })[0];
      if (!r && handleOrSpeed === 'express') r = rates.filter(function (x) { return /express|fast|priority/i.test(x.title); })[0] || rates[rates.length - 1];
      if (!r && handleOrSpeed === 'standard') r = rates[0];
      if (!r) return summary('Choose one of these delivery options:');
      if (r.handle === co.rate) return summary(r.title + ' is already chosen.');
      return quote(r.handle);
    }

    function setPayment(p) {
      var co = state.co;
      if (!co || !co.quote) return checkout();
      var q = co.quote;
      if (p === 'cod' && !q.cod.allowed) return summary(q.cod.why || 'Cash on delivery is not available for this order.');
      if (p === 'online' && !q.online) return summary('Online payment is not switched on yet; cash on delivery is available.');
      co.payment = p;
      return summary(p === 'cod' ? 'Cash on delivery: pay when it arrives.' : 'Pay online with UPI, cards, netbanking or wallets.');
    }

    function place(ref) {
      var co = state.co;
      if (!co || !co.quote) return checkout();
      if (ref && ref !== co.ref) return summary('That summary was out of date. Here is the latest; please check it.');
      if (!co.payment) return summary('Choose how you would like to pay.');
      if (!shop.place) return done([text('Placing orders is not available here.')], chips('person'));
      var q = co.quote;
      return loadBag().then(function (cart) {
        if (!cart || !cart.lines.length) { state.co = null; state.pending = null; return answer([text('Your bag is empty now.')], chips('shop')); }
        return shop.place({ lines: cartLines(cart), address: co.address, rate: co.rate, payment: co.payment, expectTotal: q.total }).then(function (r) {
          if (r && r.ok) {
            var o = r.order;
            state.pending = null;
            state.co = null;
            state.order = String(o.name).replace(/^#/, '');
            state.contact = co.address.phone;
            remember(null);
            return answer([
              { type: 'placed', order: o, eta: co.eta ? fmtEta(co.eta) : '', city: co.address.city },
              text(o.payment === 'online'
                ? 'Paid ' + money(o.total) + '. Order ' + o.name + ' is placed and on its way to our team.'
                : 'Order ' + o.name + ' is placed. Pay ' + money(o.total) + ' in cash when it arrives.')
            ], [{ label: 'Track this order', href: '#/track/' + encodeURIComponent(state.order) }, { label: 'Order something else', say: 'I want to order something else' }]);
          }
          r = r || {};
          if (r.changed && r.quote) { co.quote = r.quote; co.rate = r.quote.rate; return summary('The total changed since you looked: it is now ' + money(r.quote.total) + '. Please check and confirm again.'); }
          if (r.fields) return askAddress(co.address, r.fields, r.error);
          if (r.dismissed) {
            state.pending = 'confirm';
            return answer([text('Payment not completed. Nothing was charged.')],
              [{ label: 'Pay ' + money(q.total), act: { t: 'place', ref: co.ref } }].concat(q.cod.allowed ? [{ label: 'Cash on delivery instead', act: { t: 'pay', p: 'cod' } }] : []));
          }
          if (r.paid) {
            return answer([text(r.error + (r.paymentId ? ' Payment id ' + r.paymentId + '.' : ''))]
              .concat(contactBlocks('', handoffText('Hi Paws and Tails, I paid (payment id ' + (r.paymentId || '') + ') but my order did not confirm.'))), []);
          }
          if (r.configured === false) {
            return answer([text('Ordering online is being switched on. Send your bag to our team on WhatsApp and they will confirm it with you.')]
              .concat(contactBlocks('', 'Hi Paws and Tails, I would like to order:\n' + state.bagText)), []);
          }
          return answer([text(r.error || 'The order could not be placed. Nothing was charged.')],
            [{ label: 'Try again', act: { t: 'place', ref: co.ref } }, CHIPS.person]);
        });
      }).catch(storeDown);
    }

    function cancelCheckout() {
      state.pending = null;
      state.co = state.co ? { address: state.co.address } : null;
      return done([text('No problem, nothing was placed. Your bag is saved for when you are ready.')], [CHIPS.checkout, CHIPS.bag]);
    }

    /* ---------------------------------------------------------- reorder */

    function reorder(e, raw) {
      if (e.orderNo) { if (e.orderNo !== state.order) { state.contact = e.contact || null; state.lastOrder = null; } state.order = e.orderNo; }
      if (e.contact) state.contact = e.contact;
      var last = state.lastOrder;
      if (last && (!e.orderNo || String(last.name).replace(/^#/, '') === String(e.orderNo))) return reorderFrom(last);
      state.after = 'reorder';
      if (!state.order) { state.pending = 'reorderContact'; return done([text('Which order would you like again? Send the order number, like #1042.')]); }
      if (!state.contact) { state.pending = 'reorderContact'; return done([text('And the phone number or email used for order #' + String(state.order).replace(/^#/, '') + '?')]); }
      return lookupOrder();
    }

    function reorderFrom(o) {
      var items = (o.items || []).filter(function (i) { return i.variantId; });
      if (!items.length) return done([text('I could not read the items of ' + o.name + '. Tell me what you would like and I will add it.')], chips('shop'));
      var added = [], missed = [];
      return items.reduce(function (p, it) {
        return p.then(function () {
          return S.cartAdd(it.variantId, it.qty || 1).then(function (cart) { remember(cart); added.push(it); }, function () { missed.push(it); });
        });
      }, Promise.resolve()).then(function () {
        if (!added.length) return answer([text('Everything in ' + o.name + ' is sold out right now.')], chips('shop', 'person'));
        var note = missed.length ? missed.map(function (m) { return m.title; }).join(', ') + (missed.length === 1 ? ' is' : ' are') + ' sold out, so I left ' + (missed.length === 1 ? 'it' : 'them') + ' out.' : null;
        return checkout().then(function (next) {
          next.blocks.unshift(text('Added ' + added.length + ' of ' + items.length + ' items from ' + o.name + ' to your bag.', note));
          return next;
        });
      });
    }

    /* ------------------------------------------------------------ reply */

    function reply(raw) {
      raw = String(raw || '').trim().slice(0, 400);
      if (raw) { state.history.push(raw.slice(0, 120)); if (state.history.length > 8) state.history.shift(); }
      return Promise.resolve(S.cartId() ? loadBag().catch(function () { return null; }) : null).then(function () {
        var r = N.read(raw, { pending: state.pending, hasBag: state.bagCount > 0, brands: C.brands, vocab: vocab });
        var e = r.entities;
        e._raw = raw;
        var intent = r.intent;
        var keepPending = { checkout: 1, track: 1, reorder: 1, pickSize: 1, pickProduct: 1, confirmYes: 1, confirmNo: 1, setPayment: 1, setSpeed: 1, changeAddress: 1, useSaved: 1, emptyYes: 1, emptyNo: 1 };
        if (!keepPending[intent] && state.pending && state.pending !== 'confirm') state.pending = null;
        switch (intent) {
          case 'restart': reset(); return welcome();
          case 'greet': return welcome();
          case 'help': return answer([text('Here is what I can do: find products and recommend the best ones at your price, add them to your bag and place the order here (online payment or cash on delivery), track an order, tell you delivery dates for your pincode, and answer questions on shipping, payment and returns.')],
            chips('shop', 'track', 'when', 'returns'));
          case 'thanks': return answer([text('You are welcome. Anything else?')], state.bagCount ? chips('checkout', 'shop') : chips('shop', 'track'));
          case 'bye': return answer([text('Thank you for shopping with Paws and Tails. I am here if you need anything.')], []);
          case 'track': return track(e, raw);
          case 'reorder': return reorder(e, raw);
          case 'cancelOrder':
            return answer(contactBlocks('To cancel an order before it ships, message our team with the order number and they will stop it.',
              handoffText('Hi Paws and Tails, please cancel my order' + (e.orderNo || state.order ? ' #' + String(e.orderNo || state.order).replace(/^#/, '') : '') + '.')), chips('track'));
          case 'human': return answer(contactBlocks('Our team is happy to help. I have added what we talked about to the WhatsApp message:'), chips('track'));
          case 'delivery': return delivery(e, raw);
          case 'fee': return fromPolicy('shipping', ['free', 'charge', 'fee', 'flat', RUPEE, 'rs', 'cost', 'minimum'], 'Delivery charges depend on your address and order; checkout shows them before you pay.', ['when', 'shop']);
          case 'pay': return fromPolicy('shipping', ['cash on delivery', 'cod', 'upi', 'card', 'payment', 'pay', 'prepaid'], 'You can pay online with UPI, cards, netbanking or wallets, or choose cash on delivery where it is offered.', ['fee', 'shop']);
          case 'returns': return fromPolicy('refund', ['return', 'refund', 'exchange', 'damaged', 'days', 'cannot', 'replace'], 'Our team will help with any return or damaged item. Message them with your order number.', ['person', 'track']);
          case 'buy': return buy(e, raw);
          case 'pickProduct': return pickShown(e.which, { qty: e.qty, size: e.size, cheap: e.cheap });
          case 'pickSize': return pickSize(e);
          case 'bagShow': return showBag();
          case 'bagRemove': case 'bagQty': return changeLine(e, raw);
          case 'bagEmpty': return emptyBag(false);
          case 'emptyYes': return emptyBag(true);
          case 'emptyNo': state.pending = null; return answer([text('Okay, your bag stays as it is.')], [CHIPS.checkout]);
          case 'checkout': return checkout();
          case 'useSaved': return state.co && state.co.address ? useAddress(state.co.address) : checkout();
          case 'changeAddress': return askAddress((state.co && state.co.address) || (shop.savedAddress && shop.savedAddress()) || {}, {}, 'Where should it go instead?');
          case 'confirmYes': return place(null);
          case 'confirmNo': return cancelCheckout();
          case 'setPayment': return setPayment(e.payment);
          case 'setSpeed': return setRate(e.speed);
          case 'product': return products(e, raw);
          case 'yesNo':
            return e.yesNo === 'no' ? answer([text('Okay. Anything else I can help with?')], chips('shop', 'track'))
              : answer([text('Great. What would you like to do?')], state.bagCount ? chips('checkout', 'shop') : chips('shop', 'track'));
          default:
            if (state.pending === 'confirm' && state.co) return summary('Tap the button to place the order, or tell me what to change.');
            return answer([text('Sorry, I did not catch that. I can help you order, track a parcel, or find a product. Try "order Acana puppy", "where is my order" or "deworming under 500".')],
              chips('shop', 'track', 'person'));
        }
      });
    }

    /** A button in the chat: the same work as typing, without the guessing. */
    function act(a) {
      a = a || {};
      switch (a.t) {
        case 'add': return addVariant(a.v, a.q || 1, a.title);
        case 'pick': return pick(a.h, state.want || {});
        case 'variant': return addVariant(a.v, a.q || (state.want && state.want.qty) || 1);
        case 'qty': return setLine(a.line, a.q, a.title);
        case 'remove': return setLine(a.line, 0, a.title);
        case 'bag': return showBag();
        case 'checkout': return checkout();
        case 'useSaved': return state.co && state.co.address ? useAddress(state.co.address) : checkout();
        case 'newAddress': return askAddress((state.co && state.co.address) || (shop.savedAddress && shop.savedAddress()) || {}, {}, 'Where should it go?');
        case 'address': return useAddress(a.a);
        case 'rate': return setRate(a.r);
        case 'pay': return setPayment(a.p);
        case 'place': return place(a.ref);
        case 'cancelCheckout': return cancelCheckout();
        case 'reorder': return state.lastOrder ? reorderFrom(state.lastOrder) : reorder({}, '');
        case 'emptyYes': return emptyBag(true);
        case 'emptyNo': state.pending = null; return done([text('Okay, your bag stays as it is.')], [CHIPS.checkout]);
        default: return done([text('That button has expired. What would you like to do?')], chips('shop', 'track'));
      }
    }

    function reset() {
      var keep = { bagCount: state.bagCount, bagText: state.bagText };
      var f = fresh();
      Object.keys(state).forEach(function (k) { delete state[k]; });
      Object.keys(f).forEach(function (k) { state[k] = f[k]; });
      state.bagCount = keep.bagCount; state.bagText = keep.bagText;
    }

    return {
      /* Always a promise, and never a rejection: a fault anywhere becomes a
       * polite answer rather than a stuck chat. */
      reply: function (raw) { return Promise.resolve().then(function () { return reply(raw); }).catch(function () { return storeDown(); }); },
      act: function (a) { return Promise.resolve().then(function () { return act(a); }).catch(function () { return storeDown(); }); },
      welcome: welcome, state: state, reset: reset
    };
  }

  /* What the pages and tests use. The readers live in nlu.js. */
  var VOCAB = null;
  function classify(text, ctx) {
    ctx = ctx || {};
    if (!VOCAB) VOCAB = N.baseVocabulary(ctx.brands || []);
    return N.read(text, { pending: ctx.pending, hasBag: !!ctx.hasBag, brands: ctx.brands || [], vocab: VOCAB }).intent;
  }

  return {
    create: create,
    classify: classify,
    parseOrderNo: N.orderNo,
    parseContact: N.contact,
    parsePin: N.pin,
    parsePrice: N.price,
    parseDelivery: parseDelivery,
    estimate: estimate,
    orderEta: orderEta,
    regionOfPin: regionOfPin,
    addDays: addDays,
    fmtDay: fmtDay,
    fmtRange: fmtRange,
    fmtEta: fmtEta,
    pickSentences: pickSentences
  };
}));
