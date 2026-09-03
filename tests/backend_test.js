const { makeContext } = require('./gas_harness');
let fail = 0;
function check(n, c, e) { console.log((c?'  ✓ ':'  ✗ ')+n+(!c&&e?'  → '+e:'')); if(!c) fail++; }
const TOKEN = 'a'.repeat(48);
const flightJson = JSON.stringify({ basicInfo: { date: '2026.8.22', competitionName: 'Watarase Practice' },
  tasks: [{taskNo:'1',taskId:'JDG'},{taskNo:'2',taskId:'PDG'}] });

console.log('\n[1] 新規シートに登録 → 6列で書かれる');
let c = makeContext({ props: { TASKBOARD_API_TOKEN: TOKEN } });
let r = c.saveFlight(TOKEN, '', 'テスト便', flightJson);
check('登録できる', r.ok && r.taskCount === 2, JSON.stringify(r));
let rows = c.readFlightRows_();
check('1件読める', rows.length === 1, JSON.stringify(rows.length));
check('archived は空で始まる', rows[0].archived === '', JSON.stringify(rows[0].archived));
check('ヘッダーが6列', c.__ss.getSheetByName('flights').getRange(1,1,1,6).getValues()[0].join(',') === 'key,label,date,updatedAt,json,archived');

console.log('\n[2] アーカイブ → 戻す');
const key = r.key;
let a = c.setFlightArchived(TOKEN, key, true);
check('アーカイブできる', a.ok && !!a.archived, JSON.stringify(a));
check('読み直すとアーカイブ済み', !!c.readFlightRows_()[0].archived);
check('apiFlights_ が archived を返す', !!c.apiFlights_().flights[0].archived);
check('apiFlights_ が competitionName を返す', c.apiFlights_().flights[0].competitionName === 'Watarase Practice', JSON.stringify(c.apiFlights_().flights[0]));
check('apiFlights_ の taskCount が正しい', c.apiFlights_().flights[0].taskCount === 2);
c.setFlightArchived(TOKEN, key, false);
check('戻せる', c.readFlightRows_()[0].archived === '');

console.log('\n[3] ★退行しやすい箇所: 再登録してもアーカイブ状態が消えない');
c.setFlightArchived(TOKEN, key, true);
const before = c.readFlightRows_()[0].archived;
c.saveFlight(TOKEN, key, 'テスト便（訂正）', flightJson);   // 同じ key で上書き
const after = c.readFlightRows_()[0];
check('archived が維持される', after.archived === before, 'before=' + before + ' after=' + after.archived);
check('ラベルは更新される', after.label === 'テスト便（訂正）', after.label);
check('タスク本体も更新される', after.json === flightJson);

console.log('\n[4] 既存の5列シートからの移行');
let c2 = makeContext({ props: { TASKBOARD_API_TOKEN: TOKEN } });
const old = c2.__ss.insertSheet('flights');       // 旧ヘッダーのまま作る
old.getRange(1,1,1,5).setValues([['key','label','date','updatedAt','json']]);
old.appendRow(['legacy-1','昔のフライト','01.05.2025 AM','2025-05-01T00:00:00Z', flightJson]);
let legacy = c2.readFlightRows_();
check('旧5列の行が読める', legacy.length === 1 && legacy[0].key === 'legacy-1', JSON.stringify(legacy.length));
check('archived は空扱い', legacy[0].archived === '');
check('ヘッダーが6列に直る', old.getRange(1,1,1,6).getValues()[0][5] === 'archived', JSON.stringify(old.getRange(1,1,1,6).getValues()[0]));
c2.setFlightArchived(TOKEN, 'legacy-1', true);
check('旧行もアーカイブできる', !!c2.readFlightRows_()[0].archived);

console.log('\n[5] 5列に切り詰められたシートでも落ちない');
let c3 = makeContext({ props: { TASKBOARD_API_TOKEN: TOKEN } });
const narrow = c3.__ss.insertSheet('flights');
narrow._maxCols = 5;
narrow.getRange(1,1,1,5).setValues([['key','label','date','updatedAt','json']]);
narrow.appendRow(['n1','狭いシート','2026.8.8','2026-08-08T00:00:00Z', flightJson]);
let ok5 = true, err = '';
try { c3.readFlightRows_(); } catch (e) { ok5 = false; err = e.message; }
check('範囲外エラーにならない', ok5, err);
check('列が広がる', narrow.getMaxColumns() >= 6, String(narrow.getMaxColumns()));

console.log('\n[6] doPost: archiveFlight とトークン検証');
let c4 = makeContext({ props: { TASKBOARD_API_TOKEN: TOKEN } });
c4.saveFlight(TOKEN, 'k1', 'A', flightJson);
function post(body) { return JSON.parse(c4.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); }
check('正しいトークンでアーカイブできる', post({token:TOKEN, action:'archiveFlight', key:'k1', archived:true}).ok);
check('state に反映される', !!post({token:TOKEN, action:'state'}).flights[0].archived);
check('戻せる', post({token:TOKEN, action:'archiveFlight', key:'k1', archived:false}).ok);
check('誤ったトークンは弾かれる', post({token:'wrong', action:'archiveFlight', key:'k1', archived:true}).error === 'unauthorized');

console.log('\n[7] ★fail-closed: トークン未設定なら空トークンでも通さない');
let c5 = makeContext({ props: {} });     // TASKBOARD_API_TOKEN 未設定
function post5(body) { return JSON.parse(c5.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); }
check('空トークンを拒否', post5({token:'', action:'state'}).error === 'unauthorized', JSON.stringify(post5({token:'', action:'state'})));
check('token 省略も拒否', post5({action:'state'}).error === 'unauthorized');

console.log('\n失敗: ' + fail);
process.exit(fail ? 1 : 0);
