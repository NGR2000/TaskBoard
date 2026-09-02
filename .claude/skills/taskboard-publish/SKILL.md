---
name: taskboard-publish
description: Takes a task sheet file (PDF or photo) all the way from reading it to live on the crew app in one go — convert, preview, confirm, register, and upload the original pages. Use this whenever the user uploads a task sheet and wants it actually registered/reflected/live rather than just converted — phrases like "反映して", "登録して", "アップして", "クルーに出して", "一気にやって", or a task sheet plus any request that implies the crew should see it. If the user only wants the JSON text to paste in themselves, use taskboard-convert instead; this skill is the automated end of that same pipeline and writes to live competition data.
---

# TaskBoard one-shot publish

Take a task sheet from file to live on the crew app without the user touching the admin panel. This writes to real competition data that a crew depends on, so the confirmation step below is the part that matters most — everything else is mechanical.

## What has to be in place

The publish step needs a write token. Check `TASKBOARD_TOKEN` is set before doing any work — if it's missing, stop and tell the user to set it in their Claude Code environment settings (the token is the `TASKBOARD_API_TOKEN` value under Apps Script → Project Settings → Script Properties). Don't ask them to paste it into the chat; it ends up in the transcript.

The backend also needs a deployment that includes `doPost` in `コード.js`. If publishing fails with a non-JSON response or "unknown action", their deployed version predates the write API — they need `clasp push` and a new deployment version.

## Step 1 — Convert

Follow the `taskboard-convert` skill for this. It covers reading the sheet faithfully (zooming into unclear text, never inventing values) and the JSON shape, including the `valueJa`/`notesJa` bilingual rules. Don't reimplement that here; the conversion quality bar is the same whether or not the result gets published.

Write the JSON to a file (the scratchpad directory is fine — it doesn't need to live in the repo unless the user wants a fixture).

## Step 2 — Preview, and make it a real preview

Show the user what the crew will actually see, not the raw JSON. Raw JSON hides exactly the mistakes that matter — a misread coordinate looks fine in JSON but obviously wrong on the card.

Render it through the real crew app and screenshot it:

```bash
python3 -m http.server 8765 --directory docs &
```

then drive it with Playwright: open `http://127.0.0.1:8765/`, go to 設定 → 「JSONを直接読み込む」(`[data-screen="settings"]`, then `[data-screen="local"]`), fill `#jsonInput` with the JSON, click `[data-act="loadlocal"]`, and screenshot the result. This is the same local-load path the crew app already has for emergencies, so it renders identically to the real thing. Send the screenshot with `SendUserFile`.

Keep the screenshot small enough to actually send — a full-page capture at `deviceScaleFactor: 2` runs over a megabyte and the upload is rejected. A normal viewport-sized shot at scale 1 (roughly 430×1000) comes in under 100 KB. For a long sheet, send a few scrolled shots rather than one giant one.

Alongside the screenshot, call out anything you were unsure about while reading the sheet — illegible text, placeholders transcribed literally, handwriting, ambiguous target-vs-field calls. This is the user's last chance to catch a misread before the crew sees it.

## Step 3 — Get an explicit go-ahead

Ask before publishing, every time. Registering overwrites what the crew sees, and a wrong flight during a competition is worse than a slow one. A file upload with "変換して" is not permission to publish; a plain "お願い" on a task sheet isn't either — if the user's intent to publish isn't clear, convert and preview, then ask.

Also confirm which flight this is when it could overwrite an existing one. Publishing without `--key` creates a new flight; passing an existing `key` overwrites that flight in place. If the sheet looks like a correction to something already registered, check the current list first (`?action=flights` on the API, or `--dry-run`) and ask which they mean.

## Step 4 — Publish

```bash
python3 tools/publish.py --json <flight.json> --original <sheet.pdf> [--key <existing-key>] [--label <name>]
```

The tool reads the API URL from `docs/config.js` and the token from `TASKBOARD_TOKEN`, converts PDF pages (or images) to the same JPEG page format the admin panel produces, registers the flight, then uploads the pages in order. By default it replaces existing original pages so a re-run doesn't leave stale ones behind; `--keep-images` appends instead.

When the flight is already registered and only the original is missing — the sheet PDF often arrives after the data — drop `--json` and pass `--key` instead:

```bash
python3 tools/publish.py --key <existing-key> --original <sheet.pdf>
```

That uploads pages without touching the registered tasks or the label. Prefer it over re-publishing the whole flight, since re-saving with a blank `--label` would regenerate the label from the JSON and clobber a name the user chose by hand.

Use `--dry-run` first if anything about the target flight is uncertain — it reports what would happen without sending.

Report back what actually landed: the tool prints the post-publish state (label, task count, page count). If the page count doesn't match what you uploaded, say so rather than declaring success.

## When something fails partway

Registration and page upload are separate calls, so a failure can leave the flight registered with only some pages. That's recoverable and worth stating plainly: re-running the same command replaces the pages from scratch. Don't retry silently in a loop — report which page failed and why.

## What this skill doesn't do

It doesn't deploy the GAS backend or touch `clasp` — if the backend needs updating, that's the user's `clasp push` + new deployment version. It also doesn't handle per-task sketches; those still go through the admin panel.
