const fs = require('fs');
const path = require('path');
const dir = 'C:/Users/Trading/Documents/Default Project/_captures/tv-app-mirror/static.tradingview.com/static/bundles';

function probe(file, pats) {
  const c = fs.readFileSync(path.join(dir, file), 'utf8');
  console.log('==== ' + file + ' len=' + c.length + ' ====');
  for (const p of pats) {
    let i = c.indexOf(p);
    console.log('[' + p + '] @' + i);
  }
}

probe('97554.d905131ef6df6c297527.js', ['createStudyInserter', 'InsertStudyCommand', 'study_limit', 'studyLimit', 'type:"pine"', 'type:"java"', 'scriptIdPart', 'findStudyMetaInfoByDescription']);
probe('92005.632183ae5505103ec16d.js', ['filter=standard', 'createStudyInserter', 'InsertStudyCommand', 'type:"pine"', 'type:"java"', 'scriptIdPart', 'isStandardPine', 'STD;']);