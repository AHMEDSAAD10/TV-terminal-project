const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'static.tradingview.com', 'static', 'bundles');
const s = fs.readFileSync(path.join(dir, 'runtime.d460c5150aac666865fc.js'), 'utf8');
for (const id of ['61809', '12227', '40886', '66866']) {
  let i = -1;
  let n = 0;
  console.log('##### ' + id + ' #####');
  while ((i = s.indexOf(id, i + 1)) >= 0 && n < 3) {
    console.log('@' + i + ': ' + JSON.stringify(s.slice(Math.max(0, i - 160), i + 160)));
    n++;
  }
}
console.log('\n--- lang file pattern ---');
const m = s.match(/61809===e\)return([^;]{0,200})/);
console.log(m && m[1]);