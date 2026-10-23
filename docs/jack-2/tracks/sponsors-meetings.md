Docs and env notes for the sponsors-meetings track; folded into docs/jack.md at the end.

# Sponsors, meetings and action items (T10)

Design §4.3 (`prospect.upsert`, `prospect.activity`, `meeting.record`, `action_item.update`), §7.1 (`propose_meeting`, `sponsors_list`, `meetings_list`, `draft_text`), §11.2 (overdue action items, quiet prospects), §13 (Club → Sponsors, Meetings, Action items) and §5 (meetings from transcripts). Code paths are relative to `apps/platform/`.

**New env vars:** none. **Migrations:** none (the tables are G1's: `SponsorProspect`, `SponsorActivity`, `Meeting`, `MeetingDecision`, `ActionItem`). **Setup steps:** none.

## What's where

| Piece | Where |
|---|---|
| Stages, activity types, quiet and overdue rules, paths | `src/lib/sponsor-prospects.ts`, `src/lib/meetings.ts` |
| Field checks (shared by the pages, the kinds and the import targets) | `src/schemas/sponsor-prospect.schema.ts`, `src/schemas/meeting.schema.ts` |
| Services (every write goes through these) | `src/server/services/sponsor.service.ts`, `meeting.service.ts`, `officers.ts` (who can own things) |
| Reads | `src/server/queries/sponsor-prospects.ts`, `src/server/queries/meetings.ts` |
| Proposal kinds and import targets | `src/server/jack/proposals/sponsors-meetings/`, registered in `proposals/kinds/sponsors-meetings.ts` and `proposals/import-targets/sponsors-meetings.ts` |
| Tools | `src/server/jack/tools/draft-text.ts`, `sponsors-list.ts`, `meetings-list.ts`, registered in `tools/registry/sponsors-meetings.ts` |
| Prompt section and pages; schema notes | `prompt-sections/sponsors-meetings.ts`; `tools/schema-notes-slots/sponsors-meetings.ts` |
| Digest checks; Overview card | `src/server/automation/checks/sponsors-meetings.ts`; `src/app/admin/_overview/cards/sponsors-meetings.tsx` |
| Pages | `src/app/admin/sponsors/`, `src/app/admin/meetings/`, `src/app/admin/action-items/` |

## The data, and the rules the code keeps

**Sponsor prospects** are companies the club is courting. They aren't the sponsors on the website (`src/lib/sponsors.ts`, set in code); the schema doesn't link the two, so nothing here does either. The Sponsors page and `sponsors_list` show the website's sponsors separately, for reference.

- Stages: idea, researching, contacted, talking, committed, declined, dormant. "Being worked on" is idea to talking.
- Tier interest is one of the sponsorship tiers on `/sponsors` (`src/app/sponsors/tiers.ts`: friend, silver, gold, platinum).
- Owners are officers or admins (`officers.ts`); so are action item owners.
- A company is "the same" when its name matches without case, spacing, punctuation or a trailing Inc./LLC/Co. (`companyKey`). Adding one that's already there is refused (the page links to it; Jack's proposal turns it into a change, marked ambiguous).
- Changing the stage writes a `stage_change` activity ("Stage: Contacted → Talking"). Logging an email sent, a reply, a call or a meeting moves `lastContactAt` forward (never back); a note doesn't.
- **Quiet:** in contacted or talking with nothing logged for **21 days** (`QUIET_PROSPECT_DAYS`), counted from the newest activity, else the last contact, else when it was added. A next step is overdue the day after its due date (Central), on prospects still being worked on.
- Audit entries (`SPONSOR_PROSPECT`: CREATE, UPDATE, LOG_ACTIVITY, DELETE_ACTIVITY, DELETE) name the company and the fields changed, never the contact's name, email, role, the next step (it often names or addresses the contact) or the notes, so deleting a prospect removes them.

**Meetings** have a type (stored in `Meeting.kind`: board, tech, general, department, other), a time (a meeting recorded without one sits at midnight Central and shows without a time), and Markdown agenda and summary. They're drawn with the same parsed renderer as Jack's replies (`ReplyText`), never as HTML.

- **Decisions go to the decision log.** Each `MeetingDecision` gets a knowledge entry (`KnowledgeEntry` tagged `decision` and the meeting's type), dated when the meeting was held, linked back to the meeting (`sourceUrl`), written through the knowledge service. Who it belongs to depends on where it came from (design §9's guardrails):
  - **Typed on the meeting page:** the officer's own (`via: admin`, sourceType MANUAL), marked reviewed by them.
  - **From a `meeting.record` proposal:** Jack's (`via: jack`, sourceType JACK, version by the officer who applied it), **not reviewed** until an officer marks it on the Knowledge page, with its provenance: the room, the reply that proposed it and the officer messages it answered, who asked, the tools that reply used first (a transcript read, a page fetched), and a `propose_meeting` line with the proposal id, the room file and who applied it. The Knowledge page shows this under "Where Jack got it". The card shows each decision's whole text, so what's applied is what was read.
  - The duplicate check is skipped (a log has one entry per decision); `meeting.record`'s card shows similar entries instead, and a meeting never gets the same decision twice from a proposal (below). The secret check still applies (refused before anything is written). If an entry can't be written, the decision is kept unlinked and the result says why.
- Removing a decision from a meeting keeps its log entry (archive it in Knowledge if it's wrong). Deleting a meeting deletes its decisions, keeps their log entries, and keeps its action items (they're still to do).
- Audit entries (`MEETING`: CREATE, UPDATE, ADD_DECISIONS, REMOVE_DECISION, DELETE) say whether there's an agenda or summary, never their text.

**Action items:** open, done or dropped. Done stamps `doneAt`; reopening clears it. A due date is stored as the start of its Central day, and an item is **overdue** from the day after (an item due today isn't). Audit entries are `ACTION_ITEM` (CREATE, UPDATE, MARK_DONE, DROP, REOPEN), with the owner as `targetUserId`.

**Concurrency:** the services' `*Tx` functions lock the row (`FOR UPDATE`) and, given `expected` values, refuse with `changed` when a field moved on since it was read, so a proposal never overwrites an officer's edit. `scripts/check-sponsors-meetings.ts` checks two changes from the same read (exactly one lands) and two applies of the same new meeting at once (one records it, the other goes stale).

## Jack

### Proposal kinds (`proposals/sponsors-meetings/`)

| Kind | Tool | What it does | Rows |
|---|---|---|---|
| `meeting.record` | `propose_meeting` | A new meeting (title, type, date, time, agenda, summary), or additions to one already recorded (`meetingId`: an agenda before, the summary after). Decisions (one sentence each; an optional short title for the log) and action items (owner by handle, due date). From a transcript or notes in the room it names the file as `fileId`: the file must be this room's, READY, and a transcript, Word, text or PDF file; Apply checks it's unchanged (sha256), and the meeting keeps it as its transcript (the file cleanup never deletes meeting transcripts). A date given without a time keeps a recorded meeting's time of day | One per decision and action item, plus the meeting's own row (`m`: a new meeting, or the changes to a recorded one's fields) when there are any; a new meeting's decisions and items need `m` picked (Apply refuses them without it), and `m` alone records just the meeting |
| `prospect.upsert` | `propose_meeting` | Adds prospects or changes existing ones (`prospectId` from `sponsors_list`), several at once. A "new" company that's already a prospect becomes a change to it (ambiguous, starts unpicked); one with nothing to change is shown unmatched. A new prospect's card shows every field Apply writes (website, contact name, role and email, stage, tier, owner, next step, notes) as diff rows. Two rows for the same prospect (by id or by company name) are refused | One per prospect |
| `prospect.activity` | `propose_meeting` | Logs emails, replies, calls, meetings and notes (date defaults to today; never a future date), each optionally moving its prospect's stage and next step. One that looks already logged (same prospect, type, day and text) is ambiguous. The activity is credited to the officer who asked (`proposedFor`), not the one who applies | One per activity |
| `action_item.update` | `propose_change` | Marks items done or dropped, reopens, reassigns, changes due dates or text, or adds items (no id, optionally on a meeting) | One per item |

Shared behavior:
- `prepare` only reads, and refuses what the model can fix (`ProposalInputError`): unknown ids, handles that aren't officers', changes that change nothing, secrets in a decision, a meeting already recorded under the same title that day (a meeting of the same type that day under another title is named on the card instead), two rows for one prospect.
- **Partial approval:** every row is a checkbox. Apply writes the picked rows (and, for a meeting, the meeting itself) **in one transaction**, all or none.
- **Staleness is checked at apply, per picked row** (`checkStale` returns null): each change is written with the fields it was proposed against as `expected`, so a row an officer left out never blocks the rest, and a picked row that moved on makes the whole proposal STALE (`StaleProposalError`). A company added meanwhile, a deleted record, or an owner who stopped being an officer is stale too.
- Each change's own audit entry carries `ctx.auditMetadata` (`via: "jack"`, `proposalId`, `roomId`, `proposedFor`); the framework adds its own `JACK_PROPOSAL` entry. Paths are revalidated after the apply.
- A proposal that changes one record targets it (`targetId`), so a newer one supersedes it. A `meeting.record` for a new meeting targets `new:<Central day>:<type>`, so re-proposing it (a corrected title, say) replaces the older card in the room; the catch is that two different new meetings of the same type on the same day can't both be pending in one room. A `meeting.record` that only adds decisions or action items to a recorded meeting doesn't target it, so two of those both stand.
- **Repeats:** a new meeting whose title (case aside) is already recorded that Central day is refused when proposed and again at apply, inside the transaction under an advisory lock on the title and day (`lockMeetingDayTx`), so two applies of the same meeting (from two rooms, say) record it once and the other goes STALE. Adding to a recorded meeting leaves out decisions and action items it already has (same text, case, spacing and closing punctuation aside), read under the meeting's row lock; the result says how many, and a proposal with nothing left to add goes STALE.
- New meetings and action items made by a proposal keep the room (`roomId`), and decision-log versions keep it too, so the eval's cleanup finds them by room.

### Import targets (`proposals/sponsors-meetings/import-targets.ts`)
For the changes track's `import.rows` kind:
- `sponsor_prospects`: company (required), website, contact name/email/role, stage (key or label), tier interest (id or name), owner (officer's handle, email, or a name only one officer has), next step, next step due (`2026-10-30`, `10/30/2026`, `10/30/26`), notes. A company that's already a prospect is refused with a reason; the same company twice in the file keeps the first.
- `action_items`: text (required), owner, due. Items keep the proposal's room.
- Officers and the prospects' company names are cached for 10 seconds, since `validateRow` runs once per row.

### Tools
- **`draft_text`** (always loaded): an email (subject, who it's for), agenda, caption or other text, shown as the copyable `text_draft` card. It never sends. **Contact details:** an email address or phone number in a draft must appear in a message an officer typed in this room (the room's newest 200 officer messages), or be the club's own (`@longhornsimracing.org`); otherwise the call is refused and Jack is told to name the person instead. Captions are held to Instagram's 2,200 characters and 30 hashtags.
- **`sponsors_list`** (deferred): prospects being worked on by default (every stage when searching), filters by stage, owner handle, quiet and words; counts by stage; one prospect's notes and timeline with `prospectId`. Contact emails only with `contact: true` (when an officer asked). Also lists the website's sponsors, labelled as not prospects.
- **`meetings_list`** (deferred): `show: meetings | decisions | action_items`, or one meeting in full (`meetingId`; agenda and summary cut at 6,000 characters each). Decisions search by every word, falling back to any word (and saying so). Action items by owner handle and status (open, overdue, done, dropped, all) with per-owner counts.
- Tools that take an owner take a **handle**. The tool descriptions and the prompt say "mine"/"me" works only when one officer asked in the turn (G6 adds the core rule; this track's lines don't depend on it).
- Size: the three tools' definitions are about 4,600 characters and the four kinds add about 7,000 to the propose tools (budgets 6,000 and 8,000, checked in `tools/registry/sponsors-meetings.test.ts`). `propose_meeting` is deferred.

### Prompt and schema notes
The prompt section (about 1,300 characters) says where the data is, which kinds do what, the transcript rules (only what was decided; owners and due dates only when said), the owner/"mine" rule and the draft contact rule. Three page lines: Sponsors, Meetings, Action items. `describe_schema` gets the five tables (stages, types, the quiet and overdue definitions, how decisions link to the log).

## Admin pages (Club)
Officers only (`requireOfficerPage()` on every page; every action checks `requireOfficer()`).
- **Sponsors** (`/admin/sponsors`): stats (being worked on, committed, quiet, next steps overdue), search, views (being worked on, committed, quiet, declined or dormant, all) and owner in the URL (`?view=quiet&owner=<handle>`), the table (company and contact, stage and tier interest, owner, last activity with a quiet badge, next step with its due date), and "On the website now". **New prospect**; each prospect's page (`/admin/sponsors/<id>`): log activity (type, date, what happened, optional stage move), the timeline (remove a mistaken entry; stage changes stay), the details form (sends only what changed, so it can't undo another officer's edit), delete (confirms; keeps only the company's name in the audit log).
- **Meetings** (`/admin/meetings`): list with type filter and search over titles, agendas and summaries. **New meeting**; each meeting's page: agenda, summary, decisions (add one: it goes to the decision log; remove one), action items (add, mark done, edit, drop), the details form, transcript and room links, delete. **Agenda to copy** (`/admin/meetings/<id>/agenda`): the title, time and agenda on their own, to select and paste (lists survive into email and Teams), plus **Copy as text**.
- **Action items** (`/admin/action-items`): by owner (owners with the most overdue first, "No owner" last), overdue first within each, status views with counts (open, overdue, done, dropped, all) and an owner filter (`?owner=<handle>`, `?owner=none`); Done, Reopen, Drop, Edit (dialog); add an item on the side.
- **Overview:** an "Action items" card (overdue and due in the next 7 days).
- **Audit log** links `SPONSOR_PROSPECT`, `MEETING` and `ACTION_ITEM` entries to these pages.

## Digest checks (`automation/checks/sponsors-meetings.ts`)
- `action_items.overdue` (order 20): open items past due, **per owner** ("Dylan: 3 overdue", linking to `/admin/action-items?owner=<handle>&status=overdue`, with the oldest due date). A warning once any is more than 7 days late. Names and counts only.
- `sponsors.quiet` (order 25): quiet prospects (above), quietest first, with the owner's handle. A warning once one has been quiet 42 days (twice the window).

## Trying it locally
1. `pnpm dev`, sign in as an officer: Club → Sponsors (add a prospect, log activity, change its stage and see the timeline), Club → Meetings (record one, add a decision and check Knowledge for the entry tagged decision, add action items, open "Agenda to copy"), Club → Action items (mark done, edit, filter by owner), the Overview card, the audit log's links.
2. In a Jack room (needs `ANTHROPIC_API_KEY`): "add Apex Sim Rigs as a prospect, we're talking to them about Gold", "log that we emailed them today", attach a `.vtt` transcript and "record this meeting", "what's overdue for me?", "draft a follow-up email to Apex".
3. Against the local database, everything at once (writes only marked rows and deletes them):
   ```bash
   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm --filter @lsr/platform exec tsx scripts/check-sponsors-meetings.ts
   ```
4. Eval: `pnpm jack:eval:prepare --track=sponsors-meetings` seeds fake prospects (`*.example`), a meeting with two decisions and their log entries, and three action items owned by the eval copy's first officer; then `pnpm jack:eval --dry-run --track=sponsors-meetings --only=jack`. Eight questions: what was decided about sponsor tiers, what's overdue (by name, and "mine"), a follow-up email draft to the prospect met on Tuesday (planted per run), and four "proposes, doesn't apply" ones (add prospects, log activity, record a meeting with an action item for the asker, mark an item done). The dry run passed 8/8 on a throwaway copy of `lsr_eval` (made with `CREATE DATABASE … TEMPLATE lsr_eval`, then dropped).

## Tests
`src/lib/{sponsor-prospects,meetings}.test.ts`, `src/schemas/sponsor-prospect.schema.test.ts`, `src/server/services/{sponsor,meeting}.service.test.ts`, `src/server/jack/proposals/sponsors-meetings/*.test.ts` (each kind: schemas, card views, partial approval, staleness, apply; the import targets), `src/server/jack/tools/{draft-text,sponsors-list,meetings-list}.test.ts`, `tools/registry/sponsors-meetings.test.ts` (order, deferred flags, size budgets, kinds on their tools, targets registered), `src/server/automation/checks/sponsors-meetings.test.ts`, and the three pages' `actions.test.ts`.

## Release
Nothing to set up: no env vars, no migrations, no connectors or jobs. After the merge, a browser check of the three pages (light, dark, 390 px). The digest checks feed T11's digest and "needs attention" card once it lands.

## Notes for the next PRs
- **T11 (automation):** checks `action_items.overdue` (20) and `sponsors.quiet` (25) are registered; items carry names, handles and company names only.
- **T3 (changes):** the `sponsor_prospects` and `action_items` targets follow `ImportTarget`; `applyRows` runs in one transaction and returns `appliedRows` (prospects skipped as duplicates aren't in it).
- **G6 (who's asking):** the "mine only when one officer asked" rule is also in this track's tool descriptions and prompt section; if G6's core rule covers it, the section's line can go.
- **T6 (documents):** `Meeting.transcriptDocumentId` (a Drive/SharePoint transcript) is shown on the meeting page when set, but nothing sets it yet: a "record this meeting from that Drive doc" path would add an `externalDocumentId` to `meeting.record`.
