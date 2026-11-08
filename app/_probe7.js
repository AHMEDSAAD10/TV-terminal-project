const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';
const c = fs.readFileSync(path.join(dir, '28732.03a87d0549b0d0d7e013.js'), 'utf8');
let i = c.indexOf('_insertStudyImpl');
console.log('first @' + i);
let n = 0;
while (i >= 0 && n < 3) {
  console.log('---- @' + i + ' ----');
  console.log(c.slice(Math.max(0, i - 200), i + 2600).replace(/\s+/g, ' '));
  console.log();
  i = c.indexOf('_insertStudyImpl', i + 10);
  n++;
}