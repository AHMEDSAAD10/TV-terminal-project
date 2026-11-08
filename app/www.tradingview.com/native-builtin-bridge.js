// Native built-in bridge.
//
// The Indicators dialog lists TradingView's built-in indicators as Pine
// "standard" scripts (scriptIdPart "STD;..."). On a free (non-pro) account the
// charts server refuses to run Pine studies (study_limit_exceeded), so clicking
// e.g. "Double exponential moving average" fails even though it is a built-in.
//
// The same indicators also exist as native "@tv-basicstudies" studies, which the
// server *does* compute for free. This bridge intercepts the dialog's study
// insertion and, for a standard script that has a native equivalent, inserts the
// native study instead. Custom/community scripts (USER;/PUB;) are left untouched.
(function () {
  if (window.__tvNativeBuiltinBridge) return;
  window.__tvNativeBuiltinBridge = true;

  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/&#0*39;|&#x27;/gi, "'")
      .replace(/&amp;/gi, '&')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  var MAP = null;
  var MAP_PROMISE = null;

  // Extra hand-checked aliases where the Pine script name and the native
  // study description differ enough that matching by name misses.
  var ALIASES = {
    'STD;SMA': 'MASimple@tv-basicstudies',
    'STD;Aroon_Oscillator': 'AROON@tv-basicstudies',
    'STD;Price_Momentum_Oscillator': 'PriceOsc@tv-basicstudies',
    'STD;Average%1Directional%1Index': 'DM@tv-basicstudies',
    'STD;Money_Flow': 'MF@tv-basicstudies',
    'STD;Linear_Regression': 'LinearRegression@tv-basicstudies',
    'STD;Seasonality': 'Seasonals@tv-basicstudies',
    'STD;Trading%1Sessions': 'Sessions@tv-basicstudies',
    'STD;Advance%1Decline%1Ratio': 'studyADR@tv-basicstudies'
  };

  function buildMap() {
    var sm = window.studyMarket;
    var pJava = (sm && typeof sm._requestJavaStudies === 'function')
      ? Promise.resolve(sm._requestJavaStudies.call(sm))
      : Promise.resolve([]);
    var pStd = fetch('/pine-facade/list?filter=standard')
      .then(function (r) { return r.json(); })
      .catch(function () { return []; });
    return Promise.all([pJava, pStd]).then(function (res) {
      var java = res[0] || [];
      var std = res[1] || [];
      var byDesc = Object.create(null);
      var byShort = Object.create(null);
      for (var i = 0; i < java.length; i++) {
        var e = java[i];
        if (!e || !e.id || !/@tv-basicstudies$/.test(e.id)) continue;
        byDesc[norm(e.description)] = e.id;
        if (e.shortDescription) byShort[norm(e.shortDescription)] = e.id;
      }
      var map = Object.create(null);
      for (var j = 0; j < std.length; j++) {
        var s = std[j];
        if (!s || !s.scriptIdPart) continue;
        var id = s.scriptIdPart;
        var n = norm(s.scriptName);
        var sh = norm(s.extra && s.extra.shortDescription);
        var nat = byDesc[n] || byShort[sh] || byShort[n] || byDesc[sh];
        if (nat) map[id] = nat;
      }
      for (var k in ALIASES) { if (!map[k]) map[k] = ALIASES[k]; }
      return map;
    });
  }

  function ensureMap() {
    if (MAP) return Promise.resolve(MAP);
    if (!MAP_PROMISE) {
      MAP_PROMISE = buildMap().then(function (m) {
        MAP = m;
        try {
          var count = 0;
          for (var k in m) count++;
          console.log('[native-builtin-bridge] mapped ' + count + ' built-ins to native studies');
        } catch (e) {}
        return m;
      }).catch(function () { MAP_PROMISE = null; return {}; });
    }
    return MAP_PROMISE;
  }

  function wrap(svc) {
    if (!svc || svc.__nativeBuiltinBridge) return;
    svc.__nativeBuiltinBridge = true;
    var orig = svc.insertStudy.bind(svc);
    svc.insertStudy = function (req) {
      try {
        var d = req && req.descriptor;
        if (d && d.type === 'pine' && typeof d.pineId === 'string' && d.pineId.indexOf('STD;') === 0) {
          return ensureMap().then(function (m) {
            var nat = m[d.pineId];
            if (!nat) return orig(req);
            var req2 = {};
            for (var key in req) req2[key] = req[key];
            req2.descriptor = { type: 'java', studyId: nat };
            return orig(req2);
          });
        }
      } catch (e) {}
      return orig(req);
    };
    ensureMap();
  }

  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var sm = window.studyMarket;
    if (sm && sm._insertStudyService) wrap(sm._insertStudyService);
    if (tries > 240) clearInterval(iv);
  }, 500);

  var sm0 = window.studyMarket;
  if (sm0 && sm0._insertStudyService) wrap(sm0._insertStudyService);
})();
