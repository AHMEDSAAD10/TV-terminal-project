const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'static.tradingview.com', 'static', 'bundles');
const ids = ['61809', '12227', '40886', '66866'];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const found = {};
for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const id of ids) {
    const re = new RegExp(`["']?${id}["']?\\s*:\\s*["']([a-f0-9]{16,})["']`);
    const m = s.match(re);
    if (m) {
      if (!found[id]) found[id] = [];
      found[id].push({ hash: m[1], file: f });
    }
  }
}
console.log(JSON.stringify(found, null, 2));

// Also dump the chunk filename template function if present
for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  if (s.includes('static/bundles/') && /\.u\s*=\s*e=>/.test(s)) {
    const i = s.indexOf('.u=e=>');
    console.log('TEMPLATE in', f, ':', s.slice(i, i + 600));
    break;
  }
}