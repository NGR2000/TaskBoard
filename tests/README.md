# テスト

## Supabase 版（現行）

```bash
supabase/test/run.sh       # schema.sql をローカルの Postgres で検証（権限・変更履歴・updated_at）
python3 tests/rls_check.py # 本番（docs/config.js の接続先）で権限が意図どおりか確かめる
node tests/date_test.js    # タスクシート日付の解析（4形式）
```

`supabase/test/run.sh` は PGHOST / PGPORT / PGUSER で接続先を指定する（スーパーユーザーで）。
Supabase の `auth` / `storage` は `supabase/test/stub.sql` で最小限だけ再現している。

特に見ているのは:

- **匿名では書けず、`admins` に無いログインユーザーも書けないこと** — 読み取りは公開なので、
  書き込みの守りは RLS だけ
- **アーカイブや登録順の変更で `updated_at` が進まないこと** — 進むとクルーの端末で
  全フライトに「更新あり」の ● が付いてしまう
- **変更履歴に誰が何をしたかが残ること**（削除前の中身も残る）

ツール・アプリ・管理画面を通しで試す時は `tests/local/start.sh` でローカルに
「Supabase もどき」（本物の PostgREST＋ログインと画像保存だけの小さなゲートウェイ）を立てる。
使い方は README.md「開発者向け: ローカルで試す」。

## GAS 版（移行が済んだら消す）

`gas_harness.js` は `SpreadsheetApp` / `PropertiesService` などを最小限だけ偽装して
`コード.js` をそのまま Node 上で走らせる。

```bash
node tests/backend_test.js   # フライトの登録・アーカイブ・列移行・トークン検証
```
