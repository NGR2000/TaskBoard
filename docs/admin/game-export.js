/* 管理者向け: TaskBoard のフライト(schemaVersion 2)を、熱気球フライトゲームの「タスクファイル」(JSON)に変換する。
   ゲームの形の説明: https://github.com/NGR2000/balloon-supporters の championship/TASK-FILE-FORMAT.md
   - タスクシートの表記をそのまま渡す(グリッドは緯度経度に直さない。ゲームが IGC の離陸地点を基準に直す)
   - クルー画面では使わない(管理画面だけが読み込む)
   ブラウザでは window.toGameTaskFile、Node(テスト)では module.exports で使う */
(function (root) {
  'use strict';

  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function fieldsOf(o) { return (o && Array.isArray(o.fields)) ? o.fields : []; }
  function findField(fields, re) {
    for (var i = 0; i < fields.length; i++) if (re.test(str(fields[i].label))) return str(fields[i].value);
    return '';
  }
  // "1600/ 8000" "1650 8208" → "1600/8000"。グリッドらしくなければ空
  function normGrid(v) {
    var m = /(\d{4,6})\s*[\/ ]\s*(\d{3,7})/.exec(str(v));
    return m ? m[1] + '/' + m[2] : '';
  }
  // 旧形式の targetGPS: "1650/8208 (Red), 1927/7744 (White)"
  function legacyTargets(text) {
    var out = [], re = /(\d{4,6})\s*[\/ ]\s*(\d{3,7})\s*(?:\(([^)]*)\))?/g, m;
    while ((m = re.exec(str(text)))) out.push({ name: str(m[3]), grid: m[1] + '/' + m[2] });
    return out;
  }
  function orderOf(text) {
    var s = str(text).toLowerCase();
    if (!s) return '';
    if (/any\s*order|順不同/.test(s)) return 'any';
    if (/in\s*order|順番/.test(s)) return 'fixed';
    return '';
  }
  // 宣言ゴールの番号: "Loggergoal: 1"、または説明文の "loggergoal #2"・"Logger goal #1"
  function loggerGoalOf(task) {
    var fields = fieldsOf(task);
    for (var i = 0; i < fields.length; i++) {
      var label = str(fields[i].label), value = str(fields[i].value);
      if (/^logger\s*goal/i.test(label)) { var a = /\d+/.exec(value); if (a) return Number(a[0]); }
      var b = /logger\s*goal\s*#?\s*(\d+)/i.exec(value);
      if (b) return Number(b[1]);
    }
    return null;
  }

  function toGameTaskFile(flight) {
    var data = flight && flight.data ? flight.data : flight;
    if (!data || !Array.isArray(data.tasks)) throw new Error('タスクがありません');
    var basic = data.basicInfo || {};
    var bf = fieldsOf(basic);
    var flightNo = findField(bf, /^flight(\s*no\.?)?$/i);
    var title = [str(basic.competitionName), str(basic.date), flightNo ? 'Flight ' + flightNo : ''].filter(Boolean).join(' ');

    // 順番: 基本情報の "Task / Marker" "Task order"。無ければ各タスクの "Task order" がすべて同じならそれ
    var order = orderOf(findField(bf, /task\s*(\/\s*marker|order)/i));
    if (!order) {
      var each = data.tasks.map(function (t) { return orderOf(findField(fieldsOf(t), /task\s*order/i)); });
      if (each.length && each.every(function (o) { return o && o === each[0]; })) order = each[0];
    }
    var clp = normGrid(findField(bf, /^(clp|common launch point)$/i));

    var tasks = data.tasks.map(function (t) {
      var out = { no: str(t.taskNo), type: str(t.taskId).toUpperCase() };
      if (str(t.loggerMarker)) out.marker = str(t.loggerMarker);
      var goal = loggerGoalOf(t);
      if (goal !== null) out.loggerGoal = goal;
      if (t.cancelled === true) out.cancelled = true;
      var targets = Array.isArray(t.targets) && t.targets.length
        ? t.targets.map(function (g) {
            var o = { grid: normGrid(g.coordinates) };
            var name = str(g.name || g.color);
            if (name) o.name = name;
            if (str(g.altitude)) o.altitude = str(g.altitude);
            return o;
          })
        : legacyTargets(t.targetGPS);
      targets = targets.filter(function (g) { return g.grid; });
      if (targets.length) out.targets = targets;
      return out;
    }).filter(function (t) { return t.no || t.type; });

    var file = { format: 'balloon-task-file', version: 1 };
    if (title) file.title = title;
    if (order) file.taskOrder = order;
    if (clp) file.clp = { grid: clp };
    file.tasks = tasks;
    return file;
  }

  // ダウンロードするファイル名(フライトのキーから。使えない文字は _ に)
  function gameFileName(flight) {
    var base = str(flight && (flight.key || flight.label)) || 'flight';
    return base.replace(/[^\w.-]+/g, '_').slice(0, 60) + '-game-tasks.json';
  }

  root.toGameTaskFile = toGameTaskFile;
  root.gameFileName = gameFileName;
  if (typeof module !== 'undefined' && module.exports) module.exports = { toGameTaskFile: toGameTaskFile, gameFileName: gameFileName };
})(typeof window !== 'undefined' ? window : this);
