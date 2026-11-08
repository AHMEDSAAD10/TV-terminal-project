const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';
const c = fs.readFileSync(path.join(dir, '28732.03a87d0549b0d0d7e013.js'), 'utf8');
console.log('len', c.length);
const pats = ['createStudy', 'InsertStudyCommand', 'javaStudies', 'standardScripts', 'requestJavaStudies', 'studyMetaInfoRepository', 'onStudySelected', 'findAllJavaStudies', 'insertStudy', 'addStudy'];
for (const p of pats) {
  let i = c.indexOf(p);
  console.log('[' + p + '] @' + i);
}
console.log('\n==== contexts ====');
function show(i, pre, post) {
  console.log('---- @' + i + ' ----');
  console.log(c.slice(Math.max(0, i - pre), i + post).replace(/\s+/g, ' '));
  console.log();
}
let i = c.indexOf('requestJavaStudies');
if (i >= 0) show(i, 600, 900);
i = c.indexOf('javaStudies');
if (i >= 0) show(i, 600, 900);