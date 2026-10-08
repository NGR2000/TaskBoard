/**
 * TaskBoard keep-alive, backup and conversion trigger (Cloudflare Worker).
 * ASCII only on purpose: it is pasted into the Cloudflare dashboard editor.
 *
 * - Daily: read one row so the free Supabase project never pauses.
 * - Weekly: copy all flights/sketches rows and new images to R2.
 * - POST /notify: called by the admin page after a photo-only registration;
 *   checks the caller is an admin and the flight awaits conversion, then
 *   fires the "TaskBoard conversion" Claude Code routine.
 *
 * Variables: SUPABASE_URL, SUPABASE_ANON_KEY (public),
 *            ROUTINE_FIRE_URL (text), ROUTINE_TOKEN (Secret)
 * R2 binding: BACKUP
 * Cron: "0 18 * * *" daily keep-alive, "30 18 * * SUN" weekly backup
 *       (Cloudflare counts weekdays 1-7 or SUN-SAT; 0 is rejected.)
 *       Any trigger other than DAILY_CRON also runs the backup.
 * Setup: workers/keepalive/README.md
 */

const DAILY_CRON = '0 18 * * *';

export default {
  async scheduled(controller, env, ctx) {
    await keepAlive(env);
    if (controller.cron !== DAILY_CRON && env.BACKUP) await backup(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/notify') return notify(request, env);
    try {
      const n = await keepAlive(env);
      return Response.json({ ok: true, flights: n, at: new Date().toISOString() });
    } catch (e) {
      return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
    }
  }
};

async function rest(env, path) {
  const headers = { apikey: env.SUPABASE_ANON_KEY };
  if (!env.SUPABASE_ANON_KEY.startsWith('sb_')) headers.Authorization = 'Bearer ' + env.SUPABASE_ANON_KEY;
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path, { headers });
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

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
// ---------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function reply(status, obj) {
  return Response.json(obj, { status, headers: CORS });
}
async function notify(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  if (!env.ROUTINE_FIRE_URL || !env.ROUTINE_TOKEN) return reply(503, { ok: false, error: '\u5909\u63db\u4fc2\u304c\u672a\u8a2d\u5b9a\u3067\u3059\uff08ROUTINE_FIRE_URL / ROUTINE_TOKEN\uff09' });

  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return reply(401, { ok: false, error: '\u30ed\u30b0\u30a4\u30f3\u304c\u5fc5\u8981\u3067\u3059' });
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  const asUser = { apikey: env.SUPABASE_ANON_KEY, Authorization: auth, 'Content-Type': 'application/json' };

  const admin = await fetch(base + '/rest/v1/rpc/is_admin', { method: 'POST', headers: asUser, body: '{}' });
  if (!admin.ok || (await admin.json()) !== true) return reply(403, { ok: false, error: '\u7ba1\u7406\u30e1\u30f3\u30d0\u30fc\u3067\u306f\u3042\u308a\u307e\u305b\u3093' });

  let key = '';
  try { key = String((await request.json()).key || ''); } catch (e) { /* ignore */ }
  if (!key) return reply(400, { ok: false, error: 'key \u304c\u3042\u308a\u307e\u305b\u3093' });
  const rows = await rest(env, 'flights?select=key,label,images&key=eq.' + encodeURIComponent(key) +
    '&data->>awaitingConversion=eq.true');
  if (!rows.length) return reply(409, { ok: false, error: '\u5909\u63db\u5f85\u3061\u306e\u30d5\u30e9\u30a4\u30c8\u3067\u306f\u3042\u308a\u307e\u305b\u3093' });

  let fired;
  try {
    fired = await fetch(env.ROUTINE_FIRE_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.ROUTINE_TOKEN,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: 'flight key: ' + key + ' / label: ' + rows[0].label + ' / pages: ' + (rows[0].images || []).length })
    });
  } catch (e) {
    console.log('fire error', String(e));
    return reply(502, { ok: false, error: 'routine: ' + String(e.message || e) });
  }
  const body = await fired.text();
  if (!fired.ok) {
    console.log('fire failed', fired.status, body.slice(0, 300));
    return reply(502, { ok: false, error: '\u5909\u63db\u4fc2\u3092\u8d77\u52d5\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\uff08' + fired.status + '\uff09' });
  }
  let session = '';
  try { session = JSON.parse(body).claude_code_session_url || ''; } catch (e) { /* ignore */ }
  console.log('fired', key, session);
  return reply(200, { ok: true, session });
}
