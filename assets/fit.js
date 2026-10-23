/* ============================================================================
 * Every product at the same size, whatever its photo looks like
 * ============================================================================
 * Store photos differ: one has a wide white margin round a small pack, the
 * next is cropped tight, one is tall, one is a cut-out on transparency. Shown
 * as they are, the same frame holds a product that fills it and one that
 * sits small in a corner.
 *
 * So each photo is measured once: a small copy is read pixel by pixel to find
 * the box the product actually takes up, ignoring the plain background round
 * it. The picture is then placed so that box is centred in its frame with its
 * longer side at the same share of the frame for every product. A photograph
 * with no plain background (edge to edge) fills its frame instead.
 *
 * If a photo cannot be read (the server refuses it to scripts, or it fails),
 * the picture is shown exactly as before. The measurements are kept for the
 * visit, so going back to a page places its pictures at once.
 * ========================================================================== */
(function (root) {
  'use strict';

  /* Where pictures are framed, and how much of the frame the product's
   * longer side takes. Small frames get a little more so the product reads. */
  var FRAMES = [
    ['.tile .shot', 0.76],
    ['.gallery .main', 0.82],
    ['.gallery .thumbs button', 0.86],
    ['.line .shot', 0.86],
    ['.suggests .shot', 0.86],
    ['.sugs .thumb', 0.86],
    ['.cprod .shot', 0.86],
    ['.oitem .shot', 0.86],
    ['.coline .shot', 0.86],
    ['.cd-top .shot', 0.86],
    ['.cb-line .shot', 0.86]
  ];
  var PROBE_WIDTH = 200;
  var REVEAL_AFTER_MS = 2500;

  /* ------------------------------------------------------------ measuring */

  /** The box the product takes up in an RGBA picture, as fractions of the
   *  picture: { x0, y0, x1, y1 }. Background is whatever the border of the
   *  picture is made of: transparency, or one plain colour. A border that is
   *  not plain means a photograph, and the whole picture counts. Null for a
   *  picture with nothing on it. */
  function measure(data, w, h) {
    if (!w || !h || !data || data.length < w * h * 4) return null;
    var ring = [];
    var x, y, i;
    for (x = 0; x < w; x++) { ring.push(x, (h - 1) * w + x); }
    for (y = 1; y < h - 1; y++) { ring.push(y * w, y * w + w - 1); }

    var clear = 0;
    var rs = [], gs = [], bs = [];
    for (i = 0; i < ring.length; i++) {
      var p = ring[i] * 4;
      if (data[p + 3] < 24) { clear++; continue; }
      rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2]);
    }
    var transparent = clear >= ring.length * 0.6;
    var bg = null;
    if (!transparent) {
      bg = [median(rs), median(gs), median(bs)];
      var plain = 0;
      for (i = 0; i < ring.length; i++) {
        var q = ring[i] * 4;
        if (data[q + 3] >= 24 && far(data, q, bg) <= 30) plain++;
      }
      if (plain < ring.length * 0.7) return { x0: 0, y0: 0, x1: 1, y1: 1, photo: true };
    }

    var cols = new Array(w), rows = new Array(h);
    for (x = 0; x < w; x++) cols[x] = 0;
    for (y = 0; y < h; y++) rows[y] = 0;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var k = (y * w + x) * 4;
        if (data[k + 3] < 24) continue;
        if (!transparent && far(data, k, bg) <= 34) continue;
        cols[x]++; rows[y]++;
      }
    }
    /* A line needs a few product pixels to count, so a speck of noise or a
     * soft shadow edge does not stretch the box. */
    var minC = Math.max(2, Math.round(h * 0.006));
    var minR = Math.max(2, Math.round(w * 0.006));
    var x0 = first(cols, minC), x1 = last(cols, minC);
    var y0 = first(rows, minR), y1 = last(rows, minR);
    if (x0 < 0 || y0 < 0) return null;
    return {
      x0: Math.max(0, x0 - 1) / w, y0: Math.max(0, y0 - 1) / h,
      x1: Math.min(w, x1 + 2) / w, y1: Math.min(h, y1 + 2) / h
    };
  }

  function far(d, i, c) {
    return Math.max(Math.abs(d[i] - c[0]), Math.abs(d[i + 1] - c[1]), Math.abs(d[i + 2] - c[2]));
  }
  function median(a) {
    if (!a.length) return 255;
    var s = a.slice().sort(function (m, n) { return m - n; });
    return s[s.length >> 1];
  }
  function first(a, min) { for (var i = 0; i < a.length; i++) if (a[i] >= min) return i; return -1; }
  function last(a, min) { for (var i = a.length - 1; i >= 0; i--) if (a[i] >= min) return i; return -1; }

  /* -------------------------------------------------------------- placing */

  /** Where to draw a picture of natural size natW x natH inside a frame whose
   *  height is `aspect` times its width, so the product box is centred and its
   *  longer side is `share` of the frame. Percentages of the frame. */
  function place(box, natW, natH, aspect, share) {
    var cw = (box.x1 - box.x0) * natW;
    var ch = (box.y1 - box.y0) * natH;
    if (!(cw > 0 && ch > 0 && natW > 0 && natH > 0 && aspect > 0)) return null;
    /* Frame width is 1, height is aspect. Scale: frame units per picture px.
     * An edge to edge photograph fills its frame instead, as a photo would. */
    var s = box.photo
      ? Math.max(1 / natW, aspect / natH)
      : Math.min(share / cw, (share * aspect) / ch);
    var drawW = natW * s, drawH = natH * s;
    var cx = (box.x0 + box.x1) / 2 * drawW;
    var cy = (box.y0 + box.y1) / 2 * drawH;
    return {
      left: (0.5 - cx) * 100,
      top: (aspect / 2 - cy) / aspect * 100,
      width: drawW * 100,
      height: drawH / aspect * 100
    };
  }

  /* ------------------------------------------------------------ in a page */

  if (!root.document) {
    if (typeof module !== 'undefined') module.exports = { measure: measure, place: place, FRAMES: FRAMES };
    return;
  }

  var doc = root.document;
  var SELECTOR = FRAMES.map(function (f) { return f[0] + ' img'; }).join(',');
  var STORE_KEY = 'pt-fit-1';
  var known = load();
  var probing = {};

  doc.documentElement.className += ' fitting';

  function keyOf(src) { return String(src || '').split('?')[0].split('#')[0]; }

  function probeUrl(src) {
    var clean = keyOf(src);
    return /[?&]width=\d+/.test(src) ? clean + '?width=' + PROBE_WIDTH : src;
  }

  function shareFor(img) {
    for (var i = 0; i < FRAMES.length; i++) {
      var frame = img.closest(FRAMES[i][0]);
      if (frame && frame === img.parentElement) {
        var share = FRAMES[i][1];
        /* Phone sized tiles: a little more room so the save heart sits clear. */
        if (i === 0 && frame.clientWidth > 0 && frame.clientWidth < 200) share = 0.70;
        return { frame: frame, share: share };
      }
    }
    return null;
  }

  function settle(img) {
    img.classList.add('fit-done');
  }

  function apply(img, m) {
    var where = shareFor(img);
    if (!where || !m) { settle(img); return; }
    var r = where.frame.getBoundingClientRect();
    var aspect = r.width > 0 && r.height > 0 ? r.height / r.width : 1;
    var at = place(m, m.w, m.h, aspect, where.share);
    if (!at) { settle(img); return; }
    img.classList.add('fit');
    img.style.left = at.left.toFixed(3) + '%';
    img.style.top = at.top.toFixed(3) + '%';
    img.style.width = at.width.toFixed(3) + '%';
    img.style.height = at.height.toFixed(3) + '%';
    sharpen(img, r.width * at.width / 100);
    settle(img);
  }

  /* A product that was small in its photo is drawn larger than the frame,
   * so ask the store for a copy wide enough to stay sharp. */
  function sharpen(img, drawnPx) {
    var src = img.getAttribute('src') || '';
    var m = src.match(/[?&]width=(\d+)/);
    if (!m || !(drawnPx > 0)) return;
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var need = Math.min(2048, Math.ceil(drawnPx * dpr / 100) * 100);
    if (need > Number(m[1]) * 1.15) img.setAttribute('src', keyOf(src) + '?width=' + need);
  }

  function probe(src) {
    var key = keyOf(src);
    if (probing[key]) return probing[key];
    probing[key] = new Promise(function (resolve) {
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.decoding = 'async';
      im.onload = function () {
        try {
          var w = im.naturalWidth, h = im.naturalHeight;
          if (!w || !h) { resolve(null); return; }
          var cw = Math.min(w, PROBE_WIDTH), ch = Math.max(1, Math.round(h * cw / w));
          var c = doc.createElement('canvas');
          c.width = cw; c.height = ch;
          var g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(im, 0, 0, cw, ch);
          var box = measure(g.getImageData(0, 0, cw, ch).data, cw, ch);
          if (!box) { resolve(null); return; }
          var m = { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, w: w, h: h };
          if (box.photo) m.photo = true;
          known[key] = m;
          save();
          resolve(m);
        } catch (e) {
          resolve(null); /* refused to scripts: show the photo as it is */
        }
      };
      im.onerror = function () { resolve(null); };
      im.src = probeUrl(src);
    });
    return probing[key];
  }

  function visit(img) {
    if (img.__fit) return;
    img.__fit = true;
    var src = img.getAttribute('src');
    if (!src) { settle(img); return; }
    var key = keyOf(src);
    if (known[key]) { apply(img, known[key]); return; }
    var timer = setTimeout(function () { settle(img); }, REVEAL_AFTER_MS);
    probe(src).then(function (m) {
      clearTimeout(timer);
      if (img.isConnected) apply(img, m);
    });
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches(SELECTOR)) visit(node);
    if (node.querySelectorAll) {
      var list = node.querySelectorAll(SELECTOR);
      for (var i = 0; i < list.length; i++) visit(list[i]);
    }
  }

  /* Placing a picture depends on its frame's shape, which can change when a
   * phone turns or the window is resized from one layout to another. */
  var resizeTimer = null;
  root.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var list = doc.querySelectorAll(SELECTOR);
      for (var i = 0; i < list.length; i++) {
        var m = known[keyOf(list[i].getAttribute('src'))];
        if (m) apply(list[i], m);
      }
    }, 150);
  });

  new MutationObserver(function (changes) {
    for (var i = 0; i < changes.length; i++) {
      var added = changes[i].addedNodes;
      for (var j = 0; j < added.length; j++) scan(added[j]);
    }
  }).observe(doc.documentElement, { childList: true, subtree: true });
  scan(doc.body);

  function load() {
    try { return JSON.parse(root.sessionStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var keys = Object.keys(known);
        if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(function (k) { delete known[k]; });
        root.sessionStorage.setItem(STORE_KEY, JSON.stringify(known));
      } catch (e) { /* storage full or blocked: measuring again is fine */ }
    }, 400);
  }

  root.PTFit = { measure: measure, place: place, known: known, keyOf: keyOf, FRAMES: FRAMES };
}(typeof window !== 'undefined' ? window : globalThis));
