const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';
const c = fs.readFileSync(path.join(dir, '97554.d905131ef6df6c297527.js'), 'utf8');
function show(i, pre, post) {
  console.log('---- @' + i + ' ----');
  console.log(c.slice(Math.max(0, i - pre), i + post).replace(/\s+/g, ' '));
  console.log();
}
show(521396, 1200, 1600);
show(528659, 900, 1200);
show(378930, 700, 900);