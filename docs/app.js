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

  var APP_VERSION = '3.0.0';
  var LS = {
    api: 'tb.api',
    flightsIndex: 'tb.flights.index',
    activeFlight: 'tb.activeFlight',
    sketchIdx: 'tb.sketches',
    lastSync: 'tb.lastSync',
    flightPrefix: 'tb.flight.',      // + key  -> { data, updatedAt }
    lastViewedPrefix: 'tb.lastViewed.', // + key -> ISO timestamp
    imagePrefix: 'tb.image.',        // + key
    sketchPrefix: 'tb.sketch.'       // + flightKey + '.' + taskNo（大会をまたぐとタスク番号が再利用されるため）
  };
  var CFG = window.TASKBOARD_CONFIG || {};
  var LOCAL_KEY = '__local__';

  // =======================================================================
  // state
  // =======================================================================
  var state = {
    screen: 'view',
    booted: false,
    apiUrl: '',
    flights: [],       // [{key,label,date,updatedAt,taskCount,competitionName,archived,imagePages}]
                       // アーカイブ済みもここに含める。除くと圏外で開けなくなるため（restoreFromCache 参照）
    flightData: {},    // key -> { raw, data, updatedAt }
    activeFlight: '',
    images: [],
    sketches: [],       // [{flightKey,taskNo}] スケッチが存在する組み合わせ
    sketchCache: {},    // key: flightKey + '.' + taskNo
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
    targetGPS: 1, targetColor: 1, targetColour: 1, mma: 1
  };
  var BASIC_RESERVED = {
    competitionName: 1, CompetitionName: 1, date: 1, notes: 1, generalNotes: 1, fields: 1,
    notesJa: 1, notes_ja: 1, generalNotesJa: 1
  };

  function pushField(list, label, value, opts) {
    if (isBlank(value)) return;
    var f = { label: String(label), value: String(value).trim() };
    if (opts && opts.wide) f.wide = true;
    if (opts && !isBlank(opts.valueJa)) f.valueJa = String(opts.valueJa).trim();
    list.push(f);
  }

  /** 任意の形の fields（配列 or オブジェクト）を [{label,value,valueJa?}] に揃える。
   *  valueJa はシート原文が長い自由記述の時だけ変換元(Claude)が添える和訳（無ければ辞書のみ）。 */
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
        pushField(out, label, value, { wide: !!f.wide, valueJa: valueJa });
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

  function normalizeBasic(src) {
    var b = src || {};
    var info = {
      competitionName: firstOf(b.competitionName, b.CompetitionName, CFG.eventName, ''),
      date: firstOf(b.date, ''),
      notes: firstOf(b.notes, b.generalNotes, ''),
      notesJa: firstOf(b.notesJa, b.notes_ja, b.generalNotesJa, ''),
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
  // API (GET のみ。fetch が塞がれた時は JSONP に落とす)
  // =======================================================================
  function fetchJson(url, timeoutMs) {
    if (typeof AbortController === 'undefined' || typeof fetch !== 'function') {
      return Promise.reject(new Error('fetch 未対応'));
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    return fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'follow' })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .catch(function (e) { clearTimeout(timer); throw e; });
  }

  var jsonpSeq = 0;
  function jsonp(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var cb = '__tbcb' + (++jsonpSeq) + '_' + Date.now();
      var script = document.createElement('script');
      var done = false;
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      var timer = setTimeout(function () {
        if (done) return; done = true; cleanup();
        reject(new Error('応答がありません（タイムアウト）'));
      }, timeoutMs);
      window[cb] = function (data) { if (done) return; done = true; cleanup(); resolve(data); };
      script.onerror = function () { if (done) return; done = true; cleanup(); reject(new Error('接続に失敗しました')); };
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + cb;
      document.head.appendChild(script);
    });
  }

  function apiGet(action, params) {
    if (!state.apiUrl) return Promise.reject(new Error('データの取得先（GASのURL）が設定されていません'));
    var qs = ['action=' + encodeURIComponent(action)];
    Object.keys(params || {}).forEach(function (k) {
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    });
    var url = state.apiUrl + (state.apiUrl.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
    return fetchJson(url, 15000).catch(function () { return jsonp(url, 15000); });
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
    return apiGet('flight', { key: key })
      .then(function (res) {
        if (!res || res.ok === false || !res.data) return;
        saveFlightCache(key, res.data, res.updatedAt);
        var raw = JSON.parse(res.data);
        state.flightData[key] = { raw: raw, data: normalizeData(raw), updatedAt: res.updatedAt };
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
    return apiGet('flights')
      .then(function (res) {
        if (!res || res.ok === false) throw new Error((res && res.error) || 'サーバーがエラーを返しました');
        // サーバーは登録順（古い→新しい）で返す。フライト切替バーと自動選択は
        // 「タスクシートの日付が新しいものが先頭」にしたいので反転する。
        // 訂正登録は既存行を上書きするだけで並びは動かないため、登録順＝日付順という前提でよい。
        state.flights = (res.flights || []).filter(function (f) { return f.key !== LOCAL_KEY; }).reverse();
        state.sketches = res.sketches || [];
        safeSet(LS.flightsIndex, JSON.stringify(state.flights));
        safeSet(LS.sketchIdx, JSON.stringify(state.sketches));
        state.lastSync = new Date().toISOString();
        safeSet(LS.lastSync, state.lastSync);
        pickActiveFlight();
        safeSet(LS.activeFlight, state.activeFlight);
        state.syncing = false;
        render();
        return prefetchFlights();
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

  /** 原本タスクシートは複数ページ（image_<key>_1, _2, ...）に対応する */
  function loadImage() {
    var key = state.activeFlight;
    var meta = state.flights.filter(function (f) { return f.key === key; })[0];
    var total = (meta && meta.imagePages) || 0;
    state.screen = 'image';

    if (total === 0) { state.images = []; render(); return; }

    var cached = [];
    for (var i = 1; i <= total; i++) {
      var c = safeGet(LS.imagePrefix + key + '.' + i);
      if (!c) { cached = null; break; }
      cached.push(c);
    }
    if (cached) { state.images = cached; render(); return; }

    state.images = [];
    state.syncing = true;
    render();

    var results = new Array(total);
    var remaining = total;
    var anyFailed = false;
    function loadPage(page) {
      apiGet('image', { key: key, page: page })
        .then(function (res) {
          var img = (res && res.image) || null;
          results[page - 1] = img;
          if (img) safeSet(LS.imagePrefix + key + '.' + page, img);
        })
        .catch(function () { anyFailed = true; })
        .then(function () {
          remaining--;
          if (remaining > 0) return;
          state.images = results.filter(function (x) { return !!x; });
          state.syncing = false;
          if (anyFailed && !state.images.length) state.syncError = '画像の取得に失敗しました';
          render();
        });
    }
    for (var p = 1; p <= total; p++) loadPage(p);
  }

  /** スケッチはタスク番号だけでなくフライトにも紐づく（大会をまたぐと番号が再利用されるため） */
  function sketchCacheKey(flightKey, taskNo) { return flightKey + '.' + taskNo; }

  function loadSketch(taskNo) {
    var flightKey = state.activeFlight;
    state.currentSketch = { flightKey: flightKey, taskNo: taskNo };
    var ck = sketchCacheKey(flightKey, taskNo);
    var cached = state.sketchCache[ck] || safeGet(LS.sketchPrefix + ck);
    if (cached) { state.sketchCache[ck] = cached; state.screen = 'sketch'; render(); return; }
    state.screen = 'sketch';
    state.syncing = true;
    render();
    apiGet('sketch', { flightKey: flightKey, taskNo: taskNo })
      .then(function (res) {
        var img = (res && res.image) || null;
        state.sketchCache[ck] = img;
        if (img) safeSet(LS.sketchPrefix + ck, img);
      })
      .catch(function (e) { state.syncError = e.message || String(e); })
      .then(function () { state.syncing = false; render(); });
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
        (state.apiUrl
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
    html += renderBasic(d.basicInfo);
    html += d.tasks.map(renderTask).join('');
    html += '<div class="spacer"></div></div>';
    return html;
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

  function renderBasic(info) {
    var open = !!state.open.basic;
    var rows = info.fields.map(function (f) { return renderRow(f.label, f.value, f.wide, f.valueJa); }).join('');
    if (!rows && !info.notes) return '';
    return '<div class="card">' +
      '<div class="card-header" data-act="toggle" data-key="basic">' +
        '<div class="task-head"><h2>📋 基本情報 <span class="rule-no">Event Information</span></h2></div>' +
        '<span class="chevron">' + (open ? '▲' : '▼') + '</span>' +
      '</div>' +
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
      (task.isGMD ? '<span class="badge-gmd">🚨 GMD</span>' : '') +
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
      if (task.isGMD) {
        body += '<div class="gmd-alert">🚨 GMD（重力落下）— 投げると距離ペナルティ<br>' +
          '<span style="font-weight:400;font-size:12px">Gravity Marker Drop: 両足をゴンドラに付けたまま落下させること</span></div>';
      }
      body += renderTargets(task);
      if (!isBlank(task.markerColor)) body += renderRow('Marker Colour', task.markerColor);
      if (!isBlank(task.markerDrop)) body += renderRow('Marker Drop', task.markerDrop);
      body += task.fields.map(function (f) { return renderRow(f.label, f.value, f.wide, f.valueJa); }).join('');
      body += renderTimer(task);
      body += renderNotes(task.notes, task.notesJa);
      body += renderAttach(task);
      body += '</div>';
    }

    return '<div class="card' + (task.isGMD ? ' alert' : '') + '">' +
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
  function renderRow(label, value, wide, valueJa) {
    if (isBlank(value)) return '';
    var L = lookupLabel(label);
    var V = lookupValue(value);
    if (!V.known && !isBlank(valueJa)) V = { ja: valueJa, en: value, known: true, color: V.color };
    var labelHtml = '<span class="label-ja">' + esc(L.ja) +
      (L.known ? '' : '<span class="unknown-flag">辞書外</span>') + '</span>' +
      (L.en ? '<span class="label-en">' + esc(L.en) + '</span>' : '');
    var valueHtml =
      (V.color ? '<span class="dot" style="color:' + esc(V.color) + '">● </span>' : '') +
      '<span class="value-ja">' + esc(V.ja) + '</span>' +
      (V.en ? '<span class="value-en">' + esc(V.en) + '</span>' : '');
    var isLong = String(value).length > 32;
    return '<div class="row' + (wide || isLong ? ' wide' : '') + '">' +
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

  function renderAttach(task) {
    var no = String(task.taskNo || '');
    var flightKey = state.activeFlight;
    var has = state.sketches.some(function (x) { return x.flightKey === flightKey && x.taskNo === no; }) ||
      !!state.sketchCache[sketchCacheKey(flightKey, no)];
    if (!has) return '<div class="attach empty">📎 スケッチなし</div>';
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
    if (state.syncing) return html + '<div class="center-note">読み込み中…</div>';
    if (!state.images || !state.images.length) return html + '<div class="center-note">画像がありません' +
      (state.syncError ? '<br><br>' + esc(state.syncError) : '') + '</div>';
    var multi = state.images.length > 1;
    return html + '<div class="viewer">' + state.images.map(function (img, i) {
      return (multi ? '<div class="viewer-page-label">' + (i + 1) + ' / ' + state.images.length + '</div>' : '') +
        '<img src="' + esc(img) + '" alt="原本タスクシート ' + (i + 1) + 'ページ目">';
    }).join('') + '</div>';
  }

  function viewSketch() {
    var cur = state.currentSketch || {};
    var no = cur.taskNo;
    var html = header('Task ' + no + ' スケッチ', 'Sketch', '', 'view');
    if (state.syncing) return html + '<div class="center-note">読み込み中…</div>';
    var img = state.sketchCache[sketchCacheKey(cur.flightKey, no)];
    if (!img) return html + '<div class="center-note">画像がありません' +
      (state.syncError ? '<br><br>' + esc(state.syncError) : '') + '</div>';
    return html + '<div class="viewer"><img src="' + esc(img) + '" alt="Task ' + esc(no) + ' スケッチ"></div>';
  }

  // ---------- 設定 ----------
  function viewSettings() {
    var hasCache = state.flights.some(function (f) { return !!loadFlightCache(f.key); });
    return header('設定', 'Settings', '', 'view') +
      '<div class="wrap">' +
      '<label class="field">データの取得先（GAS ウェブアプリの /exec URL）</label>' +
      '<input type="url" id="apiInput" value="' + esc(state.apiUrl) + '" placeholder="https://script.google.com/macros/s/.../exec">' +
      '<div class="hint">入力担当のGASウェブアプリのURLです。<br>' +
      'config.js に書いてコミットしておけば、クルーはこの設定なしで開けます。</div>' +
      '<button class="btn btn-primary" style="margin-top:12px" data-act="saveapi">保存して同期</button>' +
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
      '共有するには入力担当がGASの管理画面から登録してください。</div>' +
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
      case 'saveapi': {
        var v = (el('apiInput').value || '').trim();
        state.apiUrl = v;
        if (v) safeSet(LS.api, v); else safeRemove(LS.api);
        state.screen = 'view';
        render();
        if (v) sync();
        break;
      }
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
          if (k.indexOf('tb.') === 0 && k !== LS.api) safeRemove(k);
        });
        state.flights = []; state.flightData = {}; state.activeFlight = '';
        state.images = []; state.sketchCache = {}; state.sketches = [];
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
  function resolveApiUrl() {
    var params = new URLSearchParams(location.search);
    var fromUrl = params.get('api');
    if (fromUrl) { safeSet(LS.api, fromUrl); return fromUrl; }
    return safeGet(LS.api) || CFG.apiUrl || '';
  }

  function loadJsonFile(path) {
    return fetch(path, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(path + ': HTTP ' + r.status); return r.json(); })
      .catch(function () { return fetch(path).then(function (r) { return r.json(); }); });
  }

  function boot() {
    state.apiUrl = resolveApiUrl();
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
      if (state.apiUrl && state.online) sync();
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () { /* 未対応環境は無視 */ });
      });
    }
  }

  boot();
})();
