---
name: taskboard-watch
description: Watches a competition's watchmefly.net (or similar) event page on a schedule for a task sheet that hasn't been published yet, and separately handles applying a briefing-announced change (cancellation, correction) to a flight already registered in TaskBoard once the user relays it. Use this whenever the user asks to monitor/watch/poll an event page for a task sheet ("監視して", "見張って", "アップされたら教えて/反映して", "ブリーフィングが○時なので○時から確認して"), or tells you about a cancellation/correction from a briefing that needs to be applied to a flight already in TaskBoard ("キャンセルになった", "修正が入った", "変更があった").
---

# TaskBoard: watch for a task sheet, and for changes to one already registered

A crew member is away from the venue (often in a different country/timezone) and needs to know the moment a task sheet goes up, or the moment something on an *already-registered* sheet changes, without babysitting a browser tab themselves. This skill is the polling loop around `taskboard-convert` + `taskboard-publish`; it doesn't duplicate their logic, it just knows when to call them.

Two things are worth handling, but they run on very different triggers:
1. **A new sheet** — a flight hasn't been published yet. This is the scheduled polling loop (Steps 1–4 below): 5-minute checks starting an hour before the next briefing.
2. **A change to a sheet already in TaskBoard** — this happened for real: two tasks on a registered Slovak Balloon Cup flight were cancelled *after* the flight was already converted and live. It turns out competitions announce this kind of thing verbally at briefings, not as a timestamped status on the event page — so this is **user-instructed, not polled for**. See "Amendments to an already-registered flight" below for the actual trigger and workflow.

## Why this is a scheduled loop, not a sleep loop

The wait is genuinely hours long and the event is genuinely external — never `sleep` in Bash for this. Use `mcp__Claude_Code_Remote__send_later` to have the session wake itself up. Each firing is one check: fetch, compare, decide, act or reschedule. This also means the loop survives you losing context — the message you schedule *is* the state that survives, so it must be self-contained (see below).

## WebFetch caches by URL — this will make you miss the change

`WebFetch` keeps a response cache per exact URL for 15 minutes. A polling loop that hits the *same* URL every 5–10 minutes is, by design, well inside that window — so most "recheck" calls after the first can silently return the earlier cached page instead of the live one, and "まだ変化なし" stops meaning anything. This isn't hypothetical: it happened during the Slovak Balloon Cup watch — two consecutive same-URL fetches seconds apart both showed the page's own displayed clock frozen at an earlier time, and only appending a throwaway query parameter (`&_cb=<anything unique>`) broke the cache and revealed the page had already moved on several minutes earlier, live-flight sheet included.

**Always vary the URL on every fetch** — append `&_cb=` followed by something that changes each call (current epoch seconds is easiest: check with `date +%s` right before the call, or just increment a counter). Do this on the baseline fetch in Step 2 and on every fetch in Step 4; there is no fetch in this loop that should ever reuse an exact URL from a previous call.

## Step 1 — Establish the window, in UTC

The user gives times in event-local time (a briefing time, "3時から"). Convert everything to UTC immediately — `date -u` gives you the current instant to anchor against, and every `send_later` call needs UTC math done correctly or the loop fires at the wrong time while you're asleep to notice.

- **Start time**: when asked, honor it exactly (an explicit "3時から" for a 5時 briefing means start 2 hours early — that gap is the user's judgment call about how early sheets tend to appear, not yours to shrink). If not given, a sensible default is 2 hours before the stated "Next briefing" time on the most recent sheet for that competition (this is the pattern observed in practice: a task sheet has appeared as much as 10–15 minutes *before* its own listed briefing time, so don't start right at briefing time).
- **Cutoff**: ask, or default to 2 hours after the briefing time — long enough that a briefing running late doesn't trigger a false "cancelled," short enough that you're not polling all night. State the cutoff you're using; it's a guess standing in for the user's judgment, and cancellations do happen (a briefing can be scrapped with no sheet at all). This cutoff is only about *new-sheet* detection — amendments to a flight already registered aren't something this loop polls for at all (see "Amendments to an already-registered flight" below), so don't extend the loop to "competition end time" on the assumption that it'll catch a cancellation; it won't.
- **Interval**: default 10 minutes unless told otherwise, tightening to 5 minutes once inside the last hour before the briefing (this has been requested explicitly and is a reasonable default going forward — the closer to briefing time, the more a missed sheet costs). Recompute which interval applies at the top of every firing, not just once at setup, since the loop runs for hours and the answer changes partway through. There's no reason to go below ~5 minutes for a page a human would refresh by hand.

If the start time is more than a few minutes away, schedule *one* `send_later` for the start time itself (don't sit there burning turns until then) — its message is the same self-contained check template you'll reuse every 10 minutes after, just with the window/cutoff spelled out.

## Step 2 — Snapshot the baseline before the wait begins

Fetch the event page now and record every task-sheet PDF link with its label (flight number, date, AM/PM, status). This is the diff target for every future check — without it you can't tell "still nothing new" from "I forgot what was already there."

```
WebFetch(url + "&_cb=" + Date.now(), "List every task sheet / task data sheet PDF link on this page, with flight number, date, AM/PM, and status (COMPLETE/CANCELLED/PROVISIONAL/LIVE/etc). Give exact URLs.")
```

(cache-busting suffix — see above — applies here too, not just in the polling loop, since a stale baseline is as bad as a stale recheck)

Note which flight key the *next* sheet should continue from (if Flight 1 is `slovak2026-flight1` with tasks #1–5, the next one is Flight 2, tasks continuing from #6) — you'll want this ready at publish time, not worked out under time pressure when the sheet finally lands.

## Step 3 — The scheduled message must carry its own context

`send_later`'s message is everything a fresh instance of you will have when it fires — the conversation may have compacted, or a lot may have happened since. Every firing's message needs, spelled out again in full (copy it forward each time, updating only the "last checked" fields):

- The event page URL
- The baseline PDF list (so a diff is possible without asking "what changed since when")
- Which flight key/label the found sheet should map to
- The interval to reschedule at, and the cutoff instant (in UTC) to stop at
- The full decision tree: fetch → diff → (unchanged: brief note to user, reschedule) / (found: convert → preview → publish → verify → report) / (past cutoff: stop and report, no more reschedule)

Don't rely on "see my last message" — write the whole thing again. This is cheap compared to the loop silently going stale.

## Step 4 — Each firing

1. `ReadNotifications` first if the wake came in as one (it always does for `send_later`).
2. Check the current time against the cutoff before anything else — if past it, stop here: tell the user nothing showed up (name the cancellation possibility) and don't schedule another `send_later`.
3. `WebFetch` the page the same way as the baseline — **with a fresh `&_cb=` value, never reused from a previous call** (see the cache warning above; this is the step where forgetting it costs the most). Compare — a genuinely new row (new URL, or a status flip like PROVISIONAL→CANCELLED on the flight you're waiting for) is the signal.
4. **Nothing new**: one short line to the user (what time, next check when) and reschedule with the same self-contained message, refreshed baseline timestamp. Don't editorialize further — a string of short "まだ変化なし" is the correct texture for a watch like this, the user does not want a paragraph every 10 minutes.
5. **Found it**: this is a live hand-off into `taskboard-convert` then `taskboard-publish` — download the PDF (URL-encode spaces), convert, render the preview, check for key collisions, publish, verify with `taskboard_state.py list`, then report. If the user's original request already said what to do once found ("反映したい", "アップして"), that's your go-ahead — don't re-ask before publishing, but still surface anything you're unsure about in the conversion, same as any other publish job.
6. Whether idle or found, this is the point to notice if the write API hiccups (a POST that comes back as an HTML page instead of JSON has happened before and cleared on a bare retry — retry once before treating it as a real deployment problem).

## Amendments to an already-registered flight — the user relays them, not WebFetch

Cancellations and corrections that land after a flight is already registered turn out to come from **verbal briefings and supplementary briefings** at the venue, not from a timestamped, machine-readable status on watchmefly.net. This was learned the hard way on the Slovak Balloon Cup watch: watchmefly's noticeboard only ever showed a *date* for a cancellation announcement, never a time, and there was no way to tell from the page alone when (or even whether) a briefing-announced change would show up there at all. Don't design around WebFetch reliably catching an amendment — it won't, and asserting a specific announcement time you didn't actually observe is worse than not asserting one (this happened once already; see the correction lesson below).

The real operating model, confirmed with the user:

1. **New-sheet detection** (Steps 1–4 above) keeps running exactly as designed: 5-minute checks starting an hour before the next briefing, watching for the *next* task sheet to appear. This part of the loop is unaffected by anything below.
2. **A new sheet gets converted and published** either because this loop found it, or because the user directly instructs it ("反映して" for a sheet they already know is up) — same `taskboard-convert` → `taskboard-publish` hand-off either way.
3. **Amendments to an already-registered flight are user-instructed, not autonomously detected.** The user hears about a cancellation or correction at a briefing and relays it to you directly (e.g. "Task 9 と 10 がキャンセルになった、9/13のブリーフィングで"). Treat that message as the trigger — don't wait for or expect a WebFetch signal to confirm it first. A best-effort WebFetch check of the noticeboard is still fine to do *if you're already fetching the page for new-sheet detection in the same firing* — it costs nothing extra — but never treat "the page doesn't show it" as a reason to doubt what the user told you, and never invent a precise time the page doesn't actually state.

### When the user relays a change: apply it AND grow the history

This is the concrete two-part deliverable the user asked for — not just patching the current state, but keeping a visible log of what changed and when it was learned:

1. Fetch the flight's currently-registered JSON (`?action=flight&key=<key>`) so you're patching the real live content, not a stale local copy.
2. **If `basicInfo.changeNotice` is already set from a previous amendment**, move it (and its Ja twin) into `basicInfo.changeHistory` as a new entry *before* overwriting it with the new one — that's what keeps the log growing instead of clobbering the previous change. If `changeHistory` doesn't exist yet, start it with the previous notice as its first entry (skip this if there was no previous notice — nothing to preserve).
3. Set the new current `basicInfo.changeNotice` / `changeNoticeJa` to describe the latest change (this is what shows as the always-visible red banner). Use whatever time granularity the user actually gave you for `at` in the history entry — a bare date, "ブリーフィングにて", "補足ブリーフィングにて" — never a specific clock time unless the user stated one. See README.md's "ブリーフィング後の変更" section for the exact shape of `changeHistory` entries (`{at, notice, noticeJa}`).
4. Apply the task-level fields for the new change: `cancelled: true` for a cancellation, or `changeNote` / `changeNoteJa` for a correction that isn't a full cancellation, plus `changed: true` on any specific `fields[]` entry the user identifies as corrected. Leave `cancelled`/`changeNote` from *previous, already-applied* amendments as they are — those tasks stay flagged; only the history log needs the new entry, not a rewrite of old task states.
5. Preview the patched JSON with `taskboard-publish/scripts/preview.js` — confirm the banner, the collapsed history entry, the grayed-out card, or the amber warning actually render before publishing.
6. Republish with `tools/publish.py --key <same key> --json <patched JSON>` — same key, overwrite in place. **Always pass the flight's existing `--label` explicitly** — a blank label regenerates one from the JSON content and clobbers the hand-chosen name (this happened once already; see `taskboard-publish/SKILL.md`).
7. Verify with `taskboard_state.py list` and report back what changed and what the history now shows — worth a real message, not a quiet line.

Don't build or rely on an automated per-task status-polling prompt as the primary mechanism for this — it was tried and the premise didn't hold up. If a future WebFetch check happens to surface something concrete (a specific noticeboard post with real content, not just a status word), treat it as a lead to confirm with the user before acting, not as authoritative on its own.

## What this skill doesn't do

It doesn't invent a cutoff or start time the user didn't ask for or that isn't well-motivated by a printed briefing time — say what you picked and why. It doesn't keep polling forever; every loop ends, either at "found" or at the cutoff. It doesn't replace `taskboard-convert`/`taskboard-publish` — read those for the actual conversion and registration steps once a sheet is found.
