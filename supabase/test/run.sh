#!/bin/sh
# schema.sql をローカルの使い捨て Postgres で検証する。
#   PGHOST / PGPORT / PGUSER で接続先を指定（既定: localhost:5432 postgres）
# Supabase の auth / storage は stub.sql で最小限だけ再現している。
set -e
cd "$(dirname "$0")"
DB=taskboard_schema_test
psql -q -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d $DB -f stub.sql
psql -q -v ON_ERROR_STOP=1 -d $DB -f ../schema.sql 2>/dev/null
psql -q -v ON_ERROR_STOP=1 -d $DB -f ../schema.sql 2>/dev/null   # 2回流しても壊れないこと
OUT=$(mktemp)
if ! psql -q -v ON_ERROR_STOP=1 -d $DB -f rls_test.sql >"$OUT" 2>&1; then
  sed -n 's/.*NOTICE:  //p' "$OUT"; grep -E 'ERROR|CONTEXT' "$OUT"; rm -f "$OUT"; exit 1
fi
sed -n 's/.*NOTICE:  //p' "$OUT"; rm -f "$OUT"
psql -q -c "drop database $DB"
echo "all passed"
