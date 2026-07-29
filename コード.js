/**
 * TaskBoard — GAS 側
 *
 * 役割は 2 つだけ。
 *   1. 入力・管理画面（doGet に action が無い時）— 入力担当が使う。google.script.run なので確実に動く。
 *   2. 閲覧用の JSON API（doGet?action=...）— GitHub Pages の PWA が読む。GET のみ。
 *
 * 閲覧側を GitHub Pages に置いたことで、GAS を再デプロイしても
 * クルーに配ったリンクは変わらない。
 */

/** クルーに配る閲覧アプリ（GitHub Pages）の URL */
var APP_URL = 'https://ngr2000.github.io/TaskBoard/';

var SHEET_DATA = 'data';
var SHEET_IMAGE = 'image';
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
        out = { ok: true, updatedAt: readUpdatedAt_(), version: 2 };
        break;
      case 'data':
        out = apiData_();
        break;
      case 'image':
        out = { ok: true, image: getImageData_() };
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
// API 本体
// =====================================================================

/**
 * 閲覧アプリが最初に叩くエンドポイント。
 * 画像の base64 は含めない（同期のたびに数百KB乗るのを避けるため）。
 * 画像は action=image / action=sketch で必要になった時だけ取りに来る。
 */
function apiData_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_DATA);
  var data = sheet ? String(sheet.getRange('A1').getValue() || '') : '';
  var updatedAt = sheet ? String(sheet.getRange('B1').getValue() || '') : '';

  return {
    ok: true,
    version: 2,
    data: data.length > 10 ? data : null,
    updatedAt: updatedAt || null,
    hasImage: hasContent_(ss.getSheetByName(SHEET_IMAGE)),
    sketchTaskNos: listSketchTaskNos_(ss)
  };
}

function hasContent_(sheet) {
  return !!(sheet && sheet.getLastRow() > 0 && String(sheet.getRange(1, 1).getValue() || '') !== '');
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

function readUpdatedAt_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_DATA);
  return sheet ? String(sheet.getRange('B1').getValue() || '') : '';
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

function getImageData_() {
  try {
    return readChunks_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_IMAGE));
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
function saveTaskData(dataStr) {
  var parsed = JSON.parse(dataStr); // 壊れた JSON はここで弾く
  if (!parsed || !parsed.tasks) throw new Error('tasks が含まれていません');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_DATA) || ss.insertSheet(SHEET_DATA);
  sheet.getRange('A1').setValue(dataStr);
  sheet.getRange('B1').setValue(new Date().toISOString());
  return { ok: true, taskCount: parsed.tasks.length };
}

function saveImageData(imageData) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_IMAGE) || ss.insertSheet(SHEET_IMAGE);
  writeChunks_(sheet, imageData);
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
  var sheet = ss.getSheetByName(SHEET_DATA);
  var data = sheet ? String(sheet.getRange('A1').getValue() || '') : '';
  var tasks = [];
  if (data.length > 10) {
    try {
      var parsed = JSON.parse(data);
      tasks = (parsed.tasks || []).map(function (t, i) {
        return {
          taskNo: String(t.taskNo || t.TaskNo || (i + 1)),
          taskId: String(t.taskId || t.type || ''),
          name: String(t.name || t.typeName || '')
        };
      });
    } catch (e) { /* 壊れていても管理画面は開けるようにする */ }
  }
  return {
    ok: true,
    hasData: data.length > 10,
    updatedAt: sheet ? String(sheet.getRange('B1').getValue() || '') : '',
    hasImage: hasContent_(ss.getSheetByName(SHEET_IMAGE)),
    sketchTaskNos: listSketchTaskNos_(ss),
    tasks: tasks,
    execUrl: getExecUrl_(),
    appUrl: APP_URL
  };
}

function resetTaskData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ['data', 'image'].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (sheet) sheet.clearContents();
  });
  ss.getSheets().forEach(function (sheet) {
    if (sheet.getName().indexOf(SKETCH_PREFIX) === 0) sheet.clearContents();
  });
  return true;
}
