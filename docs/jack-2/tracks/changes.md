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
