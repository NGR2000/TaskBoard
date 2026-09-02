/**
 * TaskBoard — GAS 側
 *
 * 役割は 3 つ。
 *   1. 入力・管理画面（doGet に action が無い時）— 入力担当が使う。google.script.run なので確実に動く。
 *   2. 閲覧用の JSON API（doGet?action=...）— GitHub Pages の PWA が読む。GET のみ。認証なし。
 *   3. 書き込み API（doPost）— Claude から「変換 → 反映 → 原本アップ」を一気に行うための入口。
 *      2 と違い必ずトークンを検証する（トークンは tools/publish.py を参照）。
 *
 * データモデル: 「フライト」単位で複数保持する。
 * 大会中はフライトが進むごとに新しいタスクデータシートが発表されるため、
 * 直前のフライトを上書きするのではなく、シートに1行ずつ積んでいく。
 * クルー側はどのフライトへも後から切り替えて見られる。
 *
 * 閲覧側を GitHub Pages に置いたことで、GAS を再デプロイしても
 * クルーに配ったリンクは変わらない。
 */

/** クルーに配る閲覧アプリ（GitHub Pages）の URL */
var APP_URL = 'https://ngr2000.github.io/TaskBoard/';

var SHEET_FLIGHTS = 'flights';
var FLIGHTS_HEADER = ['key', 'label', 'date', 'updatedAt', 'json'];
var IMAGE_PREFIX = 'image_';
var SKETCH_PREFIX = 'sketch_';
var CHUNK_SIZE = 40000; // 1セルの上限 5万字に対する安全マージン

// =====================================================================
// エントリポイント
// =====================================================================
function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || '';

  if (!action) return renderAdmin_();

  var out;
  try {
    switch (action) {
      case 'ping':
        out = { ok: true, version: 3 };
        break;
      case 'flights':
        out = apiFlights_();
        break;
      case 'flight':
        out = apiFlight_(p.key);
        break;
      case 'image':
        out = { ok: true, image: getImageData_(p.key, p.page) };
        break;
      case 'sketch':
        out = { ok: true, taskNo: String(p.taskNo || ''), image: getSketchData(p.taskNo) };
        break;
      default:
        out = { ok: false, error: 'unknown action: ' + action };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return reply_(out, p.callback);
}

/**
 * 書き込み API。Claude などの外部ツールから
 * 「変換 → 反映 → 原本アップ」を一気に行うための入口。
 *
 * doGet と違い、必ずトークンを検証する。/exec の URL は docs/config.js 経由で
 * 公開されているので、URL を知っているだけでは書き込めないようにするため。
 * リクエストは JSON ボディで { token, action, ... } を送る。
 */
function doPost(e) {
  var out;
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);

    if (!tokenMatches_(body.token)) {
      return reply_({ ok: false, error: 'unauthorized' });
    }

    switch (body.action) {
      case 'ping':
        out = { ok: true, version: 3, write: true };
        break;
      case 'saveFlight':
        out = saveFlight(body.key, body.label,
          typeof body.data === 'string' ? body.data : JSON.stringify(body.data));
        break;
      case 'saveImage':
        saveImageData(body.key, body.page, body.imageData);
        out = { ok: true, key: body.key, page: Number(body.page) || 1 };
        break;
      case 'clearImages':
        out = { ok: true, key: body.key, deleted: clearImages_(body.key) };
        break;
      case 'deleteFlight':
        out = { ok: deleteFlight(body.key), key: body.key };
        break;
      case 'state':
        out = apiFlights_();
        break;
      default:
        out = { ok: false, error: 'unknown action: ' + body.action };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return reply_(out);
}

// =====================================================================
// 書き込み API のトークン
// =====================================================================
var PROP_TOKEN = 'TASKBOARD_API_TOKEN';

/** 無ければ生成して保存する。Web 画面には絶対に出さない（下の注意書きを参照）。 */
function getApiToken_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty(PROP_TOKEN);
  if (!token) {
    token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty(PROP_TOKEN, token);
  }
  return token;
}

/**
 * トークンを確認するときは、この関数を Apps Script エディタから実行して
 * 実行ログを見ること。
 *
 * 管理画面（doGet）に出してはいけない。デプロイの「アクセスできるユーザー」が
 * 「全員」なので、画面に出すと URL を知っている人全員がトークンを読めてしまう。
 */
function showApiToken() {
  Logger.log(getApiToken_());
}

/** トークンが漏れた時はこれをエディタから実行して作り直す（古いトークンは即無効になる）。 */
function regenerateApiToken() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_TOKEN);
  Logger.log(getApiToken_());
}

/** 一致しなくても途中で return しない（応答時間から桁を推測されにくくするため） */
function tokenMatches_(given) {
  var expected = getApiToken_();
  var got = String(given == null ? '' : given);
  if (got.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** そのフライトの原本ページを全部消す（再アップ時に古いページが残らないように） */
function clearImages_(key) {
  if (!key) throw new Error('フライトが指定されていません');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var deleted = 0;
  ss.getSheets().forEach(function (s) {
    var name = s.getName();
    if (name.indexOf(IMAGE_PREFIX + key + '_') === 0 || name === IMAGE_PREFIX + key) {
      ss.deleteSheet(s);
      deleted++;
    }
  });
  return deleted;
}

/** CORS が塞がれた環境向けに JSONP も返せるようにしておく */
function reply_(obj, callback) {
  var body = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + body + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(body)
    .setMimeType(ContentService.MimeType.JSON);
}

function renderAdmin_() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('TaskBoard 管理')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

function getExecUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

// =====================================================================
// flights シート
// =====================================================================
function getFlightsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_FLIGHTS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_FLIGHTS);
    sheet.getRange(1, 1, 1, FLIGHTS_HEADER.length).setValues([FLIGHTS_HEADER]);
  }
  return sheet;
}

/** [{rowIndex, key, label, date, updatedAt, json}] を登録順（シート上の行順）で返す */
function readFlightRows_() {
  var sheet = getFlightsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, FLIGHTS_HEADER.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue; // key が空の行は無視
    out.push({
      rowIndex: i + 2,
      key: String(row[0]),
      label: String(row[1] || ''),
      date: String(row[2] || ''),
      updatedAt: String(row[3] || ''),
      json: String(row[4] || '')
    });
  }
  return out;
}

function slugify_(label) {
  var s = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9぀-ヿ一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || ('flight-' + Utilities.getUuid().slice(0, 8));
}

function hasContent_(sheet) {
  return !!(sheet && sheet.getLastRow() > 0 && String(sheet.getRange(1, 1).getValue() || '') !== '');
}

/** 原本タスクシートはページ画像を image_<key>_1, _2, ... と連番で持つ。
 *  欠番なく先頭から数える（途中削除は無く、末尾からしか消せない設計のため）。
 *  複数ページ対応前に image_<key>（ページ番号なし）で保存された画像が
 *  残っている場合は、それを1ページ目として数える。 */
function countImagePages_(ss, key) {
  if (hasContent_(ss.getSheetByName(IMAGE_PREFIX + key)) && !hasContent_(ss.getSheetByName(IMAGE_PREFIX + key + '_1'))) {
    return 1;
  }
  var n = 0;
  while (hasContent_(ss.getSheetByName(IMAGE_PREFIX + key + '_' + (n + 1)))) n++;
  return n;
}

/** シート名を1回だけ走査する（タスク数ぶん getSheetByName を回さない） */
function listSketchTaskNos_(ss) {
  var out = [];
  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name.indexOf(SKETCH_PREFIX) !== 0) return;
    if (!hasContent_(sheet)) return;
    out.push(name.substring(SKETCH_PREFIX.length));
  });
  return out;
}

function taskSummary_(jsonStr) {
  try {
    var parsed = JSON.parse(jsonStr);
    return (parsed.tasks || []).map(function (t, i) {
      return {
        taskNo: String(t.taskNo || t.TaskNo || (i + 1)),
        taskId: String(t.taskId || t.type || ''),
        name: String(t.name || t.typeName || '')
      };
    });
  } catch (e) { return []; }
}

// =====================================================================
// API 本体（閲覧アプリ向け・GET専用）
// =====================================================================

/**
 * 閲覧アプリが最初に叩くエンドポイント。フライトの一覧（メタ情報のみ）を返す。
 * 各フライトの中身（json）はここでは返さない。action=flight で個別に取りに来る。
 */
function apiFlights_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rows = readFlightRows_();
  var flights = rows.map(function (r) {
    return {
      key: r.key,
      label: r.label,
      date: r.date,
      updatedAt: r.updatedAt,
      taskCount: taskSummary_(r.json).length,
      imagePages: countImagePages_(ss, r.key)
    };
  });
  return { ok: true, version: 3, flights: flights, sketchTaskNos: listSketchTaskNos_(ss) };
}

/** 指定フライトの中身（タスクJSON本体）を返す */
function apiFlight_(key) {
  if (!key) return { ok: false, error: 'key が指定されていません' };
  var rows = readFlightRows_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) {
      return { ok: true, key: key, data: rows[i].json, updatedAt: rows[i].updatedAt };
    }
  }
  return { ok: false, error: 'フライトが見つかりません: ' + key };
}

// =====================================================================
// 分割保存 / 復元（base64 を複数セルに分ける）
// =====================================================================
function writeChunks_(sheet, text) {
  sheet.clearContents();
  var chunks = [];
  for (var i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push([text.substring(i, i + CHUNK_SIZE)]);
  }
  if (chunks.length) sheet.getRange(1, 1, chunks.length, 1).setValues(chunks);
  sheet.getRange(chunks.length + 1, 1).setValue('__END__');
}

function readChunks_(sheet) {
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) return null;
  var values = sheet.getRange(1, 1, lastRow, 1).getValues();
  var result = '';
  for (var i = 0; i < values.length; i++) {
    var val = values[i][0];
    if (!val || val === '__END__') break;
    result += String(val);
  }
  return result || null;
}

function getImageData_(key, page) {
  try {
    if (!key) return null;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var p = Number(page) || 1;
    var sheet = ss.getSheetByName(IMAGE_PREFIX + key + '_' + p);
    if (!sheet && p === 1) sheet = ss.getSheetByName(IMAGE_PREFIX + key); // 複数ページ対応前の保存分
    return readChunks_(sheet);
  } catch (e) { return null; }
}

function getSketchData(taskNo) {
  try {
    var name = SKETCH_PREFIX + String(taskNo || '');
    return readChunks_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name));
  } catch (e) { return null; }
}

// =====================================================================
// 管理画面から呼ばれる関数（google.script.run）
// =====================================================================

/**
 * フライトを登録／更新する。
 * key が既存フライトと一致する場合は上書き（訂正の再登録）、
 * 一致しなければ新規フライトとして末尾に追加される。
 */
function saveFlight(key, label, dataStr) {
  var parsed = JSON.parse(dataStr); // 壊れた JSON はここで弾く
  if (!parsed || !parsed.tasks) throw new Error('tasks が含まれていません');

  var finalLabel = String(label || '').trim() || suggestLabel_(parsed);
  var finalKey = String(key || '').trim() || slugify_(finalLabel);
  var date = String((parsed.basicInfo && parsed.basicInfo.date) || '');
  var now = new Date().toISOString();

  var sheet = getFlightsSheet_();
  var rows = readFlightRows_();
  var existing = null;
  for (var i = 0; i < rows.length; i++) { if (rows[i].key === finalKey) { existing = rows[i]; break; } }

  if (existing) {
    sheet.getRange(existing.rowIndex, 1, 1, FLIGHTS_HEADER.length)
      .setValues([[finalKey, finalLabel, date, now, dataStr]]);
  } else {
    sheet.appendRow([finalKey, finalLabel, date, now, dataStr]);
  }
  return { ok: true, key: finalKey, label: finalLabel, taskCount: parsed.tasks.length };
}

/** JSON の中身からラベル案を作る（例: "Flight 3 (#8-#12)"） */
function suggestLabel_(parsed) {
  var fields = (parsed.basicInfo && parsed.basicInfo.fields) || [];
  var flightNo = '', tasks = '';
  fields.forEach(function (f) {
    var label = String(f.label || '').toLowerCase();
    if (label === 'flight' || label === 'flight no') flightNo = f.value;
    if (label === 'tasks') tasks = f.value;
  });
  if (flightNo) return 'Flight ' + flightNo + (tasks ? ' (' + tasks + ')' : '');
  return 'Flight ' + new Date().toLocaleString('ja-JP');
}

function deleteFlight(key) {
  var sheet = getFlightsSheet_();
  var rows = readFlightRows_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) {
      sheet.deleteRow(rows[i].rowIndex);
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      ss.getSheets().forEach(function (s) {
        var name = s.getName();
        if (name.indexOf(IMAGE_PREFIX + key + '_') === 0 || name === IMAGE_PREFIX + key) ss.deleteSheet(s);
      });
      return true;
    }
  }
  return false;
}

/** 原本タスクシートの1ページぶんを保存する。page を省略すると1ページ目。 */
function saveImageData(key, page, imageData) {
  if (!key) throw new Error('フライトが選択されていません');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = IMAGE_PREFIX + key + '_' + (Number(page) || 1);
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  writeChunks_(sheet, imageData);
  return true;
}

/** 原本タスクシートの最後のページを削除する（途中のページは削除できない設計）。 */
function deleteLastImagePage(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = countImagePages_(ss, key);
  if (n === 0) return false;
  var sheet = ss.getSheetByName(IMAGE_PREFIX + key + '_' + n) || ss.getSheetByName(IMAGE_PREFIX + key);
  if (sheet) ss.deleteSheet(sheet);
  return true;
}

function saveSketchData(taskNo, imageData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = SKETCH_PREFIX + String(taskNo || '');
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  writeChunks_(sheet, imageData);
  return true;
}

function deleteSketchData(taskNo) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SKETCH_PREFIX + String(taskNo || ''));
  if (sheet) sheet.clearContents();
  return true;
}

/** 管理画面の初期表示用。画像 base64 は返さない（有無だけ） */
function getAdminState() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rows = readFlightRows_();
  var flights = rows.map(function (r) {
    return {
      key: r.key,
      label: r.label,
      date: r.date,
      updatedAt: r.updatedAt,
      imagePages: countImagePages_(ss, r.key),
      tasks: taskSummary_(r.json)
    };
  });
  return {
    ok: true,
    flights: flights,
    sketchTaskNos: listSketchTaskNos_(ss),
    execUrl: getExecUrl_(),
    appUrl: APP_URL
  };
}

/** 大会全体のリセット（全フライト・全画像・全スケッチを削除）。管理画面のみから呼ぶ。 */
function resetAllData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var flightsSheet = ss.getSheetByName(SHEET_FLIGHTS);
  if (flightsSheet) ss.deleteSheet(flightsSheet);
  getFlightsSheet_();
  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name.indexOf(IMAGE_PREFIX) === 0 || name.indexOf(SKETCH_PREFIX) === 0) {
      ss.deleteSheet(sheet);
    }
  });
  return true;
}
