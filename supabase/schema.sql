-- TaskBoard の Supabase スキーマ
--
-- Supabase ダッシュボードの SQL Editor に全文を貼って Run する。
-- 何度流しても壊れない（既存のデータは消さない）ので、このファイルを
-- 更新した時も同じように全文を流し直せばよい。
--
-- 権限の考え方:
--   読み取り … 誰でも可（クルー用アプリはログインしない。今の GAS と同じく公開）
--   書き込み … ログインしていて、かつ admins 表にメールがある人だけ
-- メンバーの追加は README.md「メンバーの追加」を参照。

-- =====================================================================
-- 管理者（書き込みできるメンバー）
-- =====================================================================
create table if not exists public.admins (
  email    text primary key check (email = lower(email)),
  note     text,
  added_at timestamptz not null default now()
);

-- RLS の中で admins を引くための関数。security definer にしてあるので、
-- admins 表そのものは匿名ユーザーから見えないままにできる。
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- =====================================================================
-- フライト（タスクデータシート1枚ぶん）
-- =====================================================================
-- 誰が変えたかは flights には持たせない（読み取りが公開なので、ここに置くと
-- メンバーのメールアドレスが誰でも見えてしまう）。history 表に残す。
create table if not exists public.flights (
  key         text primary key check (key <> ''),
  label       text not null default '',
  date        text not null default '',
  -- tasks が無いと jsonb_typeof が null になり CHECK を素通りするので coalesce する
  data        jsonb not null check (coalesce(jsonb_typeof(data -> 'tasks'), '') = 'array'),
  -- 原本ページの Storage パス（表示順）。ファイル名に版が入っていて中身は二度と変わらない
  images      text[] not null default '{}',
  archived_at timestamptz,
  created_at  timestamptz not null default now(),  -- 登録順。一覧の並びに使う
  updated_at  timestamptz not null default now()   -- クルー端末のキャッシュ判定に使う
);

-- =====================================================================
-- タスク別スケッチ
-- =====================================================================
create table if not exists public.sketches (
  flight_key text not null references public.flights(key) on delete cascade on update cascade,
  task_no    text not null,
  path       text not null,
  thumb_path text,
  updated_at timestamptz not null default now(),
  primary key (flight_key, task_no)
);

-- 中身が変わった時だけ updated_at を進める。クルー端末はこれを見て
-- 「更新あり」を出し、フライトを取り直すため。アーカイブや登録順の変更は
-- 中身の変更ではないので進めない（GAS 版と同じ）。
-- 移行スクリプトのように updated_at を明示して書き込んだ時はその値を尊重する。
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is not distinct from old.updated_at
     and (to_jsonb(new) - 'updated_at' - 'created_at' - 'archived_at')
         is distinct from (to_jsonb(old) - 'updated_at' - 'created_at' - 'archived_at') then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists flights_touch on public.flights;
create trigger flights_touch before update on public.flights
  for each row execute function public.touch_updated_at();

drop trigger if exists sketches_touch on public.sketches;
create trigger sketches_touch before update on public.sketches
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 変更履歴（誰が・いつ・何を）。訂正前の状態に戻す時の控えにもなる
-- =====================================================================
create table if not exists public.history (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text,          -- ログイン中メンバーのメール。SQL Editor からの操作は null
  table_name text not null,
  op         text not null, -- INSERT / UPDATE / DELETE
  row_key    text not null, -- flights は key、sketches は "<flight_key>/<task_no>"
  old_row    jsonb,
  new_row    jsonb
);
create index if not exists history_row_key_idx on public.history (row_key, at desc);

create or replace function public.record_history()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  k text;
begin
  if tg_table_name = 'sketches' then
    k := (r ->> 'flight_key') || '/' || (r ->> 'task_no');
  else
    k := r ->> 'key';
  end if;
  insert into public.history (actor, table_name, op, row_key, old_row, new_row)
  values (
    auth.jwt() ->> 'email',
    tg_table_name,
    tg_op,
    k,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return null;
end;
$$;

drop trigger if exists flights_history on public.flights;
create trigger flights_history after insert or update or delete on public.flights
  for each row execute function public.record_history();

drop trigger if exists sketches_history on public.sketches;
create trigger sketches_history after insert or update or delete on public.sketches
  for each row execute function public.record_history();

-- =====================================================================
-- クルー用アプリの一覧（今の GAS の action=flights と同じ情報）
-- =====================================================================
-- data 本体は重いので返さない。個別に flights?key=eq.<key> で取りに来る。
create or replace view public.flight_list
with (security_invoker = true) as
select
  key,
  label,
  date,
  images,
  archived_at,
  created_at,
  updated_at,
  coalesce(jsonb_array_length(data -> 'tasks'), 0)             as task_count,
  coalesce(data -> 'basicInfo' ->> 'competitionName', '')      as competition_name
from public.flights;

-- =====================================================================
-- 行レベルの権限（RLS）
-- =====================================================================
alter table public.admins   enable row level security;
alter table public.flights  enable row level security;
alter table public.sketches enable row level security;
alter table public.history  enable row level security;

drop policy if exists "admins: admins read" on public.admins;
create policy "admins: admins read" on public.admins
  for select to authenticated using (public.is_admin());
-- admins への追加・削除は SQL Editor / Table Editor からのみ（ポリシーを置かない）

drop policy if exists "flights: anyone reads" on public.flights;
create policy "flights: anyone reads" on public.flights
  for select to anon, authenticated using (true);
drop policy if exists "flights: admins write" on public.flights;
create policy "flights: admins write" on public.flights
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "sketches: anyone reads" on public.sketches;
create policy "sketches: anyone reads" on public.sketches
  for select to anon, authenticated using (true);
drop policy if exists "sketches: admins write" on public.sketches;
create policy "sketches: admins write" on public.sketches
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "history: admins read" on public.history;
create policy "history: admins read" on public.history
  for select to authenticated using (public.is_admin());
-- history への書き込みはトリガーだけ（security definer）。直接の書き込み・改ざんはできない

grant select on public.flight_list to anon, authenticated;

-- =====================================================================
-- 画像の置き場所（Storage）
-- =====================================================================
-- 公開バケット: URL を知っていれば誰でも読める（クルー用アプリ・CDN 配信のため）。
-- 書き込みはテーブルと同じく管理者だけ。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('taskboard', 'taskboard', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "taskboard: admins read" on storage.objects;
create policy "taskboard: admins read" on storage.objects
  for select to authenticated using (bucket_id = 'taskboard' and public.is_admin());
drop policy if exists "taskboard: admins insert" on storage.objects;
create policy "taskboard: admins insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'taskboard' and public.is_admin());
drop policy if exists "taskboard: admins update" on storage.objects;
create policy "taskboard: admins update" on storage.objects
  for update to authenticated using (bucket_id = 'taskboard' and public.is_admin());
drop policy if exists "taskboard: admins delete" on storage.objects;
create policy "taskboard: admins delete" on storage.objects
  for delete to authenticated using (bucket_id = 'taskboard' and public.is_admin());
