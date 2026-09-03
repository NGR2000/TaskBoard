/* docs/app.js の parseFlightDate を抜き出して、実データの4形式で確認する。
   "01.05.2025" を1月5日と読む事故（new Date の既定解釈）を防ぐのが主眼。 */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../docs/app.js', 'utf8');
const m = src.match(/ {2}function parseFlightDate\(text\) \{[\s\S]*?\n {2}\}\n/);
if (!m) { console.error('parseFlightDate を app.js から取り出せませんでした'); process.exit(1); }
eval(m[0]);

const cases = [
  ['01.05.2025 AM', 2025, 5], ['01.05.2025 PM', 2025, 5], ['02.05.2025 AM', 2025, 5],
  ['18.09.2022', 2022, 9], ['2026.8.8', 2026, 8], ['2026.8.22', 2026, 8],
  ['2026年8月20日（木）AM', 2026, 8], ['2025年5月5日（月）AM 0515', 2025, 5],
  ['2024年11月4日（月）AM', 2024, 11],
  ['', null, null], ['未定', null, null], ['31.13.2025', null, null], ['1234', null, null], [null, null, null]
];
let fail = 0;
cases.forEach(function (c) {
  const got = parseFlightDate(c[0]);
  const ok = c[1] === null ? got === null : (got && got.year === c[1] && got.month === c[2]);
  if (!ok) fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + JSON.stringify(c[0]) + ' -> ' + JSON.stringify(got));
});
console.log('失敗: ' + fail);
process.exit(fail ? 1 : 0);
