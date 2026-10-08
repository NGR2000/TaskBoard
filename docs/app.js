/* TaskBoard PWA — 閲覧アプリ
 *
 * 設計方針
 *  1. オフラインファースト。起動時はまず localStorage の内容を描画し、通信は裏で行う。
 *  2. タスクシートの形式変更に強い「辞書方式」。決め打ちフィールドを持たず、
 *     ラベルは辞書で日本語化し、辞書に無いラベルも英語のまま必ず表示する。
 *  3. 日本語を大きく、英語を小さく併記。クルーは日本語で読み、
 *     パイロットは原本や審判と英語で突き合わせできる。
 *  4. 複数フライトを同時に保持する。大会中はフライトが進むごとに新しい
 *     タスクデータシートが発表されるが、直前のフライトを上書きせず、
 *     クルーはヘッダー下のバーでいつでも過去のフライトへ切り替えて見られる。
 */
(function () {
  'use strict';

  var APP_VERSION = '4.0.0';
  var LS = {
    flightsIndex: 'tb.flights.index',
    activeFlight: 'tb.activeFlight',
    sketchIdx: 'tb.sketches',
    lastSync: 'tb.lastSync',
    flightPrefix: 'tb.flight.',      // + key  -> { data, updatedAt }
    lastViewedPrefix: 'tb.lastViewed.' // + key -> ISO timestamp
  };
  // 原本・スケッチの画像は localStorage ではなく Service Worker のキャッシュに置く（sw.js）
  var IMAGE_CACHE = 'taskboard-images';
  var CFG = window.TASKBOARD_CONFIG || {};
  var LOCAL_KEY = '__local__';

  // =======================================================================
  // state
  // =======================================================================
  var state = {
    screen: 'view',
    booted: false,
    flights: [],       // [{key,label,date,updatedAt,taskCount,competitionName,archived,imagePages,images}]
                       // アーカイブ済みもここに含める。除くと圏外で開けなくなるため（restoreFromCache 参照）
    flightData: {},    // key -> { raw, data, updatedAt }
    activeFlight: '',
    sketches: [],       // [{flightKey,taskNo,url,thumb}] スケッチが存在する組み合わせ
    currentSketch: null,
    open: {},
    syncing: false,
    syncError: null,
    online: navigator.onLine,
    dict: null,
    rules: null,
    modal: null,
    localError: null,
    lastSync: null,
    archiveGroup: 'year' // アーカイブ画面のまとめ方: year | month | event
  };
  var timers = [];

  // =======================================================================
  // 小物
  // =======================================================================
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isBlank(v) {
    if (v === null || v === undefined) return true;
    var s = String(v).trim();
    // タスクシートでは「該当なし」の意味で "-" 単独がよく使われる（実データで確認）
    return s === '' || /^[-–—]+$/.test(s);
  }
  function el(id) { return document.getElementById(id); }

  /** 辞書引き用のキー正規化: 小文字化 → colour/metre の英米差を吸収 → 英数字以外を除去 */
  function normKey(s) {
    return String(s === null || s === undefined ? '' : s)
      .toLowerCase()
      .replace(/colour/g, 'color')
      .replace(/metres|meters|metre/g, 'meter')
      .replace(/[^a-z0-9]/g, '');
  }

  /** キャメルケース/スネークケースのキーを人が読めるラベルに戻す */
  function humanize(key) {
    return String(key)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (e) { return false; } // 容量超過などは黙って諦める（表示には影響しない）
  }
  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  }

  // =======================================================================
  // 辞書
  // =======================================================================
  var labelMap = Object.create(null);
  var valueMap = Object.create(null);

  function buildDict(dict) {
    labelMap = Object.create(null);
    valueMap = Object.create(null);
    if (!dict) return;
    (dict.labels || []).forEach(function (entry) {
      (entry.keys || []).forEach(function (k) { labelMap[k] = entry; });
    });
    (dict.values || []).forEach(function (entry) {
      (entry.keys || []).forEach(function (k) { valueMap[k] = entry; });
    });
  }

  /** ラベルを引く。戻り値 { ja, en, known } — en は必ず「タスクシートの原文」 */
  function lookupLabel(label) {
    var entry = labelMap[normKey(label)];
    if (entry) return { ja: entry.ja, en: label, known: true };
    return { ja: label, en: null, known: false };
  }

  /** 値を引く。完全一致した時だけ訳す（自由記述を壊さないため） */
  function lookupValue(value) {
    var entry = valueMap[normKey(value)];
    if (entry) return { ja: entry.ja, en: value, known: true, color: entry.color || null };
    var combo = lookupCombo(value);
    if (combo) return combo;
    return { ja: value, en: null, known: false, color: colorOf(value) };
  }

  /** "red and yellow" のような既知語の組み合わせを分解して訳す。
   *  分割した単語が全て辞書に一致した時だけ使う（長い自由記述の誤爆を避けるため）。 */
  function lookupCombo(value) {
    if (!value || String(value).length > 40) return null;
    var parts = String(value).split(/\s*(?:,|\/|&|\+|\band\b)\s*/i).filter(function (s) { return s; });
    if (parts.length < 2) return null;
    var jas = [], color = null;
    for (var i = 0; i < parts.length; i++) {
      var e = valueMap[normKey(parts[i])];
      if (!e) return null;
      jas.push(e.ja);
      if (!color && e.color) color = e.color;
    }
    return { ja: jas.join('・'), en: value, known: true, color: color };
  }

  /** 単語単位の完全一致でのみ色を拾う。部分文字列一致だと "declared" が
   *  "red" を内包するなどの誤爆が起きる（長文の説明文で実際に発生した）。 */
  function colorOf(value) {
    if (!value) return null;
    var words = String(value).toLowerCase().replace(/colour/g, 'color').split(/[^a-z0-9]+/);
    for (var i = 0; i < words.length; i++) {
      var entry = words[i] && valueMap[words[i]];
      if (entry && entry.color) return entry.color;
    }
    return null;
  }

  // =======================================================================
  // ルール DB (AXMER 2026 Chapter 15)
  // =======================================================================
  var ruleById = Object.create(null);

  function buildRules(rules) {
    ruleById = Object.create(null);
    if (!rules) return;
    (rules.tasks || []).forEach(function (t) {
      if (t.task_id) ruleById[String(t.task_id).toUpperCase()] = t;
    });
  }
  function ruleFor(taskId) {
    if (!taskId) return null;
    return ruleById[String(taskId).toUpperCase()] || null;
  }

  // =======================================================================
  // 正規化 — 旧スキーマ(v1)と新スキーマ(v2)の両方を受ける
  // =======================================================================

  // v1 の basicInfo キー → タスクシート上の英語表記
  var V1_BASIC = {
    launchPeriod: 'Launch Period',
    taskOrder: 'Task Order',
    qnh: 'QNH',
    sunriseSunset: 'Sunrise / Sunset',
    nextBriefing: 'Next Briefing',
    launchReqmt: 'Launch Requirement'
  };
  // v1 の task キー → タスクシート上の英語表記（targets / 既知キーに吸収されない残り）
  var V1_TASK_FIELD = {
    loggerMarker: 'Logger Marker',
    scoringArea: 'Scoring Area',
    numberOfGoals: 'Number of Goals',
    declarationMethod: 'Declaration Method'
  };
  // 正規化で「既知キー」として扱うため fields には落とさないもの
  var TASK_RESERVED = {
    taskNo: 1, TaskNo: 1, no: 1, taskId: 1, type: 1, id: 1, name: 1, typeName: 1,
    ruleNo: 1, rule_number: 1, markerColor: 1, markerColour: 1, markerDrop: 1,
    scoringPeriodEnd: 1, scoringPeriodStart: 1, targets: 1, fields: 1, notes: 1,
    notesJa: 1, notes_ja: 1,
    targetGPS: 1, targetColor: 1, targetColour: 1, mma: 1,
    cancelled: 1, changeNote: 1, changeNoteJa: 1, changeNote_ja: 1
  };
  var BASIC_RESERVED = {
    competitionName: 1, CompetitionName: 1, date: 1, notes: 1, generalNotes: 1, fields: 1,
    notesJa: 1, notes_ja: 1, generalNotesJa: 1,
    changeNotice: 1, changeNoticeJa: 1, changeNotice_ja: 1, changeHistory: 1
  };

  function pushField(list, label, value, opts) {
    if (isBlank(value)) return;
    var f = { label: String(label), value: String(value).trim() };
    if (opts && opts.wide) f.wide = true;
    if (opts && !isBlank(opts.valueJa)) f.valueJa = String(opts.valueJa).trim();
    if (opts && opts.changed) f.changed = true;
    list.push(f);
  }

  /** 任意の形の fields（配列 or オブジェクト）を [{label,value,valueJa?,changed?}] に揃える。
   *  valueJa はシート原文が長い自由記述の時だけ変換元(Claude)が添える和訳（無ければ辞書のみ）。
   *  changed はブリーフィング後の修正で値が変わった項目に変換元が付ける印（該当行を強調表示する）。 */
  function coerceFields(src) {
    var out = [];
    if (!src) return out;
    if (Array.isArray(src)) {
      src.forEach(function (f) {
        if (!f) return;
        if (typeof f === 'string') { pushField(out, f, ''); return; }
        var label = f.label || f.name || f.key || f.en || '';
        var value = f.value !== undefined ? f.value : (f.val !== undefined ? f.val : '');
        var valueJa = firstOf(f.valueJa, f.value_ja, f.ja, '');
        pushField(out, label, value, { wide: !!f.wide, valueJa: valueJa, changed: !!f.changed });
      });
    } else if (typeof src === 'object') {
      Object.keys(src).forEach(function (k) { pushField(out, humanize(k), src[k]); });
    }
    return out;
  }

  /**
   * 座標文字列から複数ターゲットを取り出す。
   *   "6956 1478"                          → 1件
   *   "1650/8208 (Red), 1927/7744 (White)" → 2件（括弧内をターゲット名として採用）
   * 数字ペアが取れなければ原文をそのまま1件として残す（情報を落とさない）。
   */
  function parseTargets(text) {
    var out = [];
    if (isBlank(text)) return out;
    var re = /(\d{3,6})\s*[\/\s,-]\s*(\d{3,6})\s*(?:[（(]([^)）]*)[)）])?/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      out.push({ name: (m[3] || '').trim(), coordinates: m[1] + '/' + m[2] });
    }
    if (!out.length) out.push({ name: '', coordinates: String(text).trim() });
    return out;
  }

  function normalizeTargets(task) {
    var list = [];
    if (Array.isArray(task.targets) && task.targets.length) {
      task.targets.forEach(function (t) {
        if (!t) return;
        if (typeof t === 'string') { list.push({ name: '', coordinates: t }); return; }
        list.push({
          name: t.name || t.label || t.id || '',
          color: t.color || t.colour || '',
          coordinates: t.coordinates || t.coord || t.gps || t.position || '',
          mma: t.mma || '',
          altitude: t.altitude || t.alt || '',
          note: t.note || t.notes || ''
        });
      });
    } else {
      list = parseTargets(task.targetGPS || task.targetGps || '');
    }
    // v1 は targetColor / mma がタスク単位。ターゲット側に値が無ければ補完する。
    var fallbackColor = task.targetColor || task.targetColour || '';
    var fallbackMma = task.mma || '';
    list.forEach(function (t) {
      if (!t.color) t.color = t.name || fallbackColor || '';
      if (!t.mma) t.mma = fallbackMma || '';
    });
    return list.filter(function (t) { return !isBlank(t.coordinates) || !isBlank(t.mma) || !isBlank(t.name); });
  }

  function normalizeTask(src, index) {
    var t = src || {};
    var task = {
      index: index,
      taskNo: firstOf(t.taskNo, t.TaskNo, t.no, ''),
      taskId: String(firstOf(t.taskId, t.type, t.id, '')).toUpperCase(),
      name: firstOf(t.name, t.typeName, ''),
      ruleNo: firstOf(t.ruleNo, t.rule_number, ''),
      markerColor: firstOf(t.markerColor, t.markerColour, ''),
      markerDrop: firstOf(t.markerDrop, ''),
      scoringPeriodStart: firstOf(t.scoringPeriodStart, ''),
      scoringPeriodEnd: firstOf(t.scoringPeriodEnd, ''),
      notes: firstOf(t.notes, ''),
      notesJa: firstOf(t.notesJa, t.notes_ja, ''),
      cancelled: !!t.cancelled,
      changeNote: firstOf(t.changeNote, ''),
      changeNoteJa: firstOf(t.changeNoteJa, t.changeNote_ja, ''),
      targets: normalizeTargets(t),
      fields: coerceFields(t.fields)
    };

    // v1 の残りフィールドをタスクシート表記のラベルに載せ替える
    Object.keys(V1_TASK_FIELD).forEach(function (k) {
      pushField(task.fields, V1_TASK_FIELD[k], t[k]);
    });
    // ターゲットに吸収されなかった MMA は単独の項目として出す
    if (!isBlank(t.mma) && !task.targets.some(function (x) { return !isBlank(x.mma); })) {
      pushField(task.fields, 'MMA', t.mma);
    }
    // 未知のキーも必ず拾う ← 形式が変わっても情報を落とさないための要
    Object.keys(t).forEach(function (k) {
      if (TASK_RESERVED[k] || V1_TASK_FIELD[k]) return;
      var v = t[k];
      if (v && typeof v === 'object') return;
      pushField(task.fields, humanize(k), v);
    });

    // ルール DB から補完
    var rule = ruleFor(task.taskId);
    if (rule) {
      if (isBlank(task.ruleNo)) task.ruleNo = rule.rule_number || '';
      if (isBlank(task.name)) task.name = rule.title_en || '';
      task.nameJa = rule.title_ja || '';
    }
    task.isGMD = /gmd|gravity/i.test(String(task.markerDrop));
    return task;
  }

  function firstOf() {
    for (var i = 0; i < arguments.length; i++) {
      if (!isBlank(arguments[i])) return arguments[i];
    }
    return '';
  }

  /** ブリーフィング後の変更履歴。新しい変更が来るたびに追記していく前提の配列で、
   *  末尾（配列の最後）が最新。at は「いつ確定した情報か」を人間が読める形で
   *  書いた文字列（正確な発表時刻が分からない時に無理に時刻を捏造しないため、
   *  ISO日時ではなくフリーテキストを許容する）。 */
  function normalizeChangeHistory(src) {
    if (!Array.isArray(src)) return [];
    return src.map(function (h) {
      if (!h) return null;
      if (typeof h === 'string') return { at: '', notice: h, noticeJa: '' };
      return {
        at: firstOf(h.at, h.time, ''),
        notice: firstOf(h.notice, ''),
        noticeJa: firstOf(h.noticeJa, h.notice_ja, '')
      };
    }).filter(function (h) { return h && !isBlank(h.notice || h.noticeJa); });
  }

  function normalizeBasic(src) {
    var b = src || {};
    var info = {
      competitionName: firstOf(b.competitionName, b.CompetitionName, CFG.eventName, ''),
      date: firstOf(b.date, ''),
      notes: firstOf(b.notes, b.generalNotes, ''),
      notesJa: firstOf(b.notesJa, b.notes_ja, b.generalNotesJa, ''),
      changeNotice: firstOf(b.changeNotice, ''),
      changeNoticeJa: firstOf(b.changeNoticeJa, b.changeNotice_ja, ''),
      changeHistory: normalizeChangeHistory(b.changeHistory),
      fields: coerceFields(b.fields)
    };
    Object.keys(V1_BASIC).forEach(function (k) { pushField(info.fields, V1_BASIC[k], b[k]); });
    Object.keys(b).forEach(function (k) {
      if (BASIC_RESERVED[k] || V1_BASIC[k]) return;
      var v = b[k];
      if (v && typeof v === 'object') return;
      pushField(info.fields, humanize(k), v);
    });
    return info;
  }

  function normalizeData(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    return {
      schemaVersion: 2,
      basicInfo: normalizeBasic(raw.basicInfo || raw.basic || {}),
      tasks: tasks.map(normalizeTask)
    };
  }

  // =======================================================================
  // API（Supabase。読み取りだけなのでログインせず、公開の anon キーで読む）
  // =======================================================================
  function configured() { return !!(CFG.supabaseUrl && CFG.supabaseAnonKey); }

  function db(path) {
    if (!configured()) return Promise.reject(new Error('データの取得先が設定されていません（config.js）'));
    if (typeof AbortController === 'undefined' || typeof fetch !== 'function') {
      return Promise.reject(new Error('このブラウザは対応していません'));
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 15000);
    return fetch(CFG.supabaseUrl + '/rest/v1/' + path, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: anonHeaders()
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? '応答がありません（タイムアウト）' : '接続に失敗しました');
    });
  }

  /** 新しい publishable キー（sb_publishable_...）は apikey だけに載せる。旧来の anon キー（JWT）は両方に */
  function anonHeaders() {
    var h = { apikey: CFG.supabaseAnonKey };
    if (CFG.supabaseAnonKey.indexOf('sb_') !== 0) h.Authorization = 'Bearer ' + CFG.supabaseAnonKey;
    return h;
  }

  function publicUrl(path) {
    return CFG.supabaseUrl + '/storage/v1/object/public/taskboard/' +
      String(path).split('/').map(encodeURIComponent).join('/');
  }

  // =======================================================================
  // フライトのキャッシュ
  // =======================================================================
  function flightLSKey(key) { return LS.flightPrefix + key; }
  function lastViewedLSKey(key) { return LS.lastViewedPrefix + key; }

  function saveFlightCache(key, dataStr, updatedAt) {
    safeSet(flightLSKey(key), JSON.stringify({ data: dataStr, updatedAt: updatedAt || '' }));
  }
  function loadFlightCache(key) {
    var raw = safeGet(flightLSKey(key));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function markViewed(key) { safeSet(lastViewedLSKey(key), new Date().toISOString()); }
  function isNewFlight(meta) {
    if (meta.key === LOCAL_KEY) return false;
    var seen = safeGet(lastViewedLSKey(meta.key));
    if (!seen) return true;
    if (!meta.updatedAt) return false;
    var seenTime = new Date(seen).getTime();
    var updTime = new Date(meta.updatedAt).getTime();
    return isFinite(updTime) && isFinite(seenTime) && updTime > seenTime;
  }

  /** 通常フライト（切替バーに出るもの） */
  function activeFlights() {
    return state.flights.filter(function (f) { return !f.archived; });
  }
  /** アーカイブ済み（アーカイブ画面にだけ出るもの） */
  function archivedFlights() {
    return state.flights.filter(function (f) { return !!f.archived; });
  }

  /**
   * タスクシートの日付から年と月を取り出す。
   *
   * date は自由記述で、実データだけでも4形式ある:
   *   "01.05.2025 AM"（日.月.年）/ "2026.8.8"（年.月.日）
   *   "2026年8月20日（木）AM" / "2025年5月5日（月）AM 0515"
   * new Date() は使わない —— "01.05.2025" を1月5日と解釈してしまい、
   * Krosno 系の日付が全て別の月に飛ぶ。
   *
   * 判別できない時は null を返し、呼び出し側で「日付不明」に寄せる（推測しない）。
   */
  function parseFlightDate(text) {
    var nums = String(text || '').match(/\d+/g);
    if (!nums || nums.length < 2) return null;
    var year, month;
    if (nums[0].length === 4) {            // 年が先頭
      year = Number(nums[0]); month = Number(nums[1]);
    } else if (nums.length >= 3 && nums[2].length === 4) { // 日.月.年
      year = Number(nums[2]); month = Number(nums[1]);
    } else {
      return null;
    }
    if (!isFinite(year) || !isFinite(month)) return null;
    if (year < 1900 || year > 2200 || month < 1 || month > 12) return null;
    return { year: year, month: month };
  }

  /** 日付の新しい順に並べるための比較キー。不明は一番古い扱いにする */
  function dateSortKey(f) {
    var d = parseFlightDate(f.date);
    return d ? d.year * 100 + d.month : -1;
  }

  /** state.flights は新しい順（登録が新しいフライトが先頭）に揃えてある前提 */
  function pickActiveFlight() {
    var list = activeFlights();
    if (state.activeFlight && state.flights.some(function (f) { return f.key === state.activeFlight; })) return;
    state.activeFlight = list.length ? list[0].key : (state.flights.length ? state.flights[0].key : '');
  }

  function restoreFromCache() {
    try { state.flights = JSON.parse(safeGet(LS.flightsIndex) || '[]'); } catch (e) { state.flights = []; }
    state.activeFlight = safeGet(LS.activeFlight) || '';
    state.lastSync = safeGet(LS.lastSync) || null;
    try { state.sketches = JSON.parse(safeGet(LS.sketchIdx) || '[]'); }
    catch (e) { state.sketches = []; }

    state.flights.forEach(function (f) {
      var cached = loadFlightCache(f.key);
      if (!cached) return;
      try {
        var raw = JSON.parse(cached.data);
        state.flightData[f.key] = { raw: raw, data: normalizeData(raw), updatedAt: cached.updatedAt };
      } catch (e) { /* 壊れたキャッシュは無視 */ }
    });
    pickActiveFlight();
    if (state.activeFlight) markViewed(state.activeFlight);
  }

  // =======================================================================
  // 同期
  // =======================================================================
  function fetchFlight(key) {
    return db('flights?select=data,updated_at&key=eq.' + encodeURIComponent(key))
      .then(function (rows) {
        var row = rows && rows[0];
        if (!row || !row.data) return;
        saveFlightCache(key, JSON.stringify(row.data), row.updated_at);
        state.flightData[key] = { raw: row.data, data: normalizeData(row.data), updatedAt: row.updated_at };
        render();
      })
      .catch(function () { /* このフライトだけ失敗。他のフライトの取得は続ける */ });
  }

  /** 一覧取得後、表示中のフライトを優先しつつ残りも裏で取りに行く */
  function prefetchFlights() {
    // アーカイブ済みは先読みしない。増えるほど同期が重くなるため、開いた時に取りに行く。
    // アーカイブ前に通常フライトとして先読み済みなので、実際にはほぼ端末に残っている。
    var keys = activeFlights().map(function (f) { return f.key; });
    keys.sort(function (a) { return a === state.activeFlight ? -1 : 1; });
    var chain = Promise.resolve();
    keys.forEach(function (key) {
      var meta = state.flights.filter(function (f) { return f.key === key; })[0];
      var cached = state.flightData[key];
      if (cached && meta && cached.updatedAt === meta.updatedAt) return; // 変化なし
      chain = chain.then(function () { return fetchFlight(key); });
    });
    return chain;
  }

  function sync() {
    if (state.syncing) return Promise.resolve();
    state.syncing = true;
    state.syncError = null;
    render();
    return Promise.all([
      db('flight_list?select=key,label,date,images,archived_at,updated_at,task_count,competition_name' +
         '&order=created_at.asc,key.asc'),
      db('sketches?select=flight_key,task_no,path,thumb_path')
    ])
      .then(function (res) {
        // 登録順（古い→新しい）で取る。フライト切替バーと自動選択は
        // 「タスクシートの日付が新しいものが先頭」にしたいので反転する。
        // 訂正登録は既存行を上書きするだけで並びは動かないため、登録順＝日付順という前提でよい。
        state.flights = res[0].map(function (r) {
          var images = (r.images || []).map(publicUrl);
          return {
            key: r.key, label: r.label, date: r.date, updatedAt: r.updated_at,
            taskCount: r.task_count, competitionName: r.competition_name,
            archived: r.archived_at || '', imagePages: images.length, images: images
          };
        }).filter(function (f) { return f.key !== LOCAL_KEY; }).reverse();
        state.sketches = res[1].map(function (r) {
          return { flightKey: r.flight_key, taskNo: r.task_no, url: publicUrl(r.path),
                   thumb: r.thumb_path ? publicUrl(r.thumb_path) : '' };
        });
        safeSet(LS.flightsIndex, JSON.stringify(state.flights));
        safeSet(LS.sketchIdx, JSON.stringify(state.sketches));
        state.lastSync = new Date().toISOString();
        safeSet(LS.lastSync, state.lastSync);
        pickActiveFlight();
        safeSet(LS.activeFlight, state.activeFlight);
        state.syncing = false;
        render();
        return prefetchFlights().then(prefetchImages);
      })
      .catch(function (e) {
        state.syncError = e.message || String(e);
        state.syncing = false;
        render();
      });
  }

  function switchFlight(key) {
    state.activeFlight = key;
    safeSet(LS.activeFlight, key);
    markViewed(key);
    state.open = {};
    state.screen = 'view';
    render();
    if (!state.flightData[key] && state.online && key !== LOCAL_KEY) fetchFlight(key);
  }

  /**
   * 通常フライトの原本とスケッチを裏で取り込んでおく。取り込んだ画像は sw.js が
   * 端末に保存するので、会場で電波が悪くても一度同期していれば開ける。
   * 画像の URL は中身が変わらない（差し替えると URL ごと変わる）ので、
   * 保存済みのものは sw.js がネットワークに出ずに返し、二度は落とさない。
   */
  function prefetchImages() {
    if (!state.online || !('caches' in window)) return;
    var active = {};
    var urls = [];
    activeFlights().forEach(function (f) {
      active[f.key] = true;
      (f.images || []).forEach(function (u) { urls.push(u); });
    });
    state.sketches.forEach(function (s) {
      if (!active[s.flightKey]) return;
      urls.push(s.url);
      if (s.thumb) urls.push(s.thumb);
    });
    return caches.open(IMAGE_CACHE).then(function (cache) {
      var i = 0;
      function next() {
        if (i >= urls.length) return;
        var url = urls[i++];
        return cache.match(url).then(function (hit) {
          if (hit) return;
          return fetch(url, { mode: 'cors' }).then(function (res) {
            if (res.ok) return cache.put(url, res);
          });
        }).catch(function () { /* 1枚失敗しても残りは続ける */ }).then(next);
      }
      return Promise.all([next(), next(), next()]); // 3並列
    }).catch(function () { /* 先読みは失敗しても致命的ではない */ });
  }

  function loadImage() {
    state.screen = 'image';
    render();
  }

  function sketchEntry(flightKey, taskNo) {
    return state.sketches.filter(function (x) { return x.flightKey === flightKey && x.taskNo === taskNo; })[0];
  }

  function loadSketch(taskNo) {
    state.currentSketch = { flightKey: state.activeFlight, taskNo: taskNo };
    state.screen = 'sketch';
    render();
  }

  // =======================================================================
  // 描画
  // =======================================================================
  function render() {
    timers.forEach(clearInterval);
    timers = [];
    var app = el('app');
    if (!state.booted) { app.innerHTML = '<div class="center-note">読み込み中…</div>'; return; }

    var html;
    switch (state.screen) {
      case 'settings': html = viewSettings(); break;
      case 'local':    html = viewLocal(); break;
      case 'image':    html = viewImage(); break;
      case 'sketch':   html = viewSketch(); break;
      case 'rules':    html = viewRuleIndex(); break;
      case 'archive':  html = viewArchive(); break;
      default:         html = viewMain();
    }
    app.innerHTML = html;
    renderModal();
    var entry = state.flightData[state.activeFlight];
    if (state.screen === 'view' && entry && entry.data) startTimers(entry.data.tasks);
  }

  function header(title, sub, actions, back) {
    return '<div class="header">' +
      (back ? '<button class="btn-small" data-act="screen" data-screen="' + esc(back) + '">←</button>' : '') +
      '<div class="header-title">' + esc(title) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' +
      '<div class="header-actions">' + (actions || '') + '</div></div>';
  }

  /**
   * フライト切替バー。通常フライトのチップ＋右端にアーカイブ入口。
   * 通常が1件しか無く、アーカイブも無い時だけ丸ごと省く（雑音を減らす）。
   */
  function flightBar() {
    var list = activeFlights();
    var archived = archivedFlights();
    if (list.length < 2 && !archived.length) return '';

    // 開いているのがアーカイブ済みフライトの時は、それもチップとして出す。
    // 出さないと「選択中がどこにも無い」状態になって迷子になる。
    var shown = list.slice();
    if (state.activeFlight && !shown.some(function (f) { return f.key === state.activeFlight; })) {
      var current = state.flights.filter(function (f) { return f.key === state.activeFlight; })[0];
      if (current) shown.unshift(current);
    }

    var chips = shown.map(function (f) {
      var active = f.key === state.activeFlight;
      var isNew = !active && isNewFlight(f);
      var cached = !!state.flightData[f.key];
      return '<div class="flight-chip' + (active ? ' active' : '') + (cached ? '' : ' pending') +
        '" data-act="flight" data-key="' + esc(f.key) + '">' +
        (isNew ? '<span class="flight-dot"></span>' : '') + esc(f.label) + '</div>';
    }).join('');

    if (archived.length) {
      chips += '<div class="flight-chip archive" data-act="screen" data-screen="archive">📦 アーカイブ ' +
        archived.length + '</div>';
    }
    return '<div class="flight-bar">' + chips + '</div>';
  }

  // ---------- メイン ----------
  function viewMain() {
    var meta = state.flights.filter(function (f) { return f.key === state.activeFlight; })[0];
    var entry = state.flightData[state.activeFlight];
    var d = entry && entry.data;

    var actions =
      (meta && meta.imagePages > 0 ? '<button class="btn-small" data-act="image">原本</button>' : '') +
      '<button class="btn-small" data-act="rules">📖</button>' +
      '<button class="btn-small" data-act="sync">' + (state.syncing ? '…' : '↻') + '</button>' +
      '<button class="btn-small light" data-act="screen" data-screen="settings">⚙</button>';

    var title = (d && d.basicInfo.competitionName) || CFG.appName || 'TaskBoard';
    var sub = meta ? meta.label : (CFG.eventName || '');
    var html = header(title, sub, actions) + flightBar();

    html += '<div class="wrap">';
    html += statusBanners();

    if (!state.flights.length) {
      html += '<div class="center-note">' +
        (configured()
          ? 'まだフライトが登録されていません。<br>ブリーフィング後に入力担当が登録すると、ここに表示されます。<br><br>「↻」で再同期できます。'
          : 'データの取得先が未設定です。<br>右上の ⚙ から設定してください。') +
        '</div></div>';
      return html;
    }

    if (!d) {
      html += '<div class="center-note">「' + esc(meta ? meta.label : '') + '」はまだこの端末に保存されていません。<br>' +
        '電波のある場所で「↻」を押すか、上のバーで別のフライトを選んでください。</div></div>';
      return html;
    }

    if (entry.updatedAt) {
      html += '<div class="updated">タスクシート更新: ' + esc(fmtDateTime(entry.updatedAt)) + '</div>';
    }
    if (!d.tasks.length) {
      html += awaitingConversion(meta);
      html += '<div class="spacer"></div></div>';
      return html;
    }
    html += renderBasic(d.basicInfo);
    html += d.tasks.map(renderTask).join('');
    html += '<div class="spacer"></div></div>';
    return html;
  }

  /** 写真だけで速報登録されたフライト。変換が済むまでは原本をそのまま並べて見せる */
  function awaitingConversion(meta) {
    var images = (meta && meta.images) || [];
    return '<div class="banner banner-warn" style="margin-bottom:12px">' +
      '<b>⏳ タスクシートを変換中です</b><br>' +
      '変換が終わるとタスクごとの表示に切り替わります（「↻」で確認）。それまでは下の原本を見てください。</div>' +
      (images.length
        ? '<div class="viewer viewer-inline">' + images.map(function (url, i) {
            return (images.length > 1 ? '<div class="viewer-page-label">' + (i + 1) + ' / ' + images.length + '</div>' : '') +
              imgTag(url, '原本タスクシート ' + (i + 1) + 'ページ目');
          }).join('') + '</div>'
        : '<div class="center-note">原本の写真がまだありません。</div>');
  }

  function statusBanners() {
    var out = '';
    if (!state.online) {
      out += '<div class="banner banner-offline">📶 オフライン — 最終同期 ' +
        esc(state.lastSync ? fmtDateTime(state.lastSync) : '未実施') + ' の内容を表示しています</div>';
    } else if (state.syncError) {
      out += '<div class="banner banner-warn">⚠️ 同期できませんでした: ' + esc(state.syncError) +
        (state.lastSync ? '<br>最終同期 ' + esc(fmtDateTime(state.lastSync)) + ' の内容を表示しています' : '') +
        '</div>';
    }
    return out ? '<div style="margin-bottom:12px">' + out + '</div>' : '';
  }

  /** 注記: 和訳が添えられていれば日本語を上、シート原文の英語を下に二重表記する */
  function renderNotes(notes, notesJa) {
    if (isBlank(notes)) return '';
    if (!isBlank(notesJa)) {
      return '<div class="notes"><div class="notes-ja">📝 ' + esc(notesJa) + '</div>' +
        '<div class="notes-en">' + esc(notes) + '</div></div>';
    }
    return '<div class="notes">📝 ' + esc(notes) + '</div>';
  }

  /** ブリーフィング後の修正点。基本情報カードは既定で畳まれているため、
   *  開閉状態に関わらず必ず見える位置（見出しの直下）に赤字で出す。
   *  過去の変更が history にあれば、その下に折りたたみの更新履歴を出す
   *  （<details> はJS無しで開閉できるので、カード本体の開閉状態と独立して使える）。 */
  function renderChangeBanner(notice, noticeJa, history) {
    var hasNotice = !isBlank(notice);
    var hist = (history || []).filter(function (h) { return !isBlank(h.notice) || !isBlank(h.noticeJa); });
    if (!hasNotice && !hist.length) return '';
    var out = '<div class="change-banner">';
    if (hasNotice) {
      out += '📢 ' + esc(noticeJa || notice) +
        (!isBlank(noticeJa) ? '<div class="change-banner-en">' + esc(notice) + '</div>' : '');
    } else {
      out += '📢 更新履歴';
    }
    if (hist.length) {
      out += '<details class="change-history"><summary>更新履歴（' + hist.length + '件）</summary><ul>' +
        hist.slice().reverse().map(function (h) {
          return '<li>' + (h.at ? '<span class="change-history-at">' + esc(h.at) + '</span> ' : '') +
            esc(h.noticeJa || h.notice) +
            (!isBlank(h.noticeJa) && !isBlank(h.notice) && h.notice !== h.noticeJa ? '<span class="change-history-en">' + esc(h.notice) + '</span>' : '') +
            '</li>';
        }).join('') + '</ul></details>';
    }
    out += '</div>';
    return out;
  }

  function renderBasic(info) {
    var open = !!state.open.basic;
    var rows = info.fields.map(function (f) { return renderRow(f.label, f.value, f.wide, f.valueJa, f.changed); }).join('');
    if (!rows && !info.notes && isBlank(info.changeNotice) && !info.changeHistory.length) return '';
    return '<div class="card">' +
      '<div class="card-header" data-act="toggle" data-key="basic">' +
        '<div class="task-head"><h2>📋 基本情報 <span class="rule-no">Event Information</span></h2></div>' +
        '<span class="chevron">' + (open ? '▲' : '▼') + '</span>' +
      '</div>' +
      renderChangeBanner(info.changeNotice, info.changeNoticeJa, info.changeHistory) +
      (open ? '<div class="card-body">' + rows +
        renderNotes(info.notes, info.notesJa) +
        '</div>' : '') +
      '</div>';
  }

  function renderTask(task) {
    var key = 'task' + task.index;
    var open = state.open[key] !== false; // 既定は開いた状態
    var rule = ruleFor(task.taskId);
    var nameJa = task.nameJa || (rule && rule.title_ja) || '';

    var head = '<div class="task-head">' +
      '<span class="task-no">' + esc(labelTaskNo(task)) + '</span>' +
      '<span class="task-id">' + esc(task.taskId || '—') + '</span>' +
      (task.cancelled ? '<span class="badge-cancelled">🚫 キャンセル</span>' : '') +
      (task.isGMD && !task.cancelled ? '<span class="badge-gmd">🚨 GMD</span>' : '') +
      '<span>' +
        (nameJa ? '<span class="task-name-ja">' + esc(nameJa) + '</span>' : '') +
        (task.name ? '<span class="task-name-en">' + esc(task.name) + '</span>' : '') +
      '</span>' +
      '</div>' +
      '<div class="head-right">' +
      (task.ruleNo ? '<span class="rule-no">' + esc(task.ruleNo) + '</span>' : '') +
      (rule ? '<button class="help-btn" data-act="rule" data-taskid="' + esc(task.taskId) + '" aria-label="ルール解説">?</button>' : '') +
      '<span class="chevron">' + (open ? '▲' : '▼') + '</span></div>';

    var body = '';
    if (open) {
      body = '<div class="card-body">';
      if (!isBlank(task.changeNote)) {
        body += '<div class="change-alert">⚠️ ' + esc(task.changeNoteJa || task.changeNote) +
          (!isBlank(task.changeNoteJa) ? '<div class="change-alert-en">' + esc(task.changeNote) + '</div>' : '') +
          '</div>';
      }
      if (task.isGMD && !task.cancelled) {
        body += '<div class="gmd-alert">🚨 GMD（重力落下）— 投げると距離ペナルティ<br>' +
          '<span style="font-weight:400;font-size:12px">Gravity Marker Drop: 両足をゴンドラに付けたまま落下させること</span></div>';
      }
      body += renderTargets(task);
      if (!isBlank(task.markerColor)) body += renderRow('Marker Colour', task.markerColor);
      if (!isBlank(task.markerDrop)) body += renderRow('Marker Drop', task.markerDrop);
      body += task.fields.map(function (f) { return renderRow(f.label, f.value, f.wide, f.valueJa, f.changed); }).join('');
      if (!task.cancelled) body += renderTimer(task);
      body += renderNotes(task.notes, task.notesJa);
      body += renderAttach(task);
      body += '</div>';
    }

    return '<div class="card' + (task.isGMD && !task.cancelled ? ' alert' : '') + (task.cancelled ? ' cancelled' : '') + '">' +
      '<div class="card-header" data-act="toggle" data-key="' + key + '">' + head + '</div>' +
      body + '</div>';
  }

  function labelTaskNo(task) {
    // タスクシートの番号をそのまま使う。アプリ側で連番を振り直したり
    // ゼロ埋めを削ったりしない（原本と突き合わせられることを優先する）。
    var no = String(task.taskNo || '').trim();
    if (!no) return 'Task —';
    return /^task/i.test(no) ? no : 'Task ' + no;
  }

  /** ラベル1行: 日本語を大きく、タスクシートの英語原文を小さく
   *  valueJa は辞書に無い自由記述の和訳（変換時にClaudeが添えたもの）。辞書一致が無い時だけ使う。 */
  function renderRow(label, value, wide, valueJa, changed) {
    if (isBlank(value)) return '';
    var L = lookupLabel(label);
    var V = lookupValue(value);
    if (!V.known && !isBlank(valueJa)) V = { ja: valueJa, en: value, known: true, color: V.color };
    var labelHtml = '<span class="label-ja">' + esc(L.ja) +
      (L.known ? '' : '<span class="unknown-flag">辞書外</span>') +
      (changed ? '<span class="changed-flag">変更</span>' : '') + '</span>' +
      (L.en ? '<span class="label-en">' + esc(L.en) + '</span>' : '');
    var valueHtml =
      (V.color ? '<span class="dot" style="color:' + esc(V.color) + '">● </span>' : '') +
      '<span class="value-ja">' + esc(V.ja) + '</span>' +
      (V.en ? '<span class="value-en">' + esc(V.en) + '</span>' : '');
    var isLong = String(value).length > 32;
    return '<div class="row' + (wide || isLong ? ' wide' : '') + (changed ? ' changed' : '') + '">' +
      '<span class="row-label">' + labelHtml + '</span>' +
      '<span class="row-value">' + valueHtml + '</span></div>';
  }

  function renderTargets(task) {
    if (!task.targets.length) return '';
    var multi = task.targets.length > 1;
    var html = '<div class="targets"><div class="targets-title">' +
      (multi ? '◎ ターゲット / ゴール（' + task.targets.length + '箇所）' : '◎ ターゲット / ゴール') +
      ' <span class="label-en" style="display:inline">Goal / Target Position</span></div>';
    task.targets.forEach(function (t, i) {
      var V = lookupValue(t.color || t.name || '');
      var color = V.color || '#999';
      var nameJa = t.name || t.color ? V.ja : '';
      html += '<div class="target" style="border-left-color:' + esc(color) + '">' +
        '<div class="target-head">' +
          (multi || nameJa ? '<span class="target-name" style="color:' + esc(color) + '">● ' +
            esc(nameJa || ('Target ' + (i + 1))) + '</span>' : '') +
          (t.coordinates ? '<span class="target-coord">' + esc(t.coordinates) + '</span>' : '') +
        '</div>' +
        (t.mma ? '<div class="target-mma">MMA ' + esc(lookupValue(t.mma).ja) + ' <span class="target-sub">マーカー計測エリア</span></div>' : '') +
        (t.altitude ? '<div class="target-sub">高度 / Altitude: ' + esc(t.altitude) + '</div>' : '') +
        (t.note ? '<div class="target-sub">' + esc(t.note) + '</div>' : '') +
        ((t.name || t.color) && V.en ? '<div class="target-sub">' + esc(V.en) + '</div>' : '') +
      '</div>';
    });
    return html + '</div>';
  }

  function renderTimer(task) {
    if (isBlank(task.scoringPeriodEnd)) return '';
    return '<div class="timer-box">' +
      '<div class="timer-label">スコアリングピリオド終了 <span class="label-en" style="display:inline">Scoring Period End</span></div>' +
      '<div class="timer-target">🏁 ' + esc(task.scoringPeriodEnd) +
        (task.scoringPeriodStart ? ' <span class="target-sub">(開始 ' + esc(task.scoringPeriodStart) + ')</span>' : '') +
      '</div>' +
      '<div class="timer-display" id="timer' + task.index + '">--:--</div></div>';
  }

  /** サムネイルがあれば軽量画像をそのままタップ対象にする（フルサイズは「見る」で別途取得）。
   *  無ければ（古いスケッチ・サムネイル非対応で保存されたもの）従来のボタンにフォールバック。 */
  function renderAttach(task) {
    var no = String(task.taskNo || '');
    var flightKey = state.activeFlight;
    var entry = sketchEntry(flightKey, no);
    if (!entry) return '<div class="attach empty">📎 スケッチなし</div>';
    if (entry.thumb) {
      return '<div class="attach attach-has-thumb" data-act="sketch" data-taskno="' + esc(no) + '">' +
        '<img class="attach-thumb" src="' + esc(entry.thumb) + '" alt="スケッチのプレビュー">' +
        '<span class="attach-thumb-badge">🔍 タップで拡大</span>' +
        '</div>';
    }
    return '<div class="attach"><span>📎 スケッチ / Sketch</span>' +
      '<button class="btn-small" data-act="sketch" data-taskno="' + esc(no) + '">見る</button></div>';
  }

  // ---------- タイマー ----------
  function parseHHMM(s) {
    var m = String(s).match(/(\d{1,2})\s*[:：]?\s*(\d{2})/);
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return { h: h, m: mi };
  }

  function startTimers(tasks) {
    tasks.forEach(function (task) {
      var hm = parseHHMM(task.scoringPeriodEnd);
      if (!hm) return;
      var node = el('timer' + task.index);
      if (!node) return;
      function tick() {
        var now = new Date();
        var end = new Date(now);
        end.setHours(hm.h, hm.m, 0, 0);
        var diff = Math.floor((end - now) / 1000);
        if (diff <= 0) {
          node.textContent = '✅ スコアリングピリオド終了';
          node.className = 'timer-display done';
          return;
        }
        var hh = Math.floor(diff / 3600), mm = Math.floor((diff % 3600) / 60), ss = diff % 60;
        var cls = diff <= 300 ? 'danger' : (diff <= 900 ? 'warn' : '');
        var icon = diff <= 300 ? '🚨' : (diff <= 900 ? '⚠️' : '⏱');
        node.textContent = icon + ' ' + (hh > 0 ? hh + ':' : '') +
          String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
        node.className = 'timer-display' + (cls ? ' ' + cls : '');
      }
      tick();
      timers.push(setInterval(tick, 1000));
    });
  }

  // ---------- ルール解説 ----------
  function renderModal() {
    var root = el('modal-root');
    if (!state.modal) { root.innerHTML = ''; return; }
    var rule = ruleFor(state.modal);
    if (!rule) { root.innerHTML = ''; return; }

    var keys = Object.keys(rule.sections || {}).sort(function (a, b) {
      var pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      }
      return 0;
    });

    var body = keys.map(function (k) {
      var sec = rule.sections[k];
      var h = '<div class="rule-sec"><div class="rule-num">' + esc(k) + '</div>';
      if (sec.title_en) h += '<div class="rule-title">' + esc(sec.title_en === 'Task data' ? 'タスクデータ' : sec.title_en) +
        '<span class="label-en" style="display:inline"> ' + esc(sec.title_en) + '</span></div>';
      if (sec.text_ja) h += '<div class="rule-ja">' + esc(sec.text_ja) + '</div>';
      if (sec.text_en) h += '<div class="rule-en">' + esc(sec.text_en) + '</div>';
      if (sec.items) {
        h += '<ul class="rule-items">' + Object.keys(sec.items).map(function (i) {
          return '<li>' + esc(i) + '. ' + esc(sec.items[i]) + '</li>';
        }).join('') + '</ul>';
        h += '<div class="checklist-note">※ このタスクのタスクシートに載っているはずの項目。抜けがないか原本と照合してください。</div>';
      }
      return h + '</div>';
    }).join('');

    root.innerHTML = '<div class="modal-backdrop" data-act="closemodal">' +
      '<div class="modal" data-stop="1">' +
        '<div class="modal-header">' +
          '<div><h2>' + esc(rule.task_id) + ' ' + esc(rule.title_ja || '') + '</h2>' +
          '<div class="sub">' + esc(rule.title_en || '') + ' / AXMER 2026 ' + esc(rule.rule_number) + '</div></div>' +
          '<button class="btn-small" data-act="closemodal">閉じる</button>' +
        '</div>' +
        '<div class="modal-body">' + body + '</div>' +
      '</div></div>';
  }

  // ---------- アーカイブ ----------
  var ARCHIVE_TABS = [
    { id: 'year', label: '年' },
    { id: 'month', label: '月' },
    { id: 'event', label: '大会' }
  ];

  /** グループの見出しと、並べ替え用のキーを決める */
  function archiveGroupOf(f, mode) {
    var d = parseFlightDate(f.date);
    if (mode === 'event') {
      var name = f.competitionName || '大会名なし';
      return { title: name, sort: d ? d.year * 100 + d.month : -1, tie: name };
    }
    if (!d) return { title: '日付不明', sort: -1, tie: '' };
    if (mode === 'month') return { title: d.year + '年' + d.month + '月', sort: d.year * 100 + d.month, tie: '' };
    return { title: d.year + '年', sort: d.year * 100, tie: '' };
  }

  function viewArchive() {
    var list = archivedFlights();
    var mode = state.archiveGroup;
    var html = header('アーカイブ', list.length + '件', '', 'view');

    html += '<div class="archive-tabs">' + ARCHIVE_TABS.map(function (t) {
      return '<button class="archive-tab' + (t.id === mode ? ' active' : '') +
        '" data-act="archive-group" data-group="' + t.id + '">' + t.label + '</button>';
    }).join('') + '</div>';

    html += '<div class="wrap">';
    if (!list.length) {
      html += '<div class="center-note">アーカイブされたフライトはありません。</div>';
      return html + '<div class="spacer"></div></div>';
    }

    // 見出しごとにまとめる。同じ見出しの中では日付の新しい順。
    var groups = [];
    var byTitle = {};
    list.forEach(function (f) {
      var g = archiveGroupOf(f, mode);
      if (!byTitle[g.title]) {
        byTitle[g.title] = { title: g.title, sort: g.sort, tie: g.tie, items: [] };
        groups.push(byTitle[g.title]);
      }
      // 大会グループは「その大会の最新フライト」で並べたいので、最大値を採る
      if (g.sort > byTitle[g.title].sort) byTitle[g.title].sort = g.sort;
      byTitle[g.title].items.push(f);
    });
    groups.sort(function (a, b) {
      if (b.sort !== a.sort) return b.sort - a.sort;
      return String(a.tie).localeCompare(String(b.tie));
    });

    groups.forEach(function (g) {
      g.items.sort(function (a, b) { return dateSortKey(b) - dateSortKey(a); });
      html += '<div class="archive-group-title">' + esc(g.title) + '</div>';
      html += g.items.map(function (f) {
        var sub = [f.date || '日付不明', (f.taskCount || 0) + 'タスク'].join('　');
        return '<div class="card"><div class="card-header" data-act="flight" data-key="' + esc(f.key) + '">' +
          '<div><div class="archive-label">' + esc(f.label) + '</div>' +
          '<div class="archive-sub">' + esc(sub) + '</div></div>' +
          '<span class="chevron">›</span></div></div>';
      }).join('');
    });

    return html + '<div class="spacer"></div></div>';
  }

  function viewRuleIndex() {
    var list = (state.rules && state.rules.tasks) || [];
    var html = header('AXMER 2026 Chapter 15', 'タスク定義 全' + list.length + '種目', '', 'view');
    html += '<div class="wrap">';
    if (!list.length) {
      html += '<div class="center-note">ルールデータを読み込めませんでした。</div>';
    } else {
      html += list.map(function (t) {
        return '<div class="card"><div class="card-header" data-act="rule" data-taskid="' + esc(t.task_id) + '">' +
          '<div class="task-head"><span class="task-id">' + esc(t.task_id) + '</span>' +
          '<span><span class="task-name-ja">' + esc(t.title_ja) + '</span>' +
          '<span class="task-name-en">' + esc(t.title_en) + '</span></span>' +
          '<span class="rule-no">' + esc(t.rule_number) + '</span></div>' +
          '<span class="chevron">›</span></div></div>';
      }).join('');
    }
    return html + '<div class="spacer"></div></div>';
  }

  // ---------- 画像 ----------
  function viewImage() {
    var meta = state.flights.filter(function (f) { return f.key === state.activeFlight; })[0];
    var html = header('原本タスクシート', meta ? meta.label : 'Original Task Sheet', '', 'view');
    var images = (meta && meta.images) || [];
    if (!images.length) return html + '<div class="center-note">画像がありません</div>';
    var multi = images.length > 1;
    return html + '<div class="viewer">' + images.map(function (url, i) {
      return (multi ? '<div class="viewer-page-label">' + (i + 1) + ' / ' + images.length + '</div>' : '') +
        imgTag(url, '原本タスクシート ' + (i + 1) + 'ページ目');
    }).join('') + '</div>';
  }

  function viewSketch() {
    var cur = state.currentSketch || {};
    var no = cur.taskNo;
    var html = header('Task ' + no + ' スケッチ', 'Sketch', '', 'view');
    var entry = sketchEntry(cur.flightKey, no);
    if (!entry) return html + '<div class="center-note">画像がありません</div>';
    return html + '<div class="viewer">' + imgTag(entry.url, 'Task ' + no + ' スケッチ') + '</div>';
  }

  /** 読めなかった時（圏外で未保存など）は壊れた画像アイコンではなく理由を出す */
  function imgTag(url, alt) {
    return '<img src="' + esc(url) + '" alt="' + esc(alt) + '" onerror="TaskBoardImageError(this)">';
  }

  /** 電波が弱いと1回目が途切れることがあるので、少し待って2回まで読み直してから諦める */
  window.TaskBoardImageError = function (img) {
    var tries = Number(img.getAttribute('data-tries') || 0);
    if (tries < 2 && navigator.onLine) {
      img.setAttribute('data-tries', tries + 1);
      setTimeout(function () { img.src = img.src.split('#')[0] + '#retry' + (tries + 1); }, 1500 * (tries + 1));
      return;
    }
    img.outerHTML = '<div class="center-note">画像を読み込めませんでした。<br>電波のある場所で開き直してください。</div>';
  };

  // ---------- 設定 ----------
  function viewSettings() {
    var hasCache = state.flights.some(function (f) { return !!loadFlightCache(f.key); });
    return header('設定', 'Settings', '', 'view') +
      '<div class="wrap">' +
      '<button class="btn btn-secondary" data-act="screen" data-screen="local">📋 JSONを直接読み込む（この端末だけ）</button>' +
      '<div class="banner banner-info" style="margin:14px 0">' +
      '<b>オフラインについて</b><br>' +
      '一度同期したフライトはすべてこの端末に保存され、圏外でもヘッダー下のバーで切り替えて表示できます。' +
      '電波のある場所で一度「↻」しておいてください。</div>' +
      (hasCache ? '<button class="btn btn-ghost" data-act="clear">この端末の保存データを消す</button>' : '') +
      '<div class="hint" style="margin-top:20px">TaskBoard v' + esc(APP_VERSION) +
      '　ルール: AXMER 2026 Chapter 15' +
      (state.lastSync ? '<br>最終同期: ' + esc(fmtDateTime(state.lastSync)) : '') + '</div>' +
      '<div class="spacer"></div></div>';
  }

  function viewLocal() {
    return header('JSONを直接読み込む', 'この端末にだけ保存されます', '', 'settings') +
      '<div class="wrap">' +
      '<div class="banner banner-info" style="margin-bottom:12px">' +
      '通信できない時の緊急用です。ここで読み込んだ内容は<b>他のクルーには共有されません</b>し、次に同期すると消えます。<br>' +
      '共有するには入力担当が管理画面から登録してください。</div>' +
      '<textarea id="jsonInput" placeholder=\'{"basicInfo":{...},"tasks":[...]}\'></textarea>' +
      (state.localError ? '<div class="banner banner-error" style="margin-top:8px">' + esc(state.localError) + '</div>' : '') +
      '<button class="btn btn-primary" style="margin-top:10px" data-act="loadlocal">読み込む</button>' +
      '<div class="spacer"></div></div>';
  }

  function fmtDateTime(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return String(iso); }
  }

  // =======================================================================
  // 操作
  // =======================================================================
  document.addEventListener('click', function (ev) {
    var node = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!node) return;
    var act = node.getAttribute('data-act');

    if (act === 'closemodal') {
      // モーダル本体のクリックでは閉じない
      if (node.classList.contains('modal-backdrop') && ev.target !== node) return;
      state.modal = null; renderModal(); return;
    }
    ev.preventDefault();

    switch (act) {
      case 'toggle': {
        var key = node.getAttribute('data-key');
        state.open[key] = key === 'basic' ? !state.open[key] : (state.open[key] === false);
        render();
        break;
      }
      case 'screen':
        state.screen = node.getAttribute('data-screen');
        state.localError = null;
        render();
        break;
      case 'flight': switchFlight(node.getAttribute('data-key')); break;
      case 'sync': sync(); break;
      case 'image': loadImage(); break;
      case 'sketch': loadSketch(node.getAttribute('data-taskno')); break;
      case 'rules': state.screen = 'rules'; render(); break;
      case 'archive-group': state.archiveGroup = node.getAttribute('data-group'); render(); break;
      case 'rule': state.modal = node.getAttribute('data-taskid'); renderModal(); break;
      case 'loadlocal': {
        var text = el('jsonInput').value || '';
        try {
          var m = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
          if (!m) throw new Error('JSONが見つかりません');
          var parsed = JSON.parse(m[0]);
          if (!parsed.tasks) throw new Error('tasks が含まれていません');
          var updatedAt = new Date().toISOString();
          state.flights = state.flights.filter(function (f) { return f.key !== LOCAL_KEY; });
          state.flights.unshift({
            key: LOCAL_KEY, label: '手動入力（この端末のみ）',
            date: (parsed.basicInfo && parsed.basicInfo.date) || '', updatedAt: updatedAt,
            taskCount: (parsed.tasks || []).length, imagePages: 0
          });
          state.flightData[LOCAL_KEY] = { raw: parsed, data: normalizeData(parsed), updatedAt: updatedAt };
          state.activeFlight = LOCAL_KEY;
          state.localError = null;
          state.screen = 'view';
          render();
        } catch (e) {
          state.localError = 'エラー: ' + (e.message || String(e));
          render();
        }
        break;
      }
      case 'clear': {
        if (!confirm('この端末に保存したフライト・画像を消します。よろしいですか？')) break;
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf('tb.') === 0) safeRemove(k);
        });
        if ('caches' in window) caches.delete(IMAGE_CACHE);
        state.flights = []; state.flightData = {}; state.activeFlight = '';
        state.sketches = [];
        state.lastSync = null;
        state.screen = 'view';
        render();
        break;
      }
    }
  });

  window.addEventListener('online', function () { state.online = true; render(); sync(); });
  window.addEventListener('offline', function () { state.online = false; render(); });

  // =======================================================================
  // 起動
  // =======================================================================
  /** GAS 版が localStorage に置いていた base64 の画像と取得先 URL を消す（容量を空けるため） */
  function dropLegacyStorage() {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k === 'tb.api' || k.indexOf('tb.image.') === 0 || k.indexOf('tb.sketch.') === 0) safeRemove(k);
      });
    } catch (e) { /* localStorage が使えない環境 */ }
  }

  function loadJsonFile(path) {
    return fetch(path, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(path + ': HTTP ' + r.status); return r.json(); })
      .catch(function () { return fetch(path).then(function (r) { return r.json(); }); });
  }

  function boot() {
    dropLegacyStorage();
    Promise.all([
      loadJsonFile('./data/dictionary.json').catch(function () { return null; }),
      loadJsonFile('./data/axmer2026-ch15.json').catch(function () { return null; })
    ]).then(function (res) {
      state.dict = res[0];
      state.rules = res[1];
      buildDict(state.dict);
      buildRules(state.rules);
      restoreFromCache();
      // ルール DB を読んだ後に正規化し直す（ruleNo / 和名の補完のため）
      Object.keys(state.flightData).forEach(function (key) {
        var raw = state.flightData[key].raw;
        state.flightData[key].data = normalizeData(raw);
      });
      state.booted = true;
      render();
      if (configured() && state.online) sync();
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () { /* 未対応環境は無視 */ });
      });
    }
  }

  boot();
})();
