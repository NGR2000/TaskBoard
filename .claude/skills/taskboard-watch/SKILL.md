---
name: taskboard-watch
description: Watches a competition's watchmefly.net (or similar) event page on a schedule for a task sheet that hasn't been published yet, and runs taskboard-convert + taskboard-publish the moment it appears — for when the user is away from the venue and a briefing is coming up. Use this whenever the user asks to monitor/watch/poll an event page for a task sheet ("監視して", "見張って", "アップされたら教えて/反映して", "ブリーフィングが○時なので○時から確認して"), names a start time tied to an upcoming briefing, or asks to resume/re-run this kind of watch. Not for a sheet that's already published — that's a direct taskboard-publish job.
---

# TaskBoard: watch for a task sheet and publish it on arrival

A crew member is away from the venue (often in a different country/timezone) and needs the moment a task sheet goes up to turn into a registered flight, without babysitting a browser tab themselves. This skill is the polling loop around `taskboard-convert` + `taskboard-publish`; it doesn't duplicate their logic, it just knows when to call them.

## Why this is a scheduled loop, not a sleep loop

The wait is genuinely hours long and the event is genuinely external — never `sleep` in Bash for this. Use `mcp__Claude_Code_Remote__send_later` to have the session wake itself up. Each firing is one check: fetch, compare, decide, act or reschedule. This also means the loop survives you losing context — the message you schedule *is* the state that survives, so it must be self-contained (see below).

## Step 1 — Establish the window, in UTC

The user gives times in event-local time (a briefing time, "3時から"). Convert everything to UTC immediately — `date -u` gives you the current instant to anchor against, and every `send_later` call needs UTC math done correctly or the loop fires at the wrong time while you're asleep to notice.

- **Start time**: when asked, honor it exactly (an explicit "3時から" for a 5時 briefing means start 2 hours early — that gap is the user's judgment call about how early sheets tend to appear, not yours to shrink). If not given, a sensible default is 2 hours before the stated "Next briefing" time on the most recent sheet for that competition (this is the pattern observed in practice: a task sheet has appeared as much as 10–15 minutes *before* its own listed briefing time, so don't start right at briefing time).
- **Cutoff**: ask, or default to 2 hours after the briefing time — long enough that a briefing running late doesn't trigger a false "cancelled," short enough that you're not polling all night. State the cutoff you're using; it's a guess standing in for the user's judgment, and cancellations do happen (a briefing can be scrapped with no sheet at all).
- **Interval**: default 10 minutes unless told otherwise, tightening to 5 minutes once inside the last hour before the briefing (this has been requested explicitly and is a reasonable default going forward — the closer to briefing time, the more a missed sheet costs). Recompute which interval applies at the top of every firing, not just once at setup, since the loop runs for hours and the answer changes partway through. There's no reason to go below ~5 minutes for a page a human would refresh by hand.

If the start time is more than a few minutes away, schedule *one* `send_later` for the start time itself (don't sit there burning turns until then) — its message is the same self-contained check template you'll reuse every 10 minutes after, just with the window/cutoff spelled out.

## Step 2 — Snapshot the baseline before the wait begins

Fetch the event page now and record every task-sheet PDF link with its label (flight number, date, AM/PM, status). This is the diff target for every future check — without it you can't tell "still nothing new" from "I forgot what was already there."

```
WebFetch(url, "List every task sheet / task data sheet PDF link on this page, with flight number, date, AM/PM, and status (COMPLETE/CANCELLED/PROVISIONAL/LIVE/etc). Give exact URLs.")
```

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
3. `WebFetch` the page the same way as the baseline. Compare — a genuinely new row (new URL, or a status flip like PROVISIONAL→CANCELLED on the flight you're waiting for) is the signal.
4. **Nothing new**: one short line to the user (what time, next check when) and reschedule with the same self-contained message, refreshed baseline timestamp. Don't editorialize further — a string of short "まだ変化なし" is the correct texture for a watch like this, the user does not want a paragraph every 10 minutes.
5. **Found it**: this is a live hand-off into `taskboard-convert` then `taskboard-publish` — download the PDF (URL-encode spaces), convert, render the preview, check for key collisions, publish, verify with `taskboard_state.py list`, then report. If the user's original request already said what to do once found ("反映したい", "アップして"), that's your go-ahead — don't re-ask before publishing, but still surface anything you're unsure about in the conversion, same as any other publish job.
6. Whether idle or found, this is the point to notice if the write API hiccups (a POST that comes back as an HTML page instead of JSON has happened before and cleared on a bare retry — retry once before treating it as a real deployment problem).

## What this skill doesn't do

It doesn't invent a cutoff or start time the user didn't ask for or that isn't well-motivated by a printed briefing time — say what you picked and why. It doesn't keep polling forever; every loop ends, either at "found" or at the cutoff. It doesn't replace `taskboard-convert`/`taskboard-publish` — read those for the actual conversion and registration steps once a sheet is found.
