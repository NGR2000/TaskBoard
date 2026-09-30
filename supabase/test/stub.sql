-- Supabase が用意している auth / storage / ロールを最小限だけ再現する（ローカル検証専用）
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id serial primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage, public to anon, authenticated;
grant all on storage.objects to anon, authenticated;
grant usage on all sequences in schema storage to anon, authenticated;
-- 2026年5月30日以降の Supabase は public のテーブルを自動では公開しない。
-- それに合わせて既定の権限は付けず、schema.sql の GRANT だけで動くことを確かめる。
