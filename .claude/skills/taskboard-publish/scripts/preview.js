/* クルー画面に JSON を実際に読み込ませてスクリーンショットを撮る。
 *
 *   node preview.js <flight.json> <出力プレフィックス> [--server http://127.0.0.1:8765/]
 *
 * 出力:
 *   <prefix>-info.png    基本情報カードを開いた状態の先頭画面
 *   <prefix>-task-N.png  タスクカードを1枚ずつ（N はカードの並び順、1始まり）
 *
 * 事前に docs/ を配信しておくこと（別コマンドで起動し、cwd に依存しない絶対パスで）:
 *   cd <repo> && (setsid nohup python3 -m http.server 8765 --directory docs >/dev/null 2>&1 &)
 *
 * playwright は node_modules から解決する。無ければ作業ディレクトリで `npm i playwright`。
 * Chromium は同梱済みのものを使う（PLAYWRIGHT の再インストールは不要）。
 */
const fs = require('fs');
const path = require('path');

// require はこのファイルの場所から探すので、スキル内に置いたままだと作業ディレクトリの
// node_modules が見えない。cwd を先に見るようにして、`npm i playwright` した場所から動かせるようにする。
let chromium;
try {
  ({ chromium } = require(require.resolve('playwright', { paths: [process.cwd(), __dirname] })));
} catch (e) {
  console.error('playwright が見つかりません。作業ディレクトリで `npm i playwright` してから、そのディレクトリで実行してください。');
  process.exit(2);
}

const args = process.argv.slice(2);
const jsonPath = args[0];
const prefix = args[1];
const serverIdx = args.indexOf('--server');
const server = serverIdx >= 0 ? args[serverIdx + 1] : 'http://127.0.0.1:8765/';
if (!jsonPath || !prefix) {
  console.error('usage: node preview.js <flight.json> <出力プレフィックス> [--server URL]');
  process.exit(2);
}

const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
  .find((p) => fs.existsSync(p));

(async () => {
  const json = fs.readFileSync(jsonPath, 'utf8');
  JSON.parse(json); // 壊れた JSON はここで止める（アプリ側のエラーより分かりやすい）

  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 430, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(server);
  await page.waitForTimeout(800);
  // 設定 → 「JSONを直接読み込む」。クルーが圏外で使う緊急用の入口と同じ経路なので、描画は本番と同じ。
  await page.click('[data-screen="settings"]');
  await page.waitForTimeout(300);
  await page.click('[data-screen="local"]');
  await page.waitForTimeout(300);
  await page.fill('#jsonInput', json);
  await page.click('[data-act="loadlocal"]');
  await page.waitForTimeout(1200);

  fs.mkdirSync(path.dirname(path.resolve(prefix)), { recursive: true });

  // 基本情報は既定で畳まれているので開いてから撮る
  await page.click('text=基本情報');
  await page.waitForTimeout(400);
  await page.screenshot({ path: prefix + '-info.png' });

  const cards = await page.$$('.card');
  let n = 0;
  for (const card of cards) {
    const head = (await card.textContent()).slice(0, 12);
    if (head.indexOf('基本情報') >= 0) continue;
    n++;
    await card.screenshot({ path: prefix + '-task-' + n + '.png' });
  }
  await browser.close();

  console.log('screenshots: ' + prefix + '-info.png, ' + n + ' task card(s)');
  if (errors.length) {
    console.log('JS errors: ' + errors.join(' | '));
    process.exit(1);
  }
})();
