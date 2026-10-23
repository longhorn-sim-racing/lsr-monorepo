Docs and env notes for the decks-rooms track; folded into docs/jack.md at the end. This part is the rooms (T9a); Instagram publishing and the gallery (T9b) come later in the same file.

# Rooms: archive, pin, mention mode, ratings and the Usage page (T9a)

Design §10 (all but message anchors and room search, which T1 shipped) and the §13 rows for Jack → Rooms list and Jack → Usage. Code paths are relative to `apps/platform/`. The columns were already in G1's schema (`JackRoom.archivedAt`, `pinnedAt`, `answerMode`; `JackMessage.expectsAnswer`; `JackFeedback`): **no migration in this PR**.

## What officers get

**The room's menu** (the "…" in a room's header; `RoomSettingsMenu` in `src/components/jack/room-settings.tsx`):
- **Pin room to the top / Unpin room.** Pinned rooms sort first in the rooms list and the rail beside a room (pins are shared, like the rooms). No room note; audited.
- **Answer only when mentioned / Answer every message** (mention mode, below). A room note ("Gray set this room to answer only messages that mention @Jack") and an audit entry. A "Mentions only" badge sits in the header while it's on, and the composer says how to ask.
- **Archive room.** A room note ("Gray archived this room") and an audit entry. Everyone in the room sees it go read-only live.

**Archived rooms**
- Read-only: the composer is replaced by an "Archived — unarchive to continue" bar with an **Unarchive** button; renaming, switching the persona, rating replies and applying or discarding proposals are off, and the room never offers "Ask him to continue".
- They still open from links: `?m=` links from search land on their message (the snapshot loads archived rooms and takes `around`, and the gap divider works as before).
- **No Jack run starts in one** (server side): the reply loop's "waiting" query requires the room not to be archived, so a run finds nothing and lets go of the lock. A reply already streaming when the room is archived finishes; nothing after it starts, and a deck reply that stops at its limits leaves no continue note there. Posting, persona switches, renames, pins, mode changes and uploads are refused ("This room is archived. Unarchive it to continue.").
- A message left waiting when the room was archived is answered by the next run after it's unarchived (the next post, or "Ask him to continue").
- The rooms list has an **In use / Archived** switch (`/admin/jack?view=archived`, most recently archived first). Its search (T1's) now includes archived rooms and their messages, marked "Archived"; Jack's own `search` already did.
- Each row on the rooms list has a menu: Pin to the top / Unpin and Archive, or Unarchive for an archived room.

**Mention mode** (`answerMode: "mention"`, design §10)
- `postOfficerMessage` (`src/server/jack/rooms.ts`) parses the message with `mentionsAssistant` (`src/lib/jack/mentions.ts`): `@Jack`, or `@` and the name of the persona answering the room (`@Lift` in a Lift room), any case, as a word of its own (not `gray@jack.example`, not `@jackson`).
- A message without a mention is saved with `expectsAnswer = false`. It starts no run, isn't in the reply loop's waiting query (`REPLY_TRIGGERS` in `reply-triggers.ts`, which the Usage page's cost attribution uses too), and never makes the room offer to continue (`stallCandidate`, G1).
- The next reply to a mention takes every aside posted since the last reply, up to the mention, as its turn's context (`waitingAsides`): they get the reply's `answeredById`, so the history puts them in that reply's turn, and the reply's `message.created` lists them in `answers`. Asides posted after the mention wait for the next one. A scheduled note's reply and a continue note's reply never take asides.
- In the history each aside's text starts with `(not addressed to you)` (`ASIDE_MARK` in `history.ts`), and the prompt section says to answer only what's addressed to Jack.
- A turn keeps only its newest asides: at most 40, and about 20,000 characters of them (`ASIDE_LIMITS`); the turn starts with a line saying how many it left out. They're all still marked answered. Without this, the first mention in a room used as a chat for weeks would send the whole backlog (the newest turn is always sent whole, whatever `HISTORY_LIMITS.maxChars` says).
- Switching the room back to "always" doesn't change posted messages: old asides become the next reply's context.

**Ratings** (`JackFeedback`, design §10)
- Thumbs up or down under each of Jack's finished replies (`src/components/jack/reply-feedback.tsx`, through the room's `messageActions` slot). One per officer per reply (the table's unique key); clicking the same thumb again takes it back, the other one switches it.
- After a thumbs-down a small box asks "What was wrong? (optional; it helps test Jack)", up to 500 characters; the note can be edited later. Switching to a thumbs-up drops the note.
- Shown quietly: counts beside the thumbs, the officer's own choice filled in, everyone's ratings and notes on hover. Other officers' ratings show up as the room catches up (every snapshot carries them, for the viewing officer).
- A changed rating is dated when it changed (`createdAt` is overwritten; the table has no separate edit time). Ratings aren't audited.

**Usage page** (`/admin/jack/usage`, Jack → Usage; the nav entry was there; `src/app/admin/jack/usage/page.tsx`, queries in `src/server/jack/usage.ts`). Officers only. A month picker (`?month=2026-10`, Central Time months; this month by default):
- **Spent this month** against the cap (`JACK_MONTHLY_BUDGET_USD`, default $50) as a meter that turns amber at 80% and red at the cap, with words saying the same; replies; Jack, Lift and Stand each; ratings.
- **Cost by month**: the last twelve months by persona, total, replies and share of today's cap. The totals are exactly the spend meter's (replies' saved cost plus `JackUsage` side jobs, by Central Time month); a reply at 11:30 PM on the last day of a month counts in that month.
- **By officer and automation**: each reply counts for the officer whose message started it (the newest message it answered, the same officer the reply's tools ran as; a deck's continue note counts for the officer who asked). A reply to a scheduled note (a recurring question) counts as automation: no officer asked. `JackUsage` rows go by job: `name_room` is "Naming rooms (Stand)", any other job is "Automation: <job>".
- **Thumbs-down**, newest first (up to 50): who, when, the room (linking to the reply with `?m=`), the note, and the question and answer cut short. One with a note is marked **Eval candidate**.
- **Common questions**: the words that come up in the first officer message to Jack (`expectsAnswer`, so in a mention-mode room the first mention, not an aside) of the most rooms opened that month (each room counts a word once, at least two rooms, top 15), with up to three rooms each. Everyday words ("the", "what", "please", Jack's names) are left out and words aren't merged ("event" and "events" count apart); the page says so.

**For Jack**
- Prompt (`prompt-sections/decks-rooms.ts`): a "Room settings" section (mention mode: answer only what's addressed to you; what the room menu does) and a page line for Usage.
- `describe_schema` notes (`tools/schema-notes-slots/decks-rooms.ts`): the room settings, `expectsAnswer`, `JackFeedback`, and where cost lives and whose it is. `run_sql` can read `JackFeedback` (not a personal-data table under design §3.2).

**Digest checks** (`automation/checks/decks-rooms.ts`; they run once T11 wires the digest and the Overview card):
- `jack.spend` (order 95): this month's spend at 80% of the cap (warning) or at the cap (danger, "Jack stops answering until the 1st"). Links to the Usage page.
- `jack.feedback` (order 96): thumbs-down with a note in the last 7 days, by room (never the note), linking to each reply. Info.

## Where it lives
| Piece | Where |
|---|---|
| Mention parsing, answer modes, the composer's hint | `src/lib/jack/mentions.ts` |
| Rating types, summaries | `src/lib/jack/feedback.ts` |
| Archive, pin, answer mode (conditional updates, notes, live updates) | `src/server/jack/room-settings.ts` |
| Ratings (set, take back, a room's ratings) | `src/server/jack/feedback.ts` |
| Posting in mention mode, the lists, archived snapshots | `src/server/jack/rooms.ts` (`postOfficerMessage`, `listRooms`, `countArchivedRooms`, `getRoomSnapshot`) |
| Waiting messages, asides as context, no runs in archived rooms | `src/server/jack/reply-loop.ts` (`waitingIn`, `waitingAsides`); what a reply answers: `src/server/jack/reply-triggers.ts` (`REPLY_TRIGGERS`, shared with the Usage page) |
| Asides marked in the turn, and only the newest kept | `src/server/jack/history.ts` (`ASIDE_MARK`, `markAside`, `ASIDE_LIMITS`, `newestAsides`) |
| Room settings' and ratings' actions | `src/app/admin/jack/room-actions.ts` |
| The room page | `src/app/admin/jack/[roomId]/room-client.tsx`, `src/components/jack/room-settings.tsx`, `reply-feedback.tsx`; `room-view.tsx` gained a `headerActions` slot and a read-only header |
| The rooms list | `src/app/admin/jack/page.tsx`, `rooms-client.tsx`, `src/components/jack/room-list.tsx`, `room-search.tsx`, `src/server/jack/room-search.ts` |
| Usage page | `src/app/admin/jack/usage/`, `src/server/jack/usage.ts` |

## Env vars and setup
None new. The Usage page shows `JACK_MONTHLY_BUDGET_USD` (default $50), which already exists. No setup steps for Gray; the columns and `JackFeedback` came with G1's migrations.

## Trying it locally
- `pnpm --filter @lsr/platform dev`, then as an officer:
  - open a room, use the "…" menu: pin it (it moves to the top of `/admin/jack` and the rail), switch to "Answer only when mentioned" and post with and without `@Jack` (only the mention gets an answer, and its reply covers the asides), archive it (read-only bar; it moves to `/admin/jack?view=archived`; search still finds it), unarchive;
  - rate a reply thumbs down with a note, then open `/admin/jack/usage` and find it under Thumbs-down as an eval candidate.
- `NODE_ENV=production pnpm --filter @lsr/platform exec tsx scripts/check-jack-rooms.ts`: the database side, through the real reply loop without Claude (replies are the "isn't connected" notice): mention mode, archived rooms (no runs, the snapshot, lists and search), pins, the ratings' unique key, and the Usage queries' SQL in February 2001 (Central Time month edges included). Writes only rows it deletes again.
- Unit tests: `src/lib/jack/{mentions,feedback,room-state}.test.ts`, `src/server/jack/{reply-loop,history,rooms,room-search,room-settings,feedback,usage}.test.ts`, `src/app/admin/jack/{room-actions,actions,actions-imports}.test.ts`, `src/server/automation/checks/decks-rooms.test.ts`.

## Eval
No eval question in this PR. The harness (`scripts/jack-eval.ts`, `runCase`) builds each question's turn from one officer message (`ask`), plus earlier exchanges (`before`), so it can't put officers' asides in the same turn as a mention. A mention-mode question needs a small harness change first: an `asides?: string[]` on `Question` that `runCase` adds to the turn as officer messages with `expectsAnswer: false` and `answeredById: replyId`, before `ask`. Then: in a turn with "Should GM 2 move to Thursday?" / "Thursday works for me" as asides and "@Jack how many people registered for GM 2?", Jack answers the count and doesn't weigh in on moving GM 2. This track adds no tools, so there are no tool questions.

## Release
Nothing beyond the 2.0 migrations already planned. The two digest checks start reporting once T11's digest and Overview card run.

## Choices made here (for the build log)
- **Pins are shared** (like rooms) and archiving keeps a room's pin, so it comes back pinned.
- **Pinned rooms sort by activity among themselves** (not by when they were pinned), the same order as the rest of the list.
- **Archiving doesn't stop a reply already streaming**: it finishes; no new answer starts. Archiving is allowed any time rather than refused while Jack answers.
- **A pending proposal in an archived room can't be applied or discarded from its card**: the room page gives the cards Apply and Discard actions that say "This room is archived. Unarchive it to apply or discard." The server doesn't refuse it yet (`applyProposal` is G4's; see the notes below).
- **The rooms list's search includes archived rooms now**, marked, since they open (T1 had left them out until then).
- **Changing a rating re-dates it** (no edit-time column), so "this month's ratings" counts by when the rating was last set.
- **Who a reply's cost goes to** is the officer whose message started it, so a deck's automatic continue notes count for the officer who asked; replies to scheduled notes are automation.

## Notes for the next PRs
- **T9b (Instagram publish, gallery):** this doc's file is shared; add a section above or below. The room page's header has a `headerActions` slot now (the room menu fills it).
- **T11 (automation):** give `JackUsage` rows for automations a readable `job` ("recurring_question", "digest_summary"): the Usage page lists any job other than `name_room` as "Automation: <job>". The $10 automation cap isn't shown on the Usage page yet; add it there with the cap's code. Replies to scheduled notes already count as "Recurring questions". The recurring-question route should check the target room's `archivedAt` before posting its `scheduled: true` note, and skip (or pause the question) with a note when the room is archived: nothing answers in an archived room, so the note would wait there, still count as an automation run, and get a stale answer whenever someone unarchives the room. The digest checks `jack.spend` and `jack.feedback` are ready for the digest and the Overview card.
- **G6 (who's asking):** the history marks asides at the call site (`renderOfficerTurn(turn.items.map(markAside))`), so changing how an officer line renders (`authorLabel`) needs no change here; the mark goes on the message text. Each turn's items are cut to its newest asides right after grouping (`newestAsides`), and the "left out" line goes in the turn's lead, before `renderOfficerTurn`'s output.
- **Proposals (G4):** the room page already stops Apply and Discard in an archived room; `applyProposal` (and discard) should also refuse when `room.archivedAt` is set, so the rule holds on the server too (a follow-up, not filed as an issue yet).
