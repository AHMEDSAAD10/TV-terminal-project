const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';
for (const file of ['study-indicators-search-dialog.4dfffd4702b50c52e3d2.js', 'study-search-dialog.d0cca67b0f796efcf72f.js', 'study-market.a6aded772202f18dd0e5.js']) {
  const c = fs.readFileSync(path.join(dir, file), 'utf8');
  const i = c.indexOf('_insertStudyImpl');
  console.log('==== ' + file + ' len=' + c.length + ' @' + i + ' ====');
  console.log(c.slice(Math.max(0, i - 300), i + 2400).replace(/\s+/g, ' '));
  console.log();
}