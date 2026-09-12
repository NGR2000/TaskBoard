---
name: taskboard-publish
description: Takes a task sheet (PDF, photo, or a URL to an event page listing task-sheet PDFs) all the way to live on the TaskBoard crew app — fetch, convert, preview, confirm, register, upload the original pages, verify, and hand off any per-task sketch/diagram. Use this whenever the user wants a task sheet actually registered, reflected, or visible to the crew: "反映して", "登録して", "アップして", "登録とアップして", "クルーに出して", "一気にやって", a task sheet plus "変換してアップ", or "タスクシートが公表された" with a link. Also use it for follow-ups on registered flights — archive a test flight, check what's live, attach a diagram to a task — since those go through the same write API. If the user only wants the JSON text, use taskboard-convert instead.
---

# TaskBoard one-shot publish

Take a task sheet from file (or URL) to live on the crew app without the user touching the admin panel. This writes to competition data a crew relies on, so the preview and confirmation steps carry the weight; the rest is mechanical and mostly scripted.

Scripts bundled here (paths relative to this skill directory):

| Script | Does |
|---|---|
| `scripts/taskboard_state.py list` | Live flights (key, label, date, task count, pages, archived) and which flight/task pairs have sketches |
| `scripts/taskboard_state.py archive <key>` / `unarchive <key>` | Archive a flight via the write API (data stays; crew sees it under 📦) |
| `scripts/preview.js <flight.json> <prefix>` | Loads the JSON into the real crew app and screenshots the basic-info card and every task card |

`tools/publish.py` (repo root) does the registering and original-page upload.

## What has to be in place

- `TASKBOARD_TOKEN` in the environment. If missing, stop and ask the user to set it in their Claude Code environment settings (it is the `TASKBOARD_API_TOKEN` script property). Never ask for it in chat.
- A GAS deployment that includes `doPost`. Non-JSON responses or "unknown action" mean the deployed version is older than the repo. `taskboard_state.py list` prints a warning if the response still carries the pre-sketch-fix `sketchTaskNos` field — that also means the deployment is stale.

Deploying GAS is the user's job (`git pull` → `clasp push` → "デプロイを管理 → 新バージョン"). The single most common failure is running `clasp push` from a checkout that was never pulled; when a redeploy "didn't work", check that first.

## Step 1 — Fetch and convert

Follow `taskboard-convert` for reading and shaping (it covers URLs, PDFs, photos, date rules, `valueJa`). Write each flight's JSON to the scratchpad. Use absolute paths everywhere — the shell's cwd resets between commands here.

## Step 2 — Preview through the real app

Raw JSON hides exactly the mistakes that matter. Render it:

```bash
cd <repo> && (setsid nohup python3 -m http.server 8765 --directory docs >/dev/null 2>&1 < /dev/null &)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8765/      # expect 200
cd <dir with node_modules/playwright> && node <skill>/scripts/preview.js /abs/flight.json /abs/out/prefix
```

Start the server in its own command with `setsid nohup`; a `pkill` whose pattern matches the calling shell kills the command itself (exit 144), and a server started in a plain `&` tends to die with the call. If `playwright` is missing, `npm i playwright` in the scratchpad (Chromium is preinstalled; don't run `playwright install`).

Send the `-info.png` and the task cards with `SendUserFile` — viewport-sized shots stay under 100 KB; full-page 2x captures get rejected. Alongside them, list what you were unsure about (from the convert step) — this is the user's last chance to catch a misread.

Things that look wrong in the preview but are correct: a GMD banner on any "gravity" marker drop; `--:--` under a relative scoring period like `TO+2,5h`; a green dot next to "green flag + 30min"; "辞書外" badges on labels the dictionary doesn't know.

## Step 3 — Get the go-ahead, and pick the key

Ask before publishing unless the user already said so in the request ("登録して", "変換してアップ", "登録とアップして" are go-aheads — don't ask again, but still surface the uncertainties). A bare "変換して" or "お願い" is not permission.

Before sending anything:

```bash
python3 <skill>/scripts/taskboard_state.py list
```

Always pass explicit `--key` and `--label`. Without them the key is derived from the JSON's Flight/Tasks fields (`flight-1-1-2-3-4-5`) and silently overwrites any earlier flight that derived the same key. Key style in use: `saku2026-flight1`, `slovak2026-flight1`, `worlds2026-training-t3`, or the same key as an existing flight when the sheet is a correction of it. Labels are what the crew sees on the chip: `Training Flight T3`, `2022年スロベニア初日PM`, `Saku 2026 Flight1 (#1-#5)`.

If the sheet might be a correction to something already registered, say which existing key you would overwrite and confirm.

## Step 4 — Publish

```bash
python3 tools/publish.py --json /abs/flight.json --original /abs/sheet.pdf --key <key> --label "<label>"
```

- `--original` is the printed sheet (PDF pages or the photo of the sheet) — not hand-drawn sketches; those go through Step 6.
- Several flights → one command per flight, in a loop, then one `taskboard_state.py list` at the end.
- Original only, for a flight already registered: drop `--json`, keep `--key`. Re-saving with `--json` and no `--label` would regenerate the label.
- `--dry-run` reports what would happen without sending; use it when anything about the target is uncertain.

Then verify with `taskboard_state.py list` and report what actually landed (label, task count, page count). If the page count doesn't match what you uploaded, say so instead of declaring success.

## Step 5 — Test data and archiving

A sheet registered only to test something should not stay in the crew's flight bar. Ask "アーカイブ／削除／このまま？" and, for archive, run `taskboard_state.py archive <key>`. Archiving keeps data and sketches; restoring is `unarchive`. Deleting is only in the admin panel and is irreversible.

## Step 6 — Sketches and diagrams

Sketches (per-task drawings: an MMA shape when the sheet says `MMA: sketch`, the A/B quadrant circle of an MDD, a crew's terrain sketch) are stored per **flight + task** and shown as a "📎 スケッチ / 見る" button on that task. The write API has no sketch action, so the upload itself is done by the user in the admin panel — your part is to make that a single click:

1. Produce the image. A hand-drawn sheet photo is used as-is. A diagram embedded in a PDF is cropped at high zoom:
   ```python
   import pymupdf
   page = pymupdf.open(pdf)[0]
   page.get_pixmap(matrix=pymupdf.Matrix(4, 4), clip=pymupdf.Rect(x0, y0, x1, y1)).save(out)  # clip in PDF points = pixels/2 of a 2x render
   ```
2. State which flight + task it belongs to (from the handwritten label or the task the diagram sits under; when a photo shows print bleeding through from the back, trust the handwritten label).
3. `SendUserFile` it with "管理画面の『5. タスク別スケッチ』→ <flight label> → Task <no> に追加".
4. After they say it's uploaded, `taskboard_state.py list` — the sketch line must show `<flightKey> / Task <no>`.

Task numbers restart every competition, so the flight key in that line is what proves the sketch landed on the right task and not on another competition's Task 2.

## When something fails partway

Registration and page upload are separate calls; a failure can leave the flight registered with no pages. Re-running the same command replaces the pages from scratch. Don't retry in a loop — report which page failed and why. A token mismatch ("トークンが一致しません") usually means the script property was changed; the user fixes it in Apps Script, nothing to do here.

## What this skill doesn't do

It doesn't deploy GAS, and it doesn't write sketches directly (see Step 6). It also doesn't decide on its own to archive or delete anything.
