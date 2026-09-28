/**
 * TaskBoard キープアライブ兼バックアップ（Cloudflare Worker）
 *
 * Supabase の無料プランは、1週間ほぼアクセスが無いとプロジェクトを一時停止する。
 * 大会シーズンの合間に止まらないよう、毎日1回テーブルを1件だけ読む。
 * あわせて週1回、フライトとスケッチの全行と画像を R2 にバックアップする
 * （無料プランには Supabase 側のバックアップが無いため）。
 *
 * 使うのは公開の anon キー（読み取り専用）と R2 だけ。秘密情報は置かない。
 * 設定手順は同じフォルダの README.md。
 *
 * 環境変数:  SUPABASE_URL, SUPABASE_ANON_KEY
 * R2 の紐づけ: BACKUP（変数名）
 * Cron:      毎日   "0 18 * * *"  … キープアライブ（日本時間 3:00）
 *            週1回  "30 18 * * 0" … キープアライブ＋バックアップ（日本時間 月曜 3:30）
 */

const BACKUP_CRON = '30 18 * * 0';

export default {
  async scheduled(event, env, ctx) {
    await keepAlive(env);
    if (event.cron === BACKUP_CRON) await backup(env);
  },

  // ブラウザでこの Worker の URL を開くと、キープアライブを1回実行して結果を返す（動作確認用）
  async fetch(request, env) {
    try {
      const n = await keepAlive(env);
      return Response.json({ ok: true, flights: n, at: new Date().toISOString() });
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
    }
  }
};

async function rest(env, path) {
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + env.SUPABASE_ANON_KEY }
  });
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

/** 実際のテーブルを1件読む。止まっていれば例外になり、ダッシュボードの Cron 履歴に失敗として残る */
async function keepAlive(env) {
  const rows = await rest(env, 'flights?select=key&limit=1');
  console.log('keepalive ok', rows.length);
  return rows.length;
}

async function backup(env) {
  const flights = await rest(env, 'flights?select=*&order=created_at.asc');
  const sketches = await rest(env, 'sketches?select=*');
  const day = new Date().toISOString().slice(0, 10);
  await env.BACKUP.put('backups/' + day + '.json',
    JSON.stringify({ at: new Date().toISOString(), flights, sketches }, null, 1),
    { httpMetadata: { contentType: 'application/json' } });

  // 画像はファイル名に版が入っていて中身が変わらないので、まだ無いものだけ足す
  const have = new Set();
  let cursor;
  do {
    const page = await env.BACKUP.list({ prefix: 'files/', cursor });
    page.objects.forEach(o => have.add(o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const paths = [];
  flights.forEach(f => (f.images || []).forEach(p => paths.push(p)));
  sketches.forEach(s => { paths.push(s.path); if (s.thumb_path) paths.push(s.thumb_path); });

  let copied = 0;
  for (const path of paths) {
    if (have.has('files/' + path)) continue;
    const url = env.SUPABASE_URL.replace(/\/$/, '') + '/storage/v1/object/public/taskboard/' +
      path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(url);
    if (!res.ok) { console.log('skip', path, res.status); continue; }
    await env.BACKUP.put('files/' + path, await res.arrayBuffer(),
      { httpMetadata: { contentType: res.headers.get('content-type') || 'image/jpeg' } });
    copied++;
  }
  console.log('backup ok', day, 'flights', flights.length, 'sketches', sketches.length, 'new files', copied);
}
