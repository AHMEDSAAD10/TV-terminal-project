const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
const pats = ['createStudyInserter', 'requestBuiltinScripts', 'insertStudyFromMetaInfo', 'onSelectScript', 'addStudyFromMarket'];
for (const f of files) {
  let c;
  try { c = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
  for (const p of pats) {
    let i = c.indexOf(p);
    if (i >= 0) {
      console.log('=== ' + f + ' [' + p + '] @' + i + ' ===');
      console.log(c.slice(Math.max(0, i - 300), i + 500).replace(/\s+/g, ' '));
      console.log();
    }
  }
}