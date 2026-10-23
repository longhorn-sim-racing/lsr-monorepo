Docs and env notes for the changes track; folded into docs/jack.md at the end.

## Services for proposals (PR R)
Behavior-preserving refactors (design §4.4): the admin logic that `event.update`, `news.create` / `news.update` and `results.import` need now lives in services, so a proposal's `apply()` makes exactly the change the admin page makes. The admin pages behave as before.

### What's there
- **`src/server/services/event.service.ts`** (from `app/admin/events/actions.ts`):
  - `updateEventDetails({ eventId, details, publish? }, actor)`: the event form. `details` is the form's fields as Event columns (`EventDetails`); fields left out stay as they are. `publish` sets the status (a draft keeps its publish date). Turning check-in on sets `attendanceReportingMode` to CHECKIN_REQUIRED. Raising capacity, making it unlimited or removing the fee runs `reconcileEventWaitlist` (which promotes and notifies people). A taken slug returns `{ ok: false, error: SLUG_TAKEN }`.
  - `updateEventStatus({ eventId, status, publishedAt? }, actor)`: the status override.
  - `updateEventRegistration({ eventId, settings }, actor)`: the manage page's registration card. Switching auto-promotion on, raising capacity or removing the fee reconciles the waitlist; the audit entry lists `promotedUserIds`.
  - `updateEventAttendance({ eventId, attendanceEnabled, attendanceOpensAt, attendanceClosesAt }, actor)`: the check-in card, through `updateAttendanceConfig` (audit entry ATTENDANCE_CONFIG_UPDATE).
- **`src/server/services/results.service.ts`** (from `app/admin/results/actions.ts`):
  - `createUpload({ filename, bytes }, actor)`: stores the file (JSON checked, sha256, size).
  - `parseUpload(uploadId, { write: false })`: **writes nothing**. Returns the report (drivers, counts, anomalies), the status the parse would set and `unmatchedDrivers` (no DriverIdentity, or one without a member). Same refusals as the writing parse (missing upload, already ingested, not a results file).
  - `parseUpload(uploadId, { write: true, actor })`: today's Parse step: DriverIdentity upserts, ParseReport, status PARSED or FAILED.
  - `previewResultFile(rawJson)`: the pure parse plus `unmatchedDrivers` for a file that isn't uploaded yet (a room file at propose time). `parseResultFile(rawJson)` is the same without the lookup.
  - A file the parse can't read at all (a `null` entry in `Result`, e.g. `{"Result":[null],"Laps":[]}`): `previewResultFile` and `parseUpload({ write: false })` return `{ ok: false, error }` ("This file isn't a results file…"). `parseResultFile` and `parseUpload({ write: true })` still throw a TypeError on it, as the admin Parse step always has; so `results.import` should preview at propose time (and refuse there), and its `apply()` lets a throw be recorded as FAILED.
  - `bindUpload({ uploadId, eventId, pointsSystem?, sessionLabel? }, actor)`: links the event under the row lock; practice and qualifying force points NONE.
  - `ingestUpload(uploadId, actor)`: the same locked transaction as before. Returns the session id and row counts.
- **`src/server/services/news.service.ts`** (from `server/actions/news.ts`): `createPost(input, actor)` and `updatePost(id, input, actor)` validate with `newsPostSchema` and return `{ ok: true, post } | { ok: false, error }` (a bad post, "Slug already exists", "Post not found", "Failed to create/update post") instead of throwing. Tags are synced as before.
- **`src/server/services/actor.ts`**: `ServiceActor = { userId, auditMetadata? }`.

### Rules for callers (the proposal kinds)
- **Permissions:** services never check them. The admin pages use `requireOfficer()` (events, results) and `requireRole(['admin', 'officer'])` (news), so these kinds are `permission: "officer"`.
- **Audit:** pass the applying officer as `actor.userId` and the proposal as `actor.auditMetadata` (`{ via: "jack", proposalId, roomId, proposedFor }`). It's merged into the one audit entry the service writes; the service's own metadata fields win on a clash. Without it, entries are exactly what the admin pages wrote before.
- **Revalidation lives with the caller.** `revalidatePath` only works inside a request (it throws "static generation store missing" in scripts), so services don't call it. Every successful result has `revalidate: string[]`, the exact pages the admin action used to refresh; pass it to `revalidatePaths()` (`src/server/cache/revalidate-public.ts`). Proposal `apply()` runs inside the apply server action, so calling `revalidatePaths(result.revalidate)` there works. For `results.import`, call it for each step's result (or their union).
- **Errors:** `{ ok: false, error }` is for problems an officer can fix (a taken slug, an ingested upload); the text is ready to show. Anything unexpected still throws: a missing event (Prisma P2025, or "Event not found" from the attendance service), a database error. Kinds should check staleness first and let the framework record a throw as FAILED.
- **Validation:** the event services take already-validated values. The admin actions parse the forms (`parseEventForm`, `parseRegistrationConfigForm`, the check-in window in the event's time zone). A kind that changes some fields must check the merged result the same way (start before end, windows that close after they open, capacity ≥ 1, the Stripe minimum fee). The news services validate with `newsPostSchema` themselves; news proposals are Markdown only (design §4.3), which is the kind's own check.
- **Results import order:** `previewResultFile` at propose time; at apply, `createUpload` → `parseUpload({ write: true })` → `bindUpload` → `ingestUpload`. `ingestUpload` doesn't require a PARSED status (an upload with anomalies can still be ingested, as on the admin page), and standings aren't recomputed (`recomputeStandings` on the season page).

### Behavior pinned, not changed (worth knowing)
- **HALF points round down in the database.** `calculatePoints` gives 7.5 for third place; the Int column stores 7 (the golden check confirms this matches the existing rows).
- **A news post stays saved when tagging fails,** and the result is still "Failed to create post".
- **The "Updated event details" audit summary** now reads the title from the saved row instead of the form; for the admin form they're the same value.
- **One deliberate fix:** the news action detected a taken slug with the error class from `@prisma/client/runtime/library`. Loaded as ESM (Node, Vitest and very likely the production bundle), that path is a second copy of Prisma's runtime, and the client's errors aren't instances of its class, so a taken slug probably showed "Failed to create post". The service uses `Prisma.PrismaClientKnownRequestError`, like the rest of the app, so it says "Slug already exists".

### Env and setup
None. No new env vars, settings or migrations.

### Trying it locally
- Unit tests: `pnpm --filter @lsr/platform test` (`event.service`, `results.service`, `news.service` and the three action files' tests, which run the real actions on mocked Prisma).
- **Golden check** (`scripts/check-results-service.ts`): needs the local Supabase running and the `lsr_eval` database (a production copy). It reads every INGESTED upload from `lsr_eval` in read-only transactions, replays it through the services in a throwaway database (migrations applied with `prisma migrate deploy`, stand-in members and events with ids only), diffs the race rows and parse reports, and drops the throwaway database. It never writes to `lsr_eval` or saves its data, and refuses non-local URLs.
  ```
  pnpm --filter @lsr/platform exec tsx scripts/check-results-service.ts            # every ingested upload
  pnpm --filter @lsr/platform exec tsx scripts/check-results-service.ts --limit 3 --verbose
  pnpm --filter @lsr/platform exec tsx scripts/check-results-service.ts --upload <id>
  ```
  `LSR_EVAL_DATABASE_URL` points it at another local copy. On 10/22 all 68 ingested uploads matched (two were ingested twice before the row lock existed; the replay matches both copies).
- **Admin pages to click through:** an event's edit form (save, publish, schedule, raise capacity on an event with a waitlist), the status override, the manage page's registration and check-in cards; Results → upload, Parse, link an event, Ingest; News → new post, edit (with a slug change and tags).

## Proposal kinds (PR T3)
Design §4.3 and §7.1. Jack proposes, an officer applies (the framework is in `groundwork.md`, "Proposals"). Seven kinds, each applied through the same service the admin page uses, as the officer who presses Apply, with the proposal on every audit entry the change writes (`ctx.auditMetadata`: `via`, `proposalId`, `roomId`, `proposedFor`). Code paths are relative to `apps/platform/`; the kinds live in `src/server/jack/proposals/changes/` and are registered in `proposals/kinds/changes.ts`.

| Kind | Tool | What applying does | Through | Stale when |
|---|---|---|---|---|
| `event.update` | `propose_change` | Changes an event's details, times, venue, series, stream link, registration (on/off, window, capacity, waitlist, moving up on its own), check-in, or status (publish now, schedule, draft, cancelled, postponed, completed) | `event.service`: `updateEventDetails` (form fields and the publish buttons), `updateEventRegistration`, `updateEventAttendance`, `updateEventStatus` (the override); one audit entry each | A field it changes was edited since, the event is gone, or the event with the change no longer passes the form's checks |
| `news.create` | `propose_content` | Saves a post as a draft, scheduled, or published now (the time it's applied) | `news.service.createPost` | Its link was taken, its author's account is gone, its publish time passed |
| `news.update` | `propose_content` | Changes a post's title, text (exact find-and-replace edits, or a whole new text), excerpt, link, tags, author or publishing | `news.service.updatePost` (every field, the untouched ones as they are when it's applied) | A field it changes was edited, the post is gone, the new link was taken, the new publish time passed |
| `notification.send` | `propose_message` | Sends a message in the bell and/or by email to the recipients left ticked, now or at a set time | `notification.service.sendBulkNotification` (type CUSTOM), one audit entry like the Notifications page's | Its send time passed |
| `results.import` | `propose_import` | Uploads a results file from the room, parses it, links it to the event (session and points) and ingests it | `results.service`: `createUpload`, `parseUpload({ write: true })`, `bindUpload`, `ingestUpload` | The event is gone, the same file was imported since, or the room file changed (sha256, checked by the framework) |
| `attendance.checkin` | `propose_import` | Checks in the ticked people (manual check-ins by the applying officer) | `attendance.service.checkInUser` (skips anyone already in) | The event is gone |
| `import.rows` | `propose_import` | Puts the ticked rows of a spreadsheet or CSV from the room into an import target | The target's `applyRows` (LSC entry forms: `league-entry.service.saveLeagueApplication`) | The target is gone, or the room file changed |

Every kind's `prepare` only reads. It writes the card (title, summary, the changed fields as diff rows, people, links, rows to tick) and saves what `apply` needs in `before`. The model never writes the card.

### event.update
- **Fields:** title, summary, description, startsAt/endsAt (local time in the event's zone, like `2026-10-19T18:00`), venue and series (by name, slug or id; `null` removes), streamUrl (https), registrationEnabled, registrationOpensAt/ClosesAt, capacity (`null`: no limit), waitlistEnabled, waitlistAutoPromote, checkInEnabled, checkInOpensAt/ClosesAt, status (with publishAt for SCHEDULED). Only the fields that would change are kept; "nothing would change" is refused.
- **The admin form's checks:** the event as it would be is run through `parseEventForm` (the same FormData the form sends), so start before end, registration and check-in windows that close after they open, capacity and the Stripe minimum on a paid event's fee all apply, at propose time and again before applying. Also refused: moving people up on their own on a paid event (the manage page doesn't allow it), a publish time that has passed.
- **What the card says:** each change before → after in the event's zone; that it goes live (or is hidden, or stays on the site marked cancelled); how many people move off the waitlist (worked out as the registration service's reconcile does) and that they're notified; that registered people aren't messaged about a new time; when capacity drops under the number registered.
- **One proposal per event:** a newer event.update for the same event replaces the older pending one (the description tells the model to put every change to one event in one proposal).
- **Not by proposal:** the fee (Jack never changes prices, not even by proposal; the eval's `refuse-change-fee`), the link (slug), the photo and visibility. Those stay on the event's page.
- **Partial failure:** the groups are saved in order (details, registration, check-in, status). If a later one fails, the error says what was already saved and to check the event's page.

### news.create and news.update: Markdown only, with a rendered preview
- **The rule:** posts render as MDX on the site (`src/lib/news.ts`), where `<` starts a component, `{ }` run JavaScript and an `import`/`export` line is a module. So a post Jack writes may hold none of these outside code (`changes/markdown.ts`). The check parses the text as MDX parses Markdown (remark-parse with remark-gfm, indented code, HTML and `<autolinks>` switched off, as MDX switches them off), so the code spans and fenced blocks it finds are exactly the ones MDX treats as code; escaped braces count too. The error names each line and how to fix it, for the model. An edit (news.update) may keep what the site already runs as MDX (an officer's own embed) exactly as it is, so a typo can be fixed in such a post. MDX's own parser (remark-mdx, as the site parses) finds each element, expression and import/export in the old and new text; one is kept only when its whole source (tag, every attribute, anything inside it) is in the old text character for character, and only as many times as the old text has it. So a tag spread over several lines can't gain or change an attribute (a matching first line isn't enough), and anything new, changed, copied or taken out of a code block is held to the rule.
- **The preview:** the same parse becomes a small tree (headings, paragraphs, lists with checkboxes, quotes, code, tables, links, line breaks) saved with the proposal (`ProposalView.preview`) and drawn on the card by `components/jack/parts/markdown-preview.tsx` as React elements, never HTML. Links show their host (`PartLink`); pictures are never loaded on the card: they show as a link with their host.
- **Defaults:** the author is the officer who asked (or `author`: a handle); the link is made from the title, with `-2`, `-3` when taken; a new post is a draft unless the officer asks to schedule or publish it; publishing "now" uses the moment it's applied. The cover image stays with the admin form.

### notification.send
- **Audience** (resolved on the server when proposed, saved with the proposal): every active member (as the Notifications page's "all"), an event's registered, waitlisted or checked-in people, a season's LSC drivers (entered: paid or entered by an officer; or everyone who applied, from `listSeasonEntrants`), the officers (officer or admin role), or members by handle. Deleted accounts are left out; at most 2,000 people.
- **Rows:** one per recipient (row id = user id), all ticked. Apply sends to the ticked ones only.
- **Plain text:** the email template puts the title and text into the email as written, so `<` and `>` are refused (in the link text too). A link is a site path or an https link; the card shows an outside link's host. The card's preview shows the message as written, with its button.
- **Email limit:** counted as the Notifications page counts it (`getEmailUsage`, the plan's daily limit less 10 kept for confirmations and receipts; only members who allow club emails get one). More than a day can send is refused when proposed; more than today has left is said on the card, and Apply refuses it then (there's no "send anyway"). Scheduled sends aren't checked, as on the page.
- **Never twice:** every notification row carries `metadata.proposalId`; an apply that finds rows for its proposal sends nothing. The kind is `destructive` (the card asks first).
- **One pending proposal per audience:** a newer one for the same audience replaces the older (`targetId` is the audience's key).

### results.import
- Reads the room file's bytes from the file store and checks them against the sha256 taken at registration; runs `previewResultFile` (no writes) and shows the drivers, who isn't linked to a member yet, what the file says it is (track, session, time) and any parse problems. Practice and qualifying never award points.
- Refuses a file whose exact copy (sha256) is already ingested. Says when the event already has a session of that kind.
- If a step fails at apply, the error links the upload (`/admin/results/<id>`) to finish or delete it there. Standings aren't recomputed (the season page does that).

### attendance.checkin: matching names
`changes/names.ts`, pure and tested:
- A handle (with or without `@`) or an email matches exactly.
- Otherwise names compare word by word, ignoring case, accents and punctuation: the same words in any order; the same first name (nicknames: Matt and Matthew, Bill and William, and a first name that starts the other, like Chris and Christopher) and last name; an initial with a name ("J. Marshall", "Gray M"); a lone first or last name.
- The event's registered and waitlisted people are searched first: a name that fits one of them is theirs, a name that fits several is ambiguous. Only then all members, where a lone name never counts as a match (it's offered as ambiguous, up to 5 candidates, or nothing when it's that common).
- **Rows:** a matched name is one row (ticked); an ambiguous name is one row per member it could be (none ticked: the officer ticks the right one); a name with no match is a row that can't be applied. People already checked in aren't rows; the card names them. Two names for one member: the second is marked as the same member. Row ids are `<name index>:<user id>`, so a tick says exactly who it checks in. Without picks (outside the card), only the matched names apply.
- A list where nobody matches, or everyone is already in, isn't proposed.

### import.rows and import targets
- **Input:** `fileId` (a CSV or .xlsx in the room), `target`, `columnMap` (target column → the file's header, any case), optional `values` (one value for a column on every row, e.g. the season), `sheet` (default: the first with rows) and `fromRow` (500 rows per proposal; the card says where the rest start).
- **Rows** come from the text G5 extracted at registration (`changes/table.ts`: the CSV, or each sheet's CSV under `## Sheet:`), so nothing is parsed twice and the 5,000-row cap applies (the card says when the file was cut).
- Each row goes through the target's `validateRow` (8 at a time). Ready rows are ticked; rows that can't go in show why; rows the target gives the same `key` as an earlier one are repeats, not ticked. A file with no ready row isn't proposed. Apply reads the file again, checks the ticked rows again and gives the target the ones still valid.
- **Permission:** `permissionFor` returns the target's `permission` (an officer by default; an admin for a target this site doesn't know).
- **The LSC entry forms target** (`lsc_application`, `changes/lsc-applications.ts`): columns email, eid, name, discord (required), experience, equipment (required), canCommit, school, notes, season. A row is matched to a site account by email, then by UT EID (as "Add entrant" needs an account, and as `scripts/import-lsc-applications.ts` matched the Google Form); the season is the row's (slug or name) or the open Lone Star Cup season. Answers are read the way that script read the form (experience and equipment words, yes/no, a blank school is UT). A driver who already has an entry form for the season is left out (edit it on LSC entries); an EID is saved only to an account without one and only when nobody else holds it. Applied through `saveLeagueApplication` with source ADMIN and the applying officer as `createdById`, as "Add entrant" does.
- **Adding a target (for other tracks):** implement `ImportTarget` (`proposals/types.ts`) in your track's code and register it in `proposals/import-targets/<track>.ts`. `validateRow` only reads and returns a `label`, a `detail` for the card, and a `key` when two rows can be the same record. `applyRows` writes through your service with `ctx.officer.userId` and `ctx.auditMetadata`, refreshes your pages, and returns `{ summary, links, appliedRows }`. The import.rows kind lists every target and its columns in its description.

### Shared files touched (and why)
- `proposals/types.ts`: `ProposalView.preview` (the rendered preview) and `ImportRowCheck.key` (repeated rows). Both optional.
- `proposals/service.ts`: the saved view keeps `preview`, and the card's detail passes it on. `lib/jack/proposals.ts`: `JackProposalDetail.preview`.
- `components/jack/parts/proposal-card.tsx`: draws the preview under the diff.
- `services/attendance.service.ts` (`checkInUser`) and `services/league-entry.service.ts` (`saveLeagueApplication`): an optional `extraMetadata`/`auditMetadata` added to their audit entries, as `updateAttendanceConfig` already had. Without it the entries are as before.
- `package.json`: `unified`, `remark-parse` and `remark-mdx` (all already in the lockfile, through next-mdx-remote) for the Markdown and MDX parses.
- `scripts/jack-eval/tracks/index.test.ts`: `questionSet` was tested with the real track questions as its default, so it broke once a track added questions; it passes an empty list now.

### Env and setup
None. No new env vars, settings or migrations. The size test (`changes/kinds.test.ts`) keeps the seven kinds' descriptions and fields under 13,500 characters of the cached prompt.

### Trying it locally
- Unit tests: `src/server/jack/proposals/changes/*.test.ts` (every kind's schema, card, staleness and apply; the MDX rule and the preview; name matching; reading tables; the LSC target; the kinds' registration and size), `components/jack/parts/markdown-preview.test.ts` (the card's preview never renders markup or loads a picture), `services/attendance.service.test.ts`, and the proposal service's preview test.
- **DB check** (local database only): `pnpm --filter @lsr/platform exec tsx scripts/check-jack-changes.ts` proposes and applies every kind through the real framework and services against throwaway rows (two members, an event, a season, a post, results, entry forms) and deletes them all, with the audit entries. 21 checks; it passed on 10/22.
- **Cards in a room, without Claude:** `pnpm --filter @lsr/platform exec tsx scripts/try-jack-changes.ts` makes a draft event "Changes check …" and a room "Changes check" where an officer's message carries a results file and a sign-up sheet, and a scripted fake Claude proposes one of each kind. Open the printed room link. Applying a card changes the local database as the admin page would; `--clean` deletes the script's events, rooms and their files.
- **Eval** (`scripts/jack-eval/tracks/changes.ts`): `propose-news-welcome` and `propose-notify-officers` (both also run in `--dry-run`, with scripted calls), `propose-results-from-file` and `propose-import-lsc-signups` (attach a file to the question's room; they wait for G6's `room_files`), and `propose-checkin-signin` (a sign-in sheet from a recent event, as an earlier message). Each checks a PENDING proposal of its kind, nothing applied, and what it would change unchanged. `propose-email-lsc` and `propose-publish-gm1` (core) run now that their kinds exist.

### Notes for the next PRs
- **T10 (sponsors-meetings):** your import targets register in `import-targets/sponsors-meetings.ts` with the interface above; give `validateRow` a `key` so a sheet's repeated prospect shows as a repeat. `action_item.update` joins `event.update` and `page.update` on `propose_change`.
- **G6 (files):** results.import and import.rows take a room file's id; the prompt section points the model at `room_files` to find it. The two file questions in the eval wait for `room_files`.
- **T11 (automation):** pending and stale proposals of these kinds show on the Proposals page like any other.
