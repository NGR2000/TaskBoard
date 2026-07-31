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
  apiUrl: "https://script.google.com/macros/s/AKfycbxaGi3KcMjPCsX4_dbOEcBo4D3J1RDF04Rr9jN91i4cv0hkoZrH6iqy0_axZkm3STystQ/exec",
  appName: "TaskBoard",
  eventName: "26th FAI World Hot Air Balloon Championship 2026"
};
