// Local override / patch layer for the mirrored TradingView app.
//
// Every change we make to the mirror's behavior lives here as a find/replace
// rule. serve.js applies these on the fly while serving, so the original
// mirrored files stay pristine and our edits are easy to review, toggle,
// version-control and re-apply after a fresh capture.
//
// NOTE: these are *client-side* limits. Anything the TradingView backend
// enforces (e.g. server-side alert counts) cannot be raised from here.

function replaceAll(text, find, replace) {
  return text.split(find).join(replace);
}

// Features that the free plan lacks entirely. We grant them by inserting the
// keys at the start of the "free" object in the embedded plan-limit JSON.
const FREE_EXTRA_FEATURES =
  '"MULTIPLE_WATCHLISTS":{},' +
  '"CUSTOM_INTERVALS":{},' +
  '"MULTIFLAGGED_SYMBOLS_LISTS":{},' +
  '"IMPORT_WATCHLISTS":{},' +
  '"EXPORT_WATCHLISTS":{},' +
  '"DRAWINGS":{},' +
  '"NESTED_DRAWING_GROUPS":{},' +
  '"TICK_BY_TICK_PUSH_DATA":{},' +
  '"ALERTS_WEBHOOK":{},' +
  '"ALERTS_ON_EARNINGS":{},' +
  '"ALERTS_ON_FUNDAMENTAL_METRICS":{},' +
  '"ALERTS_MULTICONDITIONS":{"condition_limit":999999},' +
  '"BAR_REPLAY_INTRADAY":{"limit":999999,"history_days":999999},';

// Literal numeric limits inside the free-plan JSON block -> unlimited.
const LIMIT_PATCHES = [
  ['"WATCHLIST_SYMBOLS":{"limit":30}', '"WATCHLIST_SYMBOLS":{"limit":999999}'],
  ['"INDICATORS_ON_CHART":{"limit":2}', '"INDICATORS_ON_CHART":{"limit":999999}'],
  ['"FUNDAMENTALS_ON_CHART":{"limit":1}', '"FUNDAMENTALS_ON_CHART":{"limit":999999}'],
  ['"MULTIPLE_CHARTS":{"limit":1}', '"MULTIPLE_CHARTS":{"limit":999999}'],
  ['"CHART_STORAGE":{"limit":1}', '"CHART_STORAGE":{"limit":999999}'],
  ['"HISTORICAL_BARS":{"limit":5}', '"HISTORICAL_BARS":{"limit":999999}'],
  ['"STUDY_ON_STUDY":{"limit":800,"child_limit":1}', '"STUDY_ON_STUDY":{"limit":999999,"child_limit":999999}'],
  ['"SERVER_SIDE_ALERTS":{"overall_limit":50,"limit":3,"complex_limit":0,"primitive_limit":3}',
   '"SERVER_SIDE_ALERTS":{"overall_limit":999999,"limit":999999,"complex_limit":999999,"primitive_limit":999999,"watchlist_limit":999999,"overall_watchlist_limit":999999}'],
  ['"SCREENER_SIMULTANEOUS_FILTERS":{"limit":2}', '"SCREENER_SIMULTANEOUS_FILTERS":{"limit":999999}'],
  ['"SCREENER_SAVED_SCREEN_LIMIT":{"limit":1}', '"SCREENER_SAVED_SCREEN_LIMIT":{"limit":999999}'],
  ['"STUDY_TEMPLATES":{"limit":1}', '"STUDY_TEMPLATES":{"limit":999999}'],
  ['"SIMULTANEOUS_CONNECTIONS":{"limit":1}', '"SIMULTANEOUS_CONNECTIONS":{"limit":999999}'],
  ['"BACKEND_CONNECTIONS":{"limit":2}', '"BACKEND_CONNECTIONS":{"limit":999999}'],
  ['"MULTICOLOR_FLAGGED_SYMBOLS":{"limit":1}', '"MULTICOLOR_FLAGGED_SYMBOLS":{"limit":999999}'],
  ['"CREATE_MORE_PORTFOLIOS":{"limit":1}', '"CREATE_MORE_PORTFOLIOS":{"limit":999999}'],
  ['"OPTIONS_STRATEGIES_LIMIT":{"limit":3}', '"OPTIONS_STRATEGIES_LIMIT":{"limit":999999}'],
  ['"PORTFOLIO_TRANSACTIONS":{"limit":2000}', '"PORTFOLIO_TRANSACTIONS":{"limit":999999}'],
  ['"PORTFOLIO_HOLDINGS":{"limit":20}', '"PORTFOLIO_HOLDINGS":{"limit":999999}'],
  ['"NEWS_ALERTS":{"limit":1}', '"NEWS_ALERTS":{"limit":999999}'],
  ['"SAVED_PINE_SCRIPTS":{"limit":1}', '"SAVED_PINE_SCRIPTS":{"limit":999999}'],
  ['"CHAT_ASSISTANT":{"limit":5}', '"CHAT_ASSISTANT":{"limit":999999}'],
  ['"VIDEO_IDEAS_LENGTH":{"limit":20}', '"VIDEO_IDEAS_LENGTH":{"limit":999999}'],
  // Free screener only exposes D/W/M; allow intraday too.
  ['"SCREENER_INTERVALS":{"interval":["1D","1W","1M"]}',
   '"SCREENER_INTERVALS":{"interval":["1m","5m","15m","30m","1h","2h","4h","1D","1W","1M"]}'],
];

// Hard watchlist cap (1000) + the "tiered limits" gate that reads the plan.
const WATCHLIST_CAP_FIND =
  'const a=1e3;function c(){return(0,o.isFeatureEnabled)("watchlist_symbols_tiered_limits")' +
  '?(0,n.getConfig)(i.ProductFeatures.WATCHLIST_SYMBOLS)?.limit??a:a}';
const WATCHLIST_CAP_REPL = 'const a=999999;function c(){return a}';

// Multiple watchlists required a paid plan; drop that requirement.
//
// This gate is duplicated across 6 bundles with a different minified function
// name in each (`_`, `L`, `E`, `w`, `k`, `x`), so we match the expression body
// instead of the whole function.
const MULTI_LISTS_FIND =
  '("multiple_watchlists")&&window.user&&Boolean(window.user.is_pro)';
const MULTI_LISTS_REPL = '("multiple_watchlists")||!0';

// ---------------------------------------------------------------------------
// Kill the paywall entirely.
//
// The app is not connected to TradingView's backend, so a paywall only ever
// hides local functionality. The `openPaywall` wrapper is duplicated across
// ~37 bundles with a different minified function name in each, but its body is
// always the same call. Match the call body and turn it into a no-op:
//   return(0,<a>.openWall)(<b>.PAYWALL_KIND,{...<c>,feature:e},<d>)
const PAYWALL_RE =
  /return\(0,([A-Za-z_$][\w$]*)\.openWall\)\(([A-Za-z_$][\w$]*)\.PAYWALL_KIND,\{\.\.\.([A-Za-z_$][\w$]*),feature:e\},([A-Za-z_$][\w$]*)\)/g;
const PAYWALL_REPL = 'return null';

// Some code calls the wall opener directly with the paywall kind (Go-Pro
// buttons). Short-circuit those at the source in the walls module:
//   openWall:(e,t,n={})=>l(e).tryIntercept(t.feature)?Promise.resolve({shown:!1}):...
// becomes
//   openWall:(e,t,n={})=>"paywall"===e||l(e).tryIntercept(t.feature)?...
const OPENWALL_RE =
  /(openWall:\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=\{\}\)=>)([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\.tryIntercept\(([A-Za-z_$][\w$]*)\.feature\)/g;
const OPENWALL_REPL = '$1"paywall"===$2||$5($6).tryIntercept($7.feature)';

// Flagging a symbol is restricted to the red list unless the
// `MULTIFLAGGED_SYMBOLS_LISTS` product feature reads as enabled:
//   function I(e){return n.ListColor.Red===e||(0,w.enabled)(N.ProductFeatures.MULTIFLAGGED_SYMBOLS_LISTS)}
// `_restrictedMarkSymbols` only dispatches the mark action when `I(color)` is
// true, so with the feature off, flagging green/blue/... silently does nothing
// (no list is created, the symbol is not moved). Grant every color.
const MULTIFLAG_GATE_RE =
  /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return ([A-Za-z_$][\w$]*)\.ListColor\.Red===\2\|\|\(0,([A-Za-z_$][\w$]*)\.enabled\)\(([A-Za-z_$][\w$]*)\.ProductFeatures\.MULTIFLAGGED_SYMBOLS_LISTS\)\}/g;
const MULTIFLAG_GATE_REPL = 'function $1($2){return!0}';

// Colored ("flagged symbols") watchlists must behave like normal watchlists:
// flagging a symbol with a color must create/use that color's list AND make it
// available in the watchlist panel's list switcher.
//
// The panel only lists other watchlists through the "Recently used" section,
// which is fed by `recentSymbolListsService` (settings key `symbollist.recents`).
// That service is only updated when a list is explicitly selected, never when a
// symbol is flagged, so a freshly used color never shows up there.
//
// `MarkedSymbolsListService` (webpack module 606846) is the single choke point
// every flag path funnels through (`setSymbolsColor` for one/selected symbols,
// `markMany` for many), so register the color as recently-used there. The
// service lives in another chunk; `s(210802)` is this module's webpack require,
// which resolves it once that chunk is loaded (guarded for the pre-load case).
// Unflagging must also record the symbol in the special "Deleted symbols"
// list, exactly like removing a symbol from a watchlist already does
// (module 80322 `h()` dispatches `addWatchlistSymbolsThunk` /
// `createWatchlistThunk` for `DELETED_SYMBOLS_LIST_ID`). Every unflag path
// (legend toggle, context-menu "Unflag", palette toggle, Alt+Enter, bulk
// unflag) funnels through `MarkedSymbolsListService.setSymbolsColor(syms, null)`,
// so hook that: when the color is `null` and the symbols currently carry a
// color, append them to the Deleted symbols list.
//
//   s(188854) = DELETED_SYMBOLS_LIST_ID        (symbol-list-service chunk)
//   s(175802) = getCustomListById selector      (loaded with watchlist-widget)
//   s(857478) = addWatchlistSymbolsThunk / createWatchlistThunk
// The list itself is localStorage-backed and intercepted by the client API
// wrapper, so this works without any server persistence.
const UNFLAG_DELETED_SNIPPET =
  'try{if(null===t&&e&&e.length){' +
  'var G=s(188854).DELETED_SYMBOLS_LIST_ID,K=s(175802),T=s(857478),' +
  'Q=this,W=(this._model&&this._model._service&&this._model._service.store)||null;' +
  'if(W){var A=e.filter((function(y){return null!==Q.getSymbolColor(y)}));' +
  'if(A.length){var L=K.getCustomListById(W.getState(),G);' +
  'W.dispatch(L?T.addWatchlistSymbolsThunk(null,L,A):' +
  'T.createWatchlistThunk({id:G,name:"Deleted symbols",type:"custom",shared:!1,symbols:A}))' +
  '}}}}catch(x){}';

const FLAG_RECENTS_SET_FIND =
  'setSymbolsColor(e,t){0!==e.length&&this._runWithSync((()=>{this._model.setSymbolsColor(e,t)}))}';
const FLAG_RECENTS_SET_REPL =
  'setSymbolsColor(e,t){try{if(t){var r=s(210802).recentSymbolListsService();' +
  'r&&r.add({type:"color",id:t,color:t})}}catch(x){}' +
  UNFLAG_DELETED_SNIPPET +
  '0!==e.length&&this._runWithSync((()=>{this._model.setSymbolsColor(e,t)}))}';

// Removing a symbol from a custom watchlist is not always routed through the
// watchlist-widget handler that explicitly records it in "Deleted symbols":
// e.g. toggling a list off in the row context menu dispatches
// `removeWatchlistSymbolsThunk` directly. Centralize the behaviour in that
// thunk (webpack module 857478) so every custom-list removal is captured.
// `N` (list id / isDeletedSymbolsList), `p` (getCustomListById), `W`
// (addWatchlistSymbolsThunk) and `P` (createWatchlistThunk) are already
// imported/defined in this module. Skip the Deleted list itself and
// section separators; duplicate adds are harmless (the store dedupes).
const REMOVE_SYMBOLS_DELETED_FIND =
  'function V(e,t,a){const o=(0,r.service)(l.SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE);' +
  'return async(n,s)=>{n((0,i.exclude)({id:t.id,symbols:a,actionTimestamp:(0,T.crosstabMonotonicTimestamp)()}));';
const REMOVE_SYMBOLS_DELETED_REPL =
  'function V(e,t,a){const o=(0,r.service)(l.SYMBOL_LIST_REPOSITORY_BACKEND_SERVICE);' +
  'return async(n,s)=>{try{if(!(0,N.isDeletedSymbolsList)(t.id)){' +
  'var _dd=(0,p.getCustomListById)(s(),N.DELETED_SYMBOLS_LIST_ID),' +
  '_sy=a.filter((function(y){return 0!==y.indexOf("###")}));' +
  'if(_sy.length)n(_dd?W(null,_dd,_sy):' +
  'P({id:N.DELETED_SYMBOLS_LIST_ID,name:"Deleted symbols",type:"custom",shared:!1,symbols:_sy}))' +
  '}}catch(_de){}' +
  'n((0,i.exclude)({id:t.id,symbols:a,actionTimestamp:(0,T.crosstabMonotonicTimestamp)()}));';

// Bulk "clear all flags" bypasses `setSymbolsColor` and dispatches a reset on
// the model. Snapshot every currently-colored symbol and record it in the
// Deleted symbols list as well.
const CLEAR_ALL_DELETED_FIND =
  'clearAllSymbolsColor(){this._runWithSync((()=>{this._model.clearAllSymbolsColor()}))}';
const CLEAR_ALL_DELETED_REPL =
  'clearAllSymbolsColor(){try{var Q=this,W=(this._model&&this._model._service&&this._model._service.store)||null;' +
  'if(W){var A=[];try{var Mm=Q._model.getLists();' +
  'Mm&&Mm.forEach((function(set){set&&set.forEach((function(y){A.push(y)}))}))}catch(x){}' +
  'if(A.length){var G=s(188854).DELETED_SYMBOLS_LIST_ID,K=s(175802),T=s(857478);' +
  'var L=K.getCustomListById(W.getState(),G);' +
  'W.dispatch(L?T.addWatchlistSymbolsThunk(null,L,A):' +
  'T.createWatchlistThunk({id:G,name:"Deleted symbols",type:"custom",shared:!1,symbols:A}))' +
  '}}}catch(x){}this._runWithSync((()=>{this._model.clearAllSymbolsColor()}))}';
const FLAG_RECENTS_MANY_FIND =
  'markMany(e){this._runWithSync((()=>{this._model.markMany(e)}))}';
const FLAG_RECENTS_MANY_REPL =
  'markMany(e){try{var t=e&&e.color;if(t){var r=s(210802).recentSymbolListsService();' +
  'r&&r.add({type:"color",id:t,color:t})}}catch(x){}' +
  'this._runWithSync((()=>{this._model.markMany(e)}))}';

// The watchlist panel's list switcher only lists other watchlists through its
// "Recently used" section, and that section is built from `symbollist.recents`
// (see FLAG_RECENTS_*). Recents aren't restored from our on-disk settings store
// on load, so a color added at runtime would vanish on reload. Make the section
// self-sufficient instead: prepend every non-empty colored list that is present
// in the current store, so a color's watchlist is always selectable in the
// panel as long as it exists and holds symbols -- exactly how TradingView
// surfaces "Red list" once you flag something.
//
// `useRecentlyUsedLists(lists, activeId, includeHot)` (webpack module 184478)
// receives `lists` = all custom + colored lists. We seed its memo with the
// colored ones (deduping against what recents already provided).
const RECENT_COLORS_FIND =
  'if(!a.length)return a;const o=n||!!a.find((e=>"hot"!==e.type));' +
  'return e.length&&o?a.filter((o=>';
const RECENT_COLORS_REPL =
  'const A=a.slice();if(e&&e.length)for(let k=0;k<e.length;k++){const L=e[k];' +
  'if(L&&"colored"===L.type&&L.symbols&&L.symbols.length>0&&' +
  '!A.some((x=>"color"===x.type&&x.id===L.id)))A.push({type:"color",id:L.id,color:L.color})}' +
  'if(!A.length)return A;const o=n||!!A.find((e=>"hot"!==e.type));' +
  'return e.length&&o?A.filter((o=>';
const RECENT_COLORS_TAIL_FIND =
  'Boolean(e.find((e=>e.id===o.id&&e.type===o.type))))):a}),[e,a,t,n])';
const RECENT_COLORS_TAIL_REPL =
  'Boolean(e.find((e=>e.id===o.id&&e.type===o.type))))):A}),[e,a,t,n])';

// `featureCheck` falls back to the plan config; make the fallback always grant.
//   default:return(0,<a>.enabled)(e,n)   ->   default:return!0
const FEATURECHECK_RE = /default:return\(0,([A-Za-z_$][\w$]*)\.enabled\)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/g;
const FEATURECHECK_REPL = 'default:return!0';

// Rows at index >= 30 inside a watchlist were rendered as "locked" (quote
// values hidden, replaced by an "Upgrade to access" button) purely because of
// this client-side feature flag:
//   const Dt = isFeatureEnabled("watchlist_free_user_symbols_data_limit");
//   function Wt(e){ return Dt && e>=30 && !window.user?.is_pro }
// Point the flag at a key that does not exist so it resolves to false and every
// row renders normally.
const WL_FREE_LOCK_FIND = '"watchlist_free_user_symbols_data_limit"';
const WL_FREE_LOCK_REPL = '"watchlist_free_user_symbols_data_limit_off"';

// ---------------------------------------------------------------------------
// Custom intervals (e.g. 4m / 7m) and seconds intervals.
//
// `IntervalsService.add(multiplier, unit, onGoPro)` bails out for free users
// before ever saving the custom interval:
//   add(e,t,i){ if(!window.user.is_pro&&i) return i(),null; ... }
// The `i` callback shows the (now no-op) paywall, so the interval silently
// never gets added. Drop the is_pro requirement; keep the callback call so any
// caller that expects a return value still behaves.
//
// The featureset side (`isFeaturesetEnabled("custom_resolutions")`) is handled
// in applyHtmlPatches by adding it to window.__initialEnabledFeaturesets.
const INTERVAL_ADD_GATE_RE =
  /if\(!window\.user\.is_pro&&([A-Za-z_$][\w$]*)\)return \1\(\),null;/g;
const INTERVAL_ADD_GATE_REPL = 'if(!1&&$1)return $1(),null;';

// ---------------------------------------------------------------------------
// End-of-series "Power up your plan" banner.
//
// When the feed stops at its free-tier history cap it reports
// `endOfDataType === "limit"`. The chart then renders an inline banner offering
// a plan upgrade. We are not enforcing any plan limit locally (and the cap is
// the feed's own), so hide the banner: `_prepareDataForValidation` returns null
// and the banner/dialog is cleared.
const END_OF_SERIES_FIND =
  'if(this._series.status()===L.Status.Loading||this._series.requestMoreDataAvailable())return null;';
const END_OF_SERIES_REPL = 'return null;';

// The banner also has a DOM overlay component whose `_rebuild` re-shows the
// element whenever the series is at the history limit. Keep it permanently
// hidden there too (the canvas renderer above only covers the inline icon).
const END_OF_SERIES_DOM_FIND = '_rebuild(){this._element.classList.toggle(u,!1),this._currentHeight=0,';
const END_OF_SERIES_DOM_REPL = '_rebuild(){this._element.classList.toggle(u,!1);return;';

// ---------------------------------------------------------------------------
// Symbol search: the app builds https://symbol-search.tradingview.com/... which
// is cross-origin and not captured. Route it through the local /__ss/ proxy.
const SS_FIND =
  'function f(e){let t="https://"+(0,o.requireEnvValue)("SS_HOST");const r=(0,c.isProd)()?0:1;' +
  't+=S[r][e?0:1];const l=(0,o.getEnvValue)("SS_URL");return l&&(t=l),t}';
const SS_REPL =
  'function f(e){const r=(0,c.isProd)()?0:1;return"/__ss"+S[r][e?0:1]}';

// ---------------------------------------------------------------------------
// WebSocket latency ping.
//
// The data-feed client periodically measures round-trip latency by opening an
// XMLHttpRequest to `<feed-host>/ping`. It rebuilds the URL with
// `e.pathname+="ping", e.protocol="https:"`, but our local re-origin proxy
// (wsproxy) speaks plain HTTP, so a forced https URL throws an SSL error every
// 10s. Match the host's actual protocol instead.
const PING_PROTOCOL_FIND = 'e.pathname+="ping",e.protocol="https:"';
const PING_PROTOCOL_REPL = 'e.pathname+="ping",e.protocol="http:"';

// The chart-events (economic calendar) client rebuilds its request URL with
// `new URL(this._url)`. serve.js rewrites the calendar host to a root-relative
// path, so the one-arg URL constructor throws "Invalid URL" on every poll.
// Give it the page origin as a base so the local path resolves.
const EVENTS_URL_FIND = '_getRequestData(e,t,r=!0){const o=new URL(this._url);';
const EVENTS_URL_REPL = '_getRequestData(e,t,r=!0){const o=new URL(this._url,location.origin);';

// The built-in "screener" side panel is lazy-loaded from chunks (and a scanner
// backend URL) that this mirror does not have, so auto-restoring it throws
// "Invalid URL" on every load. The user is replacing the right panel with their
// own scanner anyway, so skip restoring just that panel. Opening it manually
// still behaves as before.
const SIDE_PANEL_FIND =
  't.register(e),this._chartPageGrid?.persistedState().value().activePanels.includes(e.id)&&t.show(e.id,void 0,{notTrackEvent:!0})';
const SIDE_PANEL_REPL =
  't.register(e),this._chartPageGrid?.persistedState().value().activePanels.includes(e.id)&&"screener"!==e.id&&t.show(e.id,void 0,{notTrackEvent:!0})';

function applyJsPatches(text) {
  const applied = [];

  // 1) Grant pro-only features on the free plan.
  if (text.includes('"free":{') && !text.includes('"MULTIPLE_WATCHLISTS":{},"CUSTOM_INTERVALS":{}')) {
    text = replaceAll(text, '"free":{', '"free":{' + FREE_EXTRA_FEATURES);
    applied.push('free-plan feature grants');
  }

  // 2) Raise numeric limits.
  for (const [find, repl] of LIMIT_PATCHES) {
    if (text.includes(find)) {
      text = replaceAll(text, find, repl);
      applied.push('limit:' + find.slice(1, find.indexOf('"', 1)).slice(0, 32));
    }
  }

  // 3) Watchlist hard cap.
  if (text.includes(WATCHLIST_CAP_FIND)) {
    text = replaceAll(text, WATCHLIST_CAP_FIND, WATCHLIST_CAP_REPL);
    applied.push('watchlist-hard-cap');
  }

  // 4) Multiple watchlists gate.
  if (text.includes(MULTI_LISTS_FIND)) {
    text = replaceAll(text, MULTI_LISTS_FIND, MULTI_LISTS_REPL);
    applied.push('multiple-watchlists');
  }

  // 5) Symbol search -> local proxy (fixes the endless spinner).
  if (text.includes(SS_FIND)) {
    text = replaceAll(text, SS_FIND, SS_REPL);
    applied.push('symbol-search-proxy');
  }

  // 6) Kill the paywall wrapper wherever it appears.
  {
    const n = (text.match(PAYWALL_RE) || []).length;
    if (n) {
      text = text.replace(PAYWALL_RE, PAYWALL_REPL);
      applied.push('paywall-noop x' + n);
    }
  }

  // 7) Short-circuit direct paywall opens in the walls module.
  {
    const n = (text.match(OPENWALL_RE) || []).length;
    if (n) {
      text = text.replace(OPENWALL_RE, OPENWALL_REPL);
      applied.push('openwall-paywall x' + n);
    }
  }

  // 8) featureCheck falls back to "granted".
  {
    const n = (text.match(FEATURECHECK_RE) || []).length;
    if (n) {
      text = text.replace(FEATURECHECK_RE, FEATURECHECK_REPL);
      applied.push('featurecheck-true x' + n);
    }
  }

  // 8b) Allow flagging a symbol in any color, not just red.
  {
    const n = (text.match(MULTIFLAG_GATE_RE) || []).length;
    if (n) {
      text = text.replace(MULTIFLAG_GATE_RE, MULTIFLAG_GATE_REPL);
      applied.push('multiflag-colors x' + n);
    }
  }

  // 8c) Flagging a symbol with a color registers that color's watchlist as
  //     recently-used so it appears in the watchlist panel's list switcher.
  {
    let n = 0;
    if (text.includes(FLAG_RECENTS_SET_FIND)) {
      text = replaceAll(text, FLAG_RECENTS_SET_FIND, FLAG_RECENTS_SET_REPL);
      n++;
    }
    if (text.includes(FLAG_RECENTS_MANY_FIND)) {
      text = replaceAll(text, FLAG_RECENTS_MANY_FIND, FLAG_RECENTS_MANY_REPL);
      n++;
    }
    if (n) applied.push('flag-recents+unflag-deleted x' + n);
  }

  // 8e) Bulk "clear all flags" also records the cleared symbols in the
  //     Deleted symbols list.
  if (text.includes(CLEAR_ALL_DELETED_FIND)) {
    text = replaceAll(text, CLEAR_ALL_DELETED_FIND, CLEAR_ALL_DELETED_REPL);
    applied.push('clear-all-deleted');
  }

  // 8f) Every custom-watchlist removal (context menu / move / row remove)
  //     records the removed symbols in the Deleted symbols list.
  if (text.includes(REMOVE_SYMBOLS_DELETED_FIND)) {
    text = replaceAll(text, REMOVE_SYMBOLS_DELETED_FIND, REMOVE_SYMBOLS_DELETED_REPL);
    applied.push('remove-symbols-deleted');
  }

  // 8d) Make the watchlist panel's list switcher list every non-empty colored
  //     list, independent of unreliably-persisted recents.
  if (text.includes(RECENT_COLORS_FIND) && text.includes(RECENT_COLORS_TAIL_FIND)) {
    text = replaceAll(text, RECENT_COLORS_FIND, RECENT_COLORS_REPL);
    text = replaceAll(text, RECENT_COLORS_TAIL_FIND, RECENT_COLORS_TAIL_REPL);
    applied.push('panel-lists-colored');
  }

  // 9) Unlock watchlist rows beyond index 30 (hidden quote values).
  if (text.includes(WL_FREE_LOCK_FIND)) {
    text = replaceAll(text, WL_FREE_LOCK_FIND, WL_FREE_LOCK_REPL);
    applied.push('watchlist-row-unlock');
  }

  // 10) Let free users add custom intervals (4m/7m) / seconds intervals.
  {
    const n = (text.match(INTERVAL_ADD_GATE_RE) || []).length;
    if (n) {
      text = text.replace(INTERVAL_ADD_GATE_RE, INTERVAL_ADD_GATE_REPL);
      applied.push('custom-interval-add x' + n);
    }
  }

  // 11) Hide the end-of-series "upgrade your plan" banner.
  if (text.includes(END_OF_SERIES_FIND)) {
    text = replaceAll(text, END_OF_SERIES_FIND, END_OF_SERIES_REPL);
    applied.push('end-of-series-banner-hidden');
  }
  if (text.includes(END_OF_SERIES_DOM_FIND)) {
    text = replaceAll(text, END_OF_SERIES_DOM_FIND, END_OF_SERIES_DOM_REPL);
    applied.push('end-of-series-banner-dom-hidden');
  }

  // 12) Latency ping -> plain HTTP (the local feed proxy is not TLS).
  if (text.includes(PING_PROTOCOL_FIND)) {
    text = replaceAll(text, PING_PROTOCOL_FIND, PING_PROTOCOL_REPL);
    applied.push('ws-ping-http');
  }

  // 13) Economic-calendar client: give its relative URL a base so `new URL`
  //     does not throw (see EVENTS_URL_* above).
  if (text.includes(EVENTS_URL_FIND)) {
    text = replaceAll(text, EVENTS_URL_FIND, EVENTS_URL_REPL);
    applied.push('chart-events-url-base');
  }

  // 14) Don't auto-restore the unloadable built-in screener side panel.
  if (text.includes(SIDE_PANEL_FIND)) {
    text = replaceAll(text, SIDE_PANEL_FIND, SIDE_PANEL_REPL);
    applied.push('skip-screener-panel-restore');
  }

  return { text, applied };
}

// The interval menu decides whether arbitrary resolutions are valid via
// `isFeaturesetEnabled("custom_resolutions")`. Featuresets are off by default
// and only turn on if listed in `__initialEnabledFeaturesets`, so prepend ours
// to that bootstrap array in the page HTML. `seconds_resolution` unlocks the
// standard seconds intervals (1s/5s/...). `hide_loading_screen_on_series_error`
// makes the loading overlay hide when a series is refused (e.g. an unservable
// seconds interval), so a rejected interval falls back instead of wedging the
// chart behind a permanent loading screen.
const HTML_FEATURESET_FIND = 'window.__initialEnabledFeaturesets =';
const HTML_FEATURESET_EXTRA =
  '["custom_resolutions","seconds_resolution","hide_loading_screen_on_series_error"]';
const HTML_FEATURESET_REPL =
  'window.__initialEnabledFeaturesets=(window.__initialEnabledFeaturesets||[]).concat(' +
  HTML_FEATURESET_EXTRA +
  ');\n\t\twindow.__initialEnabledFeaturesets =';

// Service base URLs that the page writes into initData/globals without a
// trailing slash (so serve.js's rewrite() does not convert them). Pointing them
// at the mirror makes the captured responses load locally instead of failing
// cross-origin. Applied to HTML only.
const HTML_SERVICE_URLS = [
  ['window.initData.priceAlertsFacadeClientUrl = "https://pricealerts.tradingview.com"',
   'window.initData.priceAlertsFacadeClientUrl = "/pricealerts.tradingview.com"',
   'local-url:pricealerts'],
  ['window.NEWS_MEDIATOR_URL = "https://news-mediator.tradingview.com"',
   'window.NEWS_MEDIATOR_URL = "/news-mediator.tradingview.com"',
   'local-url:news-mediator'],
];

function applyHtmlPatches(text) {
  const applied = [];
  if (text.includes(HTML_FEATURESET_FIND) && !text.includes(HTML_FEATURESET_EXTRA)) {
    // Only the first assignment is prefixed; its own `.concat(...)` then keeps
    // our additions ahead of the server-provided ones.
    text = text.replace(HTML_FEATURESET_FIND, HTML_FEATURESET_REPL);
    applied.push('featuresets:custom_resolutions,seconds_resolution,hide_loading_screen_on_series_error');
  }
  // The data-feed client is also inlined in the page; fix its latency ping URL
  // (see PING_PROTOCOL_* in applyJsPatches) so it hits the HTTP proxy.
  if (text.includes(PING_PROTOCOL_FIND)) {
    text = replaceAll(text, PING_PROTOCOL_FIND, PING_PROTOCOL_REPL);
    applied.push('ws-ping-http(inline)');
  }
  // Local UI clean-up: drop upgrade CTAs and the calendar tool button.
  if (text.includes('</head>') && !text.includes('id="local-ui-css"')) {
    text = text.replace(
      '</head>',
      '<style id="local-ui-css">' +
        '[data-name="calendar-dialog-button"],[class*="desktopUpgrade-"]{display:none!important}' +
        '</style></head>'
    );
    applied.push('local-ui-css');
  }
  // Local renderer for the three server-gated chart styles (volume footprint,
  // TPO, session volume profile). The free feed refuses those studies, so we
  // draw an approximate version from the real OHLCV bars instead.
  if (text.includes('</body>') && !text.includes('id="tv-style-overlay"')) {
    text = text.replace(
      '</body>',
      '<script id="tv-style-overlay" src="/www.tradingview.com/style-overlay.js"></script></body>'
    );
    applied.push('style-overlay');
  }
  // Route built-in "STD;" indicators in the dialog to their native
  // "@tv-basicstudies" equivalents, which the free account can run.
  if (text.includes('</body>') && !text.includes('id="tv-native-builtin-bridge"')) {
    text = text.replace(
      '</body>',
      '<script id="tv-native-builtin-bridge" src="/www.tradingview.com/native-builtin-bridge.js"></script></body>'
    );
    applied.push('native-builtin-bridge');
  }
  // Point cross-origin service base URLs at the local mirror so the captured
  // responses are used instead of failing with CORS/network errors. These are
  // written without a trailing slash, so serve.js's rewrite() leaves them be.
  for (const [find, repl, tag] of HTML_SERVICE_URLS) {
    if (text.includes(find)) {
      text = replaceAll(text, find, repl);
      applied.push(tag);
    }
  }
  return { text, applied };
}

module.exports = { applyJsPatches, applyHtmlPatches };