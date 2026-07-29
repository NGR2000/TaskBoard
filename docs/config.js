/**
 * TaskBoard PWA 設定
 *
 * apiUrl に GAS ウェブアプリの /exec URL を入れてコミットすると、
 * クルーは https://ngr2000.github.io/TaskBoard/ を開くだけで設定不要になる。
 *
 * 空のままでも動く。その場合はアプリ内の「設定」画面で URL を入力すると
 * その端末の localStorage に保存される（自分だけ）。
 *
 * 優先順位:  ?api=... （URLパラメータ）  >  localStorage  >  ここの apiUrl
 */
window.TASKBOARD_CONFIG = {
  apiUrl: "",
  appName: "TaskBoard",
  eventName: "26th FAI World Hot Air Balloon Championship 2026"
};
