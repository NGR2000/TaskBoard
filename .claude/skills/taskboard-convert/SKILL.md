---
name: taskboard-convert
description: Converts a photo of a hot-air-balloon competition "Task data sheet" into TaskBoard's JSON format, ready to paste into the GAS admin panel. Use this whenever the user uploads a picture of a task sheet (competition or practice, e.g. "Watarase Practice" or a real championship data sheet) and asks to convert it, register it, or get it into TaskBoard — phrases like "変換して", "TaskBoard用に変換して", "JSONにして", "このタスクシートを登録したい", or just an uploaded task-sheet-looking photo with no more instruction than "お願い". Also use it proactively whenever a task-sheet image and any conversion-adjacent request appear together, even if the user doesn't name TaskBoard explicitly.
---

# TaskBoard task-sheet conversion

Turn a photographed "Task data sheet" into the JSON this project's crew app understands, so the user can paste it straight into the GAS admin panel's registration textarea.

## Before you start

Read `README.md` at the repo root — the sections "JSON スキーマ" and "Claude に渡す変換プロンプト" are the authoritative schema and field list (valid `taskId`s, the `targets` vs `fields` shape, etc.). That file is the source of truth and may have evolved since this skill was written; skim it fresh each time rather than relying on memory of past conversions.

## Step 1 — Read the image at full fidelity

Task sheets pack a lot into a small area: declaration rules, scoring-area descriptions, handwritten annotations, faint placeholder text. Getting this step wrong is the single biggest way a conversion goes bad, because a wrong transcription looks just as confident as a right one once it's in JSON.

- Read the image, then crop and zoom into any region where you're not 100% sure of the text — long paragraph-style notes, coordinates, small print, handwriting — before you transcribe it. A blurry read at full-page scale is often crisp once cropped to a few hundred pixels tall.
- Transcribe exactly what's printed, including oddities. If a field is an unfilled template placeholder (e.g. a QNH box that literally prints "10??"), write down "10??" — don't invent a plausible-looking real value. If a row is blank or just a dash, leave it out of `fields` rather than guessing.
- Handwritten additions (a note, a correction, a "see photo" scrawled next to some numbers) are real content — carry them into `notes` or the relevant field, but don't blend them into the printed English text as if they were part of it.
- Never renumber or reformat anything the sheet gives you a specific value for: `taskNo` stays exactly as printed, `date` stays in whatever format the sheet uses, labels stay in the sheet's own English wording (this is what lets the crew app's dictionary and the "always show unknown fields in English" fallback both work correctly).

## Step 2 — Shape it into schemaVersion 2

Follow the schema in README.md. The two judgment calls that come up on almost every sheet:

- **Targets vs. fields**: if a task gives an actual coordinate (and optionally altitude/MMA) for a goal, put it in `targets`. If it instead just lists reference numbers from a master goal list (e.g. a Hesitation Waltz's "113, 114, 115, 117, 118" with no coordinates), that's not a target — put it in `fields` under its own label instead of forcing it into the targets shape.
- **taskId** must be one of the values README.md lists (PDG, JDG, HWZ, FIN, FON, HNH, WSD, GBM, CRT, RTA, ELB, LRN, MDT, SFL, MDD, XDT, XDI, XDD, ANG, 3DT, APT) — this is what drives the rule lookup and Japanese task name in the crew app.
- A handful of task-level keys get special treatment beyond the README's minimal example — `scoringArea`, `loggerMarker`, and `mma` are recognized directly (the app auto-labels them "Scoring Area" / "Logger Marker", and folds a bare `mma` into a field only when no target already carries one). You don't need to force these into generic `fields` entries; look at an existing fixture like `JSON/kro2025_flight3.json` or `JSON/watarase_practice_20260808_flight1.json` for the pattern.

## Step 3 — Add bilingual translations, but only where the dictionary can't help

The crew app has a small dictionary that already translates short, enum-like values on its own — color names, "Free", "In Order", "Not Required", and so on. Anything short like that needs no extra work from you.

What the dictionary *can't* handle is a one-off sentence — a declaration-method paragraph, a scoring-area description, a results-note. For those, add a same-shape translation field so the app can show Japanese with the English original underneath:

- A `fields[]` entry with a long/sentence-style `value` gets a sibling `valueJa` with a natural Japanese translation of that same value.
- A task's `notes` (or `basicInfo.notes`), when present, gets a sibling `notesJa`.

Rule of thumb: if you'd have to think about how to phrase the Japanese rather than just look up a word, it belongs here. If it's a single word or short fixed phrase, leave it alone — adding `valueJa` there is redundant and just adds noise. When in doubt, look at how existing fixtures under `JSON/*.json` handle similar fields (e.g. `kro2025_flight3.json`'s "Goals available for declaration" or `watarase_practice_20260808_flight1.json`'s RTA task) — they show the pattern on real data.

## Step 4 — Validate, then hand it over

Before showing the JSON to the user, check it actually parses — e.g. `node -e "JSON.parse(require('fs').readFileSync('/path', 'utf8'))"` if you wrote it to a file, or the equivalent inline check if you're holding it in memory. A syntax slip here means the user's paste into the admin panel fails, so don't skip it.

Present the result as:

1. The final JSON in a single fenced code block, formatted so it can be copy-pasted directly into the admin panel's registration textarea as-is.
2. A short bullet list of anything you weren't fully sure about — illegible text, unfilled placeholders you transcribed literally, handwritten additions, ambiguous target/field calls — so the user can double-check against the original photo before registering it. Skip this list if there was genuinely nothing worth flagging.

Don't register the flight yourself — this environment has no path to the live GAS admin panel or spreadsheet. Your job ends at handing over JSON the user can paste in themselves.

## Step 5 — Save as a fixture, but only if asked

If the user says they want to keep this as a test fixture (or asks to add it to the repo), save it under `JSON/` following the existing naming pattern (`kro2025_flightN.json`, `watarase_practice_YYYYMMDD_flightN.json`, or similar — match the competition/practice name and date). Otherwise, just hand over the JSON inline and leave the filesystem alone; most conversions are one-off registrations, not permanent fixtures.
