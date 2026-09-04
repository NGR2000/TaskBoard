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
// archived は末尾に足すこと。読み出しが位置ベース（row[0]..row[5]）なので、
// 途中に挿入すると json 列の位置がずれて全部壊れる。
var FLIGHTS_HEADER = ['key', 'label', 'date', 'updatedAt', 'json', 'archived'];
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
        out = { ok: true, flightKey: String(p.flightKey || ''), taskNo: String(p.taskNo || ''), image: getSketchData(p.flightKey, p.taskNo) };
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
        out = saveFlight(body.token, body.key, body.label,
          typeof body.data === 'string' ? body.data : JSON.stringify(body.data));
        break;
      case 'saveImage':
        saveImageData(body.token, body.key, body.page, body.imageData);
        out = { ok: true, key: body.key, page: Number(body.page) || 1 };
        break;
      case 'clearImages':
        out = { ok: true, key: body.key, deleted: clearImages_(body.key) };
        break;
      case 'deleteFlight':
        out = { ok: deleteFlight(body.token, body.key), key: body.key };
        break;
      case 'archiveFlight':
        out = setFlightArchived(body.token, body.key, !!body.archived);
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

/**
 * 未設定なら空文字を返す。設定は「プロジェクトの設定 → スクリプト プロパティ」から
 * 手で入れる（32文字以上のランダムな文字列）。
 *
 * ここに「無ければ自動生成する」処理を置いてはいけない。値を確認する手段が
 * 必要になり、その手段（関数）は google.script.run から誰でも呼べてしまうため。
 * スクリプト プロパティの画面は Google アカウントで保護されている唯一の場所。
 */
function getApiToken_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_TOKEN) || '';
}

/** 未設定の時は誰も通さない（設定し忘れが「素通し」にならないように） */
function tokenMatches_(given) {
  var expected = getApiToken_();
  return !!expected && secureEquals_(given, expected);
}

// =====================================================================
// 管理画面のパスフレーズ
//
// /exec は「アクセスできるユーザー: 全員」でデプロイされている（クルー用アプリが
// 匿名で読むため必須）。その結果、URL を知っていれば誰でも管理画面を開けてしまう。
// クルーに配ったブックマークを変えずに守るため、URL ではなくパスフレーズで守る。
//
// 未設定の間は今まで通り誰でも操作できる（設定し忘れた状態でいきなり締め出されると、
// 競技中に入力担当が何もできなくなるため）。設定するまで管理画面に警告を出す。
// =====================================================================
var PROP_ADMIN_PASS = 'TASKBOARD_ADMIN_PASS';

/**
 * 合言葉の設定・変更・解除は「プロジェクトの設定 → スクリプト プロパティ」から行う。
 *
 * ここに setAdminPassword() のような関数を置いてはいけない。google.script.run は
 * 末尾に _ が付かない全ての関数を呼べるので、その関数を置いた時点で
 * URL を知っている人が合言葉を書き換えたり消したりできてしまい、
 * この仕組み全体が意味を失う。
 */
function getAdminPass_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_ADMIN_PASS) || '';
}

/**
 * 書き込み系はすべてこれを通す。
 *
 * 画面側で入力欄を隠すだけでは意味がない（google.script.run はブラウザの
 * コンソールから直接呼べるので、UI を経由せず resetAllData を叩ける）。
 * だから関数そのものの入口で確認する。
 */
function requireWriteAuth_(auth) {
  var pass = getAdminPass_();
  if (!pass) return true;                    // 未設定なら従来どおり
  if (secureEquals_(auth, pass)) return true;
  if (secureEquals_(auth, getApiToken_())) return true; // publish.py 用のトークンでも通す
  // 総当たりを遅くする。締め出し（ロックアウト）にはしない —— 競技中に
  // 嫌がらせで入力担当が使えなくなる方が、この用途では困るため。
  Utilities.sleep(1000);
  throw new Error('合言葉が違います。管理画面を開き直して入力し直してください。');
}

/** 一致しなくても途中で return しない（応答時間から桁を推測されにくくするため） */
function secureEquals_(given, expected) {
  var a = String(given == null ? '' : given);
  var b = String(expected == null ? '' : expected);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < b.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
    return sheet;
  }
  // 列を増やした時、既存のシートは古いまま残る。ヘッダー行は最初の1回しか
  // 書かれないので、ここで足りない分だけ直す（何度実行しても同じ結果になる）。
  if (sheet.getMaxColumns() < FLIGHTS_HEADER.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), FLIGHTS_HEADER.length - sheet.getMaxColumns());
  }
  var head = sheet.getRange(1, 1, 1, FLIGHTS_HEADER.length).getValues()[0];
  for (var i = 0; i < FLIGHTS_HEADER.length; i++) {
    if (String(head[i] || '') !== FLIGHTS_HEADER[i]) {
      sheet.getRange(1, 1, 1, FLIGHTS_HEADER.length).setValues([FLIGHTS_HEADER]);
      break;
    }
  }
  return sheet;
}

/** [{rowIndex, key, label, date, updatedAt, json, archived}] を登録順（シート上の行順）で返す */
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
      json: String(row[4] || ''),
      archived: String(row[5] || '') // 空 = 通常、ISO日時 = アーカイブ済み
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

/**
 * シート名を1回だけ走査する（タスク数ぶん getSheetByName を回さない）。
 *
 * スケッチはタスク番号だけでなくフライトキーも紐づけて保存している
 * （sketch_<flightKey>_<taskNo>）。大会をまたぐと同じ番号のタスクが
 * 何度も出てくるため、番号だけをキーにすると別フライトの絵が出てしまう。
 * シート名からフライトキーを復元する必要があるが、キー自体に区切り文字と
 * 同じ文字（アンダースコア）が含まれ得るので、既知のフライトキー一覧と
 * 前方一致させて分解する（長いキーから先に試し、誤って短いキーの
 * 部分一致に当たらないようにする）。
 */
function listSketchKeys_(ss, rows) {
  var keys = rows.map(function (r) { return r.key; })
    .sort(function (a, b) { return b.length - a.length; });
  var out = [];
  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name.indexOf(SKETCH_PREFIX) !== 0) return;
    if (!hasContent_(sheet)) return;
    var rest = name.substring(SKETCH_PREFIX.length); // "<flightKey>_<taskNo>"
    for (var i = 0; i < keys.length; i++) {
      if (rest.indexOf(keys[i] + '_') === 0) {
        out.push({ flightKey: keys[i], taskNo: rest.substring(keys[i].length + 1) });
        return;
      }
    }
    // どのフライトにも一致しない（削除済みフライトの残骸など）。一覧には出さない。
  });
  return out;
}

/**
 * 一覧に出すのに必要な情報を、保存済みJSONの1回のパースでまとめて取り出す。
 * apiFlights_ は全フライト分これを呼ぶので、件数が増えるほどパース回数が効いてくる。
 */
function flightMeta_(jsonStr) {
  try {
    var parsed = JSON.parse(jsonStr);
    var basic = parsed.basicInfo || {};
    return {
      taskCount: (parsed.tasks || []).length,
      competitionName: String(basic.competitionName || basic.CompetitionName || '')
    };
  } catch (e) {
    return { taskCount: 0, competitionName: '' };
  }
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
    var meta = flightMeta_(r.json);
    return {
      key: r.key,
      label: r.label,
      date: r.date,
      updatedAt: r.updatedAt,
      taskCount: meta.taskCount,
      competitionName: meta.competitionName, // アーカイブ画面の大会別グループ用
      archived: r.archived,
      imagePages: countImagePages_(ss, r.key)
    };
  });
  return { ok: true, version: 3, flights: flights, sketches: listSketchKeys_(ss, rows) };
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

/** スケッチはタスク番号だけでなくフライトキーでも紐づく（sketch_<flightKey>_<taskNo>）。
 *  大会をまたぐと番号が再利用されるため、番号だけをキーにすると別フライトの絵が出てしまう。 */
function sketchSheetName_(flightKey, taskNo) {
  return SKETCH_PREFIX + String(flightKey || '') + '_' + String(taskNo || '');
}

function getSketchData(flightKey, taskNo) {
  try {
    var name = sketchSheetName_(flightKey, taskNo);
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
function saveFlight(auth, key, label, dataStr) {
  requireWriteAuth_(auth);
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
    // 更新は全列を上書きするので、archived を読んで書き戻さないと
    // 訂正のたびにアーカイブ状態が解除されてしまう。
    sheet.getRange(existing.rowIndex, 1, 1, FLIGHTS_HEADER.length)
      .setValues([[finalKey, finalLabel, date, now, dataStr, existing.archived || '']]);
  } else {
    sheet.appendRow([finalKey, finalLabel, date, now, dataStr, '']);
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

function deleteFlight(auth, key) {
  requireWriteAuth_(auth);
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

/**
 * フライトをアーカイブする／戻す。削除と違いデータは残り、
 * クルー側の切替バーから外れてアーカイブ画面へ移るだけ。
 */
function setFlightArchived(auth, key, archived) {
  requireWriteAuth_(auth);
  var sheet = getFlightsSheet_();
  var rows = readFlightRows_();
  var col = FLIGHTS_HEADER.indexOf('archived') + 1;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) {
      var value = archived ? new Date().toISOString() : '';
      sheet.getRange(rows[i].rowIndex, col).setValue(value);
      return { ok: true, key: key, archived: value };
    }
  }
  throw new Error('フライトが見つかりません: ' + key);
}

/** 原本タスクシートの1ページぶんを保存する。page を省略すると1ページ目。 */
function saveImageData(auth, key, page, imageData) {
  requireWriteAuth_(auth);
  if (!key) throw new Error('フライトが選択されていません');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = IMAGE_PREFIX + key + '_' + (Number(page) || 1);
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  writeChunks_(sheet, imageData);
  return true;
}

/** 原本タスクシートの最後のページを削除する（途中のページは削除できない設計）。 */
function deleteLastImagePage(auth, key) {
  requireWriteAuth_(auth);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = countImagePages_(ss, key);
  if (n === 0) return false;
  var sheet = ss.getSheetByName(IMAGE_PREFIX + key + '_' + n) || ss.getSheetByName(IMAGE_PREFIX + key);
  if (sheet) ss.deleteSheet(sheet);
  return true;
}

function saveSketchData(auth, flightKey, taskNo, imageData) {
  requireWriteAuth_(auth);
  if (!flightKey) throw new Error('フライトが指定されていません');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = sketchSheetName_(flightKey, taskNo);
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  writeChunks_(sheet, imageData);
  return true;
}

function deleteSketchData(auth, flightKey, taskNo) {
  requireWriteAuth_(auth);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sketchSheetName_(flightKey, taskNo));
  if (sheet) sheet.clearContents();
  return true;
}

/**
 * 管理画面の初期表示用。画像 base64 は返さない（有無だけ）。
 *
 * 合言葉が設定されていて一致しない時は locked を返すだけにする。ここで
 * 例外を投げないのは、画面側で「入力し直してください」と出したいため。
 */
function getAdminState(auth) {
  var pass = getAdminPass_();
  if (pass && !secureEquals_(auth, pass) && !secureEquals_(auth, getApiToken_())) {
    Utilities.sleep(1000); // 総当たりを遅くする
    return { ok: false, locked: true };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rows = readFlightRows_();
  var flights = rows.map(function (r) {
    return {
      key: r.key,
      label: r.label,
      date: r.date,
      updatedAt: r.updatedAt,
      archived: r.archived,
      imagePages: countImagePages_(ss, r.key),
      tasks: taskSummary_(r.json)
    };
  });
  return {
    ok: true,
    flights: flights,
    sketches: listSketchKeys_(ss, rows),
    execUrl: getExecUrl_(),
    appUrl: APP_URL,
    // 合言葉が未設定なら画面に警告を出させる（URL を知っている人は誰でも操作できる状態）
    needsPassword: !pass
  };
}

/** 大会全体のリセット（全フライト・全画像・全スケッチを削除）。管理画面のみから呼ぶ。 */
function resetAllData(auth) {
  requireWriteAuth_(auth);
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
