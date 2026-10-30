-- schema.sql の権限と履歴の動きを確かめる（ローカル検証専用。run.sh から流す）
\set ON_ERROR_STOP 1
insert into public.admins (email) values ('admin@example.com') on conflict do nothing;

create or replace function pg_temp.as_user(r text, email text) returns void language plpgsql as $$
begin
  execute format('set role %I', r);
  perform set_config('request.jwt.claims',
    case when email is null then '' else json_build_object('email', email)::text end, false);
end $$;

create or replace function pg_temp.expect_denied(sql text, what text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when insufficient_privilege or check_violation then
    raise notice 'OK  (拒否された): %', what; return;
  end;
  -- RLS の using 句に合わない UPDATE/DELETE はエラーにならず 0 行になる
  get diagnostics sql = row_count;
  if sql = '0' then raise notice 'OK  (0行): %', what; return; end if;
  raise exception 'NG  通ってしまった: %', what;
end $$;

-- 匿名（クルー用アプリ）
select pg_temp.as_user('anon', null);
select pg_temp.expect_denied($$insert into public.flights (key, data) values ('x', '{"tasks":[]}')$$, '匿名はフライトを登録できない');
select pg_temp.expect_denied($$insert into storage.objects (bucket_id, name) values ('taskboard', 'a.jpg')$$, '匿名は画像を置けない');
reset role;

-- ログインしているが admins に無い人
select pg_temp.as_user('authenticated', 'stranger@example.com');
select pg_temp.expect_denied($$insert into public.flights (key, data) values ('x', '{"tasks":[]}')$$, '管理者でない人は登録できない');
select pg_temp.expect_denied($$insert into storage.objects (bucket_id, name) values ('taskboard', 'a.jpg')$$, '管理者でない人は画像を置けない');
do $$ begin if (select count(*) from public.admins) <> 0 then raise exception 'NG 管理者でない人に admins が見えた'; end if; raise notice 'OK  管理者でない人に admins は見えない'; end $$;
reset role;

-- 管理者
select pg_temp.as_user('authenticated', 'admin@example.com');
insert into public.flights (key, label, date, data, images)
  values ('f1', 'Flight 1', '20.09.2026', '{"basicInfo":{"competitionName":"Worlds"},"tasks":[{"taskNo":"1"},{"taskNo":"2"}]}', array['originals/f1/1-a.jpg']);
insert into public.sketches (flight_key, task_no, path) values ('f1', '2', 'sketches/f1/2-a.jpg');
insert into storage.objects (bucket_id, name) values ('taskboard', 'originals/f1/1-a.jpg');
select pg_temp.expect_denied($$insert into public.flights (key, data) values ('bad', '{"no":"tasks"}')$$, 'tasks の無い JSON は入らない');
do $$ declare t timestamptz; begin
  select updated_at into t from public.flights where key = 'f1';
  perform pg_sleep(0.01);
  update public.flights set archived_at = now(), created_at = now() where key = 'f1';
  if (select updated_at from public.flights where key = 'f1') <> t then raise exception 'NG アーカイブで updated_at が進んだ'; end if;
  raise notice 'OK  アーカイブ・登録順の変更では updated_at は進まない';
  update public.flights set label = 'Flight 1 訂正' where key = 'f1';
  if (select updated_at from public.flights where key = 'f1') <= t then raise exception 'NG updated_at が進まない'; end if;
  raise notice 'OK  中身の更新で updated_at が進む';
end $$;
do $$ begin if (select count(*) from public.history) <> 0 then raise notice 'OK  管理者は履歴を読める'; else raise exception 'NG 履歴が読めない'; end if; end $$;
do $$ begin
  if not public.is_admin() then raise exception 'NG 管理者の rpc(is_admin) が true にならない'; end if;
  if (select count(*) from public.admins) <> 1 then raise exception 'NG 管理者がメンバー一覧を読めない'; end if;
  raise notice 'OK  管理者は is_admin を呼べて、メンバー一覧を読める';
end $$;
reset role;

-- 匿名は読める・履歴は読めない
select pg_temp.as_user('anon', null);
do $$ declare r record; begin
  select * into r from public.flight_list where key = 'f1';
  if r.task_count <> 2 or r.competition_name <> 'Worlds' or r.archived_at is null then raise exception 'NG flight_list: %', r; end if;
  raise notice 'OK  匿名は flight_list を読める (task_count=%, competition=%)', r.task_count, r.competition_name;
  if (select count(*) from public.sketches) <> 1 then raise exception 'NG 匿名がスケッチを読めない'; end if;
  raise notice 'OK  匿名はスケッチ一覧を読める';
end $$;
-- 権限エラー（GRANT なし）でも 0 行（RLS）でも、見えなければよい
do $$ begin
  begin
    if (select count(*) from public.history) <> 0 then raise exception 'NG 匿名に履歴が見えた'; end if;
  exception when insufficient_privilege then null;
  end;
  raise notice 'OK  匿名に履歴は見えない';
end $$;
-- GV4D のブリッジが anon キーで叩いているのと同じ読み方
do $$ declare n int; d jsonb; begin
  select count(*) into n from (
    select key, label, date, archived_at, updated_at, task_count, competition_name
    from public.flight_list order by created_at asc, key asc) q;
  if n <> 1 then raise exception 'NG GV4D の一覧の読み方で読めない'; end if;
  select data into d from public.flights where key = 'f1';
  if jsonb_typeof(d -> 'tasks') <> 'array' then raise exception 'NG GV4D がフライト1件を読めない'; end if;
  raise notice 'OK  匿名は GV4D と同じ読み方で flight_list と flights を読める';
end $$;
select pg_temp.expect_denied($$select public.is_admin()$$, '匿名は is_admin を呼べない');
select pg_temp.expect_denied($$insert into public.sketches (flight_key, task_no, path) values ('f1', '9', 'x')$$, '匿名はスケッチを登録できない');
select pg_temp.expect_denied($$update public.flights set label = 'hacked'$$, '匿名は書き換えられない');
select pg_temp.expect_denied($$delete from public.flights$$, '匿名は削除できない');
reset role;

-- 履歴の中身と、削除で一緒に消えるもの
select pg_temp.as_user('authenticated', 'admin@example.com');
delete from public.flights where key = 'f1';
reset role;
do $$ begin
  if exists (select 1 from public.sketches where flight_key = 'f1') then raise exception 'NG フライト削除でスケッチが残った'; end if;
  raise notice 'OK  フライトを消すとスケッチも消える';
  if (select string_agg(table_name || ':' || op || ':' || coalesce(actor,'-'), ',' order by id) from public.history)
     <> 'flights:INSERT:admin@example.com,sketches:INSERT:admin@example.com,flights:UPDATE:admin@example.com,flights:UPDATE:admin@example.com,flights:DELETE:admin@example.com,sketches:DELETE:admin@example.com'
  then raise exception 'NG 履歴: %', (select string_agg(table_name || ':' || op || ':' || coalesce(actor,'-'), ',' order by id) from public.history); end if;
  raise notice 'OK  履歴に誰が何をしたかが残る（削除前の中身も old_row に残る）';
end $$;

-- public のテーブル・ビューには、すべて明示的な GRANT と（テーブルなら）RLS があること。
-- 2026/10/30 以降の Supabase は新しいテーブルを自動では API に公開しないので、
-- GRANT を書き忘れたテーブルを足すと、本番ではそのテーブルだけ "permission denied" になる
do $$ declare r record; bad text := ''; begin
  for r in
    select c.relname, c.relkind, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
  loop
    if not (has_table_privilege('anon', 'public.' || quote_ident(r.relname), 'select')
            or has_table_privilege('authenticated', 'public.' || quote_ident(r.relname), 'select')) then
      bad := bad || ' ' || r.relname || '(GRANT なし)';
    end if;
    if r.relkind in ('r', 'p') and not r.relrowsecurity then
      bad := bad || ' ' || r.relname || '(RLS なし)';
    end if;
  end loop;
  if bad <> '' then raise exception 'NG 公開設定の足りないテーブル:%', bad; end if;
  raise notice 'OK  public のテーブル・ビューはすべて GRANT と RLS が明示されている';
end $$;
