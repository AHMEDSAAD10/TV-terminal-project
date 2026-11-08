const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'static.tradingview.com', 'static', 'bundles');
const s = fs.readFileSync(path.join(dir, 'runtime.d460c5150aac666865fc.js'), 'utf8');
const ids = ['61809', '12227', '40886', '66866'];
for (const id of ids) {
  const re = new RegExp(`if\\(${id}===e\\)return"([^"]+)"`);
  const m = s.match(re);
  if (m) {
    const name = m[1];
    const p = path.join(dir, name);
    console.log(id, '->', name, fs.existsSync(p) ? 'EXISTS' : 'MISSING');
  } else {
    console.log(id, '-> no mapping found');
  }
}
// Show the tail of _.u (default branch) to understand prefix
const i = s.indexOf('.u=e=>');
const end = s.indexOf('},', i);
console.log('\n--- tail of _.u ---');
console.log(s.slice(end - 700, end + 100));