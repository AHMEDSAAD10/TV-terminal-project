// Keep auth-token.txt fresh without a browser.
//
// Fetches https://www.tradingview.com/ with the captured session cookies and
// extracts the freshly-issued auth_token from the authenticated page. TradingView
// tokens live ~4h, so we refresh well before expiry.
//
//   node token-keepalive.js           -> one shot
//   node token-keepalive.js --watch   -> refresh every 30 min
//
// Requires cookie-header.txt (captured by token-refresh.js from a logged-in
// browser). If TradingView ever rejects the cookies, re-capture them.

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TOKEN_FILE = path.join(ROOT, 'auth-token.txt');
const COOKIE_FILE = path.join(ROOT, 'cookie-header.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const KEY = '"auth_token":"';

function log(...a) { console.log(new Date().toISOString(), ...a); }

function fetchHome(cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.tradingview.com', path: '/', method: 'GET',
      headers: { Cookie: cookie, 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

function decode(t) {
  try { return JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return null; }
}

async function refresh() {
  if (!fs.existsSync(COOKIE_FILE)) throw new Error('cookie-header.txt missing');
  const cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  const { status, body } = await fetchHome(cookie);
  const i = body.indexOf(KEY);
  if (status !== 200 || i < 0) throw new Error('not authenticated (status ' + status + ', token ' + (i >= 0) + ') - re-capture cookies');
  const s = i + KEY.length; let e = s; while (body[e] !== '"') e++;
  const token = body.slice(s, e);
  const d = decode(token);
  if (!d || !d.exp) throw new Error('bad token payload');
  if (d.exp * 1000 < Date.now()) throw new Error('server returned an already-expired token');
  const prev = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
  fs.writeFileSync(TOKEN_FILE, token);
  log('token ' + (token !== prev ? 'UPDATED' : 'unchanged') + ' user=' + d.user_id + ' exp=' + new Date(d.exp * 1000).toISOString() + ' max_studies=' + d.max_studies);
  return token;
}

(async () => {
  const once = async () => { try { await refresh(); } catch (e) { log('ERROR ' + e.message); } };
  await once();
  if (process.argv.includes('--watch')) setInterval(once, 30 * 60 * 1000);
})();
