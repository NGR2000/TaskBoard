// コード.js を Node で実際に動かすための最小の Spreadsheet 偽装。
// saveFlight の列数不一致や archived の引き継ぎは、実際に走らせないと分からないため。
const fs = require('fs'), vm = require('vm');

function makeSheet(name) {
  const cells = [];           // cells[r][c] 0-based
  function ensure(r, c) {
    while (cells.length < r) cells.push([]);
    for (const row of cells) while (row.length < c) row.push('');
  }
  const sheet = {
    _name: name, _maxCols: 26,
    getName: () => sheet._name,
    getLastRow: () => cells.length,
    getLastColumn: () => cells.reduce((m, r) => Math.max(m, r.length), 0),
    getMaxColumns: () => sheet._maxCols,
    insertColumnsAfter: (after, n) => { sheet._maxCols += n; },
    appendRow: (arr) => { cells.push(arr.slice()); },
    deleteRow: (r) => { cells.splice(r - 1, 1); },
    clearContents: () => { cells.length = 0; },
    getRange: (row, col, nRows, nCols) => {
      nRows = nRows || 1; nCols = nCols || 1;
      if (col + nCols - 1 > sheet._maxCols) throw new Error('Range out of bounds (columns)');
      return {
        getValues: () => {
          ensure(row + nRows - 1, col + nCols - 1);
          const out = [];
          for (let r = 0; r < nRows; r++) {
            const src = cells[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < nCols; c++) line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
            out.push(line);
          }
          return out;
        },
        setValues: (vals) => {
          if (vals.length !== nRows) throw new Error('row count mismatch');
          for (const v of vals) if (v.length !== nCols)
            throw new Error('The number of columns in the data does not match the number of columns in the range. データ ' + v.length + '、範囲 ' + nCols);
          ensure(row + nRows - 1, col + nCols - 1);
          for (let r = 0; r < nRows; r++) {
            while (cells.length < row + r) cells.push([]);
            for (let c = 0; c < nCols; c++) cells[row - 1 + r][col - 1 + c] = vals[r][c];
          }
        },
        setValue: (v) => {
          ensure(row, col);
          while (cells.length < row) cells.push([]);
          cells[row - 1][col - 1] = v;
        }
      };
    },
    _dump: () => JSON.parse(JSON.stringify(cells))
  };
  return sheet;
}

function makeContext(opts) {
  const sheets = [];
  const props = Object.assign({}, (opts && opts.props) || {});
  const ss = {
    getSheetByName: (n) => sheets.filter(s => s._name === n)[0] || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets.push(s); return s; },
    getSheets: () => sheets.slice(),
    deleteSheet: (s) => { const i = sheets.indexOf(s); if (i >= 0) sheets.splice(i, 1); }
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; },
      deleteProperty: (k) => { delete props[k]; }
    })},
    Utilities: { sleep: () => {}, getUuid: () => 'uuid-uuid-uuid-uuid' },
    Logger: { log: () => {} },
    ContentService: { MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }) },
    HtmlService: { createHtmlOutputFromFile: () => ({ setTitle(){return this;}, setXFrameOptionsMode(){return this;}, addMetaTag(){return this;} }), XFrameOptionsMode: { ALLOWALL: 1 } },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://example/exec' }) },
    console
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('/home/user/TaskBoard/コード.js', 'utf8'), ctx);
  ctx.__sheets = sheets;
  ctx.__ss = ss;
  return ctx;
}
module.exports = { makeContext, makeSheet };
