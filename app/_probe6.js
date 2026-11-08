const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';
const c = fs.readFileSync(path.join(dir, '28732.03a87d0549b0d0d7e013.js'), 'utf8');
function show(i, pre, post) {
  console.log('---- @' + i + ' ----');
  console.log(c.slice(Math.max(0, i - pre), i + post).replace(/\s+/g, ' '));
  console.log();
}
show(90330, 1400, 1800);
const pats = ['_addStudy', 'addStudyToChart', 'onStudyAdded', 'createStudyFrom', 'runStudy', 'studySelected', 'onClickStudy', 'addToChart', 'handleStudy'];
for (const p of pats) {
  let i = c.indexOf(p);
  if (i >= 0) { console.log('HIT ' + p + ' @' + i); show(i, 400, 600); }
}