/**
 * TaskBoard キープアライブ兼バックアップ（Cloudflare Worker）
 *
 * Supabase の無料プランは、1週間ほぼアクセスが無いとプロジェクトを一時停止する。
 * 大会シーズンの合間に止まらないよう、毎日1回テーブルを1件だけ読む。
 * あわせて週1回、フライトとスケッチの全行と画像を R2 にバックアップする
 * （無料プランには Supabase 側のバックアップが無いため）。
 *
 * もう1つの役割として、管理画面の「写真だけで速報登録」が終わった時に呼ばれ、
 * Claude Code のルーティン（変換係）を起動する（POST /notify）。呼んできた人が
 * 管理メンバーかを Supabase で確かめてから起動するので、URL を知られても悪用されない。
 *
 * 設定手順は同じフォルダの README.md。
 *
 * 環境変数:  SUPABASE_URL, SUPABASE_ANON_KEY（公開の値）
 *            ROUTINE_FIRE_URL（ルーティンの /fire の URL）
 *            ROUTINE_TOKEN（ルーティンのトークン。必ず「Secret」として登録する）
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

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/notify') return notify(request, env);
    // ブラウザでこの Worker の URL を開くと、キープアライブを1回実行して結果を返す（動作確認用）
    try {
      const n = await keepAlive(env);
      return Response.json({ ok: true, flights: n, at: new Date().toISOString() });
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
    }
  }
};

async function rest(env, path) {
  // 新しい publishable キー（sb_publishable_...）は apikey だけに載せる。旧来の anon キー（JWT）は両方に
  const headers = { apikey: env.SUPABASE_ANON_KEY };
  if (!env.SUPABASE_ANON_KEY.startsWith('sb_')) headers.Authorization = 'Bearer ' + env.SUPABASE_ANON_KEY;
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path, { headers });
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

// ---------------------------------------------------------------------
// 変換係（ルーティン）の起動
// ---------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function reply(status, obj) {
  return Response.json(obj, { status, headers: CORS });
}

/**
 * 管理画面から { key } を、ログイン中メンバーのトークン付きで受け取る。
 * そのメンバーが admins に入っていて、key のフライトが本当に「変換待ち」なら
 * ルーティンを起動する。ルーティンのトークンはこの Worker の外には出さない。
 */
async function notify(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  if (!env.ROUTINE_FIRE_URL || !env.ROUTINE_TOKEN) return reply(503, { ok: false, error: '変換係が未設定です（ROUTINE_FIRE_URL / ROUTINE_TOKEN）' });

  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return reply(401, { ok: false, error: 'ログインが必要です' });
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const asUser = { apikey: env.SUPABASE_ANON_KEY, Authorization: auth, 'Content-Type': 'application/json' };

  const admin = await fetch(base + '/rest/v1/rpc/is_admin', { method: 'POST', headers: asUser, body: '{}' });
  if (!admin.ok || (await admin.json()) !== true) return reply(403, { ok: false, error: '管理メンバーではありません' });

  let key = '';
  try { key = String((await request.json()).key || ''); } catch (e) { /* 下で弾く */ }
  if (!key) return reply(400, { ok: false, error: 'key がありません' });
  const rows = await rest(env, 'flights?select=key,label,images&key=eq.' + encodeURIComponent(key) +
    '&data->>awaitingConversion=eq.true');
  if (!rows.length) return reply(409, { ok: false, error: '変換待ちのフライトではありません' });

  const fired = await fetch(env.ROUTINE_FIRE_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.ROUTINE_TOKEN,
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text: 'flight key: ' + key + ' / label: ' + rows[0].label + ' / pages: ' + (rows[0].images || []).length })
  });
  const body = await fired.text();
  if (!fired.ok) {
    console.log('fire failed', fired.status, body.slice(0, 300));
    return reply(502, { ok: false, error: '変換係を起動できませんでした（' + fired.status + '）' });
  }
  let session = '';
  try { session = JSON.parse(body).claude_code_session_url || ''; } catch (e) { /* URL が無くても起動はできている */ }
  console.log('fired', key, session);
  return reply(200, { ok: true, session });
}
