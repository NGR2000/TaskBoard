# キープアライブ兼バックアップ Worker

Supabase の無料プランは、**1週間ほぼアクセスが無いとプロジェクトを一時停止**します。
止まっている間はクルー用アプリに新しいフライトが出ず、登録もできません。
この Worker は毎日1回 Supabase のテーブルを1件だけ読んで、止まらないようにします。
あわせて週1回、全データと画像を Cloudflare R2 にバックアップします。

使うのは公開の anon キー（読み取り専用）と R2 だけで、秘密情報はありません。
既存の Cloudflare アカウント（他の用途の Worker があっても可）にそのまま追加できます。

## 設定（ダッシュボードだけで完結）

1. **R2 のバケットを作る**
   R2 Object Storage → Create bucket → 名前は `taskboard-backup`
2. **Worker を作る**
   Workers & Pages → Create → Worker → 名前は `taskboard-keepalive` → Deploy →
   Edit code で中身を全部消し、[`worker.js`](worker.js) を貼り付けて Deploy
3. **環境変数を入れる**（Settings → Variables and Secrets → Add、種類は Text）
   - `SUPABASE_URL` … `docs/config.js` の `supabaseUrl` と同じ値
   - `SUPABASE_ANON_KEY` … `docs/config.js` の `supabaseAnonKey` と同じ値
4. **R2 を紐づける**（Settings → Bindings → Add → R2 bucket）
   - Variable name: `BACKUP`
   - Bucket: `taskboard-backup`
5. **定期実行を入れる**（Settings → Trigger Events → Add → Cron Triggers）。2つ入れる:
   - `0 18 * * *` … 毎日 日本時間 3:00（キープアライブ）
   - `30 18 * * 0` … 毎週 日本時間 月曜 3:30（キープアライブ＋バックアップ）

   ※ 2つ目の式は `worker.js` の `BACKUP_CRON` と一字一句同じにすること。違うとバックアップが動きません。

## 動いているかの確認

- Worker の URL（`https://taskboard-keepalive.<アカウント>.workers.dev`）をブラウザで開くと、
  その場で1回アクセスして `{"ok":true,...}` を返します。`"ok":false` なら Supabase が止まっているか、
  環境変数が間違っています
- 定期実行の結果は Worker の **Logs**（または Cron Events）に残ります。失敗した回は赤く表示されます
- バックアップは R2 の `taskboard-backup` に入ります
  - `backups/YYYY-MM-DD.json` … その日のフライトとスケッチの全行
  - `files/...` … 原本とスケッチの画像（Supabase の Storage と同じパス）

## Supabase が止まってしまった時

キープアライブが何らかの理由で止まり、Supabase が一時停止した場合:

1. Supabase のダッシュボードにログイン → 該当プロジェクト → **Resume project**
2. 数分待ってからクルー用アプリで「↻」

データは消えません（停止から1年以内なら元どおりに戻せます）。
停止の約1週間前に、プロジェクトの持ち主宛てに Supabase から警告メールが届きます。
