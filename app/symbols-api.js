// Local watchlist API for the mirrored TradingView app.
//
// The app's watchlist code talks to `TV_WATCHLISTS_URL + /api/v1/symbols_list/...`
// and the page sets TV_WATCHLISTS_URL = "" (same origin). In the original site
// that was tradingview.com; here it is our local server. Without this module
// every create/append/remove/copy call 404s and the UI silently does nothing.
//
// This implements the same endpoints on top of a JSON file, with NO plan limits.
// Data survives restarts in `watchlists.json`.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STORE_FILE = path.join(ROOT, 'watchlists.json');
const PAGE_FILE = path.join(ROOT, 'www.tradingview.com', 'chart', 'j3mUKCaZ', 'index.html');

let state = null;

function nowIso() {
  return new Date().toISOString().replace('Z', '000Z');
}

// ---------------------------------------------------------------- brace scan
// Extract `var user = {...};` from the mirrored page and parse it as JSON.
function extractJsonObjectAfter(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(from, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function seedFromPage() {
  try {
    const html = fs.readFileSync(PAGE_FILE, 'utf8');
    const user = extractJsonObjectAfter(html, 'var user = ');
    if (!user || !user.settings) return null;
    const raw = user.settings['symbollist.recents'];
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return null;

    const lists = [];
    for (const it of arr) {
      if (!it || !it.id) continue;
      if (it.id === 'deleted_symbols_list_id') continue;
      const isColor = it.type === 'color';
      lists.push(normalizeList({
        type: isColor ? 'color' : 'custom',
        id: isColor ? it.id : Number(it.id),
        color: isColor ? (it.color || it.id) : null,
        name: it.name ?? null,
        description: it.description ?? null,
        symbols: Array.isArray(it.symbols) ? it.symbols.slice() : [],
        shared: Boolean(it.shared),
        active: Boolean(it.active),
        created: it.created || nowIso(),
        modified: it.modified || nowIso(),
      }));
    }
    const active = lists.find(l => l.active) || lists[0] || null;
    return {
      nextId: Math.max(10000001, ...lists.filter(l => l.type === 'custom').map(l => Number(l.id) + 1)),
      activeId: active ? active.id : null,
      lists,
    };
  } catch (e) {
    console.error('watchlists: seed from page failed:', e.message);
    return null;
  }
}

function normalizeList(l) {
  return {
    type: l.type === 'color' ? 'color' : 'custom',
    id: l.type === 'color' ? String(l.id) : Number(l.id),
    color: l.type === 'color' ? (l.color || String(l.id)) : null,
    name: l.name ?? null,
    description: l.description ?? null,
    symbols: Array.isArray(l.symbols) ? l.symbols : [],
    shared: Boolean(l.shared),
    active: Boolean(l.active),
    created: l.created || nowIso(),
    modified: l.modified || nowIso(),
  };
}

function save() {
  try {
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) {
    console.error('watchlists: save failed:', e.message);
  }
}

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.lists)) {
        state = parsed;
        return state;
      }
    }
  } catch (e) {
    console.error('watchlists: store unreadable, reseeding:', e.message);
  }
  state = seedFromPage() || { nextId: 10000001, activeId: null, lists: [] };
  save();
  return state;
}

// ------------------------------------------------------------- serialization
// Shapes expected by the app's convertToCustomSymbolList / convertToMarkedSymbolList.
function toWire(l) {
  if (l.type === 'color') {
    return {
      id: l.id,
      color: l.color,
      type: 'color',
      name: l.name,
      description: l.description,
      symbols: l.symbols,
      shared: l.shared,
      active: l.active,
      created: l.created,
      modified: l.modified,
    };
  }
  return {
    id: l.id,
    type: 'custom',
    name: l.name,
    description: l.description,
    symbols: l.symbols,
    shared: l.shared,
    active: l.active,
    color: null,
    created: l.created,
    modified: l.modified,
  };
}

function findList(id) {
  const s = String(id);
  return load().lists.find(l => String(l.id) === s) || null;
}

function setActive(id) {
  const st = load();
  const target = findList(id);
  if (!target) return null;
  for (const l of st.lists) l.active = String(l.id) === String(id);
  st.activeId = target.id;
  save();
  return target;
}

function touch(l) {
  l.modified = nowIso();
  save();
  return l;
}

function dedupePush(arr, items) {
  const seen = new Set(arr);
  for (const s of items) {
    if (typeof s !== 'string') continue;
    if (!seen.has(s)) { seen.add(s); arr.push(s); }
  }
  return arr;
}

// ------------------------------------------------------------------- helpers
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(data); }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, code, obj) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function asSymbols(body) {
  if (Array.isArray(body)) return body.filter(x => typeof x === 'string');
  if (body && Array.isArray(body.symbols)) return body.symbols.filter(x => typeof x === 'string');
  if (typeof body === 'string') return [body];
  return [];
}

// ------------------------------------------------------------------- routing
// Returns true if the request was handled.
async function handle(req, res, pathname) {
  const PREFIX = '/api/v1/symbols_list';
  if (!pathname.startsWith(PREFIX)) return false;

  const st = load();
  let rest = pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '');
  const seg = rest.split('/').filter(Boolean);
  const method = req.method || 'GET';

  // /all/
  if (seg[0] === 'all' && method === 'GET') {
    return sendJson(res, 200, st.lists.map(toWire)), true;
  }

  // /active/  and  /active/:id/
  if (seg[0] === 'active') {
    if (method === 'GET') {
      const a = findList(st.activeId) || st.lists[0] || null;
      return sendJson(res, 200, a ? toWire(a) : null), true;
    }
    if (method === 'POST' && seg[1]) {
      const l = setActive(seg[1]);
      return sendJson(res, l ? 200 : 404, l ? toWire(l) : { detail: 'list not found', code: 'not_found' }), true;
    }
  }

  // /shared/:id/
  if (seg[0] === 'shared' && method === 'GET') {
    const l = findList(seg[1]);
    return sendJson(res, l ? 200 : 404, l ? toWire(l) : { detail: 'list not found', code: 'not_found' }), true;
  }

  // /colored/...  (marked lists, ids are color names)
  if (seg[0] === 'colored') {
    // GET /colored/ -> every colored list (the watchlist widget loads these first)
    if (seg.length === 1 && method === 'GET') {
      return sendJson(res, 200, st.lists.filter(l => l.type === 'color').map(toWire)), true;
    }
    if (method === 'DELETE') {
      for (const l of st.lists) if (l.type === 'color') l.symbols = [];
      save();
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end(), true;
    }
    if (seg[1] === 'bulk_remove' && method === 'POST') {
      const body = await readBody(req);
      const rm = new Set(asSymbols(body));
      for (const l of st.lists) if (l.type === 'color') l.symbols = l.symbols.filter(s => !rm.has(s));
      save();
      return sendJson(res, 200, []), true;
    }
    const color = seg[1];
    let l = color ? st.lists.find(x => x.type === 'color' && String(x.id) === String(color)) : null;
    if (color && !l) {
      // Auto-create a color list the first time it is touched.
      l = normalizeList({ type: 'color', id: color, color, name: null, symbols: [] });
      st.lists.push(l);
      save();
    }
    if (!color) return sendJson(res, 404, { detail: 'missing color', code: 'not_found' }), true;

    if (method === 'GET' && seg.length === 2) return sendJson(res, 200, toWire(l)), true;

    if (method === 'POST') {
      const body = await readBody(req);
      const action = seg[2] || '';
      if (action === 'append') {
        const add = asSymbols(body);
        // A symbol has exactly one flag color: moving it into this list removes
        // it from every other color list.
        const addSet = new Set(add);
        for (const other of st.lists) {
          if (other === l || other.type !== 'color') continue;
          const next = other.symbols.filter(s => !addSet.has(s));
          if (next.length !== other.symbols.length) {
            other.symbols = next;
            touch(other);
          }
        }
        dedupePush(l.symbols, add);
        touch(l);
        return sendJson(res, 200, l.symbols), true;
      }
      if (action === 'remove') {
        const rm = new Set(asSymbols(body));
        l.symbols = l.symbols.filter(s => !rm.has(s));
        touch(l);
        return sendJson(res, 200, l.symbols), true;
      }
      if (action === 'replace') {
        l.symbols = asSymbols(body);
        touch(l);
        return sendJson(res, 200, l.symbols), true;
      }
      if (action === 'rename') {
        if (body && typeof body.name === 'string') l.name = body.name;
        touch(l);
        return sendJson(res, 200, toWire(l)), true;
      }
      if (action === 'share') {
        if (body && typeof body.shared === 'boolean') l.shared = body.shared;
        touch(l);
        return sendJson(res, 200, toWire(l)), true;
      }
      if (action === 'replace_symbol' && body) {
        const from = body.old, to = body.new;
        l.symbols = l.symbols.map(s => (s === from ? to : s));
        touch(l);
        return sendJson(res, 200, toWire(l)), true;
      }
      // Unknown colored action: accept and echo, so the UI does not hang.
      return sendJson(res, 200, toWire(l)), true;
    }
    return sendJson(res, 405, { detail: 'method not allowed' }), true;
  }

  // /custom/...  (user watchlists, numeric ids)
  if (seg[0] === 'custom') {
    // POST /custom/  -> create
    if (method === 'POST' && seg.length === 1) {
      const body = await readBody(req) || {};
      const list = normalizeList({
        type: 'custom',
        id: st.nextId++,
        name: typeof body.name === 'string' ? body.name : 'New list',
        description: null,
        symbols: asSymbols(body),
        shared: false,
        active: false,
      });
      st.lists.push(list);
      save();
      return sendJson(res, 200, toWire(list)), true;
    }

    // GET /custom/ -> all custom lists
    if (method === 'GET' && seg.length === 1) {
      return sendJson(res, 200, st.lists.filter(l => l.type === 'custom').map(toWire)), true;
    }

    const l = findList(seg[1]);
    if (!l) return sendJson(res, 404, { detail: 'list not found', code: 'not_found' }), true;

    if (method === 'GET') return sendJson(res, 200, toWire(l)), true;

    if (method === 'DELETE') {
      st.lists = st.lists.filter(x => String(x.id) !== String(l.id));
      if (String(st.activeId) === String(l.id)) st.activeId = st.lists[0] ? st.lists[0].id : null;
      save();
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end(), true;
    }

    if (method === 'POST') {
      const body = await readBody(req);
      const action = seg[2] || '';

      if (action === 'append') {
        dedupePush(l.symbols, asSymbols(body));
        touch(l);
        return sendJson(res, 200, l.symbols), true;
      }
      if (action === 'remove') {
        const rm = new Set(asSymbols(body));
        l.symbols = l.symbols.filter(s => !rm.has(s));
        touch(l);
        return sendJson(res, 200, l.symbols), true;
      }
      if (action === 'replace') {
        l.symbols = asSymbols(body);
        touch(l);
        return sendJson(res, 200, l.symbols), true;
      }
      if (action === 'rename') {
        if (body && typeof body.name === 'string') l.name = body.name;
        touch(l);
        return sendJson(res, 200, toWire(l)), true;
      }
      if (action === 'update_meta') {
        if (body && 'description' in body) l.description = body.description;
        touch(l);
        return sendJson(res, 200, toWire(l)), true;
      }
      if (action === 'share') {
        if (body && typeof body.shared === 'boolean') l.shared = body.shared;
        touch(l);
        return sendJson(res, 200, toWire(l)), true;
      }
      if (action === 'replace_symbol' && body) {
        const from = body.old, to = body.new;
        l.symbols = l.symbols.map(s => (s === from ? to : s));
        touch(l);
        return sendJson(res, 200, toWire(l)), true;
      }
      // Unknown action: accept + echo current list so the UI never hangs.
      return sendJson(res, 200, toWire(l)), true;
    }

    return sendJson(res, 405, { detail: 'method not allowed' }), true;
  }

  return sendJson(res, 404, { detail: 'unknown watchlist route', code: 'not_found' }), true;
}

module.exports = { handle, STORE_FILE };