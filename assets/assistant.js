/* ============================================================================
 * Paws and Tails assistant: the part that understands and answers
 * ============================================================================
 * No language model. Every answer is built from the store itself: products,
 * prices and stock from the live catalogue, delivery times and charges from
 * the store's own shipping page, returns from its returns page, and orders
 * from the order lookup (api/order.js). What the shopper types is read with
 * plain rules: an order number, a phone or email, a pincode, a price limit,
 * a pet, a kind of product, a brand.
 *
 * It answers:
 *   - where is my order          stage, courier, tracking link, expected date
 *   - when will it arrive        dates from the shipping page, by pincode
 *   - best deworming under 500   the store's best sellers in that collection,
 *                                filtered by price and stock
 *   - do you have / price of X   the store's search
 *   - shipping charges, cash on delivery, returns, a person to talk to
 *
 * Also used by the track page for its expected dates, so both agree.
 * Loadable in a browser (window.PTAssist) and in node, where the tests drive
 * it with a fake store.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PTAssist = factory();
}(typeof self !== 'undefined' ? self : this, function () {
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

  /* ========================================================== WHAT WAS SAID */

  /** An order number: "#1042", "order 1042", "order no. PT1042". A bare
   *  number counts only when the conversation is waiting for one. */
  function parseOrderNo(text, expecting) {
    var t = String(text || '');
    var m = t.match(/#\s*([a-z]{0,6}\d{3,10})\b/i) ||
      t.match(/\border\s*(?:no\.?|number|id)?\s*(?:is|:)?\s*#?\s*([a-z]{0,6}\d{3,10})\b/i) ||
      t.match(/\b(?:track|tracking|status of|status for)\s+#?\s*([a-z]{0,6}\d{3,10})\b/i);
    if (m) {
      var d = m[1].replace(/\D/g, '');
      if (!(d.length === 10 && /^[6-9]/.test(d) && !/#/.test(m[0]))) return m[1].toUpperCase();
    }
    if (expecting) {
      var bare = t.trim().match(/^#?\s*([a-z]{0,6}\d{3,9})$/i);
      if (bare) return bare[1].toUpperCase();
    }
    return null;
  }

  function parseContact(text) {
    var t = String(text || '');
    var e = t.match(/[^\s@,;:<>()]+@[^\s@,;:<>()]+\.[a-z]{2,}/i);
    if (e) return e[0].toLowerCase();
    var p = t.replace(/[\s-]/g, '').match(/(?:\+?91|0)?([6-9]\d{9})(?!\d)/);
    return p ? p[1] : null;
  }

  /** A six digit Indian pincode that is not part of a phone number. */
  function parsePin(text) {
    var m = String(text || '').match(/(?:^|[^\d#])([1-9]\d{5})(?!\d)/);
    return m ? m[1] : null;
  }

  function amountOf(num, k) {
    var n = Number(String(num).replace(/,/g, ''));
    if (!isFinite(n)) return null;
    if (k) n *= 1000;
    return Math.round(n * 100);
  }

  /** Price limits in paise: { max, min }. "under 500", "below rs 1,000",
   *  "between 200 and 400", "within 2k", "for \u20b9500". */
  function parsePrice(text) {
    var t = lower(text).replace(/\u20b9/g, ' rs ').replace(/rupees?|inr/g, ' rs ');
    var AMT = '(?:rs\\.?\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k\\b)?';
    var out = {};
    var between = t.match(new RegExp('between\\s+' + AMT + '\\s*(?:rs\\.?)?\\s*(?:and|to|-)\\s*' + AMT)) ||
      t.match(new RegExp('rs\\.?\\s*(\\d[\\d,]*)\\s*(k\\b)?\\s*(?:-|to)\\s*(?:rs\\.?\\s*)?(\\d[\\d,]*)\\s*(k\\b)?'));
    if (between) {
      out.min = amountOf(between[1], between[2]);
      out.max = amountOf(between[3], between[4]);
      if (out.min > out.max) { var x = out.min; out.min = out.max; out.max = x; }
      return out;
    }
    var under = t.match(new RegExp('(?:under|below|less than|lesser than|within|upto|up to|max(?:imum)?|not more than|cheaper than|no more than|budget(?: of| is)?|<)\\s*' + AMT));
    if (under) out.max = amountOf(under[1], under[2]);
    var over = t.match(new RegExp('(?:above|over|more than|greater than|at least|min(?:imum)?|>)\\s*' + AMT));
    if (over) out.min = amountOf(over[1], over[2]);
    if (out.max === undefined && out.min === undefined) {
      var bare = t.match(/rs\.?\s*(\d[\d,]*)\s*(k\b)?/) || t.match(/(\d[\d,]*)\s*(k\b)?\s*rs\b/);
      if (bare) out.max = amountOf(bare[1], bare[2]);
    }
    return out;
  }

  var PETS = {
    dog: ['dog', 'puppy', 'pup', 'canine', 'doggy'],
    cat: ['cat', 'kitten', 'kitty', 'feline'],
    bird: ['bird', 'parrot', 'budgie', 'cockatiel'],
    rabbit: ['rabbit', 'bunny'],
    fish: ['fish', 'aquarium']
  };
  var YOUNG = ['puppy', 'pup', 'kitten'];

  /* Kinds of product and the words shoppers use for them. `match` is what a
   * collection title or handle would contain. */
  var TOPICS = [
    { key: 'deworm', label: 'deworming', say: ['deworm', 'dewormer', 'deworming', 'worm', 'wormer', 'deworme'], match: ['deworm', 'worm'], care: true },
    { key: 'tick', label: 'tick and flea', say: ['tick', 'flea', 'lice', 'mite'], match: ['tick', 'flea'], care: true },
    { key: 'vaccine', label: 'vaccine', say: ['vaccine', 'vaccination', 'immunoglobulin'], match: ['vaccin'], care: true },
    { key: 'antibiotic', label: 'antibiotic', say: ['antibiotic', 'infection'], match: ['antibiotic'], care: true },
    { key: 'joint', label: 'joint care', say: ['joint', 'hip', 'arthritis', 'mobility'], match: ['joint'] },
    { key: 'supplement', label: 'supplement', say: ['supplement', 'vitamin', 'multivitamin', 'calcium', 'omega'], match: ['supplement', 'vitamin'] },
    { key: 'milk', label: 'milk', say: ['milk', 'formula', 'weaning'], match: ['milk'] },
    { key: 'treat', label: 'treats', say: ['treat', 'snack', 'chew', 'biscuit', 'jerky'], match: ['treat', 'snack'] },
    { key: 'shampoo', label: 'grooming', say: ['shampoo', 'bath', 'groom', 'grooming', 'brush', 'conditioner'], match: ['shampoo', 'groom'] },
    { key: 'litter', label: 'litter', say: ['litter'], match: ['litter'] },
    { key: 'bowl', label: 'bowl', say: ['bowl', 'feeder'], match: ['bowl', 'feeding'] },
    { key: 'toy', label: 'toy', say: ['toy', 'ball', 'rope', 'squeaky'], match: ['toy'] },
    { key: 'food', label: 'food', say: ['food', 'kibble', 'diet', 'meal', 'feed', 'gravy'], match: ['food'] },
    { key: 'medicine', label: 'medicine', say: ['medicine', 'med', 'tablet', 'syrup', 'pharmacy', 'drug'], match: ['medicine', 'pharmacy'], care: true }
  ];

  function hasWord(ws, list) {
    for (var i = 0; i < ws.length; i++) {
      var w = stem(ws[i]);
      for (var j = 0; j < list.length; j++) {
        var l = list[j];
        if (w === l || ws[i] === l || (l.length >= 5 && w.indexOf(l) === 0)) return l;
      }
    }
    return null;
  }

  function parsePet(ws) {
    for (var k in PETS) if (hasWord(ws, PETS[k])) return { pet: k, young: !!hasWord(ws, YOUNG) };
    return null;
  }

  function parseTopic(ws) {
    for (var i = 0; i < TOPICS.length; i++) if (hasWord(ws, TOPICS[i].say)) return TOPICS[i];
    return null;
  }

  function parseBrand(text, brands) {
    var t = lower(text);
    for (var i = 0; i < (brands || []).length; i++) {
      var b = lower(brands[i]);
      if (b && new RegExp('(^|[^a-z])' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])').test(t)) return brands[i];
    }
    return null;
  }

  /* ============================================================= INTENTS */

  var RX = {
    greet: /^(hi+|hello|hey+|hai|namaste|namaskara|good (morning|afternoon|evening)|yo)\b/,
    thanks: /\b(thanks|thank you|thank u|thx|ty|great|awesome|perfect|cool|ok(ay)? thanks)\b/,
    human: /\b(human|real person|a person|agent|executive|customer care|support team|call (me|you)|phone number|contact|whats ?app|email (you|address)|speak to|talk to|complain|complaint)\b/,
    track: /\b(track|tracking|where('?s| is) my|order status|status of (my )?order|my order|my parcel|my package|awb|consignment|has (it|my order) (shipped|been shipped|dispatched)|not (yet )?(received|delivered|arrived)|didn'?t (get|receive))\b/,
    cancel: /\b(cancel)\b/,
    delivery: /\b(when will|how long|how many days|delivery time|delivery date|days to deliver|deliver(y|ed)? (to|in|at)|arrive|arrival|reach me|reach by|eta|shipping time|do you (deliver|ship)|ship to|pin ?code|pincode|by when|how soon|fast delivery|express)\b/,
    fee: /\b(shipping (charge|cost|fee)s?|delivery (charge|cost|fee)s?|free (shipping|delivery)|charges? for (shipping|delivery)|minimum order)\b/,
    pay: /\b(cod|cash on delivery|pay(ment)?( options| methods| mode)?|upi|emi|credit card|debit card|net ?banking|gpay|phonepe|paytm)\b/,
    returns: /\b(return|refund|exchange|replace(ment)?|damaged|broken|wrong (item|product)|expired|leak(ed|ing)?)\b/,
    recommend: /\b(best|recommend|suggest|good|top|which|what should|cheap|cheapest|affordable|budget|lowest|popular|bestseller|best seller)\b/,
    ask: /\b(do you (have|sell|stock)|in stock|available|availability|price of|cost of|how much|looking for|need|want|buy|show me|find)\b/,
    cheap: /\b(cheap|cheapest|lowest|affordable|budget|least expensive|low price)\b/
  };

  function classify(text, ctx) {
    var t = lower(text).trim();
    var ws = words(t);
    var order = parseOrderNo(text, ctx && ctx.pending === 'order');
    var contact = parseContact(text);
    var price = parsePrice(text);
    var hasPrice = price.max !== undefined || price.min !== undefined;
    var topic = parseTopic(ws);

    if (ctx && ctx.pending && (order || contact)) return 'track';
    if (order) return RX.returns.test(t) ? 'returns' : 'track';
    if (RX.cancel.test(t) && /\border\b/.test(t)) return 'cancel';
    if (RX.track.test(t) && !(hasPrice || (topic && RX.recommend.test(t)))) return 'track';
    if (RX.returns.test(t)) return 'returns';
    if (RX.fee.test(t)) return 'fee';
    if (RX.pay.test(t) && !topic) return 'pay';
    if (RX.delivery.test(t) && !hasPrice) return 'delivery';
    if (RX.human.test(t)) return 'human';
    if (hasPrice || topic || RX.recommend.test(t) || RX.ask.test(t)) return 'product';
    if (RX.greet.test(t) && ws.length <= 4) return 'greet';
    if (RX.thanks.test(t) && ws.length <= 5) return 'thanks';
    if (ws.length === 0) return 'greet';
    return 'product';
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

  /**
   * create({ S, C, collections, now })
   *   S            the storefront client (assets/storefront.js)
   *   C            store facts (assets/catalogue.js)
   *   collections  () => Promise of the live collection list
   *   now          () => Date, for tests
   * Returns { reply(text) -> Promise<{ blocks, chips }>, state, welcome() }.
   */
  function create(deps) {
    var S = deps.S;
    var C = deps.C || {};
    var now = deps.now || function () { return new Date(); };
    var getCols = deps.collections || function () { return S.collections(); };
    var fallbackDays = (C.delivery && C.delivery.fallbackDays) || [3, 7];
    var state = { pending: null, order: null, contact: null, lastOrder: null, lastQuery: null };
    var policyCache = null;

    function policies() {
      if (!policyCache) {
        policyCache = S.policies({ shippingPath: C.policies && C.policies.shipping, refundPath: C.policies && C.policies.refund })
          .catch(function () { return { shipping: { text: '' }, refund: { text: '' } }; });
      }
      return policyCache;
    }
    function terms() {
      return policies().then(function (p) { return parseDelivery(p.shipping.text); });
    }

    function text(t, extra) { var b = { type: 'text', text: t }; if (extra) b.note = extra; return b; }
    function money(p) { return S.money(p); }

    var CHIPS = {
      track: { label: 'Track my order', say: 'Track my order' },
      when: { label: 'When will it arrive?', say: 'When will my order arrive if I order today?' },
      deworm: { label: 'Best deworming under ' + RUPEE + '500', say: 'Best deworming under 500' },
      person: { label: 'Talk to a person', say: 'Talk to a person' },
      returns: { label: 'Returns', say: 'What is the return policy?' },
      fee: { label: 'Shipping charges', say: 'What are the shipping charges?' }
    };
    function chips() {
      return Array.prototype.slice.call(arguments).map(function (k) { return CHIPS[k]; }).filter(Boolean);
    }

    function welcome() {
      return {
        blocks: [text('Hi! I can track an order, tell you when a parcel will arrive, or find the right product at your price.')],
        chips: chips('track', 'deworm', 'when', 'person')
      };
    }

    /* ---------------------------------------------------------- contact */

    function contactBlocks(lead) {
      var s = C.support || {};
      var links = [];
      if (s.whatsapp) links.push({ label: 'WhatsApp us', href: 'https://wa.me/' + s.whatsapp });
      if (s.phone) links.push({ label: 'Call ' + (s.phoneLabel || s.phone), href: 'tel:' + s.phone });
      if (s.email) links.push({ label: 'Email ' + s.email, href: 'mailto:' + s.email });
      return [text(lead || 'Happy to put you through to our team.'), { type: 'links', links: links }];
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
          state.order = null; state.contact = null;
          return {
            blocks: [text('Order tracking here is still being connected to our store. Your order confirmation email has a "View your order" link that shows its status, or our team can check it for you.')]
              .concat(contactBlocks('').slice(1)),
            chips: chips('when', 'person')
          };
        }
        if (!res.found) {
          var tried = order;
          state.contact = null;
          state.pending = 'contact';
          return {
            blocks: [text('I could not find order #' + tried.replace(/^#/, '') + ' with that phone number or email. Both have to be the ones on the order. Try the other one, or check the number in your confirmation email.')],
            chips: [{ label: 'Use a different order number', say: 'Track a different order' }, CHIPS.person]
          };
        }
        var o = res.order;
        state.lastOrder = o;
        var eta = orderEta(o, t, fallbackDays);
        var note = eta && eta.basis === 'usual' ? 'Estimated from our usual delivery times.' :
          eta && eta.basis === 'policy' ? 'Estimated from our shipping page' + (eta.region && eta.region.metro ? ' for ' + eta.region.city : '') + '.' : null;
        return {
          blocks: [
            { type: 'order', order: o, eta: eta },
            text(orderSummary(o, eta), note)
          ],
          chips: o.stage === 'delivered' || o.stage === 'cancelled'
            ? chips('returns', 'person')
            : [{ label: 'Open the track page', href: '#/track/' + encodeURIComponent(o.name.replace(/^#/, '')) }, CHIPS.person]
        };
      }).catch(function (e) {
        state.pending = null;
        return { blocks: [text((e && e.message) || 'I could not reach the order desk just now. Try again in a moment.')], chips: chips('track', 'person') };
      });
    }

    function track(msg) {
      var o = parseOrderNo(msg, state.pending === 'order');
      var c = parseContact(msg);
      if (/different order|another order|other order/i.test(msg)) { state.order = null; state.contact = null; }
      if (o) { if (o !== state.order) state.contact = c || null; state.order = o; }
      if (c) state.contact = c;
      if (!state.order) {
        state.pending = 'order';
        return Promise.resolve({ blocks: [text('Sure. What is your order number? It is in your order confirmation email, like #1042.')], chips: [] });
      }
      if (!state.contact) {
        state.pending = 'contact';
        return Promise.resolve({ blocks: [text('Thanks. And the phone number or email used for order #' + state.order.replace(/^#/, '') + '?')], chips: [] });
      }
      return lookupOrder();
    }

    /* ---------------------------------------------------------- delivery */

    function delivery(msg) {
      var pin = parsePin(msg);
      if (state.lastOrder && /\b(my|the|this|that) (order|parcel|package)\b|\bit\b/i.test(msg) && !pin) {
        return terms().then(function (t) {
          var o = state.lastOrder;
          var eta = orderEta(o, t, fallbackDays);
          return { blocks: [text(orderSummary(o, eta))], chips: chips('person') };
        });
      }
      if (/\b(my|the) (order|parcel|package)\b/i.test(msg) && !pin && !/if i order|order (it )?today|ordered today|order now/i.test(msg)) {
        return track(msg);
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
        return {
          blocks: [text(lead + (detail.length ? ' ' + detail.join(' ') : ''), note)],
          chips: pin ? chips('fee', 'track') : [{ label: 'Delivery to my pincode', say: 'Delivery time to pincode ' }, CHIPS.fee, CHIPS.track]
        };
      });
    }

    function span(r) {
      var n = r.min === r.max ? (r.upTo ? 'up to ' : '') + r.max : r.min + ' to ' + r.max;
      return n + (r.business ? ' working' : '') + (r.max === 1 ? ' day' : ' days');
    }

    /* ------------------------------------------------- policy questions */

    function fromPolicy(which, keys, lead, fallbackText, chipKeys) {
      return policies().then(function (p) {
        var src = p[which] || { text: '', url: '' };
        var picked = pickSentences(src.text, keys, 2);
        var blocks = picked.length
          ? [text((lead ? lead + ' ' : '') + picked.join(' '))]
          : [text(fallbackText)];
        if (src.url) blocks.push({ type: 'links', links: [{ label: which === 'refund' ? 'Full returns policy' : 'Full shipping policy', href: src.url }] });
        return { blocks: blocks, chips: chips.apply(null, chipKeys) };
      });
    }

    /* ---------------------------------------------------------- products */

    function scoreCollection(col, topic, pet) {
      var hay = lower(col.title + ' ' + col.handle);
      var s = 0;
      if (topic && topic.match.some(function (m) { return hay.indexOf(m) >= 0; })) s += 4;
      if (pet) {
        var mine = PETS[pet.pet].some(function (w) { return hay.indexOf(w) >= 0; });
        var other = Object.keys(PETS).some(function (k) {
          return k !== pet.pet && PETS[k].some(function (w) { return new RegExp('(^|[^a-z])' + w).test(hay); });
        });
        if (mine) s += 2;
        if (pet.young && YOUNG.some(function (w) { return hay.indexOf(w) >= 0; })) s += 2;
        if (!pet.young && YOUNG.some(function (w) { return hay.indexOf(w) >= 0; })) s -= 1;
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

    function cleanQuery(msg, brand) {
      var stop = /^(best|good|top|recommend|suggest|which|what|is|are|the|a|an|for|my|me|i|need|want|looking|show|find|do|you|have|sell|any|some|please|pls|under|below|above|over|between|and|to|rs|in|of|price|cost|how|much|stock|available|buy|with|cheap|cheapest|budget|affordable|less|than|more|within|upto|up|max|can|get|should|it|this|that|there|your|k|from)$/;
      return words(msg).filter(function (w) {
        return !stop.test(w) && !/^\d/.test(w) && w.indexOf('@') < 0 && w !== RUPEE;
      }).join(' ').trim();
    }

    function products(msg) {
      var ws = words(msg);
      var price = parsePrice(msg);
      var topic = parseTopic(ws);
      var pet = parsePet(ws);
      var brand = parseBrand(msg, C.brands);
      var cheap = RX.cheap.test(lower(msg));
      var priceWords = price.max !== undefined && price.min !== undefined
        ? ' between ' + money(price.min) + ' and ' + money(price.max)
        : price.max !== undefined ? ' under ' + money(price.max) : price.min !== undefined ? ' above ' + money(price.min) : '';
      state.lastQuery = { topic: topic, pet: pet, brand: brand };

      return getCols().then(function (cols) {
        var col = pickCollection(cols, topic, pet);
        var source, what, more = null, ranked;
        if (col) {
          source = function (after) { return S.collectionPage(col.handle, { sort: cheap ? 'priceLow' : 'featured', after: after }); };
          what = col.title;
          more = { label: 'See all of ' + col.title, href: '#/c/' + encodeURIComponent(col.handle) };
          ranked = cheap ? 'lowest price first' : 'best sellers';
        } else if (brand && !topic) {
          source = function (after) { return S.brandPage(brand, { sort: cheap ? 'priceLow' : 'featured', after: after }); };
          what = brand;
          more = { label: 'See all ' + brand, href: '#/brand/' + encodeURIComponent(brand) };
          ranked = cheap ? 'lowest price first' : 'best sellers';
        } else {
          var q = cleanQuery(msg, brand) || (topic ? topic.label : '') || (pet ? pet.pet : '');
          if (!q) {
            return {
              blocks: [text('Tell me what you are looking for, and your budget if you have one. For example: "cat food under 800" or "tick spray for my dog".')],
              chips: chips('deworm', 'track')
            };
          }
          source = function (after) { return S.searchAll(q, { after: after, sort: cheap ? 'priceLow' : 'featured' }); };
          what = '"' + q + '"';
          more = { label: 'See all results', href: '#/search/' + encodeURIComponent(q) };
          ranked = cheap ? 'lowest price first' : 'closest matches';
        }
        var keep = function (p) {
          if (!p.available || !within(p, price)) return false;
          if (pet && !col) {
            var t = lower(p.title + ' ' + p.type);
            var other = Object.keys(PETS).some(function (k) { return k !== pet.pet && PETS[k].some(function (w) { return t.indexOf(w) >= 0; }); });
            if (other && !PETS[pet.pet].some(function (w) { return t.indexOf(w) >= 0; })) return false;
          }
          return true;
        };
        return gather(source, keep, 3).then(function (r) {
          var picks = r.kept;
          if (cheap) picks = picks.slice().sort(function (a, b) { return a.paise - b.paise; });
          picks = picks.slice(0, 3);
          var care = topic && topic.care ? 'Check the dose for your pet\'s weight on the pack or with your vet.' : null;
          if (!picks.length) {
            var inStock = r.seen.filter(function (p) { return p.available && p.paise !== null; })
              .sort(function (a, b) { return a.paise - b.paise; });
            if (!r.seen.length) {
              return {
                blocks: [text('I could not find ' + what + ' in the store right now. Try another word, or ask our team and they will check.')],
                chips: chips('person', 'deworm')
              };
            }
            if (priceWords && inStock.length) {
              return {
                blocks: [
                  text('Nothing in ' + what + ' is' + priceWords + ' right now. The lowest price there is ' + money(inStock[0].paise) + ':'),
                  { type: 'products', items: inStock.slice(0, 1), more: more }
                ],
                chips: chips('person')
              };
            }
            return {
              blocks: [text('Everything in ' + what + ' that fits is sold out at the moment.'), { type: 'products', items: r.seen.slice(0, 2), more: more }],
              chips: chips('person')
            };
          }
          var lead = (ranked === 'best sellers' ? 'Our best-selling ' : ranked === 'lowest price first' ? 'The lowest priced ' : 'Here is what I found for ') +
            (ranked === 'closest matches' ? what : (col ? lower(col.title) : what)) + (ranked === 'closest matches' ? '' : ' picks') + priceWords + ':';
          var note = ranked === 'best sellers' ? 'Ranked by what sells most in our store, in stock now.' : null;
          if (care) note = note ? note + ' ' + care : care;
          return {
            blocks: [text(lead, note), { type: 'products', items: picks, more: more }],
            chips: cheap
              ? chips('when', 'track')
              : [{ label: 'Something cheaper', say: (topic ? topic.label : (brand || 'products')) + (pet ? ' for ' + pet.pet : '') + ' cheapest' }, CHIPS.when, CHIPS.track]
          };
        });
      }).catch(function () {
        return { blocks: [text('I could not reach the store just now. Try again in a moment.')], chips: chips('person') };
      });
    }

    /* ----------------------------------------------------------- reply */

    function reply(msg) {
      msg = String(msg || '').trim().slice(0, 400);
      var intent = classify(msg, state);
      if (intent !== 'track' && state.pending) state.pending = null;
      if (intent === 'track') return track(msg);
      if (intent === 'greet') return Promise.resolve(welcome());
      if (intent === 'thanks') return Promise.resolve({ blocks: [text('You are welcome. Anything else I can help with?')], chips: chips('track', 'deworm') });
      if (intent === 'human') return Promise.resolve({ blocks: contactBlocks('Our team is happy to help. Reach them here:'), chips: chips('track') });
      if (intent === 'cancel') {
        return Promise.resolve({
          blocks: contactBlocks('To cancel an order before it ships, message or call our team with the order number and they will stop it.'),
          chips: chips('track', 'returns')
        });
      }
      if (intent === 'delivery') return delivery(msg);
      if (intent === 'fee') {
        return fromPolicy('shipping', ['free', 'charge', 'fee', 'flat', RUPEE, 'rs', 'cost', 'minimum'], '',
          'Delivery charges depend on your address and order, and checkout shows them before you pay.', ['when', 'track']);
      }
      if (intent === 'pay') {
        return fromPolicy('shipping', ['cash on delivery', 'cod', 'upi', 'card', 'payment', 'pay', 'prepaid'], '',
          'Checkout shows every payment option available for your order before you pay, including cards and UPI where offered.', ['fee', 'when']);
      }
      if (intent === 'returns') {
        return fromPolicy('refund', ['return', 'refund', 'exchange', 'damaged', 'days', 'cannot', 'replace'], '',
          'Our team will help with any return or damaged item. Message them with your order number.', ['person', 'track']);
      }
      return products(msg);
    }

    return { reply: reply, welcome: welcome, state: state };
  }

  return {
    create: create,
    classify: classify,
    parseOrderNo: parseOrderNo,
    parseContact: parseContact,
    parsePin: parsePin,
    parsePrice: parsePrice,
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
