/**
 * TaskBoard PWA 設定
 *
 * Supabase の URL と anon キー（どちらも公開前提の値）。クルー用アプリ・管理画面
 * （docs/admin/）・tools/*.py が共通でここを読む。
 * anon キーでできるのは読み取りだけで、書き込みはログインした管理者に限られる
 * （supabase/schema.sql の RLS）。
 */
window.TASKBOARD_CONFIG = {
  supabaseUrl: "https://qlcslkvpudelhmcnjbcf.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsY3Nsa3ZwdWRlbGhtY25qYmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzNzIwNjgsImV4cCI6MjEwNjk0ODA2OH0.Hsza62zZzyO671gEk6cuDLIBriOyc6eUSVu8Na9kfKY",
  // 写真だけの速報登録のあと、変換係（Claude のルーティン）を起こす Worker の URL。
  // 空なら起こさない（決めた時間帯の定期確認だけになる）。workers/keepalive/README.md 参照
  notifyUrl: "https://taskboard-keepalive.rnogamigm.workers.dev",
  appName: "TaskBoard",
  eventName: ""
};
