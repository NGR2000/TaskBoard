# TaskBoard

熱気球競技のタスクシートを、AIで読み取ったJSONからクルー共有用の画面に整形して表示する仕組み。
2026年世界選手権（26th FAI World Hot Air Balloon Championship, ポーランド・クロスノ）に向けて、
**オフライン対応**と**タスクシート形式変更への耐性**を軸に作り直したもの。

---

## 構成

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  入力担当（パイロット）  │        │      クルー（閲覧のみ）        │
│                         │        │                              │
│  GAS 管理画面           │        │  GitHub Pages の PWA         │
│  .../exec               │        │  ngr2000.github.io/TaskBoard │
│  ・フライトごとに登録    │        │  ・オフラインで開ける         │
│  ・原本画像             │        │  ・日本語大／英語小            │
│  ・スケッチ             │        │  ・フライト切替バーで行き来   │
└───────────┬─────────────┘        └──────────────┬───────────────┘
            │ google.script.run                   │ GET (JSON / JSONP)
            ▼                                     ▼
     ┌──────────────────────────────────────────────────┐
     │  スプレッドシート（flights / image_* / sketch_*） │
     └──────────────────────────────────────────────────┘
```

**なぜこの分け方にしたか**

- 閲覧アプリを GitHub Pages に置いたので Service Worker が使え、**圏外でもタスクシートが開く**。
  GAS の HtmlService はサンドボックス iframe 内で動くため、これは構造的に実現できなかった。
- クルーに配るURLが GitHub Pages 側で固定される。**GASを何度再デプロイしてもリンクが死なない。**
- 書き込みは GAS 管理画面の `google.script.run` に閉じているので、
  ブラウザ→GAS の CORS 問題が発生しうる経路が無い。閲覧側は GET のみ（失敗時は JSONP に自動フォールバック）。
- 同期時に画像の base64 を返さない。原本・スケッチは開いた時だけ取得し、端末に保存する。
- **フライトは上書きせず積み重ねる。** 大会中はフライトが進むごとに新しいタスクデータシートが
  発表される。直前のフライトを消してしまうと、着陸後の振り返りやスコア確認で前のフライトの
  内容を見返せなくなる。クルーはヘッダー下のバーでいつでも過去のフライトに切り替えられる。

### ファイル

| パス | 役割 |
|---|---|
| `コード.js` | GAS。JSON API（`?action=flights/flight/image/sketch/ping`）と管理画面の配信 |
| `index.html` | GAS の入力・管理画面（フライト一覧・登録・編集・削除） |
| `docs/` | GitHub Pages に公開する閲覧用PWA |
| `docs/app.js` | 正規化・辞書適用・複数フライトの同期と切替・描画 |
| `docs/data/dictionary.json` | **用語辞書**（英語表記 → 日本語） |
| `docs/data/axmer2026-ch15.json` | AXMER 2026 Chapter 15 の全21タスク定義（和訳付き） |
| `docs/sw.js` | Service Worker（オフライン） |
| `JSON/sample_worlds2026_v2.json` | 新スキーマのサンプル |
| `JSON/kro2025_flight{1,2,3,4}.json` | 実データ（KRO2025 Pre Worlds）のフィクスチャ |

---

## セットアップ

### 1. GitHub Pages を有効にする

リポジトリの Settings → Pages → Source: `Deploy from a branch` →
Branch: `main` / フォルダ: `/docs` → Save。

数分後に `https://ngr2000.github.io/TaskBoard/` で開けるようになる。

### 2. GAS をデプロイする

```bash
clasp push
```

Apps Script エディタ → デプロイ → 新しいデプロイ → 種類「ウェブアプリ」

- 次のユーザーとして実行: **自分**
- アクセスできるユーザー: **全員**

発行された `.../exec` URL を控える。

### 3. 閲覧アプリに取得先を教える

`docs/config.js` の `apiUrl` に `/exec` URL を書いてコミットする。

```js
window.TASKBOARD_CONFIG = {
  apiUrl: "https://script.google.com/macros/s/XXXXXXXX/exec",
  ...
};
```

これでクルーは `https://ngr2000.github.io/TaskBoard/` を開くだけでよくなる。

書き換えずに使うこともできる。GAS 管理画面の「1. クルーに配るリンク」に出る
`...?api=<exec URL>` 付きのURLを配れば同じように動く（設定はその端末に保存される）。

---

## 使い方

### 入力担当（ブリーフィング後、電波のある場所で）

1. GAS の `/exec` を開く（＝管理画面）
2. Claude にタスクシート画像を送り「**TaskBoard用JSONに変換して**」と依頼
3. 「対象フライト」で **＋ 新しいフライトとして登録** を選ぶ（誤字の訂正など、既存フライトを
   直す時だけ一覧からそのフライトを選ぶ）
4. 出てきたJSONを貼り付けて「登録して全クルーに反映」— ラベルは空でも
   JSONの中身（Flight番号・Tasks番号）から自動で付く
5. 原本画像・スケッチがあれば登録（原本は「2.」で選んでいるフライトに紐づく。
   タスクシートが複数ページにわたる場合は、順番通りに「+ ページを追加」で1枚ずつ足す）
6. 初回だけ「クルーに配るリンク」をLINEで共有。以降のフライトはこのURLのまま増えていく

### クルー

1. 配られたURLを開く（ホーム画面に追加しておくとアプリとして起動する）
2. **電波のあるうちに一度「↻」を押す** — 全フライトがこの端末に保存され、圏外でも開ける
3. ヘッダー下のバーでフライトを切り替える。まだ見ていない／更新されたフライトには
   赤い ● が付く。開くと消える
4. タスク名の横の **?** でそのタスクのAXMERルール（和訳）が読める

---

## タスクシートの形式が変わったとき

このアプリは項目名を決め打ちしていない。タスクシートに知らない項目が出ても
**英語のまま必ず表示され、`辞書外` の印が付く**。情報が落ちることはない。

日本語化したくなったら `docs/data/dictionary.json` の `labels` に1行足すだけ。

```json
{ "ja": "接近コリドー", "en": "Approach Corridor", "keys": ["approachcorridor"] }
```

`keys` は正規化済みのキー（小文字化 → `colour`→`color` / `metre`→`meter` → 英数字以外を除去）。
表記ゆれは `keys` に並べれば全部同じ訳に寄せられる。

値の側（`Free`、`In Order`、色名など）も `values` で同じように追加できる。
`color` を付けると ● の色分けに使われる。

---

## JSON スキーマ

新形式（v2）は「決め打ちの項目」を最小限にし、残りを `fields` の
**ラベルと値の組**として素通しする。旧形式（v1）もそのまま読めるので、
過去のJSONを作り直す必要はない。

```jsonc
{
  "schemaVersion": 2,
  "basicInfo": {
    "competitionName": "26th FAI World Hot Air Balloon Championship 2026",
    "date": "2026年8月20日（木）AM",
    "fields": [
      { "label": "Launch Period", "value": "0600 - 0700" }   // ← タスクシートの表記そのまま
    ],
    "notes": "..."
  },
  "tasks": [
    {
      "taskNo": "13",            // タスクシートの番号をそのまま。アプリは振り直さない
      "taskId": "HWZ",           // AXMER のタスクID。ここからルール解説と和名を自動で引く
      "ruleNo": "15.3",          // 省略可（taskId から補完される）
      "markerColor": "Yellow",
      "markerDrop": "GMD",       // GMD を含むと自動で赤い警告が出る
      "scoringPeriodEnd": "09:00",
      "targets": [               // 複数ターゲットはここに並べる
        { "name": "Red",   "color": "Red",   "coordinates": "4890/7102", "mma": "R 70m" },
        { "name": "White", "color": "White", "coordinates": "4773/7415", "mma": "R 80m" }
      ],
      "fields": [
        { "label": "Min / Max Distance from CLP", "value": "3000m / 8000m" }
      ],
      "notes": "..."
    }
  ]
}
```

`targets` を省略して旧形式の `targetGPS` に
`"1650/8208 (Red), 1927/7744 (White)"` のように書いた場合も、
座標と色名を自動で分解して1つずつ表示する。

---

## Claude に渡す変換プロンプト

```
このタスクシート画像を TaskBoard 用 JSON に変換してください。

【最重要】タスクシートに書かれている項目は、私が指定した項目名に無理に当てはめず、
シート上の英語表記のまま fields に { "label": ..., "value": ... } として入れてください。
知らない項目名でも構いません。省略せず全部入れてください。

出力形式:
{
  "schemaVersion": 2,
  "basicInfo": {
    "competitionName": "...",
    "date": "YYYY年M月D日（曜）AM/PM",
    "fields": [ { "label": "シート上の英語表記", "value": "値" } ],
    "notes": "General Notes があれば"
  },
  "tasks": [
    {
      "taskNo": "タスクシートに書かれている番号をそのまま（勝手に1から振り直さない）",
      "taskId": "PDG / JDG / HWZ / FIN / FON / HNH / WSD / GBM / CRT / RTA / ELB /
                 LRN / MDT / SFL / MDD / XDT / XDI / XDD / ANG / 3DT / APT のいずれか",
      "ruleNo": "15.x（書かれていれば）",
      "markerColor": "マーカー色（あれば）",
      "markerDrop": "Free / GMD など（あれば）",
      "scoringPeriodEnd": "HH:MM（あれば）",
      "targets": [
        { "name": "Red", "color": "Red", "coordinates": "1650/8208", "mma": "R 70m" }
      ],
      "fields": [ { "label": "シート上の英語表記", "value": "値" } ],
      "notes": "そのタスクの注記"
    }
  ]
}

規則:
- ターゲットが複数ある場合は targets に1つずつ分けて入れる。MMAがターゲットごとに違う場合も個別に。
- 距離の指定（Min/Max Distance など）は fields にシートの表記どおり入れる。
- 値は翻訳しない。シートに書いてある英語のまま入れる（アプリ側で日本語化する）。
- 読み取れなかった箇所は勝手に補わず、空文字にするか項目ごと省く。
- JSON のみを出力する。
```

---

## フライトの切り替えについて

- クルー側は同期のたびに「フライト一覧（ラベル・日付・更新時刻）」だけをまず取得し、
  各フライトの中身は表示中のフライトを優先しながら裏で1件ずつ取得して端末に保存する
  （画像と違って軽いテキストなので、基本的に全フライト分をまとめて先読みする）。
  そのため一度同期しておけば、圏外でもどのフライトへも切り替えられる。
- フライトの見分けは GAS 側の `key`（例: `flight-3`）。管理画面でラベルを変えても
  同じフライトとして扱われる。既存の `key` で再登録すると上書き（訂正）になる。
- 「JSONを直接読み込む（この端末だけ）」で読み込んだ内容は一時フライトとして
  バーに加わるが、次に「↻」で同期すると消える（あくまで緊急用）。

## 制限・注意

- 初回だけは通信が必要。**一度も開いていない端末は圏外では起動できない。**
  大会前にクルー全員に一度開いてもらうこと。
- 原本画像・スケッチは端末の localStorage に保存する。容量上限（およそ5MB）を
  超えた分は保存されず、その画像だけ毎回取得しにいく（表示自体はできる）。
- `docs/` 以下を更新したら `docs/sw.js` の `CACHE_VERSION` を上げること。
  上げないと古いキャッシュが残る。
- GAS のデプロイを作り直して `/exec` URL が変わった場合は `docs/config.js` も更新する。
- 大会全体のリセット（全フライト削除）は管理画面の「6.」からのみ行える。
  クルー側アプリには破壊的な操作は置いていない。

## 参考

- ルール（和訳）: https://ngr2000.github.io/AXMER2026Chp15JP/
- 大会情報・スコア: https://watchmefly.net/events/event.php?e=worlds2026
