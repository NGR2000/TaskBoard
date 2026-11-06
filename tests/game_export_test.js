/* docs/admin/game-export.js: TaskBoard のフライト(schemaVersion 2)→ ゲームのタスクファイル。
   実データの形(JSON/ の fixtures)と、作り話の例で確かめる。 node tests/game_export_test.js */
const assert = require('assert');
const fs = require('fs');
const { toGameTaskFile, gameFileName } = require('../docs/admin/game-export.js');

let fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}

// 作り話のフライト(タスクシートの書き方の例)
const sample = {
  schemaVersion: 2,
  basicInfo: {
    competitionName: 'Practice Cup', date: '2026.11.1 AM',
    fields: [
      { label: 'Task / Marker', value: 'In Any Order' },
      { label: 'Flight No.', value: '2' },
      { label: 'CLP', value: '1600/ 8000' },
    ],
  },
  tasks: [
    { taskNo: '6', taskId: 'PDG', loggerMarker: '1', fields: [{ label: 'Method of declaration', value: 'before launch Logger goal #1' }] },
    { taskNo: '7', taskId: 'JDG', loggerMarker: '2', targets: [{ name: 'Red', color: 'Red', coordinates: '1653/8209', mma: 'sketch' }] },
    { taskNo: '10', taskId: 'jdg', loggerMarker: '5', cancelled: true, targets: [{ coordinates: '1600/8000', altitude: '2000ft' }] },
    { taskNo: '13', taskId: 'HWZ', loggerMarker: '6', targetGPS: '1650/8208 (Red), 1927 7744 (White)' },
  ],
};

check('基本: 形式・題名・順不同・CLP', () => {
  const g = toGameTaskFile(sample);
  assert.strictEqual(g.format, 'balloon-task-file');
  assert.strictEqual(g.version, 1);
  assert.strictEqual(g.title, 'Practice Cup 2026.11.1 AM Flight 2');
  assert.strictEqual(g.taskOrder, 'any');
  assert.deepStrictEqual(g.clp, { grid: '1600/8000' });
});

check('タスク: 番号・種類・マーカー・宣言ゴール・キャンセル・ターゲット(グリッドはそのまま)', () => {
  const g = toGameTaskFile({ data: sample }); // DB の行(data に中身)でも読める
  assert.deepStrictEqual(g.tasks[0], { no: '6', type: 'PDG', marker: '1', loggerGoal: 1 });
  assert.deepStrictEqual(g.tasks[1], { no: '7', type: 'JDG', marker: '2', targets: [{ grid: '1653/8209', name: 'Red' }] });
  assert.deepStrictEqual(g.tasks[2], { no: '10', type: 'JDG', marker: '5', cancelled: true, targets: [{ grid: '1600/8000', altitude: '2000ft' }] });
  assert.deepStrictEqual(g.tasks[3].targets, [{ name: 'Red', grid: '1650/8208' }, { name: 'White', grid: '1927/7744' }], '旧形式の targetGPS');
});

check('順番: 各タスクの Task order がそろっていればそれ', () => {
  const fx = JSON.parse(fs.readFileSync(__dirname + '/../JSON/watarase_practice_20260808_flight1.json', 'utf8'));
  const g = toGameTaskFile(fx);
  assert.strictEqual(g.taskOrder, undefined, '"in any order" と "in order" が混ざっていれば書かない');
  const fin = g.tasks.find((t) => t.type === 'FIN');
  assert.deepStrictEqual(fin.targets, [{ grid: '38140/1270', altitude: '-50ft' }]);
  const pdg = g.tasks.find((t) => t.type === 'PDG');
  assert.strictEqual(pdg.loggerGoal, 2, '説明文 "in loggergoal #2 or #3 before TO" の最初の番号');
  const rta = g.tasks.find((t) => t.type === 'RTA');
  assert.strictEqual(rta.loggerGoal, undefined, 'RTA の宣言(時間)は notes にあり、位置ではないので読まない');
});

check('実データの fixtures がすべて変換できる', () => {
  const dir = __dirname + '/../JSON/';
  fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).forEach((f) => {
    const j = JSON.parse(fs.readFileSync(dir + f, 'utf8'));
    if (j.schemaVersion !== 2) return;
    const g = toGameTaskFile(j);
    assert.ok(Array.isArray(g.tasks) && g.tasks.length, f);
    g.tasks.forEach((t) => (t.targets || []).forEach((x) => assert.ok(/^\d{4,6}\/\d{3,7}$/.test(x.grid), f + ' ' + x.grid)));
  });
});

check('ファイル名', () => {
  assert.strictEqual(gameFileName({ key: 'saga 2026/11-01 AM' }), 'saga_2026_11-01_AM-game-tasks.json');
  assert.throws(() => toGameTaskFile({}));
});

console.log('失敗: ' + fail);
process.exit(fail ? 1 : 0);
