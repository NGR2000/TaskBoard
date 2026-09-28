# TaskBoard

熱気球競技のタスクシートを、AIで読み取ったJSONからクルー共有用の画面に整形して表示する仕組み。
2026年世界選手権（26th FAI World Hot Air Balloon Championship, ポーランド・クロスノ）に向けて、
**オフライン対応**と**タスクシート形式変更への耐性**を軸に作り直したもの。
データの置き場所は Supabase（Postgres＋画像ストレージ）。

---

## 構成

```
┌─────────────────────────────┐    ┌──────────────────────────────┐
│ 入力担当（管理メンバー）     │    │      クルー（閲覧のみ）        │
│                             │    │                              │
│ 管理画面  …/TaskBoard/admin/ │    │  PWA  ngr2000.github.io/     │
│ ・メンバーごとにログイン     │    │       TaskBoard/             │
│ ・フライト登録・原本・スケッチ│    │  ・オフラインで開ける         │
│ ・変更履歴                   │    │  ・日本語大／英語小            │
│ Claude（tools/publish.py）   │    │  ・フライト切替バーで行き来   │
└──────────────┬──────────────┘    └──────────────┬───────────────┘
               │ ログインして書き込み               │ 読み取りのみ（anon キー）
               ▼                                   ▼
     ┌──────────────────────────────────────────────────────┐
     │ Supabase                                              │
     │  Postgres: flights / sketches / admins / history      │
     │  Storage : taskboard バケット（原本・スケッチの画像）  │
     └──────────────────────────────────────────────────────┘
               ▲ 毎日1回アクセス（一時停止の防止）・週1回バックアップ
     ┌─────────┴───────────────┐
     │ Cloudflare Worker ＋ R2 │  workers/keepalive/
     └─────────────────────────┘
```

**なぜこの形か**

- 閲覧アプリと管理画面はどちらも GitHub Pages（`docs/`）。サーバー側のコードは無く、
  Supabase を直接読み書きする。**書き込みの可否はデータベース側の規則（RLS）で決める**
  （`supabase/schema.sql`）。読み取りは誰でも可、書き込みは `admins` 表に載ったメンバーだけ
- 画像はファイルのまま Storage に置き、CDN から配る。ファイル名に版が入っていて中身は二度と
  変わらないので、端末（Service Worker）に保存したら二度と落とさない。同期のあと、
  アーカイブしていないフライトの原本とスケッチは裏で先に取り込むので、**会場で電波が悪くても開ける**
- **誰がいつ何を変えたか**は `history` 表に自動で残る。訂正前の内容にも戻せる
- **フライトは上書きせず積み重ねる。** 大会中はフライトが進むごとに新しいタスクデータシートが
  発表される。直前のフライトを消してしまうと、着陸後の振り返りやスコア確認で前のフライトの
  内容を見返せなくなる。クルーはヘッダー下のバーでいつでも過去のフライトに切り替えられる

以前は Google Apps Script（GAS）とスプレッドシートで動いていた。画像を base64 にして
セルに分割保存していたため遅く、管理も1人の Google アカウントに縛られていたので移行した
（移行手順は「GAS からの移行」）。

### ファイル

| パス | 役割 |
|---|---|
| `docs/` | GitHub Pages に公開する部分 |
| `docs/config.js` | Supabase の URL と anon キー（公開前提の値）。アプリ・管理画面・tools が共通で読む |
| `docs/app.js` | クルー用アプリ。正規化・辞書適用・複数フライトの同期と切替・描画 |
| `docs/sw.js` | Service Worker（オフライン・画像の保存） |
| `docs/admin/index.html` | 管理画面（ログイン・登録・原本・スケッチ・アーカイブ・履歴） |
| `docs/data/dictionary.json` | **用語辞書**（英語表記 → 日本語） |
| `docs/data/axmer2026-ch15.json` | AXMER 2026 Chapter 15 の全21タスク定義（和訳付き） |
| `docs/*.png` | ホーム画面／タブ用アイコン（`make_icons.py` の生成物。手で編集しない） |
| `supabase/schema.sql` | テーブル・権限（RLS）・変更履歴・画像バケットの定義。SQL Editor に貼って流す |
| `supabase/test/` | `schema.sql` をローカルの Postgres で検証するテスト |
| `tools/publish.py` | 変換済みJSONと原本・スケッチを登録する（ワークフローB） |
| `tools/taskboard_db.py` | tools 共通の Supabase クライアント（標準ライブラリのみ） |
| `tools/migrate_from_gas.py` | GAS 版の全データを Supabase へ移す（一度きり） |
| `tools/make_icons.py` | `tools/icon-source.png` から PWA のアイコン一式を作り直す |
| `workers/keepalive/` | 一時停止を防ぐ毎日のアクセスと週1回のバックアップ（Cloudflare Worker） |
| `tests/rls_check.py` | 本番の Supabase で権限が意図どおりかを確かめる |
| `tests/local/` | ローカルに「Supabase もどき」を立てて通しで試すためのもの |
| `.claude/skills/` | Claude 用スキル（`taskboard-convert` = 変換、`taskboard-publish` = 反映・確認・スケッチ添付、`taskboard-watch` = 公開待ちの監視と変更の反映）。`taskboard-publish/scripts/` にプレビュー撮影（`preview.js`）と本番状態の確認（`taskboard_state.py`）を同梱 |
| `JSON/sample_worlds2026_v2.json` | 新スキーマのサンプル |
| `JSON/kro2025_flight{1,2,3,4}.json` | 実データ（KRO2025 Pre Worlds）のフィクスチャ |

---

## セットアップ（最初に1回。プロジェクトの持ち主が行う）

### 1. GitHub Pages を有効にする

リポジトリの Settings → Pages → Source: `Deploy from a branch` →
Branch: `main` / フォルダ: `/docs` → Save。
数分後に `https://ngr2000.github.io/TaskBoard/` で開けるようになる。

### 2. Supabase のプロジェクトを作る

1. https://supabase.com でアカウントを作り、New project（リージョンは **Tokyo**、プランは Free）
2. **SQL Editor** → New query → `supabase/schema.sql` の全文を貼って **Run**
   （このファイルを更新した時も、同じように全文を流し直せばよい。データは消えない）
3. **Authentication → Sign In / Providers → Email** で「Allow new users to sign up」を**オフ**にする
   （メンバーは招待だけで増やす）
4. **Authentication → URL Configuration** の Site URL を `https://ngr2000.github.io/TaskBoard/admin/` にする
   （招待・パスワード再設定メールのリンクの行き先）
5. **Project Settings → API** の Project URL と anon public キーを `docs/config.js` に書いてコミットする。
   どちらも公開前提の値（anon キーでできるのは読み取りだけ）

### 3. メンバーを追加する（自分も含めて）

下の「メンバーの追加」の手順で、自分と、Claude 用のボットアカウントを追加する。

### 4. 一時停止を防ぐ Worker を置く

`workers/keepalive/README.md` の手順で Cloudflare に Worker を1つ置く（ダッシュボードだけで完結）。

---

## メンバーの追加

管理画面を使えるのは、**Supabase にアカウントがあり、かつ `admins` 表にメールアドレスがある人**だけ。
追加はプロジェクトの持ち主（または Supabase のダッシュボードを触れる人）が行う。

1. **Authentication → Users → Add user → Send invitation** でメールアドレスを入れる
   → 本人に招待メールが届き、リンクから管理画面でパスワードを設定する
2. **Table Editor → admins → Insert row** で同じメールアドレスを**小文字で**入れる（`note` に名前など）

外す時は、`admins` からその行を消す（書き込めなくなる）。Authentication → Users から消せばログインもできなくなる。

**Claude 用のボット**も同じ手順で1人ぶん作る（例: `taskboard-bot@…`）。招待の代わりに
Add user → Create new user でメールとパスワードを直接決めてよい（Auto Confirm をオン）。
そのメールとパスワードは、Claude Code の環境設定で
`TASKBOARD_BOT_EMAIL` / `TASKBOARD_BOT_PASSWORD` に入れる。**リポジトリやチャットには書かない。**
漏れた時はボットのパスワードを変えるか、`admins` から外せばすぐ無効になる。

---

## 使い方

入力担当のやり方は2通りある。**どちらを使ってもよく、いつでも混ぜられる。**

| | A. 管理画面で手動 | B. Claude から一気に |
|---|---|---|
| 手順 | Claudeで変換 → 管理画面に貼り付け → 原本アップ | タスクシートを渡して「反映して」だけ |
| 必要なもの | ブラウザと自分のアカウント | ボットアカウントの設定（初回のみ） |
| 向いている時 | 現地でスマホしかない時、確実に自分の目で確認したい時 | 手数を減らしたい時、原本が複数ページのPDFの時 |

Bが失敗しても、Aは何も変わらず使える。**大会本番で不安ならAだけで完結する。**

### A. 入力担当 — 管理画面で手動（ブリーフィング後、電波のある場所で）

1. `https://ngr2000.github.io/TaskBoard/admin/` を開いてログインする
2. Claude にタスクシート画像を送り「**TaskBoard用JSONに変換して**」と依頼
3. 「対象フライト」で **＋ 新しいフライトとして登録** を選ぶ（訂正の時だけ一覧からそのフライトを選ぶ。
   カードの「編集」を押すと、今の内容がフォームに入る）
4. 出てきたJSONを貼り付けて「登録して全クルーに反映」— ラベルは空でも
   JSONの中身（Flight番号・Tasks番号）から自動で付く。既存フライトの訂正でラベルを空にすると今のラベルのまま
5. 原本画像・スケッチがあれば登録（原本は「2.」で選んでいるフライトに紐づく。
   複数ページは順番通りに「+ ページを追加」で足す。PDFのまま選べば全ページを順番に追加する）
6. 初回だけ「クルーに配るリンク」をLINEで共有。以降のフライトはこのURLのまま増えていく

各フライトの「履歴」で、誰がいつ何を変えたかが見られる。タスク内容が変わった行の
「変更前をフォームへ」を押すと、訂正前の内容をフォームに戻せる（確認して登録すれば元に戻る）。

### B. 入力担当 — Claude から一気に反映する

タスクシート（PDF・写真どちらでも）を Claude に渡して「**反映して**」と言うだけで、
読み取り → 変換 → プレビュー → 反映 → 原本アップまで通る。
反映の直前に必ずクルー画面のプレビューが出るので、そこで確認してからGOを出す。

裏で動いているのは `tools/publish.py`。手で叩くこともできる。

```bash
export TASKBOARD_BOT_EMAIL=... TASKBOARD_BOT_PASSWORD=...
python3 tools/publish.py --json flight.json --original tds.pdf --key worlds2026-flight7 --label "Flight 7 (#21-#24)"
```

- 接続先は `docs/config.js` から自動で読む
- 既存フライトを直す時は `--key <既存のkey>` を付ける。付けなければ新規フライトになる。
  既存フライトの更新で `--label` を省くと、今のラベルのまま
- 迷ったら `--dry-run` で送信せず内容だけ確認できる
- 登録済みフライトに**原本だけ後から足す**場合は `--json` を省く（タスク内容とラベルには触らない）:
  `python3 tools/publish.py --key <既存のkey> --original tds.pdf`
- **タスク別スケッチ**（図・手描き）は `--sketch <タスク番号>:<画像パス>` を繰り返し指定する:
  `python3 tools/publish.py --key <既存のkey> --sketch 20:task20.png --sketch 22:task22.png`
  タスクカードに出すプレビュー用の軽量サムネイルも自動で一緒に作る
- 状態の確認は `python3 .claude/skills/taskboard-publish/scripts/taskboard_state.py list`
  （`archive` / `unarchive` / `show` / `history` もある）

### クルー

1. 配られたURLを開く（ホーム画面に追加しておくとアプリとして起動する）
2. **電波のあるうちに一度「↻」を押す** — 全フライトと、アーカイブしていないフライトの原本・スケッチが
   この端末に保存され、圏外でも開ける
3. ヘッダー下のバーでフライトを切り替える。まだ見ていない／更新されたフライトには
   赤い ● が付く。開くと消える
4. バー右端の **📦 アーカイブ** から過去のフライトを開ける。
   **年 / 月 / 大会** で見出しをまとめ直せる
5. タスク名の横の **?** でそのタスクのAXMERルール（和訳）が読める

---

## 困った時

| 症状 | 原因と対処 |
|---|---|
| クルーのアプリに新しいフライトが出ない・「同期できませんでした」 | Supabase が一時停止しているかもしれない。ダッシュボード → プロジェクト → **Resume project** → 数分待って「↻」。キープアライブ Worker のログも確認する（`workers/keepalive/README.md`） |
| 管理画面で「管理者として登録されていません」 | ログインはできているが `admins` にメールが無い。「メンバーの追加」の2を行う |
| パスワードを忘れた | ログイン画面の「パスワードを忘れた」から再設定メールを送る |
| Claude の反映で「権限がありません」 | ボットのメールが `admins` に無い |
| Claude の反映で「ログインできませんでした」 | `TASKBOARD_BOT_EMAIL` / `TASKBOARD_BOT_PASSWORD` が違う |
| 権限が正しいか不安 | `python3 tests/rls_check.py`（本番に確認用フライトを1件作って消す） |

Supabase の無料プランは **1週間ほぼアクセスが無いと一時停止**する。キープアライブ Worker が
毎日アクセスするので普段は止まらない。止まる約1週間前にはプロジェクトの持ち主へ警告メールも届く。
止まってもデータは消えない（1年以内なら元どおりに戻せる）。

---

## GAS からの移行

GAS 版からの切り替えは次の順で行う（一度きり）。

1. 「セットアップ」の 2〜3 を済ませる
2. `python3 tools/migrate_from_gas.py` — GAS の公開読み取りAPIから全フライト・原本・スケッチを読み、
   Supabase に書き込み、最後に中身（画像はバイト単位）を突き合わせる。何度流しても同じ結果になる
3. `python3 tests/rls_check.py` で権限を確認する
4. `docs/config.js` を切り替えて main にマージする。クルーの端末は Service Worker の仕組み上、
   **2回目の起動から**新しい版になる（1回目は古い版が開き、裏で更新される）
5. `workers/keepalive/` を置く
6. 1大会ぶん問題なく動いたら、GAS 一式（`コード.js`・ルートの `index.html`・`appsscript.json`・
   `.clasp*`・`.github/workflows/deploy-gas.yml`・`tests/*.js` の GAS 用テスト）を消す。
   それまでは GAS を読み取り専用の控えとして残しておく

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
        { "label": "Min / Max Distance from CLP", "value": "3000m / 8000m" },
        { "label": "Goals available for declaration",
          "value": "any coordinate (no goal number) with altitude: goal altitude must be at least 1000ft higher than declaration point",
          "valueJa": "ゴール番号のない任意の座標（高度指定あり）：ゴール高度は宣言地点より1000ft以上高いこと" }
      ],
      "notes": "...",
      "notesJa": "..."
    }
  ]
}
```

`targets` を省略して旧形式の `targetGPS` に
`"1650/8208 (Red), 1927/7744 (White)"` のように書いた場合も、
座標と色名を自動で分解して1つずつ表示する。

`value` が単語（色名・"Free"・"In Order" など）なら辞書が自動で和訳するので `valueJa` は不要。
**辞書に無い長い自由記述**（"Goals available for declaration" の説明文、Scoring Area の説明文など）
だけ `valueJa` を添えると、日本語を太字・英語原文を小さくその下に二重表記する。
`notes` / `basicInfo.notes` も同様に `notesJa` を添えられる（無ければ従来通り英語のみ表示）。

### ブリーフィング後の変更（キャンセル・修正）

競技中にタスクがキャンセルされたり内容が修正されたりした時のためのフィールド。
一度登録したフライトのJSONに追記して同じ `key` で再登録すると、クルー画面に変更が分かる形で出る。

```jsonc
{
  "basicInfo": {
    "changeNotice": "Task 9 and Task 10 cancelled after briefing (13/09 announcement)",
    "changeNoticeJa": "ブリーフィング後の発表により Task 9・Task 10 がキャンセルになりました（13/09）",
    // ↑ 基本情報の見出し直下に赤字で常時表示（カードが畳まれていても見える）
    // "現在の変更" は1件だけ。過去の変更も残したい時は changeHistory に追記していく
    // （新しい変更が来るたびに、直前の changeNotice を末尾に足してから上書きする）
    "changeHistory": [
      {
        "at": "9/13",
        // ↑ 正確な発表時刻が分からない時は無理に時刻を書かない。日付だけ、
        //   「ブリーフィングにて」など、実際に確認できた粒度でよい
        "notice": "Task 9 and Task 10 cancelled after briefing",
        "noticeJa": "ブリーフィング後の発表により Task 9・Task 10 がキャンセルになりました"
      }
    ]
    // ↑ 赤バナーの下に「更新履歴（N件）」として折りたたみ表示。新しい方が上に出る
  },
  "tasks": [
    {
      "taskNo": "9",
      "cancelled": true   // ← カード全体をグレーアウトし、「🚫 キャンセル」バッジを出す。カウントダウンも止める
    },
    {
      "taskNo": "11",
      "changeNote": "Goal coordinates corrected after briefing",
      "changeNoteJa": "ブリーフィング後にゴール座標が修正されました",
      // ↑ タスクカード内に黄色の注意ボックスとして表示
      "targets": [
        { "coordinates": "5764/4400", "altitude": "2126ft", "mma": "R30m" }
      ],
      "fields": [
        // 具体的にどの項目が変わったかを示したい時は、その項目に changed: true を付ける
        { "label": "Goals available for declaration", "value": "...", "changed": true }
      ]
    }
  ]
}
```

`cancelled` はタスク単位、`changeNotice`/`changeNoticeJa` はフライト全体（基本情報）向け、
`changeNote`/`changeNoteJa` は個別タスク向け、`fields[].changed` はその中でもさらに
特定の項目だけを目立たせたい時に使う。`basicInfo.changeHistory` は複数回の変更を積み重ねて
残すための配列（省略時は履歴なし＝現在の `changeNotice` だけが表示される）。すべて省略可能で、
無ければ今まで通りの表示になる。

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
    "fields": [ { "label": "シート上の英語表記", "value": "値", "valueJa": "値が長い自由記述の説明文の時だけ、その和訳" } ],
    "notes": "General Notes があれば",
    "notesJa": "notes の和訳（notesがあれば必ず添える）"
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
      "fields": [ { "label": "シート上の英語表記", "value": "値", "valueJa": "値が長い自由記述の説明文の時だけ、その和訳" } ],
      "notes": "そのタスクの注記",
      "notesJa": "notes の和訳（notesがあれば必ず添える）"
    }
  ]
}

規則:
- ターゲットが複数ある場合は targets に1つずつ分けて入れる。MMAがターゲットごとに違う場合も個別に。
- 距離の指定（Min/Max Distance など）は fields にシートの表記どおり入れる。
- value は翻訳しない。シートに書いてある英語のまま入れる（アプリ側で日本語化する）。
- ただし value が単語や短い定型句（色名・Free・In Order など）ではなく1文以上の説明文
  （例: "Goals available for declaration" や "Description of scoring area(s)" の中身、
  スコアリング方法の説明など）の場合は、同じ項目に valueJa として日本語訳を追加する
  （アプリ側の辞書は単語しかカバーできないため）。短い値には valueJa を付けない。
- notes / basicInfo の notes も、英語のままの notes に加えて notesJa に日本語訳を入れる。
- 読み取れなかった箇所は勝手に補わず、空文字にするか項目ごと省く。
- JSON のみを出力する。
```

---

## フライトの切り替えについて

- クルー側は同期のたびに「フライト一覧（ラベル・日付・更新時刻）」だけをまず取得し、
  各フライトの中身は表示中のフライトを優先しながら裏で1件ずつ取得して端末に保存する
  （軽いテキストなので、基本的に全フライト分をまとめて先読みする）。
  そのため一度同期しておけば、圏外でもどのフライトへも切り替えられる。
- フライトの見分けは `key`（例: `worlds2026-flight3`）。ラベルを変えても
  同じフライトとして扱われる。既存の `key` で再登録すると上書き（訂正）になる。
- 「JSONを直接読み込む（この端末だけ）」で読み込んだ内容は一時フライトとして
  バーに加わるが、次に「↻」で同期すると消える（あくまで緊急用）。

## フライトのアーカイブ

大会が進むとフライトが積み上がる。削除はせず「アーカイブ」に送ることで、
クルー側の切替バーを常に「今のフライト」だけに保てる。

- **管理画面の「3. 登録済みフライト」**の各カードにある「アーカイブ」を押す。戻すのも同じ場所
  （Claude からは `taskboard_state.py archive <key>` / `unarchive <key>`）
- アーカイブしたフライトはクルー側の切替バーから外れ、バー右端の **📦 アーカイブ** に入る
- アーカイブ画面では **年 / 月 / 大会** の3通りに見出しをまとめ直せる
- 日付は `01.05.2025 AM` `2026.8.8` `2026年8月20日（木）AM` などバラバラなので、
  数字の並びから年・月を判定する。判定できないものは推測せず「日付不明」にまとめる
- アーカイブ済みは同期時に先読みしない（件数が増えても同期が重くならないように）。
  アーカイブ前に端末へ保存済みなので、通常は圏外でも開ける
- **訂正のために再登録してもアーカイブ状態は維持される**。アーカイブしても「更新あり」の ● は付かない

## 制限・注意

- 初回だけは通信が必要。**一度も開いていない端末は圏外では起動できない。**
  大会前にクルー全員に一度開いてもらうこと。
- `docs/` 以下を更新したら `docs/sw.js` の `CACHE_VERSION` を上げること。
  上げないと古いキャッシュが残る（管理画面 `docs/admin/` はキャッシュしないので不要）。
- 削除は管理画面からのみ。フライトを消すと原本・スケッチの画像も消える（行の中身は変更履歴に残る）。
  普段はアーカイブを使う。クルー側アプリには破壊的な操作は置いていない。
- 原本のPDF変換は管理画面側でCDNから読み込む変換ライブラリ（pdf.js）に依存するため、
  通信できる状態で行う必要がある（クルー側アプリは変換済みの画像しか受け取らないので影響しない）。
- **アイコンを変えた後は、クルーの端末で一度ホーム画面から削除して追加し直す必要がある。**
  iOSは追加した時点のアイコンを保持し、あとから差し替えても更新されない。

## 開発者向け: ローカルで試す

本物の Supabase を触らずに、ローカルの Postgres と PostgREST で通しで試せる。

```bash
supabase/test/run.sh                  # schema.sql の権限・履歴のテスト（PGHOST 等で接続先を指定）
POSTGREST=/path/to/postgrest tests/local/start.sh   # Supabase もどきを 127.0.0.1:54321 に立てる
```

`start.sh` が表示する URL と anon キーを `TASKBOARD_SUPABASE_URL` / `TASKBOARD_SUPABASE_ANON_KEY` に入れると、
tools/*.py はそちらを向く（ユーザーは `admin@example.com` / `bot@example.com`、パスワードは `password`）。
アプリを試す時は `docs/` を別の場所に写し、`config.js` だけ同じ値に書き換えて配信する。

## 参考

- ルール（和訳）: https://ngr2000.github.io/AXMER2026Chp15JP/
- 大会情報・スコア: https://watchmefly.net/events/event.php?e=worlds2026
