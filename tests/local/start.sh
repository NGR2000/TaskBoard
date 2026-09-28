#!/bin/sh
# ローカルに「Supabase もどき」を立ち上げる（検証専用）。
#
# 必要なもの:
#   - Postgres（PGHOST / PGPORT / PGUSER で接続先を指定。スーパーユーザーで）
#   - PostgREST の実行ファイル（環境変数 POSTGREST にパス。無ければ PATH の postgrest）
#
# 立ち上がるもの:
#   http://127.0.0.1:54321  … Supabase の URL の代わり（/rest/v1・/auth/v1・/storage/v1）
#   ユーザー: admin@example.com / bot@example.com（admins に登録済み）、
#             stranger@example.com（ログインはできるが admins に無い）。パスワードはどれも "password"
#
# 止める時: tests/local/stop.sh
set -e
cd "$(dirname "$0")"
HERE=$(pwd)
STATE=${TB_LOCAL_STATE:-/tmp/taskboard-local}
DB=taskboard_local
SECRET=local-only-jwt-secret-not-for-production-0123456789
PGRST=${POSTGREST:-postgrest}
mkdir -p "$STATE"
sh "$HERE/stop.sh" >/dev/null 2>&1 || true
rm -rf "$STATE/files"

psql -q -c "drop database if exists $DB" -c "create database $DB" >/dev/null 2>&1
psql -q -v ON_ERROR_STOP=1 -d $DB -f ../../supabase/test/stub.sql >/dev/null
psql -q -v ON_ERROR_STOP=1 -d $DB -f ../../supabase/schema.sql >/dev/null 2>&1
psql -q -v ON_ERROR_STOP=1 -d $DB >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end \$\$;
grant anon, authenticated to authenticator;
grant select on storage.buckets to anon, authenticated;
insert into public.admins (email, note) values
  ('admin@example.com', 'ローカル検証'), ('bot@example.com', 'ローカル検証のボット')
  on conflict do nothing;
SQL

PGRST_DB_URI="postgres://authenticator@/${DB}?host=${PGHOST:-/var/run/postgresql}&port=${PGPORT:-5432}" \
PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET=$SECRET \
PGRST_SERVER_PORT=54330 PGRST_SERVER_HOST=127.0.0.1 PGRST_LOG_LEVEL=error \
  nohup "$PGRST" >"$STATE/postgrest.log" 2>&1 &
echo $! >"$STATE/postgrest.pid"

nohup python3 "$HERE/fake_supabase.py" --port 54321 --postgrest http://127.0.0.1:54330 \
  --secret $SECRET --files "$STATE/files" \
  --user admin@example.com:password --user bot@example.com:password --user stranger@example.com:password \
  >"$STATE/gateway.log" 2>&1 &
echo $! >"$STATE/gateway.pid"

for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null http://127.0.0.1:54321/rest/v1/flight_list && break
  sleep 0.5
done
ANON=$(python3 "$HERE/fake_supabase.py" --postgrest x --secret $SECRET --files /tmp --print-anon-key)
echo "TASKBOARD_SUPABASE_URL=http://127.0.0.1:54321"
echo "TASKBOARD_SUPABASE_ANON_KEY=$ANON"
