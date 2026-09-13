---
name: taskboard-watch
description: Watches a competition's watchmefly.net (or similar) event page on a schedule — either for a task sheet that hasn't been published yet, or for a live change (cancellation, correction) to a task sheet that's already registered in TaskBoard — and keeps the registered flight in sync, for when the user is away from the venue. Use this whenever the user asks to monitor/watch/poll an event page for a task sheet or for changes ("監視して", "見張って", "アップされたら教えて/反映して", "変更があったら教えて/反映して", "ブリーフィングが○時なので○時から確認して", "競技終了まで確認を続けて"), names a start or end time tied to a briefing or the day's flying, or asks to resume/re-run this kind of watch.
---

# TaskBoard: watch for a task sheet, and for changes to one already registered

A crew member is away from the venue (often in a different country/timezone) and needs to know the moment a task sheet goes up, or the moment something on an *already-registered* sheet changes, without babysitting a browser tab themselves. This skill is the polling loop around `taskboard-convert` + `taskboard-publish`; it doesn't duplicate their logic, it just knows when to call them.

Two things are worth watching for, and one loop can do both at once:
1. **A new sheet** — a flight hasn't been published yet (Steps 1–4 below).
2. **A change to a sheet already in TaskBoard** — this happened for real: two tasks on a registered Slovak Balloon Cup flight were cancelled *after* the flight was already converted and live. Competitions amend things mid-day — a briefing correction, a cancellation announced on the noticeboard — and there is no other signal for this than watching the same page again (see "Watching for amendments" below).

If the user asks you to keep checking through the end of the flying day specifically because more changes might land, that's mode 2 (or both at once) — don't stop at "no new flight" if amendments are what they actually asked about.

## Why this is a scheduled loop, not a sleep loop

The wait is genuinely hours long and the event is genuinely external — never `sleep` in Bash for this. Use `mcp__Claude_Code_Remote__send_later` to have the session wake itself up. Each firing is one check: fetch, compare, decide, act or reschedule. This also means the loop survives you losing context — the message you schedule *is* the state that survives, so it must be self-contained (see below).

## WebFetch caches by URL — this will make you miss the change

`WebFetch` keeps a response cache per exact URL for 15 minutes. A polling loop that hits the *same* URL every 5–10 minutes is, by design, well inside that window — so most "recheck" calls after the first can silently return the earlier cached page instead of the live one, and "まだ変化なし" stops meaning anything. This isn't hypothetical: it happened during the Slovak Balloon Cup watch — two consecutive same-URL fetches seconds apart both showed the page's own displayed clock frozen at an earlier time, and only appending a throwaway query parameter (`&_cb=<anything unique>`) broke the cache and revealed the page had already moved on several minutes earlier, live-flight sheet included.

**Always vary the URL on every fetch** — append `&_cb=` followed by something that changes each call (current epoch seconds is easiest: check with `date +%s` right before the call, or just increment a counter). Do this on the baseline fetch in Step 2 and on every fetch in Step 4; there is no fetch in this loop that should ever reuse an exact URL from a previous call.

## Step 1 — Establish the window, in UTC

The user gives times in event-local time (a briefing time, "3時から"). Convert everything to UTC immediately — `date -u` gives you the current instant to anchor against, and every `send_later` call needs UTC math done correctly or the loop fires at the wrong time while you're asleep to notice.

- **Start time**: when asked, honor it exactly (an explicit "3時から" for a 5時 briefing means start 2 hours early — that gap is the user's judgment call about how early sheets tend to appear, not yours to shrink). If not given, a sensible default is 2 hours before the stated "Next briefing" time on the most recent sheet for that competition (this is the pattern observed in practice: a task sheet has appeared as much as 10–15 minutes *before* its own listed briefing time, so don't start right at briefing time).
- **Cutoff**: ask, or default to 2 hours after the briefing time — long enough that a briefing running late doesn't trigger a false "cancelled," short enough that you're not polling all night. State the cutoff you're using; it's a guess standing in for the user's judgment, and cancellations do happen (a briefing can be scrapped with no sheet at all). If the user frames the request around watching for *amendments* to something already registered rather than a next sheet, the natural cutoff is "competition end time" for the day — ask what time that is rather than guessing; it varies by venue and day, and running the loop a bit past real end-of-flying is cheap insurance against a late correction, whereas stopping early means missing exactly the thing being watched for.
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

## Watching for amendments to an already-registered flight

A brand-new PDF appearing is one kind of signal; a status flip on a flight you've *already* converted and published is another, and the static Task Data Sheet PDF is the wrong place to look for it — cancellations and corrections show up as live status labels and noticeboard posts on the event page itself, not as a new PDF. Check both in the same fetch once a flight is registered: ask the page for each registered flight's per-task status, not just whether a new flight row exists.

```
WebFetch(url + "&_cb=" + Date.now(), "For Flight <N> (<date>), what is the overall flight status and the status of EACH individual task (task number + status: VALID/PROVISIONAL/CANCELLED/etc)? Quote any noticeboard cancellation or correction announcements naming these tasks.")
```

When a registered task's status has newly flipped to CANCELLED, or a noticeboard post announces a correction to it:

1. Fetch the flight's currently-registered JSON (`?action=flight&key=<key>`) so you're patching the real live content, not a stale local copy.
2. Add the schema fields from README.md's "ブリーフィング後の変更" section:
   - `basicInfo.changeNotice` / `changeNoticeJa` — one sentence naming what changed on this flight (e.g. "Task 9 and Task 10 cancelled after briefing"), shown to the crew as a red banner they can't miss even with the card collapsed.
   - The affected task(s): `cancelled: true` for a cancellation, or `changeNote` / `changeNoteJa` for a correction that isn't a full cancellation. Add `changed: true` on a specific `fields[]` entry if you know exactly which value was corrected.
3. Preview the patched JSON the same way as any conversion (`taskboard-publish/scripts/preview.js`) — confirm the banner, the grayed-out card, or the amber warning actually show before publishing.
4. Republish with `tools/publish.py --key <same key> --json <patched JSON>` — same key, so this overwrites the flight in place rather than creating a duplicate. Don't pass `--label`, since re-saving with a blank one would regenerate it from the JSON and clobber the name already in use.
5. Verify with `taskboard_state.py list` and report what changed to the user — this is worth a real message, not a quiet "no change" line, since it's the entire reason this watch exists.

This can run in the same loop as watching for a next sheet: one firing can check "any new flight?" and "any status change on flights I already have?" together, and only needs the one `send_later` reschedule either way.

## What this skill doesn't do

It doesn't invent a cutoff or start time the user didn't ask for or that isn't well-motivated by a printed briefing time — say what you picked and why. It doesn't keep polling forever; every loop ends, either at "found" or at the cutoff. It doesn't replace `taskboard-convert`/`taskboard-publish` — read those for the actual conversion and registration steps once a sheet is found.
