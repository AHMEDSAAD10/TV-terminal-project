const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'static.tradingview.com', 'static', 'bundles');
const s = fs.readFileSync(path.join(dir, 'runtime.d460c5150aac666865fc.js'), 'utf8');
const i = s.indexOf('.u=e=>');
console.log('idx', i, 'len', s.length);
console.log(s.slice(Math.max(0, i - 3000), i + 4000));