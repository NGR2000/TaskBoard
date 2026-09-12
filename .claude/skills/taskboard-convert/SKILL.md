---
name: taskboard-convert
description: Converts a hot-air-balloon competition "Task Data Sheet" — a photo, a PDF, or a URL of an event page that links to task-sheet PDFs — into TaskBoard's schemaVersion-2 JSON that the crew app renders. Use this whenever the user hands over a task sheet in any form and wants it converted, JSON-ified, or "into TaskBoard" ("変換して", "JSONにして", "このタスクシートを登録したい", "タスクシートが公表された" + a link, or just an uploaded task-sheet-looking file with "お願い"). Also use it when the user pastes a link to an event page (e.g. watchmefly.net) and mentions task sheets, flights, or training flights, even without naming TaskBoard. If they also want it registered/live, taskboard-publish builds on top of this skill.
---

# TaskBoard task-sheet conversion

Turn a "Task Data Sheet" into the JSON this project's crew app understands. The output is either pasted into the GAS admin panel by the user, or fed to `taskboard-publish`.

`README.md` at the repo root ("JSON スキーマ" and "Claude に渡す変換プロンプト") is the authoritative schema. Skim it fresh each time — it may have evolved since this skill was written. Existing schemaVersion-2 fixtures under `JSON/` (`kro2025_flight3.json`, `watarase_practice_20260808_flight1.json`) show the house style on real data. Ignore the old flat-format files (`Saku Balloon Festival *.JSON`, `*.txt`) — they are schema v1 and are not the pattern to follow.

## Step 0 — Get the sheet into a readable form

- **Photo / PDF upload**: render with PyMuPDF (`pymupdf`); Pillow and poppler are not installed here.
  ```python
  import pymupdf
  page = pymupdf.open(path)[0]
  page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(out_png)   # 2x is enough to read small print
  print(page.get_text())                                          # digital PDFs: use this to double-check every number
  ```
  Photos open as a one-page PDF too. For a phone photo, `get_text()` returns nothing — read the image and zoom into anything unclear.
- **URL**: the user may send an event page (watchmefly.net "event.php?e=…") rather than a file. `WebFetch` it and ask for the task-sheet links, then download each PDF with `curl -sS -L -o`. Those links often contain spaces — URL-encode them (`%20`). Check `file *.pdf` says "PDF document" before trusting the download; an error page saved as `.pdf` looks like a download success.
- **Several sheets in one request** (training flights T1–T4, AM/PM of the same day): one JSON per sheet. Each becomes its own flight.

Use absolute paths in every command — the shell's working directory resets between calls in this environment.

## Step 1 — Read faithfully, and check the story matches the paper

Transcription mistakes look exactly as confident as correct data once they are JSON, so this step carries the risk.

- Zoom into any region you are not sure about before transcribing. Use `get_text()` output to confirm coordinates, altitudes, times and marker numbers on digital PDFs.
- Compare what the user *said* with what the sheet *says*. A user once called a "Slovak Balloon Cup, Veľká Lomnica, Slovakia" sheet "クロアチアの大会". Point out the mismatch and ask before finalising the competition name — don't silently pick either.
- Transcribe what is printed, including oddities: placeholder values (`10??`), skipped enumeration letters (a, b, c, e, f — the sheet simply has no "d"), decimal commas (`2,5km`). Don't repair them. Rows that are blank or just `-` are omitted, not guessed.
- Handwritten additions are real content — carry them into `notes` or the relevant field, but don't blend them into printed text.
- On NTA-Competition sheets, a grey circle with a white "+" is the software's *missing-image placeholder*, not a rendering problem on your side. Real diagrams (e.g. the A/B quadrant circle) do render; refer to them in text ("see quadrant diagram") and offer to attach them as a sketch — see taskboard-publish.

## Step 2 — Shape it into schemaVersion 2

- `taskNo` exactly as printed, including prefixes (`"T7"` on training sheets). The app never renumbers, and the sketch feature keys on flight + task number.
- `taskId` must be one of the README list (PDG, JDG, HWZ, FIN, FON, HNH, WSD, GBM, CRT, RTA, ELB, LRN, MDT, SFL, MDD, XDT, XDI, XDD, ANG, 3DT, APT). It drives the rule text and Japanese task name — don't supply `name`, the app fills it.
- **Labels** keep the sheet's English wording, minus the layout enumeration (`a.` `b.` `c.`). Singular/plural differences between sheets ("Goals available for declaration(s)") are fine — the dictionary handles what it knows and shows the rest in English.
- **Targets vs fields**: a goal with coordinates goes in `targets` (`{ "name": "A", "coordinates": "4816/3558", "altitude": "2333ft", "mma": "R30m" }`). Coordinates are written `NNNN/NNNN` and altitude `NNNft` regardless of how the sheet spaces them — formatting only, never a different number. Reference numbers without coordinates ("113, 114, 117") are a field, not a target.
- **MMA**: one target → put `mma` on the target. One MMA shared by several goals (HWZ with Goal A/B) → task-level `mma`; the app copies it onto every target that lacks its own. `"sketch"` is a legitimate MMA value (the shape is defined by an attached drawing).
- **Loggermarker** → task-level `loggerMarker` (`"2, 3, 4"` as printed). **Loggergoal** → a field `{ "label": "Loggergoal", "value": "1" }`.
- `markerDrop` containing "gravity" or "GMD" makes the app show the red GMD warning by itself.
- `scoringArea` is a task-level key ("entire contest area", or "MMA" when the sheet says so).
- Per-task NOTES boxes → `notes`; a general remark under all tasks ("Task 1 PDG Goal must be at least 500m from all targets") → `basicInfo.notes`. Footer timestamps and "created with NTA Competition" are not notes.

### Dates — this decides the crew app's sort order

The app orders flights newest-first and groups the archive by year/month by pulling digit runs out of `basicInfo.date`. Formats that parse: `01.05.2025 AM`, `18.09.2022 PM`, `2026.9.17`, `2026年5月3日（日）AM`. An English month name (`03-May-2026`) does **not** — it lands the flight at the bottom as "unknown date".

- Numeric on the sheet → keep the sheet's format.
- Month name → write the numeric equivalent in `date` and keep the printed string as a field (`{ "label": "Date / Time (as printed)", "value": "Sunday, 03-May-2026, AM 0510" }`) so nothing is lost. European sheets are DD/MM.
- No date at all (training flights pilots fly whenever) → leave `date` out and ask. If the user gives a provisional date, use it and add a `Date (provisional)` field with a `valueJa` explaining where it came from, so the crew doesn't take it for a printed value.

### Scoring period

`scoringPeriodEnd` drives a live countdown, but only for clock times (`0745`, `09:00:00`). Relative ends like `TO+2,5h` are kept verbatim, render as text, and the countdown stays `--:--`. Say so when handing over — it looks like a bug otherwise.

## Step 3 — Bilingual text, only where the dictionary can't help

The dictionary translates short enum-like values on its own (colours, "Free", "In Order", "not required", "entire contest area"). Add `valueJa` only to sentence-length values — declaration methods, scoring-area descriptions, validity-time rules, point A/B definitions; add `notesJa` to every `notes`. Rule of thumb: if you had to think about phrasing rather than look up a word, it needs `valueJa`. Distance limits ("min. 2km, max. no") are numbers, not sentences — leave them.

## Step 4 — Validate and hand over

`node -e "JSON.parse(require('fs').readFileSync('<path>','utf8'))"` before showing anything — a syntax slip means the paste into the admin panel fails.

Present:
1. The JSON in one fenced block, paste-ready.
2. A short list of what to double-check: unreadable text, placeholders kept literally, the country/name mismatch if any, a placeholder image, a relative scoring period, a date you normalised or invented.

To see it the way the crew will, `taskboard-publish/scripts/preview.js` renders any JSON through the real app (details in that skill). Worth doing even when you are only handing over JSON — a wrong coordinate is invisible in JSON and obvious on the card.

Don't register anything from here. Save under `JSON/` only if the user asks for a fixture.
