/**
 * TaskBoard PWA 設定
 *
 * Supabase の URL と anon キー（どちらも公開前提の値）。クルー用アプリ・管理画面
 * （docs/admin/）・tools/*.py が共通でここを読む。
 * anon キーでできるのは読み取りだけで、書き込みはログインした管理者に限られる
 * （supabase/schema.sql の RLS）。
 */
window.TASKBOARD_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  appName: "TaskBoard",
  eventName: "26th FAI World Hot Air Balloon Championship 2026"
};
