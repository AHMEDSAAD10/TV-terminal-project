const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
function scan(pat) {
  for (const f of files) {
    let c;
    try { c = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    let i = c.indexOf(pat);
    if (i >= 0) {
      console.log('=== ' + f + ' [' + pat + '] @' + i + ' ===');
      console.log(c.slice(Math.max(0, i - 250), i + 650).replace(/\s+/g, ' '));
      console.log();
    }
  }
}
scan('insertStudy({descriptor');
scan('descriptor:o,insertionInfo');
scan('insertStudy(e)');
scan('.insertStudy=');