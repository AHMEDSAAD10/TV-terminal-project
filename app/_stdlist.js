const fs = require('fs');
const file = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/pine-facade.tradingview.com/pine-facade/list-7c2c823b94c56.html';
const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('total std entries:', arr.length);
const want = ['STD;EMA', 'STD;DEMA', 'STD;TEMA', 'STD;DMI', 'STD;DONCH', 'STD;EFI', 'STD;EOM', 'STD;ENV', 'STD;FISHER', 'STD;CORREL', 'STD;DPO', 'STD;CVD', 'STD;GAPS'];
for (const e of arr) {
  if (want.some(w => (e.scriptIdPart || '').toUpperCase().startsWith(w))) {
    console.log(JSON.stringify({ id: e.scriptIdPart, name: e.scriptName, short: e.extra && e.extra.shortDescription, kind: e.extra && e.extra.kind, builtin: e.extra && e.extra.isBuiltIn }));
  }
}
console.log('--- first 15 ---');
for (const e of arr.slice(0, 15)) {
  console.log(JSON.stringify({ id: e.scriptIdPart, name: e.scriptName, short: e.extra && e.extra.shortDescription }));
}