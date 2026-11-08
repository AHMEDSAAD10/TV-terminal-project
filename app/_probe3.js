const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';
const c = fs.readFileSync(path.join(dir, '92005.632183ae5505103ec16d.js'), 'utf8');
function show(i, pre, post) {
  console.log('---- @' + i + ' ----');
  console.log(c.slice(Math.max(0, i - pre), i + post).replace(/\s+/g, ' '));
  console.log();
}
show(3884, 900, 1200);
show(10645, 1200, 1800);
show(22249, 1400, 1600);