// Local renderer for the TradingView server-gated chart styles.
//
// Volume footprint (17), Time price opportunity (18) and Session volume profile
// (20) are computed on TradingView's servers and the free feed refuses them:
//   study_not_auth:Footprint@tv-volumebyprice-192
//   study_limit_exceeded            (TPO / SVP)
// The chart still has all OHLCV bars, so this module draws an approximate
// version of each style on an overlay canvas above the chart, using the real
// bar data and the chart's own time/price coordinate systems.
//
// It also silences the three server study bindings so the failed studies (and
// their red error icons) never appear.
(function () {
  'use strict';
  if (window.__tvStyleOverlay) return;
  window.__tvStyleOverlay = true;
  window.__tvOverlayBuild = 'native-barset';
  // If the script is ever injected more than once (hot-reload during
  // development), a newer instance supersedes older ones so only one loop and
  // one canvas remain.
  var MYGEN = (window.__tvOverlayGen = (window.__tvOverlayGen || 0) + 1);
  function alive() { return MYGEN === window.__tvOverlayGen; }
  // Drop any canvases left behind by an earlier instance.
  var stale = document.querySelectorAll('canvas.tv-style-overlay');
  for (var si = 0; si < stale.length; si++) stale[si].remove();

  // Bar-set styles: 4 Renko, 5 Kagi, 6 Point & figure, 7 Line break.
  // They live in `tv-prostudies` and are refused by the free feed on intraday
  // ("study_not_auth:BarSetRenko@tv-prostudies-78"), after which the chart
  // silently falls back to Daily. They are rebuilt here from the real intraday
  // bars instead.
  var STYLE_KIND = {
    17: 'footprint',
    18: 'tpo',
    20: 'svp',
  };
  // Bar-set styles are rendered by the app itself (native study). They are
  // deliberately NOT handled here: the local canvas approximation looked wrong
  // and hid the working native path. Empty map = no interception.
  var BARSET_KIND = {};
  var BARSET_STYLE = { renko: 4, kagi: 5, pnf: 6, linbreak: 7 };
  var BUY = '38,166,154';       // teal
  var SELL = '239,83,80';       // red
  var TPO_A = '41,98,255';      // blue
  var TPO_B = '255,152,0';      // orange
  var SVP = '41,98,255';
  var POC = '255,152,0';

  var host = null;
  var canvas = null;
  var ctx = null;
  var lastSig = '';
  var lastDraw = 0;
  var lastStyle = null;
  var rafQueued = false;
  var spacingFor = null;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function widget() {
    try {
      var c = window._exposed_chartWidgetCollection;
      if (!c || typeof c.activeWidget !== 'function') return null;
      return c.activeWidget().value();
    } catch (e) { return null; }
  }
  function model() {
    var w = widget();
    try { return w ? w.model() : null; } catch (e) { return null; }
  }
  function series() {
    var m = model();
    try { return m ? m.mainSeries() : null; } catch (e) { return null; }
  }
  function timeScale() {
    var m = model();
    try { return m ? m.timeScale() : null; } catch (e) { return null; }
  }

  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

  function ensureCanvas() {
    var w = document.querySelector('.chart-gui-wrapper');
    if (!w) return false;
    if (host !== w || !canvas || !canvas.isConnected) {
      host = w;
      canvas = document.createElement('canvas');
      canvas.className = 'tv-style-overlay';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText =
        'position:absolute;left:0;top:0;pointer-events:none;z-index:5;';
      // Sit above the two chart canvases, below the legend (z6) and controls.
      var anchor = w.children[2] ? w.children[2].nextSibling : null;
      w.insertBefore(canvas, anchor);
      ctx = canvas.getContext('2d');
    }
    var ratio = dpr();
    var cw = host.clientWidth;
    var ch = host.clientHeight;
    var W = Math.max(1, Math.round(cw * ratio));
    var H = Math.max(1, Math.round(ch * ratio));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return true;
  }

  // TPO / Footprint / SVP are drawn locally, so stop the real study bindings
  // from asking the server (they only produce an access error).
  function silenceNativeStudies(s) {
    try {
      var b = s._studyBindings;
      if (!b || !b._bindings) return;
      for (var i = 0; i < b._bindings.length; i++) {
        var bind = b._bindings[i];
        var rs;
        try { rs = bind.requiredStyle(); } catch (e) { continue; }
        // Only silence styles that are drawn here instead of by the server.
        var local = rs === 17 || rs === 18 || rs === 20 ||
          (BARSET_KIND[rs] && window.__tvBarSet === rs);
        if (local) {
          if (!bind.__tvLocalOverlay) {
            bind.__tvLocalOverlay = true;
            bind.syncStudy = function () { return Promise.resolve(); };
            try { if (bind._destroyStudy) bind._destroyStudy(); } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // Bar-set styles (Renko / Kagi / Point & figure / Line break)
  // ---------------------------------------------------------------------

  // The model reports minutes as a bare number ('1', '5', '60', '240'), daily
  // and above as 'D' / 'W' / 'M', and range bars as '<n>R'.
  function isIntradayInterval(iv) {
    if (iv == null) return false;
    return /^\d+$/.test(String(iv));
  }

  function cfgFor(s) {
    var out = {};
    try {
      var p = s.properties().childs();
      var kind = STYLE_KIND[s.style()];
      var key = kind === 'renko' ? 'renkoStyle'
        : kind === 'kagi' ? 'kagiStyle'
        : kind === 'pnf' ? 'pnfStyle'
        : kind === 'linbreak' ? 'pbStyle' : null;
      if (!key) return out;
      var inp = p[key].childs().inputs.childs();
      for (var k in inp) {
        if (k.charAt(0) === '_') continue;
        try { out[k] = inp[k].value(); } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  function rememberBarSet(style) {
    try {
      if (style) localStorage.setItem('tvBarSetStyle', String(style));
      else localStorage.removeItem('tvBarSetStyle');
    } catch (e) {}
  }
  function savedBarSet() {
    var v = 0;
    try { v = parseInt(localStorage.getItem('tvBarSetStyle'), 10); } catch (e) {}
    return BARSET_KIND[v] ? v : 0;
  }

  // Remap the requested bar-set style to plain candles *before* the model asks
  // the server, remember what the user actually picked, and report it back to
  // the chart UI so the toolbar/legend still show Renko, Kagi, ...
  function patchStyleSwitch() {
    var m = model();
    if (!m || m.__tvBarSetPatched) return;
    var s;
    try { s = m.mainSeries(); } catch (e) { return; }
    if (!s || typeof s.setSymbolParams !== 'function') return;
    m.__tvBarSetPatched = true;

    function wantBarset(style, interval) {
      return !!BARSET_KIND[style] && isIntradayInterval(interval);
    }

    var origStyle = m.setChartStyle.bind(m);
    m.setChartStyle = function (style, tag) {
      try {
        if (wantBarset(style, s.interval())) {
          window.__tvBarSet = style;
          rememberBarSet(style);
          return origStyle(1, tag);
        }
        if (style != null) {
          window.__tvBarSet = null;
          rememberBarSet(0);
        }
      } catch (e) {}
      return origStyle(style, tag);
    };

    var origProps = m.setChartStyleProperty.bind(m);
    m.setChartStyleProperty = function (prop, style, tag) {
      try {
        if (wantBarset(style, s.interval())) {
          window.__tvBarSet = style;
          rememberBarSet(style);
          style = 1;
        }
      } catch (e) {}
      return origProps(prop, style, tag);
    };

    // Layout restore and interval changes go through setSymbolParams.
    var origParams = s.setSymbolParams.bind(s);
    s.setSymbolParams = function (params) {
      try {
        if (params && wantBarset(params.style, params.interval || s.interval())) {
          window.__tvBarSet = params.style;
          rememberBarSet(params.style);
          var copy = {};
          for (var k in params) copy[k] = params[k];
          copy.style = 1;
          return origParams(copy);
        }
      } catch (e) {}
      return origParams(params);
    };

    // The layout only stores the real (candle) style, so re-apply the bar set
    // the user was last looking at once the chart has loaded.
    var tries = 0;
    (function reapply() {
      tries++;
      var v = savedBarSet();
      if (!v) return;
      try {
        if (!window.__tvBarSet && isIntradayInterval(s.interval()) && s.bars().size() > 0) {
          m.setChartStyle(v);
          return;
        }
      } catch (e) {}
      if (tries < 6) setTimeout(reapply, 900);
    })();

    // Only the real style is stored; advertise the picked bar set to the UI.
    s.__tvOrigStyle = s.style.bind(s);
    s.style = function () {
      return window.__tvBarSet || s.__tvOrigStyle();
    };
  }

  // The native candle series must not paint over the local bar set, but the
  // price scale and time scale have to stay alive, so hide it rather than
  // detach it. Always restore it before the page can be saved/unloaded.
  var nativeHidden = null;
  var nextFit = false;
  var wasBarSet = false;
  var lastRangeKey = '';
  function setNativeVisible(s, hide) {
    if (nativeHidden === hide) return;
    try {
      var p = s.properties().childs().visible;
      if (p.value() !== !hide) p.setValue(!hide);
      nativeHidden = hide;
    } catch (e) {}
  }
  function restoreNative() {
    var s = series();
    if (!s) return;
    try {
      var p = s.properties().childs().visible;
      if (p.value() !== true) p.setValue(true);
    } catch (e) {}
    nativeHidden = false;
  }
  window.addEventListener('pagehide', restoreNative);
  window.addEventListener('beforeunload', restoreNative);

  function allBars(s) {
    var bars = s.bars();
    var n = bars.size();
    var out = [];
    var from = Math.max(0, n - 1500);
    for (var i = from; i < n; i++) {
      var row = bars.valueAt(i);
      if (!row) continue;
      var v = row.value !== undefined ? row.value : row;
      if (!v || !(v[0] > 0)) continue;
      out.push({ i: i, t: v[0], o: v[1], h: v[2], l: v[3], c: v[4], v: v[5] || 0 });
    }
    return out;
  }

  function atrOf(list, len) {
    var n = Math.min(len || 14, list.length - 1);
    if (n <= 0) return list.length ? list[0].h - list[0].l : 0;
    var sum = 0;
    for (var k = list.length - n; k < list.length; k++) {
      var b = list[k], p = list[k - 1];
      if (!p) continue;
      sum += Math.max(
        b.h - b.l,
        Math.abs(b.h - p.c),
        Math.abs(b.l - p.c)
      );
    }
    return sum / n;
  }

  function pitchFor(count) {
    var w = host ? host.clientWidth : 600;
    var usable = Math.max(120, w - 24);
    // Fill the pane like a real bar-set chart instead of leaving a time-axis
    // gap: the pitch is derived from how many bars/columns exist.
    var p = usable / Math.max(1, count);
    return Math.max(3, Math.min(p, 56));
  }

  function rightEdge() {
    return (host ? host.clientWidth : 600) - 10;
  }

  function rightAnchor(s, ts) {
    var n = s.bars().size();
    var w = host ? host.clientWidth : 600;
    var x = NaN;
    try { x = ts.indexToCoordinate(n - 1); } catch (e) {}
    if (!isFinite(x) || x <= 0) x = w - 14;
    return Math.min(x, w - 4);
  }

  // Bar sets have their own price extent. If the pane kept a much wider range
  // (e.g. from a previous Daily fallback) the drawing looks squeezed, so refit
  // only when the current range is clearly wrong. User-scaled ranges that are
  // merely a bit looser are left alone.
  function fitRange(ps, lo, hi) {
    if (!(hi > lo) || !isFinite(lo) || !isFinite(hi)) return;
    var pad = (hi - lo) * 0.08;
    var from = lo - pad;
    var to = hi + pad;
    var need = to - from;
    try {
      if (nextFit) {
        nextFit = false;
        ps.setPriceRangeInPrice({ from: from, to: to });
        return;
      }
      var cur = ps.priceRangeInPrice ? ps.priceRangeInPrice() : null;
      if (cur && isFinite(cur.from) && isFinite(cur.to)) {
        var span = cur.to - cur.from;
        // Accept the current scale only when it is roughly the size of the bar
        // set. Anything far too wide (Daily fallback left-overs) or far too
        // narrow (a previous zoomed-in view) is refitted.
        if (span > 0 && span <= need * 1.8 && span >= need / 1.8 &&
            cur.from < to && cur.to > from) return;
      }
      ps.setPriceRangeInPrice({ from: from, to: to });
    } catch (e) {}
  }

  // --- Renko ------------------------------------------------------------
  function renkoBricks(list, box) {
    var out = [];
    if (!(box > 0) || !list.length) return out;
    var hi = list[0].c, lo = list[0].c;
    for (var k = 1; k < list.length; k++) {
      var c = list[k].c;
      var guard = 0;
      while (c >= hi + box && guard++ < 5000) {
        out.push({ from: hi, to: hi + box, dir: 1 });
        hi += box;
        lo = hi - box;
      }
      guard = 0;
      while (c <= lo - box && guard++ < 5000) {
        out.push({ from: lo, to: lo - box, dir: -1 });
        lo -= box;
        hi = lo + box;
      }
    }
    return out;
  }

  function drawRenko(s, ts) {
    var list = allBars(s);
    if (list.length < 3) return;
    var cfg = cfgFor(s);
    var a = atrOf(list, cfg.atrLength || 14);
    var box = (cfg.boxSize > 0 ? cfg.boxSize : 1) * (a > 0 ? a : (list[list.length - 1].c * 0.001));
    if (!(box > 0)) return;
    var bricks = renkoBricks(list, box);
    if (!bricks.length) return;

    var ps = s.priceScale();
    var pitch = pitchFor(bricks.length);
    var right = rightEdge();
    var maxN = Math.ceil((right + pitch) / pitch) + 1;
    var start = Math.max(0, bricks.length - maxN);
    ctx.lineWidth = 0.5;

    var loP = Infinity, hiP = -Infinity;
    for (var k = start; k < bricks.length; k++) {
      var br = bricks[k];
      if (br.from < loP) loP = br.from;
      if (br.from > hiP) hiP = br.from;
      if (br.to < loP) loP = br.to;
      if (br.to > hiP) hiP = br.to;
      var x = right - (bricks.length - 1 - k) * pitch;
      var yA = ps.priceToCoordinate(br.from);
      var yB = ps.priceToCoordinate(br.to);
      if (!isFinite(yA) || !isFinite(yB)) continue;
      var top = Math.min(yA, yB);
      var h = Math.max(1, Math.abs(yB - yA) - 1);
      var w = Math.max(1, pitch - 1);
      ctx.fillStyle = br.dir > 0 ? 'rgba(' + BUY + ',0.95)' : 'rgba(' + SELL + ',0.95)';
      ctx.fillRect(x - w / 2, top + 0.5, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeRect(x - w / 2, top + 0.5, w, h);
    }
    fitRange(ps, loP, hiP);
  }

  // --- Kagi -------------------------------------------------------------
  function kagiPoints(list, rev) {
    if (!list.length) return [];
    var pts = [{ i: list[0].i, p: list[0].c }];
    var dir = 0, ext = list[0].c, extI = list[0].i;
    for (var k = 1; k < list.length; k++) {
      var b = list[k], p = b.c;
      if (dir === 0) {
        if (p >= ext + rev) { dir = 1; pts.push({ i: extI, p: ext }); ext = p; extI = b.i; }
        else if (p <= ext - rev) { dir = -1; pts.push({ i: extI, p: ext }); ext = p; extI = b.i; }
        else { ext = p; extI = b.i; }
      } else if (dir === 1) {
        if (p > ext) { ext = p; extI = b.i; }
        else if (p <= ext - rev) { dir = -1; pts.push({ i: extI, p: ext }); ext = p; extI = b.i; }
      } else {
        if (p < ext) { ext = p; extI = b.i; }
        else if (p >= ext + rev) { dir = 1; pts.push({ i: extI, p: ext }); ext = p; extI = b.i; }
      }
    }
    pts.push({ i: extI, p: ext });
    return pts;
  }

  function drawKagi(s, ts) {
    var list = allBars(s);
    if (list.length < 3) return;
    var cfg = cfgFor(s);
    var a = atrOf(list, cfg.atrLength || 14);
    var rev = (cfg.reversalAmount > 0 ? cfg.reversalAmount : 1) * (a > 0 ? a : (list[list.length - 1].c * 0.001));
    if (!(rev > 0)) return;
    var pts = kagiPoints(list, rev);
    if (pts.length < 2) return;

    var ps = s.priceScale();
    var pitch = pitchFor(pts.length);
    var right = rightEdge();
    var maxN = Math.ceil((right + pitch) / pitch) + 1;
    var start = Math.max(0, pts.length - maxN);

    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var loP = Infinity, hiP = -Infinity;
    for (var k = start + 1; k < pts.length; k++) {
      var a2 = pts[k - 1], b2 = pts[k];
      if (a2.p < loP) loP = a2.p;
      if (a2.p > hiP) hiP = a2.p;
      if (b2.p < loP) loP = b2.p;
      if (b2.p > hiP) hiP = b2.p;
      var xa = right - (pts.length - 1 - (k - 1)) * pitch;
      var xb = right - (pts.length - 1 - k) * pitch;
      var ya = ps.priceToCoordinate(a2.p);
      var yb = ps.priceToCoordinate(b2.p);
      if (!isFinite(ya) || !isFinite(yb)) continue;
      // Kagi = horizontal run plus the vertical jump at the turn.
      ctx.strokeStyle = b2.p > a2.p ? 'rgba(' + BUY + ',0.95)' : 'rgba(' + SELL + ',0.95)';
      ctx.beginPath();
      ctx.moveTo(xa, ya);
      ctx.lineTo(xb, ya);
      ctx.lineTo(xb, yb);
      ctx.stroke();
    }
    fitRange(ps, loP, hiP);
  }

  // --- Line break -------------------------------------------------------
  function lineBreakLines(list, n) {
    var out = [];
    n = Math.max(1, Math.floor(n) || 3);
    for (var k = n; k < list.length; k++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = k - n; j < k; j++) {
        if (list[j].h > hi) hi = list[j].h;
        if (list[j].l < lo) lo = list[j].l;
      }
      var c = list[k].c;
      var dir = c > hi ? 1 : c < lo ? -1 : 0;
      if (!dir) continue;
      var prev = out.length ? out[out.length - 1] : null;
      if (prev) {
        if (dir === prev.dir) {
          if (dir === 1 && c <= prev.c) continue;
          if (dir === -1 && c >= prev.c) continue;
        } else {
          if (prev.dir === 1 && c > prev.l) continue;
          if (prev.dir === -1 && c < prev.h) continue;
        }
      }
      var open = prev ? prev.c : list[k].o;
      out.push({
        i: list[k].i,
        o: open,
        c: c,
        h: Math.max(open, c),
        l: Math.min(open, c),
        dir: dir,
      });
    }
    return out;
  }

  function drawLineBreak(s, ts) {
    var list = allBars(s);
    if (list.length < 4) return;
    var cfg = cfgFor(s);
    var lines = lineBreakLines(list, cfg.lb || 3);
    if (!lines.length) return;

    var ps = s.priceScale();
    var pitch = pitchFor(lines.length);
    var right = rightEdge();
    var maxN = Math.ceil((right + pitch) / pitch) + 1;
    var start = Math.max(0, lines.length - maxN);
    var w = Math.max(1, pitch - 1);

    var loP = Infinity, hiP = -Infinity;
    for (var k = start; k < lines.length; k++) {
      var ln = lines[k];
      if (ln.l < loP) loP = ln.l;
      if (ln.h > hiP) hiP = ln.h;
      var x = right - (lines.length - 1 - k) * pitch;
      var yO = ps.priceToCoordinate(ln.o);
      var yC = ps.priceToCoordinate(ln.c);
      var yH = ps.priceToCoordinate(ln.h);
      var yL = ps.priceToCoordinate(ln.l);
      if (!isFinite(yO) || !isFinite(yC)) continue;
      var col = ln.dir > 0 ? BUY : SELL;
      // Wick (the line's full break extent).
      ctx.strokeStyle = 'rgba(' + col + ',0.95)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yH);
      ctx.lineTo(x, yL);
      ctx.stroke();
      // Body.
      var top = Math.min(yO, yC);
      var h = Math.max(1, Math.abs(yC - yO));
      ctx.fillStyle = 'rgba(' + col + ',0.95)';
      ctx.fillRect(x - w / 2, top, w, h);
    }
    fitRange(ps, loP, hiP);
  }

  // --- Point & figure ---------------------------------------------------
  function pnfColumns(list, box, rev) {
    var cols = [];
    if (!(box > 0) || !list.length) return cols;
    var dir = 0, ref = list[0].c, hi = ref, lo = ref, cur = null;
    for (var k = 0; k < list.length; k++) {
      var p = list[k].c;
      var guard = 0;
      while (guard++ < 5000) {
        if (dir === 0) {
          if (p >= ref + box) {
            dir = 1; cur = { dir: 1, from: ref, to: ref + box };
            cols.push(cur); hi = cur.to; lo = cur.from; ref = hi;
          } else if (p <= ref - box) {
            dir = -1; cur = { dir: -1, from: ref, to: ref - box };
            cols.push(cur); hi = cur.from; lo = cur.to; ref = lo;
          } else break;
        } else if (dir === 1) {
          if (p >= hi + box) { hi += box; cur.to = hi; ref = hi; }
          else if (p <= hi - rev * box) {
            dir = -1; cur = { dir: -1, from: hi, to: hi - box };
            cols.push(cur); lo = cur.to; hi = cur.from; ref = lo;
          } else break;
        } else {
          if (p <= lo - box) { lo -= box; cur.to = lo; ref = lo; }
          else if (p >= lo + rev * box) {
            dir = 1; cur = { dir: 1, from: lo, to: lo + box };
            cols.push(cur); hi = cur.to; lo = cur.from; ref = hi;
          } else break;
        }
      }
    }
    return cols;
  }

  function drawPnf(s, ts) {
    var list = allBars(s);
    if (list.length < 3) return;
    var cfg = cfgFor(s);
    var a = atrOf(list, cfg.atrLength || 14);
    var box = (cfg.boxSize > 0 ? cfg.boxSize : 1) * (a > 0 ? a : (list[list.length - 1].c * 0.001));
    var rev = cfg.reversalAmount > 0 ? Math.floor(cfg.reversalAmount) : 3;
    if (!(box > 0)) return;
    var cols = pnfColumns(list, box, rev);
    if (!cols.length) return;

    var ps = s.priceScale();
    var pitch = pitchFor(cols.length);
    var right = rightEdge();
    var maxN = Math.ceil((right + pitch) / pitch) + 1;
    var start = Math.max(0, cols.length - maxN);
    var r = Math.max(1.2, Math.min(pitch * 0.30, 4.2));

    ctx.lineWidth = 1.1;
    var loP = Infinity, hiP = -Infinity;
    for (var k = start; k < cols.length; k++) {
      var col = cols[k];
      if (col.from < loP) loP = col.from;
      if (col.to < loP) loP = col.to;
      if (col.from > hiP) hiP = col.from;
      if (col.to > hiP) hiP = col.to;
      var x = right - (cols.length - 1 - k) * pitch;
      var lo = Math.min(col.from, col.to);
      var hi = Math.max(col.from, col.to);
      for (var lv = lo; lv <= hi + 1e-9; lv += box) {
        var y = ps.priceToCoordinate(lv);
        if (!isFinite(y)) continue;
        if (col.dir > 0) {
          ctx.strokeStyle = 'rgba(' + BUY + ',0.95)';
          ctx.beginPath();
          ctx.moveTo(x - r, y - r);
          ctx.lineTo(x + r, y + r);
          ctx.moveTo(x + r, y - r);
          ctx.lineTo(x - r, y + r);
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(' + SELL + ',0.95)';
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    fitRange(ps, loP, hiP);
  }

  function visibleBars(s, ts) {
    var bars = s.bars();
    var n = bars.size();
    if (!n) return [];
    var r = null;
    try { r = ts.visibleBarsStrictRange(); } catch (e) {}
    var i0 = r ? r.firstBar() : 0;
    var i1 = r ? r.lastBar() : n - 1;
    i0 = Math.max(0, i0 - 1);
    i1 = Math.min(n - 1, i1 + 1);
    var out = [];
    for (var i = i0; i <= i1; i++) {
      var row = bars.valueAt(i);
      if (!row) continue;
      // valueAt() returns the raw [time,o,h,l,c,v] array, while last()/first()
      // return { index, value }. Accept either shape.
      var v = row.value !== undefined ? row.value : row;
      if (!v || !(v[0] > 0)) continue;
      out.push({
        i: i,
        t: v[0], o: v[1], h: v[2], l: v[3], c: v[4],
        v: v[5] || 0,
      });
    }
    return out;
  }

  function fmt(v) {
    if (!isFinite(v)) return '';
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return Math.round(v / 1e3) + 'K';
    if (a >= 10) return String(Math.round(v));
    return v.toFixed(1);
  }

  function drawFootprint(s, ts) {
    var ps = s.priceScale();
    var sp = ts.barSpacing();
    var list = visibleBars(s, ts);
    var width = Math.max(1.5, Math.min(sp * 0.86, 64));
    var half = width / 2;
    var showNums = width >= 26;

    for (var k = 0; k < list.length; k++) {
      var b = list[k];
      if (!(b.h > b.l) || !(b.v > 0)) continue;
      var xc = ts.indexToCoordinate(b.i);
      var left = xc - half;
      var yH = ps.priceToCoordinate(b.h);
      var yL = ps.priceToCoordinate(b.l);
      if (!isFinite(yH) || !isFinite(yL) || yL <= yH) continue;

      var rows = clamp(Math.round((yL - yH) / 13), 3, 40);
      var step = (b.h - b.l) / rows;
      var uCenter = clamp((b.h + b.l + b.c) / 3 - b.l, 0, b.h - b.l) / (b.h - b.l);
      var weights = [];
      var sum = 0;
      for (var r = 0; r < rows; r++) {
        var u = (r + 0.5) / rows;
        var wt = Math.max(0.06, 1 - 1.25 * Math.abs(u - uCenter));
        weights.push(wt);
        sum += wt;
      }
      var buyFrac = clamp(0.5 + 0.5 * ((b.c - b.o) / (b.h - b.l || 1)), 0.12, 0.88);
      var maxRow = 0;
      var rowVols = [];
      for (var r2 = 0; r2 < rows; r2++) {
        var rv = b.v * weights[r2] / sum;
        rowVols.push(rv);
        if (rv > maxRow) maxRow = rv;
      }
      maxRow = maxRow || 1;

      var poc = 0;
      for (var r3 = 1; r3 < rows; r3++) if (rowVols[r3] > rowVols[poc]) poc = r3;

      for (var r4 = 0; r4 < rows; r4++) {
        var yTop = ps.priceToCoordinate(b.h - (r4 + 1) * step);
        var yBot = ps.priceToCoordinate(b.h - r4 * step);
        var hgt = Math.max(1, yBot - yTop - 0.6);
        var sellVol = rowVols[r4] * (1 - buyFrac);
        var buyVol = rowVols[r4] * buyFrac;
        var as = 0.07 + 0.55 * Math.sqrt(sellVol / maxRow);
        var ab = 0.07 + 0.55 * Math.sqrt(buyVol / maxRow);
        ctx.fillStyle = 'rgba(' + SELL + ',' + as.toFixed(3) + ')';
        ctx.fillRect(left, yTop + 0.3, Math.max(0.5, half - 0.4), hgt);
        ctx.fillStyle = 'rgba(' + BUY + ',' + ab.toFixed(3) + ')';
        ctx.fillRect(left + half + 0.2, yTop + 0.3, Math.max(0.5, half - 0.4), hgt);
        if (showNums) {
          ctx.font = '7px -apple-system,Segoe UI,Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(0,0,0,0.58)';
          var my = yTop + hgt / 2;
          ctx.fillText(fmt(sellVol), left + half / 2, my);
          ctx.fillText(fmt(buyVol), left + half + half / 2, my);
        }
      }

      // POC line inside the bar.
      if (rowVols[poc] > 0) {
        var py = ps.priceToCoordinate(b.h - (poc + 0.5) * step);
        ctx.fillStyle = 'rgba(' + POC + ',0.9)';
        ctx.fillRect(left, py, width, 1);
      }
      // Subtle frame.
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(left, yH, width, yL - yH);
    }
  }

  function drawTpo(s, ts) {
    var ps = s.priceScale();
    var sp = ts.barSpacing();
    var list = visibleBars(s, ts);
    var width = Math.max(1.5, Math.min(sp * 0.86, 64));
    var showLetters = width >= 12;
    var counters = {};

    for (var k = 0; k < list.length; k++) {
      var b = list[k];
      if (!(b.h > b.l)) continue;
      var xc = ts.indexToCoordinate(b.i);
      var left = xc - width / 2;
      var yH = ps.priceToCoordinate(b.h);
      var yL = ps.priceToCoordinate(b.l);
      if (!isFinite(yH) || !isFinite(yL) || yL <= yH) continue;

      var session = Math.floor(b.t / 86400);
      if (counters[session] == null) counters[session] = 0;
      var letter = String.fromCharCode(65 + (counters[session] % 26));
      counters[session]++;

      var col = session % 2 === 0 ? TPO_A : TPO_B;
      var rows = clamp(Math.round((yL - yH) / 13), 1, 40);
      var step = (b.h - b.l) / rows;

      ctx.font = Math.min(11, Math.max(7, width * 0.72)) + 'px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (var r = 0; r < rows; r++) {
        var yTop = ps.priceToCoordinate(b.h - (r + 1) * step);
        var yBot = ps.priceToCoordinate(b.h - r * step);
        var hgt = Math.max(1, yBot - yTop - 0.6);
        ctx.fillStyle = 'rgba(' + col + ',0.18)';
        ctx.fillRect(left, yTop + 0.3, width, hgt);
        if (showLetters) {
          ctx.fillStyle = 'rgba(' + col + ',0.88)';
          ctx.fillText(letter, xc, yTop + hgt / 2);
        }
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(left, yH, width, yL - yH);
    }
  }

  function drawSvp(s, ts) {
    var ps = s.priceScale();
    var list = visibleBars(s, ts);
    if (!list.length) return;

    var groups = {};
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var key = Math.floor(b.t / 86400);
      (groups[key] || (groups[key] = [])).push(b);
    }

    var maxWidth = Math.min(150, Math.max(40, host.clientWidth * 0.2));
    var keys = Object.keys(groups);
    for (var g = 0; g < keys.length; g++) {
      var bars = groups[keys[g]];
      var lo = Infinity;
      var hi = -Infinity;
      for (var j = 0; j < bars.length; j++) {
        if (bars[j].l < lo) lo = bars[j].l;
        if (bars[j].h > hi) hi = bars[j].h;
      }
      if (!(hi > lo)) continue;
      var yH = ps.priceToCoordinate(hi);
      var yL = ps.priceToCoordinate(lo);
      if (!isFinite(yH) || !isFinite(yL) || yL <= yH) continue;

      var rows = clamp(Math.round((yL - yH) / 13), 8, 80);
      var step = (hi - lo) / rows;
      var vol = new Array(rows);
      for (var z = 0; z < rows; z++) vol[z] = 0;

      for (var j2 = 0; j2 < bars.length; j2++) {
        var b2 = bars[j2];
        if (!(b2.h > b2.l) || !(b2.v > 0)) continue;
        var r0 = clamp(Math.floor((b2.l - lo) / step), 0, rows - 1);
        var r1 = clamp(Math.floor((b2.h - lo) / step), 0, rows - 1);
        var span = r1 - r0 + 1;
        for (var rr = r0; rr <= r1; rr++) vol[rr] += b2.v / span;
      }

      var maxV = 0;
      var poc = 0;
      for (var z2 = 0; z2 < rows; z2++) {
        if (vol[z2] > maxV) { maxV = vol[z2]; poc = z2; }
      }
      if (!(maxV > 0)) continue;

      var anchorX = ts.indexToCoordinate(bars[bars.length - 1].i) + ts.barSpacing() * 0.55;
      anchorX = Math.min(anchorX, host.clientWidth - 3);
      if (anchorX < 20) continue;

      for (var z3 = 0; z3 < rows; z3++) {
        var w = (vol[z3] / maxV) * maxWidth;
        if (w < 0.6) continue;
        var yTop = ps.priceToCoordinate(hi - (z3 + 1) * step);
        var yBot = ps.priceToCoordinate(hi - z3 * step);
        var hgt = Math.max(1, yBot - yTop - 0.6);
        ctx.fillStyle = 'rgba(' + (z3 === poc ? POC : SVP) + ',' + (z3 === poc ? 0.55 : 0.26) + ')';
        ctx.fillRect(anchorX - w, yTop + 0.3, w, hgt);
      }

      // POC guide.
      var py = ps.priceToCoordinate(hi - (poc + 0.5) * step);
      ctx.fillStyle = 'rgba(' + POC + ',0.85)';
      ctx.fillRect(anchorX - maxWidth, py, maxWidth, 1);
    }
  }

  function signature(s, ts) {
    var r = null;
    try { r = ts.visibleBarsStrictRange(); } catch (e) {}
    var bars = s.bars();
    var n = bars.size();
    var last = n ? bars.last() : null;
    return [
      s.style(),
      window.__tvBarSet || 0,
      ts.barSpacing().toFixed(2),
      r ? r.firstBar() : 0,
      r ? r.lastBar() : 0,
      last && last.value ? last.value[0] : 0,
      last && last.value ? last.value[4] : 0,
      host ? host.clientWidth : 0,
      host ? host.clientHeight : 0,
    ].join('|');
  }

  function clearOverlay() {
    if (ctx && host) ctx.clearRect(0, 0, host.clientWidth, host.clientHeight);
    lastSig = '';
  }

  function render() {
    if (!alive()) return;
    rafQueued = false;
    patchStyleSwitch();
    var s = series();
    if (!s) { schedule(); return; }
    var style;
    try { style = s.style(); } catch (e) { schedule(); return; }
    var kind = STYLE_KIND[style];
    // A bar-set style that the model is really rendering itself (Daily and
    // above) must not be covered by the local renderer.
    if (BARSET_KIND[style] && window.__tvBarSet !== style) kind = null;
    var isBarSet = !!kind && !!BARSET_KIND[style];
    if (wasBarSet && !isBarSet) {
      // Leaving a bar set: give the normal chart its automatic price scale
      // back, otherwise candles stay squeezed into the bar-set price range.
      wasBarSet = false;
      try { s.priceScale().resetScale(); } catch (e) {}
    }
    if (isBarSet) wasBarSet = true;
    setNativeVisible(s, isBarSet);
    if (!kind) { clearOverlay(); lastStyle = style; schedule(); return; }

    if (!ensureCanvas()) { schedule(); return; }
    silenceNativeStudies(s);

    // Refit the price range once per style/timeframe change for bar sets.
    var rangeKey = style + '|' + (s.interval ? s.interval() : '');
    if (rangeKey !== lastRangeKey) {
      lastRangeKey = rangeKey;
      nextFit = true;
    }

    var ts = timeScale();
    if (!ts) { schedule(); return; }

    if (style !== lastStyle) {
      lastStyle = style;
      if (BARSET_KIND[style]) {
        // Bar sets need a readable brick/column pitch.
        setTimeout(function () {
          try {
            var t2 = timeScale();
            if (t2 && t2.barSpacing() < 6) t2.setBarSpacing(9);
          } catch (e) {}
        }, 60);
      }
      if (style === 17 || style === 18) {
        // Native footprint/TPO use a wide bar pitch; give the grid room once.
        var want = style === 17 ? 46 : 34;
        setTimeout(function () {
          try {
            var t2 = timeScale();
            if (!t2) return;
            if (t2.barSpacing() < 22) t2.setBarSpacing(want);
            // Keep the latest bars on screen instead of leaving a wide gap of
            // empty future space once the pitch grows.
            if (typeof t2.setRightOffset === 'function') t2.setRightOffset(2);
            else if (typeof t2.scrollToRealtime === 'function') t2.scrollToRealtime();
          } catch (e) {}
        }, 60);
      }
    }

    var sig = signature(s, ts);
    var now = Date.now();
    if (sig === lastSig && now - lastDraw < 350) { schedule(); return; }
    lastSig = sig;
    lastDraw = now;

    ctx.clearRect(0, 0, host.clientWidth, host.clientHeight);
    try {
      if (kind === 'footprint') drawFootprint(s, ts);
      else if (kind === 'tpo') drawTpo(s, ts);
      else if (kind === 'svp') drawSvp(s, ts);
      else if (kind === 'renko') drawRenko(s, ts);
      else if (kind === 'kagi') drawKagi(s, ts);
      else if (kind === 'pnf') drawPnf(s, ts);
      else if (kind === 'linbreak') drawLineBreak(s, ts);
    } catch (e) {
      // Never let a drawing error break the chart.
    }
    schedule();
  }

  function schedule() {
    if (!alive() || rafQueued) return;
    rafQueued = true;
    window.requestAnimationFrame(render);
  }

  window.addEventListener('resize', function () { lastSig = ''; schedule(); });
  schedule();

  // Small debugging handle for the test harness.
  window.__tvStyleOverlayInfo = function () {
    var s = series();
    var ts = timeScale();
    return {
      style: s ? s.style() : null,
      realStyle: s && s.__tvOrigStyle ? s.__tvOrigStyle() : null,
      barSet: window.__tvBarSet || null,
      interval: s ? s.interval() : null,
      nativeHidden: !!nativeHidden,
      barSpacing: ts ? ts.barSpacing() : null,
      overlay: !!canvas,
      size: canvas ? [canvas.width, canvas.height] : null,
    };
  };
})();