// Pull the live TradingView auth token (and sessionid cookie) from the
// DevTools-enabled Brave on 127.0.0.1:9222 and cache them for serve.js.
//
// Usage:
//   node token-refresh.js           -> one shot
//   node token-refresh.js --watch   -> refresh every 30 min and keep Brave alive
//
// Requires a Brave/Chromium started with --remote-debugging-port=9222 and a
// logged-in tradingview.com tab.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TOKEN_FILE = path.join(ROOT, 'auth-token.txt');
const CDP = 'http://127.0.0.1:9222';

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function listTargets() {
  const r = await fetch(CDP + '/json');
  if (!r.ok) throw new Error('CDP /json -> ' + r.status);
  return r.json();
}

function cdpSend(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function fetchCreds() {
  const targets = await listTargets();
  const page = targets.find(t => t.type === 'page' && /tradingview\.com/.test(t.url));
  if (!page) throw new Error('no tradingview.com page open in Brave (9222)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true });
  });
  try {
    let id = 0;
    const evalRes = await cdpSend(ws, ++id, 'Runtime.evaluate', {
      expression: '(window.user && window.user.auth_token) || ""',
      returnByValue: true,
    });
    const token = (evalRes && evalRes.result && evalRes.result.value) || '';
    const cookieRes = await cdpSend(ws, ++id, 'Network.getCookies', { urls: ['https://www.tradingview.com/'] });
    const cookies = (cookieRes && cookieRes.cookies) || [];
    const sessionid = (cookies.find(c => c.name === 'sessionid') || {}).value || '';
    const cookieHeader = cookies.map(c => c.name + '=' + c.value).join('; ');
    return { token, sessionid, cookieHeader, url: page.url };
  } finally {
    try { ws.close(); } catch {}
  }
}

function decodePayload(t) {
  try {
    const p = t.split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

async function refresh() {
  const { token, sessionid, cookieHeader, url } = await fetchCreds();
  if (!token) throw new Error('empty token (Brave tab not logged in?)');
  const prev = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
  fs.writeFileSync(TOKEN_FILE, token);
  if (sessionid) fs.writeFileSync(path.join(ROOT, 'session-cookie.txt'), sessionid);
  if (cookieHeader) fs.writeFileSync(path.join(ROOT, 'cookie-header.txt'), cookieHeader);
  const d = decodePayload(token);
  const changed = token !== prev;
  log('token ' + (changed ? 'UPDATED' : 'unchanged') + ' len=' + token.length +
      ' exp=' + (d && d.exp ? new Date(d.exp * 1000).toISOString() : '?') +
      ' max_studies=' + (d && d.max_studies));
  if (!changed && prev) log('  (source ' + url + ')');
  return token;
}

(async () => {
  const watch = process.argv.includes('--watch');
  const once = async () => { try { await refresh(); } catch (e) { log('ERROR ' + e.message); } };
  await once();
  if (watch) setInterval(once, 30 * 60 * 1000);
})();
