/* ============================================================================
 * Paws and Tails assistant: reading what shoppers type
 * ============================================================================
 * No language model. Plain, testable rules:
 *
 *   normalise   lower case, rupee signs, dashes, common Hinglish and chat
 *               shorthand ("chahiye", "kab aayega", "pls", "cart")
 *   correct     typos fixed against the shop's own words and brands
 *               ("acanna", "dewormr", "trak my ordr")
 *   entities    order number, phone or email, pincode, price limits,
 *               quantity ("2 bags", "x3", "two"), pack size ("2kg", "340 g"),
 *               which one ("the second one", "that"), yes or no, pet,
 *               kind of product, brand, payment and delivery choices
 *   intent      what the message is for, with the conversation's context
 *
 * Loadable in a browser (window.PTNlu) and in node for the tests.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PTNlu = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DASHES = '\u2010\u2011\u2012\u2013\u2014\u2015\u2212';

  /* ============================================================ NORMALISE */

  /* Whole words only. Indian English, Hinglish and chat shorthand that
   * shoppers really type, mapped to the words the rules below look for. */
  var SYNONYMS = {
    chahiye: 'want', chaiye: 'want', chahie: 'want', mangta: 'want', mangti: 'want',
    kitna: 'how much', kitne: 'how much', kitni: 'how much', daam: 'price', keemat: 'price',
    kab: 'when', aayega: 'arrive', ayega: 'arrive', aaega: 'arrive', aaeyga: 'arrive', pahunchega: 'arrive',
    mera: 'my', meri: 'my', mere: 'my', mujhe: 'i', hume: 'we', kya: 'what', kahan: 'where', kaha: 'where',
    dawai: 'medicine', dawa: 'medicine', dava: 'medicine', khana: 'food', kutta: 'dog', kutte: 'dog',
    billi: 'cat', pilla: 'puppy', haan: 'yes', han: 'yes', ha: 'yes', ji: 'yes', theek: 'okay', thik: 'okay',
    nahi: 'no', nahin: 'no', bhejo: 'send', bhej: 'send', dikhao: 'show', batao: 'tell',
    pls: 'please', plz: 'please', plse: 'please', u: 'you', ur: 'your', r: 'are', wanna: 'want to', gimme: 'give me',
    thx: 'thanks', thnx: 'thanks', thanx: 'thanks', ty: 'thanks', tq: 'thanks', thanku: 'thanks', tks: 'thanks',
    cart: 'bag', basket: 'bag', trolley: 'bag', qty: 'quantity', nos: 'pieces', pcs: 'pieces', pc: 'piece',
    rupees: 'rs', rupee: 'rs', inr: 'rs', rs: 'rs', bucks: 'rs',
    ordr: 'order', oder: 'order', odr: 'order', delievery: 'delivery', delivary: 'delivery', adress: 'address',
    whatsap: 'whatsapp', watsapp: 'whatsapp', whatapp: 'whatsapp', cancle: 'cancel', recieve: 'receive', recieved: 'received'
  };

  function normalise(text) {
    var t = String(text || '');
    try { t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* old engines */ }
    t = t.toLowerCase()
      .replace(/\u20b9/g, ' rs ')
      .replace(new RegExp('[' + DASHES + ']', 'g'), '-')
      .replace(/[\u2018\u2019\u201b]/g, "'").replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, ' ').trim();
    return t.split(' ').map(function (w) {
      var m = w.match(/^([^a-z0-9#@]*)(.*?)([^a-z0-9%]*)$/);
      return m && SYNONYMS.hasOwnProperty(m[2]) ? m[1] + SYNONYMS[m[2]] + m[3] : w;
    }).join(' ');
  }

  /** Words, without punctuation, keeping #, @, . and - inside tokens. */
  function tokens(t) {
    return String(t || '').toLowerCase().replace(/[^a-z0-9@#.\- ]+/g, ' ')
      .split(/\s+/).map(function (w) { return w.replace(/^[.\-]+|[.\-]+$/g, ''); }).filter(Boolean);
  }

  function stem(w) {
    w = String(w || '').toLowerCase();
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
    return w;
  }

  /* ============================================================== TYPOS */

  /** Edit distance with transpositions, giving up beyond `max`. */
  function distance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var d = [];
    var i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 0; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      var rowMin = Infinity;
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
        if (d[i][j] < rowMin) rowMin = d[i][j];
      }
      if (rowMin > max) return max + 1;
    }
    return d[a.length][b.length];
  }

  function allowed(len) { return len >= 8 ? 2 : len >= 4 ? 1 : 0; }

  /* Words that are right as they are, so are never "corrected". */
  var KEEP = ('with your have that this what when where will from some want need like there them they very much more less than then ' +
    'just also about after before could would should which their these those been being into only over such here make made give take ' +
    'send show tell know good best under below above between within today tomorrow week days hours time sure okay yeah fine great cool ' +
    'thank thanks placed place again same last first second third next both each every many long soon fast free cost costs paid ' +
    'pays does done dont cant wont isnt hello help please this that pack packs bags bottle bottles piece pieces kgs gram grams ' +
    'litre liter ltrs size sizes small large medium adult puppy kitten senior baby food dogs cats bird birds fish').split(' ');

  /** The shop's own vocabulary; built once from the rules and the brands. */
  function vocabulary(extra) {
    var v = {};
    (extra || []).forEach(function (w) { if (w && w.length >= 3) v[w] = true; });
    return v;
  }

  /** The message with typos fixed against the vocabulary. Only words the
   *  vocabulary does not know, of 4 letters or more, and only when exactly
   *  one known word is that close. */
  function correct(text, vocab) {
    var keep = {};
    KEEP.forEach(function (w) { keep[w] = true; });
    var words = Object.keys(vocab);
    return String(text || '').split(' ').map(function (raw) {
      var w = raw.replace(/^[^a-z]+|[^a-z]+$/g, '');
      if (w.length < 4 || !/^[a-z]+$/.test(w) || vocab[w] || keep[w] || vocab[stem(w)]) return raw;
      var max = allowed(w.length);
      var found = [], bestD = max + 1;
      for (var i = 0; i < words.length; i++) {
        var c = words[i];
        if (Math.abs(c.length - w.length) > max || c.charAt(0) !== w.charAt(0) && max < 2) continue;
        var dd = distance(w, c, max);
        if (dd > max) continue;
        if (dd < bestD) { found = [c]; bestD = dd; }
        else if (dd === bestD) found.push(c);
      }
      if (!found.length) return raw;
      /* Two equally close words that are one word and its longer form
       * ("deworm", "dewormer") are the same fix: take the longer. */
      found.sort(function (a, b) { return b.length - a.length; });
      var pick = found[0];
      var same = found.every(function (f) { return pick.indexOf(f) === 0; });
      return same ? raw.replace(w, pick) : raw;
    }).join(' ');
  }

  /* =========================================================== ENTITIES */

  /** An order number: "#1042", "order 1042", "order no. PT1042", "track 1042".
   *  A bare number counts only when the conversation asked for one. */
  function orderNo(text, expecting) {
    var t = String(text || '');
    var m = t.match(/#\s*([a-z]{0,6}\d{3,10})\b/i) ||
      t.match(/\border\s*(?:no\.?|number|id)?\s*(?:is|:)?\s*#?\s*([a-z]{0,6}\d{3,10})\b/i) ||
      t.match(/\b(?:track|tracking|status of|status for|reorder|re-order)\s+#?\s*([a-z]{0,6}\d{3,10})\b/i);
    if (m) {
      var d = m[1].replace(/\D/g, '');
      if (!(d.length >= 10 && /^[6-9]/.test(d) && !/#/.test(m[0])) && !(d.length === 6 && /pin/i.test(t))) return m[1].toUpperCase();
    }
    if (expecting) {
      var bare = t.trim().match(/^#?\s*([a-z]{0,6}\d{3,9})$/i);
      if (bare) return bare[1].toUpperCase();
    }
    return null;
  }

  function contact(text) {
    var t = String(text || '');
    var e = t.match(/[^\s@,;:<>()]+@[^\s@,;:<>()]+\.[a-z]{2,}/i);
    if (e) return e[0].toLowerCase();
    var p = t.replace(/[\s-]/g, '').match(/(?:\+?91|0)?([6-9]\d{9})(?!\d)/);
    return p ? p[1] : null;
  }

  /** A six digit Indian pincode that is not part of a phone number. */
  function pin(text) {
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
   *  "between 200 and 400", "within 2k", "for rs 500". */
  function price(text) {
    var t = normalise(text).replace(/\brs\b\.?/g, ' rs ');
    var AMT = '(?:rs\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k\\b)?';
    var out = {};
    var between = t.match(new RegExp('between\\s+' + AMT + '\\s*(?:rs)?\\s*(?:and|to|-)\\s*' + AMT)) ||
      t.match(new RegExp('rs\\s*(\\d[\\d,]*)\\s*(k\\b)?\\s*(?:-|to)\\s*(?:rs\\s*)?(\\d[\\d,]*)\\s*(k\\b)?'));
    if (between) {
      out.min = amountOf(between[1], between[2]);
      out.max = amountOf(between[3], between[4]);
      if (out.min > out.max) { var x = out.min; out.min = out.max; out.max = x; }
      return out;
    }
    var under = t.match(new RegExp('(?:under|below|less than|lesser than|within|upto|up to|max(?:imum)?|not more than|cheaper than|no more than|budget(?: of| is)?|<)\\s*' + AMT + '(?!\\s*(?:kg|g|gm|gms|ml|l|ltr|lb)\\b)'));
    if (under) out.max = amountOf(under[1], under[2]);
    var over = t.match(new RegExp('(?:above|over|more than|greater than|at least|min(?:imum)?|>)\\s*' + AMT + '(?!\\s*(?:kg|g|gm|gms|ml|l|ltr|lb)\\b)'));
    if (over) out.min = amountOf(over[1], over[2]);
    if (out.max === undefined && out.min === undefined) {
      var bare = t.match(/\brs\s*(\d[\d,]*)\s*(k\b)?/) || t.match(/(\d[\d,]*)\s*(k\b)?\s*rs\b/);
      if (bare) out.max = amountOf(bare[1], bare[2]);
    }
    return out;
  }

  var UNIT_RX = '(kg|kgs|kilo|kilos|kilogram|kilograms|g|gm|gms|gram|grams|gr|ml|mls|l|ltr|ltrs|litre|litres|liter|liters|lb|lbs)';

  /** A pack size in grams or millilitres: { amount, unit: 'g'|'ml', text }. */
  function size(text) {
    var m = String(text || '').toLowerCase().match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + UNIT_RX + '\\b'));
    if (!m) return null;
    return sizeOf(m[1], m[2], m[0]);
  }
  function sizeOf(num, unit, raw) {
    var n = Number(num);
    var u = unit.toLowerCase();
    if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(u)) return { amount: Math.round(n * 1000), unit: 'g', text: raw };
    if (/^(lb|lbs)$/.test(u)) return { amount: Math.round(n * 453.6), unit: 'g', text: raw };
    if (/^(l|ltr|ltrs|litre|litres|liter|liters)$/.test(u)) return { amount: Math.round(n * 1000), unit: 'ml', text: raw };
    if (/^(ml|mls)$/.test(u)) return { amount: Math.round(n), unit: 'ml', text: raw };
    return { amount: Math.round(n), unit: 'g', text: raw };
  }
  /** Every pack size named in a title, e.g. "340g x 4" gives 340 g. */
  function sizesIn(title) {
    var out = [];
    var rx = new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + UNIT_RX + '\\b', 'gi');
    var m;
    while ((m = rx.exec(String(title || '')))) out.push(sizeOf(m[1], m[2], m[0]));
    return out;
  }
  function sameSize(a, b) {
    return !!(a && b && a.unit === b.unit && Math.abs(a.amount - b.amount) <= Math.max(1, a.amount * 0.02));
  }

  var NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, couple: 2, pair: 2 };
  var COUNT_NOUNS = '(?:x|pieces?|packs?|packets?|bags?|bottles?|units?|tins?|cans?|boxes?|strips?|tubes?|sachets?|pouches?|jars?|nos|of (?:them|those|these|it|that|this|each))';

  /** How many: "2 bags", "x3", "qty 3", "two packs", "3 of them", or a small
   *  number right after a buying word ("add 2", "buy 3 acana"). */
  function quantity(text) {
    var t = normalise(text);
    var m;
    if ((m = t.match(/\b(?:quantity|qty)\s*(?:of|is|:|=)?\s*(\d{1,3})\b/))) return Number(m[1]);
    if ((m = t.match(/(?:^|\s)x\s*(\d{1,3})\b/)) || (m = t.match(/\b(\d{1,3})\s*x\b(?!\s*\d)/))) return Number(m[1]);
    if ((m = t.match(new RegExp('\\b(\\d{1,3})\\s*' + COUNT_NOUNS + '\\b')))) return Number(m[1]);
    var nw = Object.keys(NUMBER_WORDS).join('|');
    if ((m = t.match(new RegExp('\\b(?:a\\s+)?(' + nw + ')\\s*(?:more\\s+)?' + COUNT_NOUNS + '\\b'))) && !/\bone of\b/.test(m[0])) return NUMBER_WORDS[m[1]];
    if ((m = t.match(new RegExp('\\b(?:add|buy|order|get|send|want|need|take|purchase|make it|change (?:it )?to|set (?:it )?to|i\'ll take)\\s+(\\d{1,3}|' + nw + ')(?!\\s*(?:kg|g|gm|gms|ml|l|ltr|lb|rs|%|\\d|\\.\\d))\\b')))) {
      return /^\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
    }
    return null;
  }

  var ORDINALS = [
    [/\b(first|1st|top one|number 1|no\.? ?1|option 1)\b/, 0], [/\b(second|2nd|number 2|no\.? ?2|option 2)\b/, 1],
    [/\b(third|3rd|number 3|no\.? ?3|option 3)\b/, 2], [/\b(fourth|4th|number 4|option 4)\b/, 3],
    [/\b(fifth|5th|number 5|option 5)\b/, 4], [/\b(last one|the last|last)\b/, -1]
  ];
  /** Which of the things just shown: 0, 1, 2 ... -1 for the last, 'it' for
   *  "that one" or "it", or null. */
  function which(text) {
    var t = normalise(text);
    for (var i = 0; i < ORDINALS.length; i++) if (ORDINALS[i][0].test(t)) return ORDINALS[i][1];
    if (/\b(that one|this one|that|this|it|same one|the same)\b/.test(t)) return 'it';
    return null;
  }

  function yesNo(text) {
    var t = normalise(text).replace(/[.!]+$/, '').replace(/^(actually|um+|uh+|hmm+|oh|well|so|then|and|but|ok so|okay so),?\s+/, '');
    if (/^(yes|yeah|yep|yup|ya|yea|ok|okay|sure|confirm|confirmed|go ahead|do it|place it|place the order|place order|please do|correct|right|done|perfect|fine|okay go|go|proceed|yes please|ok please|yes confirm|that's right|thats right|sounds good)\b/.test(t)) return 'yes';
    if (/^(no|nope|nah|not now|cancel|stop|don't|dont|never mind|nevermind|wait|hold on|not yet|leave it|no thanks|no thank you)\b/.test(t)) return 'no';
    return null;
  }

  function payment(text) {
    var t = normalise(text);
    if (/\b(cod|cash on delivery|cash|pay on delivery|pay when it arrives|pay at (the )?door)\b/.test(t)) return 'cod';
    if (/\b(online|upi|card|credit card|debit card|net ?banking|gpay|google pay|phonepe|paytm|razorpay|prepaid|pay now|wallet)\b/.test(t)) return 'online';
    return null;
  }

  function speed(text) {
    var t = normalise(text);
    if (/\b(express|fastest|faster|quickest|urgent|asap|priority)\b/.test(t)) return 'express';
    if (/\b(standard|normal|regular|cheapest delivery|free delivery|slower)\b/.test(t)) return 'standard';
    return null;
  }

  var PETS = {
    dog: ['dog', 'puppy', 'pup', 'canine', 'doggy', 'doggo'],
    cat: ['cat', 'kitten', 'kitty', 'feline'],
    bird: ['bird', 'parrot', 'budgie', 'cockatiel'],
    rabbit: ['rabbit', 'bunny'],
    fish: ['fish', 'aquarium']
  };
  var YOUNG = ['puppy', 'pup', 'kitten'];

  var TOPICS = [
    { key: 'deworm', label: 'deworming', say: ['deworm', 'dewormer', 'deworming', 'worm', 'wormer'], match: ['deworm', 'worm'], care: true },
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

  function pet(ws) {
    for (var k in PETS) if (hasWord(ws, PETS[k])) return { pet: k, young: !!hasWord(ws, YOUNG) };
    return null;
  }

  function topic(ws) {
    for (var i = 0; i < TOPICS.length; i++) if (hasWord(ws, TOPICS[i].say)) return TOPICS[i];
    return null;
  }

  function key(t) { return ' ' + String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '; }

  /** A brand named in the message, typos allowed for longer names. */
  function brand(text, brands) {
    var k = key(text);
    var list = (brands || []).slice().sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < list.length; i++) if (k.indexOf(key(list[i])) >= 0) return list[i];
    var ws = k.trim().split(' ');
    for (var j = 0; j < list.length; j++) {
      var parts = key(list[j]).trim().split(' ');
      if (parts.join('').length < 5) continue;
      for (var s = 0; s + parts.length <= ws.length; s++) {
        var ok = parts.every(function (p, n) { return distance(ws[s + n], p, allowed(p.length)) <= allowed(p.length); });
        if (ok) return list[j];
      }
    }
    return null;
  }

  /* ============================================================= INTENTS */

  var RX = {
    restart: /\b(start over|start again|new chat|new conversation|reset( the)? chat|restart|clear (the )?chat)\b/,
    help: /^(help|menu|options|what can you do|what do you do|how does this work|how can you help|what can i ask|what all can you do)\b/,
    greet: /^(hi+|hello+|hey+|hai|hii+|namaste|namaskara|namaskar|good (morning|afternoon|evening)|yo|hola)\b/,
    bye: /^(bye|goodbye|good bye|see you|that'?s all|nothing else|no thanks that'?s all|thats it|that is all)\b/,
    thanks: /\b(thanks|thank you|great|awesome|perfect|cool|nice|super|wonderful)\b/,
    human: /\b(human|real person|a person|agent|executive|customer care|customer service|support team|call (me|you)|phone number|contact|whatsapp|email (you|address)|speak to|talk to|complain|complaint|manager)\b/,
    track: /\b(track|tracking|where('?s| is) my|order status|status of (my )?order|my order|my parcel|my package|awb|consignment|has (it|my order) (shipped|been shipped|dispatched)|not (yet )?(received|delivered|arrived)|didn'?t (get|receive)|haven'?t (got|received))\b/,
    cancelOrder: /\b(cancel)\b/,
    reorder: /\b(re-?order|order (it |that |this |the same |same )?again|buy (it |that |this |the same |same )?again|repeat (my |the |last )?order|same (order|as last time|as before)|order the same)\b/,
    checkout: /\b(checkout|check out|place (my|the) order|proceed( to (pay|payment|checkout))?|pay now|complete (my |the )?(order|purchase)|confirm (my )?order|finish (my |the )?order|ready to (pay|order))\b/,
    bagShow: /\b(my bag|in (my )?bag|show (me )?(my |the )?bag|view (my |the )?bag|open (my |the )?bag|what('?s| is) in|bag total|how much is my bag|my bag total|items in)\b/,
    bagRemove: /\b(remove|delete|take out|take off|drop|get rid of|don'?t want)\b/,
    bagEmpty: /\b(empty|clear|clean) (my |the )?bag\b|\bremove (everything|all)\b|\bstart (my )?bag again\b/,
    bagQty: /\b(change|update|set|make)\b.*\b(quantity|qty|it|that|them|\d+)\b|\b(one|1|two|2) more\b|\bless\b|\breduce\b|\bincrease\b/,
    buy: /\b(buy|purchase|place (an |a |my )?order|order( for| me| some| a| an| the)?|add|put|get me|send me|i'?ll take|i will take|book)\b/,
    delivery: /\b(when will|how long|how many days|delivery time|delivery date|days to deliver|deliver(y|ed)? (to|in|at)|arrive|arrival|reach me|reach by|eta|shipping time|do you (deliver|ship)|ship to|pin ?code|pincode|by when|how soon|fast delivery)\b/,
    fee: /\b(shipping (charge|cost|fee)s?|delivery (charge|cost|fee)s?|free (shipping|delivery)|charges? for (shipping|delivery)|minimum order)\b/,
    pay: /\b(cod|cash on delivery|pay(ment)?( options| methods| mode)?|upi|emi|credit card|debit card|net ?banking|gpay|phonepe|paytm)\b/,
    returns: /\b(return|refund|exchange|replace(ment)?|damaged|broken|wrong (item|product)|expired|leak(ed|ing)?)\b/,
    recommend: /\b(best|recommend|suggest|good|top|which|what should|cheap|cheapest|affordable|budget|lowest|popular|bestseller|best seller)\b/,
    ask: /\b(do you (have|sell|stock)|in stock|available|availability|price of|cost of|how much|looking for|need|want|show me|find|sizes?|details? (of|about))\b/,
    cheap: /\b(cheap|cheapest|lowest|affordable|budget|least expensive|low price|cheaper)\b/,
    info: /\b(sizes?|what size|price|how much|cost|in stock|available|availability|details?|ingredients?|tell me about|weights?)\b/
  };

  /* Words that only steer the request, taken out before searching. */
  var STOP = ('best good top recommend suggest which what is are the a an for my me i need want looking show find do you have sell any some please ' +
    'under below above over between and to rs in of price cost how much stock available buy with cheap cheapest budget affordable less than more ' +
    'within upto up max can get should it this that there your k from place order orders add put purchase send give bag into on would like could ' +
    'will ill i\'ll take book us we our one ones size sizes pack packs details tell about is am pieces piece quantity qty x lowest cheaper ' +
    'checkout again same also just only now today please kindly sir madam hi hello hey yes no ok okay pls ' +
    'them those these where when arrive talk person start track cancel reorder deliver make change set update increase reduce more less ' +
    'remove delete empty clear does come thanks thank bye sure express standard cash delivery online cod upi card pay payment them ' +
    'ka ki ke se hai do does did kindly want wanted need needed help could if tomorrow week soon').split(' ');

  /** What to search the catalogue for, once steering words are gone. */
  function searchTerms(text) {
    var stop = {};
    STOP.forEach(function (w) { stop[w] = true; });
    var t = normalise(text)
      .replace(new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + UNIT_RX + '\\b', 'g'), ' ')
      .replace(new RegExp('\\b(\\d{1,3}|' + Object.keys(NUMBER_WORDS).join('|') + ')\\s*' + COUNT_NOUNS + '\\b', 'g'), ' ')
      .replace(/(^|\s)x\s*\d{1,3}\b|\b\d{1,3}\s*x\b/g, ' ')
      .replace(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b/g, ' ');
    return tokens(t).filter(function (w) {
      return !stop[w] && !/^\d/.test(w) && w.indexOf('@') < 0 && w.indexOf('#') < 0 && w.length > 1;
    }).join(' ').trim();
  }

  /**
   * Everything in one go: { text, words, intent, entities }.
   * ctx: { pending, hasBag, brands, vocab } from the conversation.
   */
  function read(raw, ctx) {
    ctx = ctx || {};
    var n = normalise(raw);
    var fixed = ctx.vocab ? correct(n, ctx.vocab) : n;
    var ws = tokens(fixed);
    var e = {
      orderNo: orderNo(fixed, ctx.pending === 'order'),
      contact: contact(raw),
      pin: pin(raw),
      price: price(fixed),
      qty: quantity(fixed),
      size: size(fixed),
      which: which(fixed),
      yesNo: yesNo(fixed),
      payment: payment(fixed),
      speed: speed(fixed),
      pet: pet(ws),
      topic: topic(ws),
      brand: brand(fixed, ctx.brands),
      terms: searchTerms(fixed),
      cheap: RX.cheap.test(fixed)
    };
    return { raw: String(raw || ''), text: fixed, words: ws, entities: e, intent: intentOf(fixed, ws, e, ctx) };
  }

  function intentOf(t, ws, e, ctx) {
    var hasPrice = e.price.max !== undefined || e.price.min !== undefined;
    var productWords = !!(e.terms || e.topic || e.brand);
    if (!t) return 'greet';
    if (RX.restart.test(t)) return 'restart';

    /* What the conversation is waiting for comes first, unless the message
     * plainly asks for something else. */
    var p = ctx.pending;
    if ((p === 'order' || p === 'contact') && (e.orderNo || e.contact)) return 'track';
    if (p === 'reorderContact' && (e.orderNo || e.contact)) return 'reorder';
    if (p === 'confirm') {
      if (e.yesNo === 'yes' || /\b(place (the |my )?order|confirm|pay now|go ahead)\b/.test(t)) return 'confirmYes';
      if (e.yesNo === 'no') return 'confirmNo';
      if (/\b(change|different|edit|new) (the )?(address|delivery address)\b/.test(t)) return 'changeAddress';
      if (e.payment && !productWords) return 'setPayment';
      if (e.speed && !productWords) return 'setSpeed';
    }
    if (p === 'savedAddress') {
      if (e.yesNo === 'yes' || /\b(use (this|that|it)|same address|this address)\b/.test(t)) return 'useSaved';
      if (e.yesNo === 'no' || /\b(change|different|new|another)\b/.test(t)) return 'changeAddress';
    }
    if (p === 'emptyBag') {
      if (e.yesNo === 'yes') return 'emptyYes';
      if (e.yesNo === 'no') return 'emptyNo';
    }
    if (p === 'pickSize' && !RX.track.test(t) && !RX.human.test(t)) {
      if (e.size || e.which !== null || e.cheap || /\b(small|smallest|big|biggest|large|largest)\b/.test(t) || (e.qty && !e.terms)) return 'pickSize';
    }
    if (p === 'pickProduct' && (e.which !== null && e.which !== 'it' || (e.cheap && !e.terms)) && !RX.track.test(t)) return 'pickProduct';

    if (RX.help.test(t)) return 'help';
    var plain = ws.length <= 5 && !e.brand && !e.topic && !hasPrice && !e.orderNo;
    if (plain && RX.greet.test(t)) return 'greet';
    if (plain && RX.bye.test(t)) return 'bye';
    if (plain && RX.thanks.test(t) && !RX.buy.test(t)) return 'thanks';
    if (e.orderNo && RX.reorder.test(t)) return 'reorder';
    if (e.orderNo) return RX.returns.test(t) ? 'returns' : RX.cancelOrder.test(t) ? 'cancelOrder' : 'track';
    if (RX.cancelOrder.test(t) && /\border\b/.test(t)) return 'cancelOrder';
    if (RX.reorder.test(t)) return 'reorder';
    if (RX.bagEmpty.test(t)) return 'bagEmpty';
    if (RX.checkout.test(t) && !(productWords && RX.buy.test(t) && !/\b(place|complete|confirm|finish) (my|the) order\b/.test(t))) return 'checkout';
    if (RX.bagShow.test(t) && !RX.bagRemove.test(t)) return 'bagShow';
    if (ctx.hasBag && RX.bagRemove.test(t)) return 'bagRemove';
    if (ctx.hasBag && RX.bagQty.test(t) && !productWords && (e.qty || /\b(one|1|two|2) more\b|\bless\b|\breduce\b|\bincrease\b/.test(t))) return 'bagQty';
    if (RX.track.test(t) && !(hasPrice || (e.topic && RX.recommend.test(t))) && !(RX.buy.test(t) && productWords && !/\bmy order\b/.test(t))) return 'track';
    if (RX.delivery.test(t) && !hasPrice && !e.brand && !e.topic && !/\b(buy|purchase|add|place (an |a )?order for)\b/.test(t)) return 'delivery';
    if (RX.buy.test(t) && (productWords || e.which !== null)) return 'buy';
    if (RX.returns.test(t)) return 'returns';
    if (RX.fee.test(t)) return 'fee';
    if (RX.pay.test(t) && !e.topic && !e.terms.replace(/\b(cod|cash|delivery|payment|pay|upi|card|options?|methods?|mode|available|accept|do|you)\b/g, '').trim()) return 'pay';
    if (RX.delivery.test(t) && !hasPrice) return 'delivery';
    if (RX.human.test(t)) return 'human';
    if (RX.buy.test(t) && ctx.hasBag && !productWords) return 'checkout';
    if (e.yesNo && ws.length <= 4 && !e.brand && !e.topic) return ctx.hasBag && e.yesNo === 'yes' ? 'checkout' : 'yesNo';
    if (hasPrice || productWords || RX.recommend.test(t) || RX.ask.test(t)) return 'product';
    if (RX.greet.test(t) && ws.length <= 4) return 'greet';
    if (RX.bye.test(t)) return 'bye';
    if (RX.thanks.test(t) && ws.length <= 5) return 'thanks';
    if (e.yesNo === 'yes' && ctx.hasBag) return 'checkout';
    if (e.yesNo) return 'yesNo';
    return 'unknown';
  }

  /* ================================================== MATCHING PRODUCTS */

  /** How well a title answers the search words: 0 to 1, typos allowed. */
  function titleScore(terms, title) {
    var want = tokens(terms).map(stem).filter(function (w) { return w.length > 1; });
    if (!want.length) return 0;
    var have = tokens(title).map(stem);
    var hit = 0;
    want.forEach(function (w) {
      if (have.some(function (h) { return h === w || (w.length >= 3 && h.indexOf(w) === 0) || (w.length >= 4 && h.length >= 4 && distance(w, h, 1) <= 1); })) hit++;
    });
    return hit / want.length;
  }

  /** The base words every rule above listens for, for the typo fixer. */
  function baseVocabulary(brands) {
    var w = ('track tracking order orders deliver delivery delivered arrive arrival return returns refund exchange replace cancel checkout ' +
      'payment cash online shipping charges price cheapest cheap recommend suggest remove delete quantity change reorder again status parcel ' +
      'package courier pincode address person human agent whatsapp call email hello please medicine tablet syrup vaccine puppy kitten food ' +
      'treats shampoo litter toys bowl supplement vitamin deworming dewormer tick flea grooming express standard confirm available stock ' +
      'sizes bag purchase dispatch shipped received damaged broken expired wrong recommend biscuit chew kibble').split(' ');
    TOPICS.forEach(function (tp) { tp.say.forEach(function (s) { w.push(s); }); });
    Object.keys(PETS).forEach(function (k) { PETS[k].forEach(function (s) { w.push(s); }); });
    (brands || []).forEach(function (b) { key(b).trim().split(' ').forEach(function (s) { if (s.length >= 4) w.push(s); }); });
    return vocabulary(w);
  }

  return {
    normalise: normalise, tokens: tokens, stem: stem, distance: distance, correct: correct,
    orderNo: orderNo, contact: contact, pin: pin, price: price, size: size, sizesIn: sizesIn, sameSize: sameSize,
    quantity: quantity, which: which, yesNo: yesNo, payment: payment, speed: speed,
    pet: pet, topic: topic, brand: brand, searchTerms: searchTerms, titleScore: titleScore,
    read: read, baseVocabulary: baseVocabulary,
    PETS: PETS, YOUNG: YOUNG, TOPICS: TOPICS, RX: RX
  };
}));
