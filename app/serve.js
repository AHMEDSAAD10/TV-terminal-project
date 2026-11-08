// Local static server for the mirrored TradingView app build.
// Serves the extracted mirror and rewrites absolute tradingview URLs to local paths.
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const https = require('https');
const zlib = require('zlib');
const { applyJsPatches, applyHtmlPatches } = require('./patches');
const symbolsApi = require('./symbols-api');

const ROOT = __dirname;
const PORT = 8088;
// Fresh auth token captured from a logged-in browser (see token-refresh.js).
// The captured page ships a frozen, expired token; splice in the live one.
const TOKEN_FILE = path.join(ROOT, 'auth-token.txt');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const hosts = new Set(
  fs.readdirSync(ROOT).filter(n => {
    try { return fs.statSync(path.join(ROOT, n)).isDirectory(); } catch { return false; }
  })
);

// Log each file's applied patches once, so the console isn't spammed.
const servedPatches = new Set();

function rewrite(text) {
  // https://host/path  or  //host/path  ->  /host/path  (only for mirrored hosts)
  text = text.replace(/(?:https?:)?\/\/([a-z0-9.-]+)\//gi, (m, host) => {
    if (hosts.has(host)) return '/' + host + '/';
    return m;
  });
  // Route the live feed through the local WS proxy (re-originates as tradingview.com).
  text = text
    .split('window.WEBSOCKET_HOST = "data.tradingview.com"')
    .join('window.WEBSOCKET_HOST = "127.0.0.1:8090"')
    .split('window.PUSHSTREAM_URL = "wss://pushstream.tradingview.com"')
    .join('window.PUSHSTREAM_URL = "ws://127.0.0.1:8090"')
    .split('e.pathname+="socket.io/websocket",e.protocol="wss:"')
    .join('e.pathname+="socket.io/websocket",e.protocol="ws:"')
    .split('new URL("wss://"+e)')
    .join('new URL("ws://"+e)')
    .split('"wss:"!==t.protocol&&"https:"!==t.protocol')
    .join('"ws:"!==t.protocol&&"wss:"!==t.protocol&&"https:"!==t.protocol');
  return text;
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Re-originate an HTTP API to TradingView, preserving the query string and body.
// Used for symbol search and the public community/script-library endpoints that
// the capture omitted (the dialog's "Editors' picks / Top / Trending" tabs).
function proxyUpstream(hostname, req, res, upstreamPath, label) {
  const target = url.parse(req.url);
  const opts = {
    protocol: 'https:',
    hostname: hostname,
    port: 443,
    method: req.method,
    path: upstreamPath + (target.search || ''),
    headers: {
      'Accept': req.headers['accept'] || 'application/json',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Origin': 'https://www.tradingview.com',
      'Referer': 'https://www.tradingview.com/',
    },
  };
  if (req.headers['content-type']) opts.headers['Content-Type'] = req.headers['content-type'];
  if (req.headers['cookie']) opts.headers['Cookie'] = req.headers['cookie'];

  const up = https.request(opts, (ur) => {
    res.writeHead(ur.statusCode || 502, {
      'Content-Type': ur.headers['content-type'] || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    ur.pipe(res);
  });
  up.on('error', (e) => {
    console.error((label || hostname) + ' proxy error:', e.message);
    if (!res.headersSent) send(res, 502, JSON.stringify({ error: 'upstream unavailable' }), 'application/json; charset=utf-8');
    else res.end();
  });
  req.pipe(up);
}

// Re-originate symbol search to TradingView, preserving the query string and body.
function proxySymbolSearch(req, res, upstreamPath) {
  proxyUpstream('symbol-search.tradingview.com', req, res, upstreamPath, 'symbol-search');
}

// Seconds/ticks resolutions cannot be served by the free feed (it refuses even
// the 1S base with `seconds_not_entitled`). If one is ever persisted the app
// retries it on every reload, so fold any such interval back to a safe 1 minute
// before storing. The client also falls back on its own, but this keeps the
// stored state clean.
const UNSERVABLE_RESOLUTION_RE = /^\d*(?:[SsTt]|[Tt]icks?)$/;
function sanitizeResolution(v) {
  if (typeof v === 'string' && UNSERVABLE_RESOLUTION_RE.test(v.trim())) return '1';
  return v;
}
function sanitizeStoredIntervals(store) {
  for (const key of ['editchart.model.interval', 'chart.lastUsedTimeBasedResolution']) {
    if (key in store) store[key] = sanitizeResolution(store[key]);
  }
  const mspKey = 'chartproperties.mainSeriesProperties';
  if (typeof store[mspKey] === 'string') {
    try {
      const msp = JSON.parse(store[mspKey]);
      if (msp && typeof msp === 'object' && 'interval' in msp) {
        msp.interval = sanitizeResolution(msp.interval);
        store[mspKey] = JSON.stringify(msp);
      }
    } catch { /* leave malformed value untouched */ }
  }
  return store;
}

// Persist UI/chart preference deltas locally instead of 404ing (the app posts
// multipart/form-data with a single `delta` JSON field).
function handleSaveSettings(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 16 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    try {
      const m = raw.match(/name="delta"\r?\n\r?\n([\s\S]*?)\r?\n--/);
      if (m) {
        const delta = JSON.parse(m[1]);
        const file = path.join(ROOT, 'settings-store.json');
        let store = {};
        try { if (fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
        Object.assign(store, delta);
        sanitizeStoredIntervals(store);
        fs.writeFileSync(file, JSON.stringify(store, null, 2));
      }
    } catch (e) {
      console.error('savesettings parse error:', e.message);
    }
    send(res, 200, '{}', 'application/json; charset=utf-8');
  });
}

// Local persistence for chart drawings (line tools). The app saves them with
// PUT .../charts-storage/layout/<id>/sources and loads them back with
// GET .../charts-storage/get/layout/<id>/sources, expecting
// {success:true,payload:...}. Store the payloads on disk so drawings survive
// reloads; the captured mirror only had empty canned responses.
const CHART_STORAGE_PREFIX = '/charts-storage.tradingview.com/charts-storage/';
const CHART_STORAGE_FILE = path.join(ROOT, 'chart-storage-store.json');

function readChartStorage() {
  try { return JSON.parse(fs.readFileSync(CHART_STORAGE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeChartStorage(store) {
  try { fs.writeFileSync(CHART_STORAGE_FILE, JSON.stringify(store, null, 2)); } catch (e) { console.error('chart storage write error:', e.message); }
}
function chartStorageKey(pathname, query) {
  return pathname + '|' + (query.chart_id || '');
}
function jsonReply(res, payload) {
  return send(res, 200, JSON.stringify({ success: true, payload }), 'application/json; charset=utf-8');
}
function handleChartStorage(req, res, pathname, query) {
  const rest = pathname.slice(CHART_STORAGE_PREFIX.length);
  const sizes = rest === 'user/sizes' || /^layout\/[^/]+\/sizes$/.test(rest);
  if (sizes) {
    return jsonReply(res, { charts: {}, countSourcesTotal: 0, limitBytesTotal: 0, sizeBytesTotal: 0 });
  }
  const isLoad = rest.startsWith('get/');
  const storePath = isLoad ? rest.slice(4) : rest;
  const key = chartStorageKey(storePath, query);

  if (req.method === 'GET') {
    const store = readChartStorage();
    return jsonReply(res, store[key] || {});
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const store = readChartStorage();
        store[key] = raw ? JSON.parse(raw) : {};
        writeChartStorage(store);
      } catch (e) {
        console.error('chart storage save error:', e.message);
      }
      jsonReply(res, { serverUpdateTime: Math.floor(Date.now() / 1000) });
    });
    return true;
  }
  if (req.method === 'DELETE') {
    const store = readChartStorage();
    delete store[key];
    writeChartStorage(store);
    return jsonReply(res, {});
  }
  jsonReply(res, {});
  return true;
}

// ---------------------------------------------------------------------------
// Saved layouts. The real app saves a layout with POST /api/v1/charts/save/
// (multipart, content gzip-compressed), lists them with GET /my-charts/,
// counts them with GET /api/v1/charts/count/ and loads one with
// GET /chart/<uid>/json/. The capture only had the layout list as a static
// file, so saving 404'd and changes never survived a reload. We store saved
// layouts on disk and splice the saved content into the chart page's
// `initData` when it is served, so symbol/interval/studies persist.
var LAYOUT_FILE = path.join(ROOT, 'layout-store.json');

function readLayouts() {
  try { return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeLayouts(store) {
  try { fs.writeFileSync(LAYOUT_FILE, JSON.stringify(store, null, 2)); } catch (e) { console.error('layout write error:', e.message); }
}

// Minimal multipart/form-data parser (browser FormData, boundary-delimited).
function parseMultipart(buf, boundary) {
  const fields = {};
  const b = Buffer.from('--' + boundary);
  let pos = buf.indexOf(b);
  while (pos !== -1) {
    const after = pos + b.length;
    if (buf[after] === 45 && buf[after + 1] === 45) break; // closing "--"
    const next = buf.indexOf(b, after);
    if (next === -1) break;
    let seg = buf.slice(after + 2, next - 2); // strip CRLF after/before boundary
    const he = seg.indexOf('\r\n\r\n');
    if (he !== -1) {
      const header = seg.slice(0, he).toString('utf8');
      const body = seg.slice(he + 4);
      const m = /name="([^"]+)"/.exec(header);
      if (m) fields[m[1]] = { body, filename: (/filename="([^"]*)"/.exec(header) || [])[1] || null };
    }
    pos = next;
  }
  return fields;
}

function decodeField(field) {
  if (!field) return null;
  // content/study_meta_info_map arrive gzipped (blob.gz).
  if (field.filename && /\.gz$/.test(field.filename)) {
    try { return zlib.gunzipSync(field.body).toString('utf8'); } catch { /* fall through */ }
  }
  return field.body.toString('utf8');
}

function readCapturedMyCharts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'www.tradingview.com', 'my-charts', 'index.html'), 'utf8')) || [];
  } catch { return []; }
}

// Merge saved layouts into the captured list (saved wins on the same uid).
function listLayouts() {
  const saved = readLayouts();
  const list = readCapturedMyCharts();
  const seen = new Set(list.map(c => c.url));
  for (const uid of Object.keys(saved)) {
    const s = saved[uid];
    const idx = list.findIndex(c => c.url === uid);
    const patch = {
      symbol: s.symbol || undefined,
      resolution: s.resolution || undefined,
      modified: s.modified || undefined,
      modified_iso: s.modified_iso || undefined,
    };
    if (idx >= 0) {
      Object.assign(list[idx], { ...patch, name: s.name || list[idx].name });
    } else if (!seen.has(uid)) {
      list.unshift({
        id: s.id, image_url: uid, url: uid,
        symbol: s.symbol || '', short_name: s.short_name || s.name || uid,
        name: s.name || uid, created: s.created || '', modified: s.modified || '',
        resolution: s.resolution || '1D', pro_symbol: s.symbol || '',
        expression: s.symbol || '', created_time: '', created_timestamp: s.created_timestamp || 0,
        modified_iso: s.modified_iso || 0, short_symbol: s.short_name || '', interval: s.resolution || '1D',
        favorite: !!s.favorite,
      });
      seen.add(uid);
    }
  }
  return list;
}

function handleChartSave(req, res) {
  const ct = req.headers['content-type'] || '';
  const bm = /boundary=([^;]+)/.exec(ct);
  if (!bm) { req.resume(); return send(res, 400, '{"error":"no boundary"}', 'application/json; charset=utf-8'); }
  const boundary = bm[1].replace(/^"|"$/g, '');
  const chunks = [];
  let size = 0;
  req.on('data', c => { chunks.push(c); size += c.length; if (size > 64 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let uid = null, id = null, lastModified = Math.floor(Date.now() / 1000);
    try {
      const fields = parseMultipart(Buffer.concat(chunks), boundary);
      uid = decodeField(fields.image_url) || null;
      const name = decodeField(fields.name) || 'Unnamed';
      const symbol = decodeField(fields.symbol) || '';
      const shortName = decodeField(fields.short_name) || '';
      const resolution = decodeField(fields.resolution) || '1D';
      const content = decodeField(fields.content);
      const studyMap = decodeField(fields.study_meta_info_map);

      const store = readLayouts();
      if (!uid) uid = 'local' + Math.random().toString(36).slice(2, 9);
      const prev = store[uid] || {};
      id = prev.id || (60000000 + Math.floor(Math.random() * 8000000));
      store[uid] = {
        id, name, symbol, short_name: shortName, resolution,
        content, study_meta_info_map: studyMap,
        modified: new Date().toISOString().slice(0, 10),
        modified_iso: lastModified,
        created: prev.created || new Date().toISOString().slice(0, 10),
        created_timestamp: prev.created_timestamp || lastModified,
        favorite: !!prev.favorite,
      };
      writeLayouts(store);
      console.log('layout saved: ' + uid + ' (' + name + ', ' + symbol + ' ' + resolution + ')'
        + ' fields=[' + Object.keys(fields).join(',') + ']'
        + ' map=' + (studyMap ? studyMap.length : 'null')
        + ' content=' + (content ? content.length : 'null'));
    } catch (e) {
      console.error('layout save error:', e.message);
    }
    return send(res, 200, JSON.stringify({ id, image_url: uid, last_modified: lastModified }), 'application/json; charset=utf-8');
  });
}

function handleChartCount(res) {
  const n = listLayouts().length;
  return send(res, 200, String(n), 'application/json; charset=utf-8');
}

function handleChartDelete(req, res) {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    try {
      const { uid } = JSON.parse(raw || '{}');
      const store = readLayouts();
      for (const u of (uid || [])) delete store[u];
      writeLayouts(store);
    } catch { /* ignore */ }
    send(res, 200, '{}', 'application/json; charset=utf-8');
  });
}

// GET /chart/<uid>/json/ -> the saved layout's chart state. Unknown layouts
// (e.g. the captured list entries that were never captured as a chart page)
// fall back to the base page's initial state so switching layouts never errors.
function baseInitData() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'www.tradingview.com', 'chart', 'j3mUKCaZ', 'index.html'), 'utf8');
    const cKey = 'initData.content = ';
    const sKey = 'initData.study_meta_info_map = ';
    const cStart = html.indexOf(cKey);
    if (cStart === -1) return null;
    const sIdx = html.indexOf(sKey, cStart);
    if (sIdx === -1) return null;
    const content = html.slice(cStart + cKey.length, html.lastIndexOf(';', sIdx)).trim();
    const sFrom = sIdx + sKey.length;
    const dIdx = html.indexOf('initData.defSymbol', sFrom);
    const studyMap = dIdx === -1 ? '{}' : html.slice(sFrom, html.lastIndexOf(';', dIdx)).trim();
    return { content, study_meta_info_map: studyMap };
  } catch { return null; }
}

function handleChartJson(res, uid) {
  const store = readLayouts();
  const s = store[uid];
  const base = baseInitData();
  if (s && s.content) {
    // Merge the saved study metadata over the page's own map, mirroring
    // spliceInitData, so switching layouts keeps custom studies restorable.
    const baseObj = base ? (parseJsonObject(base.study_meta_info_map) || {}) : {};
    const savedObj = parseJsonObject(s.study_meta_info_map) || {};
    const merged = Object.assign(baseObj, savedObj);
    return send(res, 200, JSON.stringify({
      content: s.content,
      study_meta_info_map: Object.keys(merged).length ? JSON.stringify(merged) : '{}',
      name: s.name, symbol: s.symbol, resolution: s.resolution,
    }), 'application/json; charset=utf-8');
  }
  if (base) return send(res, 200, JSON.stringify(base), 'application/json; charset=utf-8');
  return send(res, 404, 'not found: /chart/' + uid + '/json/');
}

// Parse a JSON object literal, returning null for anything else.
function parseJsonObject(str) {
  try {
    const o = JSON.parse(str);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// Replace the `initData.content` object literal, and merge the saved
// `study_meta_info_map` over the page's own map. The page ships full metadata
// for its custom Pine studies; an incoming save may omit or only partially
// include that map, so merging (rather than overwriting) keeps studies
// restorable.
function spliceInitData(html, layout) {
  if (!layout || !layout.content) return html;
  const cKey = 'initData.content = ';
  const sKey = 'initData.study_meta_info_map = ';
  const cStart = html.indexOf(cKey);
  if (cStart === -1) return html;
  const cFrom = cStart + cKey.length;
  const sIdx = html.indexOf(sKey, cFrom);
  if (sIdx === -1) return html;

  const cSemi = html.lastIndexOf(';', sIdx);
  if (cSemi > cFrom) html = html.slice(0, cFrom) + layout.content + html.slice(cSemi);

  const sFrom = html.indexOf(sKey) + sKey.length;
  const dIdx = html.indexOf('initData.defSymbol', sFrom);
  if (dIdx !== -1) {
    const sSemi = html.lastIndexOf(';', dIdx);
    if (sSemi > sFrom) {
      const savedObj = parseJsonObject(layout.study_meta_info_map);
      if (savedObj && Object.keys(savedObj).length) {
        const baseObj = parseJsonObject(html.slice(sFrom, sSemi)) || {};
        const merged = Object.assign(baseObj, savedObj);
        html = html.slice(0, sFrom) + JSON.stringify(merged) + html.slice(sSemi);
      }
      // No usable saved map: keep the page's original metadata untouched.
    }
  }
  return html;
}

// Swap the page's baked-in (expired) auth token for the live one fetched from
// a logged-in browser. The token lives in the embedded user JSON as
// "auth_token":"<jwt>". Without this the charts server treats every session as
// unentitled and rejects all Pine studies (study_limit_exceeded).
function applyAuthToken(html) {
  try {
    const tok = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!tok || tok.split('.').length !== 3) return html;
    const key = '"auth_token":"';
    const i = html.indexOf(key);
    if (i === -1) return html;
    const s = i + key.length;
    let e = s;
    while (e < html.length && html[e] !== '"') e++;
    if (html.slice(s, e) === tok) return html;
    return html.slice(0, s) + tok + html.slice(e);
  } catch { return html; }
}

const server = http.createServer(async (req, res) => {
  let pathname;
  let query = {};
  try {
    const parsed = url.parse(req.url, true);
    pathname = decodeURIComponent(parsed.pathname);
    query = parsed.query || {};
  }
  catch { return send(res, 400, 'bad request'); }

  if (pathname === '/savesettings/' && req.method === 'POST') {
    return handleSaveSettings(req, res);
  }

  // Telemetry is fire-and-forget; answer locally so it doesn't log a 404.
  if (pathname.startsWith('/telemetry.tradingview.com/')) {
    req.resume();
    return send(res, 200, '{}', 'application/json; charset=utf-8');
  }

  // Chart drawings persistence (line tools / groups).
  if (pathname.startsWith(CHART_STORAGE_PREFIX)) {
    return handleChartStorage(req, res, pathname, query);
  }

  // Drawing-tool templates are JSON too; the capture omitted them.
  if (/^\/drawing-templates\/[^/]+\/?$/.test(pathname)) {
    return send(res, 200, '[]', 'application/json; charset=utf-8');
  }
  if (pathname === '/save-drawing-template/' && req.method === 'POST') {
    req.resume();
    return send(res, 200, '{}', 'application/json; charset=utf-8');
  }
  if (pathname === '/drawing-template/' || pathname.startsWith('/drawing-template/')) {
    return send(res, 200, '{"content":"{}"}', 'application/json; charset=utf-8');
  }

  // Custom chart themes. The app fetches the saved-theme list here and .json()s
  // it; without a JSON response the global-search dialog rejects and never
  // opens. Local builds start with no saved themes.
  if (pathname === '/themes/' || pathname === '/themes') {
    return send(res, 200, '[]', 'application/json; charset=utf-8');
  }
  if (pathname === '/theme/') {
    return send(res, 200, '{}', 'application/json; charset=utf-8');
  }
  if ((pathname === '/save-theme/' || pathname === '/remove-theme/') && req.method === 'POST') {
    req.resume();
    return send(res, 200, '{}', 'application/json; charset=utf-8');
  }

  // Saved study templates / broker plans are JSON APIs on the real site. The
  // capture did not include them, so answer with empty collections instead of
  // plain-text 404s (which break the app's .json() calls).
  if (pathname === '/api/v1/study-templates') {
    return send(res, 200, '{"custom":[],"standard":[],"fundamentals":[]}', 'application/json; charset=utf-8');
  }
  if (pathname === '/api/v1/brokers/trading_panel') {
    return send(res, 200, '[]', 'application/json; charset=utf-8');
  }

  // pine-facade/list is filtered by ?filter=standard|candlestick|fundamental|
  // saved. The capture stored each filter's response under a content-hashed
  // name, and the plain list.html is the fundamental set. Without this dispatch
  // every tab (Technicals, Fundamentals, Patterns, My scripts) got the same
  // fundamental list, which is why the built-in list was wrong and duplicated.
  {
    const m = /\/pine-facade\/list\/?$/.exec(pathname);
    if (m) {
      const PINE_LIST = {
        standard: 'list-7c2c823b94c56.html',
        candlestick: 'list-0ceda9546bd118.html',
        saved: 'list-62e800277dda18.html',
        fundamental: 'list.html',
      };
      const filter = String(query.filter || '').toLowerCase();
      const file = path.join(ROOT, 'pine-facade.tradingview.com', 'pine-facade', PINE_LIST[filter] || 'list.html');
      try {
        return send(res, 200, fs.readFileSync(file), 'application/json; charset=utf-8');
      } catch {
        return send(res, 200, '[]', 'application/json; charset=utf-8');
      }
    }
  }

  // Saved-layout API (save / list / count / delete / load).
  if (pathname === '/api/v1/charts/save/' && req.method === 'POST') {
    return handleChartSave(req, res);
  }
  if (pathname === '/api/v1/charts/count/') {
    return handleChartCount(res);
  }
  if (pathname === '/api/v1/charts/delete/' && req.method === 'POST') {
    return handleChartDelete(req, res);
  }
  if (pathname === '/my-charts/' || pathname === '/my-charts') {
    return send(res, 200, JSON.stringify(listLayouts()), 'application/json; charset=utf-8');
  }
  {
    const m = /^\/(?:www\.tradingview\.com\/)?chart\/([^/]+)\/json\/$/.exec(pathname);
    if (m) return handleChartJson(res, m[1]);
  }

  // Local watchlist backend (create/copy/append/remove/rename, unlimited + persistent).
  try {
    if (await symbolsApi.handle(req, res, pathname)) return;
  } catch (e) {
    console.error('symbols-api error:', e);
    return send(res, 500, 'symbols api error');
  }

  // Symbol-search proxy: the app calls symbol-search.tradingview.com, which is
  // cross-origin and was not captured. /__ss/* is re-originated server-side.
  if (pathname.startsWith('/__ss/')) {
    return proxySymbolSearch(req, res, pathname.slice('/__ss'.length));
  }

  // Community / script-library endpoints were not captured. Re-originate the
  // public ones so the dialog's Editors' picks / Top / Trending tabs fill in
  // (they use ?offset&count&sort paging). personal-access requires a login and
  // just returns the upstream status. The captured POST /pubscripts-get/ (exact)
  // is left to the static handler below.
  if (pathname.startsWith('/pubscripts-library/')
      || pathname === '/pubscripts-get/personal-access/'
      || pathname === '/api/v1/script_packages/store/') {
    return proxyUpstream('www.tradingview.com', req, res, pathname, 'pubscripts');
  }

  // pine-facade serves the study metadata / compiled script used when adding a
  // built-in indicator or restoring a saved one (is_auth_to_get, versions/.../last,
  // translate). Only a couple of responses were captured, so serve those from
  // disk and re-originate everything else to the live host; otherwise adding any
  // indicator 404s and silently does nothing.
  if (pathname.startsWith('/pine-facade.tradingview.com/pine-facade/')) {
    const rel = pathname.slice('/pine-facade.tradingview.com/'.length);
    let local = path.join(ROOT, 'pine-facade.tradingview.com', rel);
    if (rel.endsWith('/') || rel.endsWith('\\')) local = path.join(local, 'index.html');
    if (!fs.existsSync(local) && fs.existsSync(local + '.html')) local += '.html';
    if (fs.existsSync(local) && fs.statSync(local).isFile()) {
      return send(res, 200, fs.readFileSync(local, 'utf8'), 'text/plain; charset=utf-8');
    }
    const rawPath = req.url.split('?')[0];
    return proxyUpstream('pine-facade.tradingview.com', req, res,
      rawPath.replace('/pine-facade.tradingview.com', ''), 'pine-facade');
  }

  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { Location: '/www.tradingview.com/chart/j3mUKCaZ/' });
    return res.end();
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  // map to file
  let file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');

  // the page lives under /www.tradingview.com/... ; also accept /chart/... and /api/...
  if (!fs.existsSync(file)) {
    const alt = path.join(ROOT, 'www.tradingview.com', pathname);
    if (fs.existsSync(alt)) file = alt;
  }

  // allow extensionless -> .html
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';

  // Layout switching: /chart/<uid>/ for a locally-saved layout serves the base
  // chart page with that layout's initData spliced in.
  const chartMatch = /^(?:\/www\.tradingview\.com)?\/chart\/([^/]+)\/index\.html$/.exec(pathname);
  const chartUid = chartMatch ? chartMatch[1] : null;
  const savedLayouts = readLayouts();
  if ((!fs.existsSync(file) || !fs.statSync(file).isFile()) && chartUid) {
    const base = path.join(ROOT, 'www.tradingview.com', 'chart', 'j3mUKCaZ', 'index.html');
    if (fs.existsSync(base)) file = base;
  }

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    try { fs.appendFileSync(path.join(ROOT, 'serve-404.log'), new Date().toISOString() + ' ' + req.method + ' ' + pathname + '\n'); } catch {}
    return send(res, 404, 'not found: ' + pathname);
  }

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  // Rewrite HTML / CSS / JS so absolute tradingview URLs resolve locally.
  if (ext === '.html' || ext === '.css' || ext === '.js' || ext === '.svg') {
    let body = fs.readFileSync(file, 'utf8');
    body = rewrite(body);
    // Apply our local override patches (limits, features, UI tweaks).
    if (ext === '.js') {
      const res = applyJsPatches(body);
      body = res.text;
      if (res.applied.length && !servedPatches.has(pathname)) {
        servedPatches.add(pathname);
        console.log('patched ' + pathname + ' -> ' + res.applied.join(', '));
      }
    } else if (ext === '.html') {
      body = applyHtmlPatches(body).text;
      // Restore the saved layout state (symbol/interval/studies/settings) for
      // this chart page so reopening the app shows the last-saved layout.
      if (chartUid && savedLayouts[chartUid]) {
        body = spliceInitData(body, savedLayouts[chartUid]);
      }
      // Use the live auth token instead of the page's frozen (expired) one.
      body = applyAuthToken(body);
    }
    return send(res, 200, body, type);
  }

  const buf = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
  });
  res.end(buf);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('serving ' + ROOT);
  console.log('http://127.0.0.1:' + PORT + '/chart/j3mUKCaZ/');
});