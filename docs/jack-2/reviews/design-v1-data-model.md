# Data model and migrations review: Jack 2.0 design (`docs/jack-2/design.md`)

Paths are relative to `C:/Users/Gray/WebstormProjects/lsr-monorepo`.

How I checked the Prisma claims, all without writing anything:
- **Local DB vs schema:** `prisma migrate diff --from-url <local> --to-schema-datamodel prisma/schema.prisma` gives an empty diff. The local DB already has the partial index `RecruitingCycle_single_active_idx` and the JackMessage CHECK constraints, so Prisma ignores both.
- **Schema-only diffs:** run on probe schemas, with no database.
- **The Prisma 6.15 schema-engine's introspection SQL:**
  - Partial indexes are skipped (`indpred IS NULL -- filter out partial indexes`).
  - Columns are listed from `information_schema.columns`, with defaults read through `pg_get_expr(attdef.adbin, …)` and no filter for generated columns.

## Findings

1. **Major · §3.3 (full-text paragraph), §12. "Prisma ignores it" is false, so the first track that runs `pnpm db:migrate` will drop the search columns.**
   - **Problem:**
     - Prisma diffs every column in `public`. A tsvector column that exists only in hand-written SQL shows up in the next `prisma migrate dev` as `ALTER TABLE … DROP COLUMN`, and its GIN index goes with it. That would hit KnowledgeEntry, JackMessage and ExternalDocument. Nine tracks are expected to run `migrate dev`.
     - Declaring the column as `Unsupported("tsvector")?` probably isn't enough while it stays a STORED generated column. Prisma reads the generation expression from `pg_attrdef` as a default, so it will likely emit `ALTER COLUMN … DROP DEFAULT`, which Postgres rejects for generated columns. That would make every later migration fail to apply. I couldn't run this without a writable database, so treat it as likely, not proven.
     - Generated expressions must be immutable. `array_to_string(tags, ' ')` is STABLE, so tags can't be folded into a generated column.
     - `JackMessage.content` is rewritten every second while Jack streams (`DELTA_PERSIST_MS = 1_000` in `src/server/jack/delta-stream.ts:7`; the write is at `src/server/jack/reply-loop.ts:242`). A stored column plus a GIN index re-tokenizes the whole reply on every write, and those writes stop being HOT updates.
     - A tsvector larger than 1 MB makes `to_tsvector` raise an error. With a 200k-character cap, a CSV-like Sheets export in ExternalDocument could hit that and fail its sync row on every run.
   - **Fix:**
     - Declare each column in `schema.prisma` as `search Unsupported("tsvector")?` with `@@index([search], type: Gin)`. I checked that Prisma emits `CREATE INDEX … USING GIN ("search")` for this.
     - Fill the column from a plpgsql `BEFORE INSERT OR UPDATE` trigger instead of `GENERATED`. Prisma doesn't introspect triggers. The trigger can include tags, skip rows with `status = 'streaming'`, and cap the input with `left(text, 100000)`.
     - Backfill existing rows in the same migration.
     - Make this a G1 acceptance check and an every-PR check: `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <throwaway> --exit-code` must report no changes.

2. **Major · §12 (release) with §3.4, §3.8, §3.15. The one-shot merge races the separate migrate job.**
   - **Problem:**
     - Code that reads a new column errors until the migration lands, and the deploy and the migration "start from the same push and neither waits for the other" (`codebase-infra.md` §1).
     - `getSessionUser` (`apps/platform/src/server/auth/session.ts:78`) calls `prisma.user.findUnique({ include })` with no `select`, so it selects every User column. Once the release build, with `department`, `workingOn`, `discordUserId` and `discordUsername` in the client, goes live, every signed-in request fails until migrations finish.
     - `.github/workflows/migrate.yml` installs dependencies and a PG 17 client and runs `pg_dump` before it migrates. JackRoom and JackMessage reads break the same way.
     - If any of the dozen or so jack-2 migrations fails in prod (the pg_cron guard, an RLS block), the outage lasts until someone rolls back.
   - **Fix:**
     - Add a release step: freeze the jack-2 migrations, run `migrate.yml` by `workflow_dispatch` on the `jack-2` ref (or merge a migrations-only PR to main) and confirm it succeeded before merging jack-2 into main. Every change is additive, so current main keeps working.
     - Rehearse first by running `prisma migrate deploy` on `lsr_eval` (a prod copy that already has main's later migrations).
     - Put both in the build-log pre-merge checklist.

3. **Major · §3 access rules, §3.2, §3.7, §3.8, §3.10, §3.12, §3.13. The RLS list names tables that don't exist and misses tables that hold personal data.**
   - **Problem:** §3.8 puts RLS on `DiscordMember` and `DiscordPollVote`, and neither is defined. By the design's own rule, these tables also hold personal data:
     - **`JackFile.text`:** sign-in sheets, LSC application spreadsheets, and the meeting transcript. `Meeting.transcriptFileId` points there, so §3.13's RLS on Meeting doesn't cover the raw transcript.
     - **EmailEvent:** the Resend payload carries `to: ["member@utexas.edu"]`. `resend.md` §4 step 7 says to copy the RLS tail, and §6 says to drop the IP and user agent from click events.
     - **`ExternalDocument.text`:** Drive and SharePoint sheet exports. `microsoft-graph.md` calls this "UT data about students".
     - **SponsorActivity:** RLS is mentioned only in the §3.12 heading, which reads as SponsorProspect only.
     - **`JackProposal.payload` and `before`:** `import.rows` carries application rows with emails and EIDs.

     Locally, anon and authenticated get privileges on new public tables, and incident #109 shows grants can drift.
   - **Fix:**
     - Replace the prose with an explicit G1 list: DiscordMessage, JackFile, EmailEvent, ExternalDocument, TeamsMessage (see finding 5), SponsorProspect, SponsorActivity, Meeting and JackProposal.
     - Either define DiscordPollVote or drop the name.
     - Extend `scripts/check-jack-sql-role.ts` to assert, for each listed table: `relrowsecurity` is on, the `jack_readonly_select` policy exists, and anon/authenticated have no privileges.

4. **Major · §3.1, §4.1 step 3, §3.8, §3.11. Outbound side effects have no in-flight state, so retries can double-send.**
   - **Problem:**
     - **Proposals:** `applyJackProposal` locks the row `FOR UPDATE`, applies, then sets APPLIED. That means Resend, Discord or Instagram calls run inside an interactive transaction (Prisma's default timeout is 5 s) while holding a row lock. A timeout rolls back the status after the side effect already happened, so a retry applies it again.
     - **DiscordPost:** it goes straight from SCHEDULED to SENT, with no SENDING state, no claim and no nonce. `discord.md` W1: `nonce` (25 characters or fewer) plus `enforce_nonce` makes retries idempotent. The uuid id is 36 characters, so a separate column is needed.
     - **InstagramPublish:** it has no container id. `instagram.md` 3f: `media_publish` is "Not idempotent. If the call times out, read the container's status_code".
     - The repo already has this pattern: `ApplicationEmail.claimedAt` plus `idempotencyKey`, and `failInterruptedEmails`.
   - **Fix:**
     - **Proposals:** add an `APPLYING` status and a `claimedAt` column. Claim the proposal with a conditional update in a short transaction, run `apply` outside it, then write APPLIED or FAILED. A sweep turns old APPLYING rows into FAILED with a "check before retrying" note.
     - **DiscordPost:** add `SENDING`, `claimedAt` and `nonce String? @db.VarChar(25)`.
     - **InstagramPublish:** add `containerIds Json`, a status that includes the container and publishing stages, and `claimedAt`.

5. **Major · §3 overall vs #188. "All new tables in groundwork", yet several needed tables are missing.**
   - **Problem:**
     - **Teams channel messages:** §7's `teams` tool searches "synced Teams channel messages", but there's no model for them. There's also nowhere to keep Graph change-notification subscriptions. `microsoft-graph.md` §5 allows polling only once a day, so live sync needs subscriptions with lifecycle URLs, and deletes must be purged.
     - **Meeting transcripts:** #188 asks for them. The recommended low-privilege path (`microsoft-graph.md` 3h) lands transcripts as SharePoint files, which become ExternalDocument rows, but `Meeting.transcriptFileId` can only point at a JackFile.
     - **Site traffic:** §2 fetches it live, but on Hobby the API sees only one month (`vercel-analytics.md`), and the research's plan is a daily snapshot table. Every day that isn't snapshotted is lost for good, and the API's buckets are in UTC.
     - **Twitch token:** the user refresh token rotates and must be stored, kept away from `jack_readonly` (`twitch.md` §2). That contradicts principle 8 and "nothing here holds secrets". The second Instagram publish token (`instagram.md`) has the same problem.
   - **Fix:**
     - Add `TeamsMessage` (with RLS) and `GraphSubscription`, or explicitly drop Teams reading and its tool.
     - Add `Meeting.transcriptDocumentId` next to `transcriptFileId`.
     - Add `SiteTrafficDaily` and snapshot it daily.
     - Store the Twitch refresh token under the `SystemSetting` key `twitch` and the publish token under `instagram_publish`. SystemSetting is already revoked from Jack. Update principle 8 and §3 to say so.

6. **Major · §3.8 and §10 (Discord sync). Edits and deletes never reach our copy.**
   - **Problem:**
     - Paging "with `after`" can't see edits or deletes (`discord.md` §6). `editedAt` and `deletedAt` will never be set, so messages members deleted live on and are served to Jack.
     - That conflicts with the Developer Terms §5 deletion duties.
     - Account deletion is a hard delete (`apps/platform/src/app/account/actions.ts:66`), so `DiscordMessage.userId` is left pointing at nobody.
   - **Fix:**
     - Add `lastRescanAt` (or a rescan cursor) to DiscordChannel and `lastSeenAt` to DiscordMessage.
     - Re-scan a trailing 7-day window and mark missing ids deleted. On delete, purge `content` instead of only setting `deletedAt`.
     - Make `userId` a relation with `onDelete: SetNull`, and add a retention window.
     - Fix `DiscordPost.dedupeKey` so a rescheduled event still gets reminders: include the event start time in the key, or update SCHEDULED rows when the event moves.

7. **Minor · §3.14 vs §3.5. A recurring question's schedule lives in two places.**
   - **Problem:**
     - `RecurringQuestion.schedule` and `lastRunAt` duplicate the `recurring:<id>` ScheduledJob row, and no foreign key links them. Different tracks own each side.
     - Editing a question through `recurring.upsert`, or deleting it, leaves the job stale or orphaned.
     - `createdById` is required, has no relation, and means "runs as". The question keeps running as an officer who left or deleted their account.
   - **Fix:**
     - Make ScheduledJob the only place the schedule lives: `RecurringQuestion.scheduledJobId @unique`, with create, edit and delete done in one transaction.
     - Make `createdById` a nullable relation with `SetNull`. The dispatcher disables the question when its creator is gone or no longer an officer.
     - Make `roomId` a relation.

8. **Minor · §3.2 and §3.15. File links are recorded twice.**
   - **Problem:**
     - Both `JackFile.messageId` and `JackMessage.fileIds String[]` record which files a message carries.
     - Prisma emits `ADD COLUMN "fileIds" TEXT[]` with no default (verified), so existing rows get NULL. Prisma's list filters (`isEmpty`, `has`) skip NULL rows.
   - **Fix:**
     - Drop `fileIds`. Make `JackFile.messageId` a relation (`SetNull`) and add `position Int`.
     - Give every scalar list `@default([])`, including the `tags` columns on KnowledgeEntry and KnowledgeEntryVersion.
     - Add `@@index([status, createdAt])` and a cleanup job for UPLOADING or never-attached files. Otherwise their private blobs, which hold personal data, are orphaned.

9. **Minor · relations and onDelete across §3.**
   - **Problem:**
     - None of the new models has a relation to User: `proposedForId`, `decidedById`, `uploadedById`, `ownerId`, `byId`, `editedById`, and `JackFeedback.userId`. Recent Jack tables do use them (`JackDeck.createdById` → User, `SetNull`).
     - Because account deletion is a hard delete, ids that drive behaviour dangle: `ActionItem.ownerId` (for "what's on my plate") and `SponsorProspect.ownerId`.
     - JackRoom is missing the back-relations Prisma requires for JackProposal and JackFile (`proposals JackProposal[]`, `files JackFile[]`).
     - `JackFeedback.messageId` should cascade on delete.
   - **Fix:**
     - Use optional relations with `SetNull` for user ids that drive behaviour, never required or Restrict, so account deletion is never blocked (compare the `ApplicationReview` comment).
     - Keep plain ids for audit-only fields.
     - Add every named User back-relation in G1 so tracks never need to edit User.

10. **Minor · §3.10 EmailEvent.**
    - **Problem:**
      - There's no `recipient` column, which `resend.md` §4 lists, yet the `email_delivery` tool answers "for a recipient".
      - The join targets have no index: `Notification.emailMessageId` and `ApplicationEmail.resendMessageId` (see `schema.prisma` around lines 826–855 and 1195–1216).
      - There's no pruning, though the privacy page promises at most one year of delivery logs.
    - **Fix:**
      - Add `recipient`, `@@index([recipient, occurredAt])` and `@@index([type, occurredAt])`.
      - In G1, add `@@index([emailMessageId])` on Notification and `@@index([resendMessageId])` on ApplicationEmail.
      - Strip the click IP and user agent before storing, and prune at 12 months.

11. **Minor · §6 and §3, pg_cron and pg_net.**
    - **Problem:**
      - **Bearer secret:** §6 sends `Authorization: Bearer <secret>` through pg_net. Any login role, `jack_readonly` included, can read queued headers in `net.http_request_queue` (verified locally, `supabase-pg-cron.md` §6.1). The research recommends an HMAC of timestamp plus body, keyed with a dedicated `SCHEDULER_SIGNING_SECRET`. The Vault names also differ from the research (`jack_cron_secret` vs `lsr_scheduler_secret` / `lsr_scheduler_url`). Never reuse `CRON_SECRET`.
      - **Self-check:** §6 points to `codebase-infra.md` §2, which says to add `net` to the `jack_readonly` USAGE self-check. `net` has PUBLIC usage that can't be revoked, so that check always fails. Check `cron` and `scheduler` only.
      - **run_sql guard:** once pg_net is installed, the only thing stopping `SELECT net.http_get('…' || data)` exfiltration is the READ ONLY transaction (`src/server/jack/tools/run-sql.ts:433`). `OFF_LIMITS_NAMES` (line 71) doesn't list the pg_net names.
      - **Ungated tick:** the design calls the route every minute whether or not anything is due.
    - **Fix:**
      - Sign the tick with HMAC under its own secret.
      - Keep `net` out of the self-check.
      - Add `http_get`, `http_post`, `http_delete`, `http_request_queue`, `_http_response`, `vault` and `cron` to `OFF_LIMITS_NAMES`, with tests.
      - Put the SQL-gated `scheduler.tick()` inside the guarded migration (it holds no secrets). Leave only the Vault values and `cron.schedule` to the setup script.

12. **Minor · §12 migration ranges.**
    - **Problem:**
      - G2–G7 run in parallel and share `20261023…` with G1. The repo uses round times, so two of them can pick the same folder name.
      - Jack bug fixes keep landing on main. A main migration dated Oct 23–24 falls inside jack-2's ranges, and later ones sort after every jack-2 migration even though prod applies them first. Fresh databases and prod then apply in different orders, and local `migrate dev` may report a diverged history.
      - The ranges don't stop `schema.prisma` conflicts, since tracks still edit it and User gets back-relations.
    - **Fix:**
      - Give G2–G7 their own sub-ranges.
      - Never edit a migration after it merges into jack-2.
      - Before release, since nothing is applied in prod yet, consider squashing all jack-2 migrations into one, timestamped after main's latest. Then rehearse it on `lsr_eval` (finding 2).

13. **Minor · §3.8, §3.9, §3.11 daily tables.**
    - **Problem:**
      - The `@db.Date` keys don't say which day they mean. Club activity runs 7–10 pm CT, which is the next day in UTC, and Vercel's buckets are UTC.
      - `InstagramAccountDaily.profileViews` relies on a metric deprecated on 2025-01-08 (`instagram.md` 3a).
    - **Fix:**
      - Define every daily table's date as the America/Chicago date, written through one helper, and note it in the schema notes.
      - Instagram daily columns: followers (from `followers_count`), reach, views, accountsEngaged, totalInteractions, follows and unfollows. Drop `profileViews`.

14. **Minor · §3.7 ExternalDocument.**
    - **Problem:**
      - `sizeBytes Int?` overflows for files over 2 GiB (Drive's `size` is int64).
      - SharePoint item ids are unique only within a drive, and private or shared channels have their own sites and drives.
      - The `deletedAt` soft delete keeps the text of removed files, but the research says to purge it.
    - **Fix:**
      - Use `BigInt`, or skip such files before insert.
      - Use `driveId!itemId` as the external id, or add `driveId` to the unique key.
      - Null `text` on delete.
      - Add `version` or `eTag` for change detection.

15. **Minor · §3.6 and §3.5 connector and job status rows.**
    - **Problem:**
      - `ConnectorState.enabled` defaults to true, but §10 says Graph is disabled by default.
      - `lastError` (on ConnectorState and ScheduledJob) and `ScheduledJobRun.error` are readable by Jack's SQL role. Raw errors can carry credentials: the Instagram Graph API accepts `access_token=` in the query string, and a Teams Workflows URL is itself the secret. Instagram's `lastError` lives in the revoked SystemSetting today.
      - Nothing is pruned (ScheduledJobRun, TwitchViewerSample).
    - **Fix:**
      - Seed `('teams', false)` and `('sharepoint', false)` rows with `ON CONFLICT DO NOTHING`.
      - Run errors through a tested `safeError()` that strips URLs, query strings and tokens before writing.
      - Add a G3 prune job with a window per table, plus an index on `ScheduledJobRun(startedAt)`.

## Keep
1. **Additive-only changes.** Only new tables and nullable or defaulted columns: no renames, no drops, no new values on existing enums. That is what keeps "migrate first, then merge" safe.
2. **Synced copies with idempotency keys built in:** `EmailEvent.svixId @unique`, `DiscordPost.dedupeKey @unique`, the composite primary keys on TwitchViewerSample and DiscordDailyStat, and `@@unique([source, externalId])`. History survives the providers' retention limits, and tokens stay away from Jack.
3. **The RLS plus `jack_readonly_select` pattern copied from `add_recruiting`, and secrets kept out of `public` and `cron.job`.** Secrets stay in Vault, and the cron schedule is a setup step, not a migration.
4. **One pg_cron tick plus a ScheduledJob table.** It claims jobs with a conditional update on `lockedUntil`, computes cron times in America/Chicago in app code, and creates the extensions in a migration guarded for the shadow database.
5. **JackProposal's design:** it stores a `before` snapshot, a payload with only the changes, `checkStale`, the applying officer's permissions, and audit metadata (`via: "jack"`, `proposalId`).