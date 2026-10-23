# Jack 2.0 design (v2)

The plan for everything in #188, written for the people and agents building it: read this before touching code.
- **Background:** facts about this repo are in `docs/jack-2/research/codebase-*.md`, outside APIs in `docs/jack-2/research/<service>.md`, and how Jack works today in `docs/jack.md`.
- **Revisions:** v2 folds in the API research and a six-lens design review (data model, security, platform, completeness, agent UX, build plan). Changes to this document are logged in `build-log.md` under Decisions.

---

## 1. Principles (binding)
1. **Officers approve every change and every post Jack writes.** Jack *proposes*; an officer presses Apply. There are two exceptions, each fenced in:
   - **Standing automations an officer sets up** (event reminders and the like). They post **fixed templates over our own data**, never text a model writes at send time.
   - **Knowledge entries.** Jack saves them directly, but only in a reply to a message an officer typed, with the limits in section 9.
2. **Jack never moves money.** No tool or proposal creates charges, refunds or payouts.
3. **The website is the only way to talk to Jack.** Discord and Teams receive posts. Nothing reads a Discord or Teams message as an instruction.
4. **Every room is shared with all officers.** No private rooms.
5. **Outside content is data, not instructions.** That covers web pages, documents, Discord and Teams messages, emails, uploaded files and synced records. Nothing Jack reads can cause a change, a post, a fetch of an outside URL, or a knowledge save without an officer in the loop. Section 14 lists the specific guards.
6. **Jack cites sources:** a link to the room message, document, page, post or record.
7. **Jack is never the only way to see information.** Every source has a place in the admin console (section 13).
8. **Credentials live in env (Vercel) or in `SystemSetting` rows.** `SystemSetting` is revoked from Jack's SQL role, and every key that holds a credential is listed in section 3.2. Nothing else stores a token. Error and summary columns pass through `redactSecrets()` (`src/lib/redact.ts`) before they're written. Cursors and configs must simply never contain tokens; they are NOT redacted, because redaction strips query strings and would break page tokens and Graph delta links.
9. **Outside keys are read-only or restricted** wherever the provider offers it. The exceptions are documented, for Gray's sign-off: Vercel's analytics token (section 12.5) and Resend's sending key (section 12.4).
10. **Budget:** $50/month in total. Automations (recurring questions and Jack-written digest summaries) get their own cap inside it, **$10/month**, so they can't use up the officers' share.
11. **Everything works locally against fakes,** and every outside service is switchable. When a service is missing or switched off, its tools say "not connected" and the app keeps working. **Connectors ship switched off** and are turned on one at a time once their smoke test passes.

---

## 2. Architecture
```
src/server/jack/                 the reply loop, prompt and tools (existing), plus:
  proposals/                     the proposed-change framework: registry, claim/apply, staleness, kinds/<track>.ts
  files/                         room files: storage, registration, model copies, extraction
  knowledge/                     knowledge base service and search
  search/                        unified full-text search across sources
  tools/<area>.ts                new tools (section 7)
  prompt-sections/<track>.ts     prompt text and admin-page lines per track
src/server/connectors/           outside services, shared by Jack and the admin pages
  types.ts, registry.ts          the Connector interface, status, switches
  <service>/client.ts, fake/     a real HTTP client and an HTTP fake (section 12)
  <service>/sync.ts              scheduled jobs
src/server/scheduler/            job registry (jobs/<track>.ts), dispatcher, run log
src/server/automation/           digest checks (checks/<track>.ts) and recurring questions
src/app/api/cron/tick            called by pg_cron when something is due (HMAC-signed)
src/app/api/admin/jack/run       hand-off route for long jobs (300 s, Chromium traced)
src/app/api/webhooks/<svc>       twitch, resend, graph (+ graph lifecycle), stripe events go to the existing /api/stripe/webhook
src/app/api/admin/jack/files/... upload token, register, serve
```

### 2.1 Storage: Jack's files move to Supabase Storage
- **The problem:** Vercel Blob on Hobby includes **2,000 write operations a month**, shared by every Blob user in the project, and going over locks Blob for up to 30 days (`research/vercel-blob-client-upload.md`). Each deck slide render writes about 5 blobs today.
- **The decision:** `jackFileStore` gains a **Supabase Storage** backend (private bucket `jack`, service-role key on the server). It becomes the default for deck renders, exports, screenshots and room files. The Blob backend stays as code for a later move to Pro.
- **Why Supabase:** it has no per-operation cap and supports signed upload URLs (`createSignedUploadUrl` / `uploadToSignedUrl`) for direct browser uploads, which also removes the need for `BLOB_WEBHOOK_PUBLIC_KEY`.
- **To verify in G5:** Free-plan storage size (expected 1 GB) and the per-file limit. Pruning old renders (re-renderable caches) keeps usage in bounds; there's a prune job.
- **Release step:** copy the existing `jack/assets/*` (stored screenshots that slides reference) from Blob to Supabase.

### 2.2 Plug-in slots and extension points (so parallel work doesn't collide)
**One file per track for every shared registry.** Each starts empty in G1:
- `tools/registry/<track>.ts`
- `prompt-sections/<track>.ts`, exporting `{ section, pages[] }`
- `tools/schema-notes-slots/<track>.ts`
- `proposals/kinds/<track>.ts`
- `proposals/import-targets/<track>.ts`
- `scheduler/jobs/<track>.ts`
- `connectors/slots/<track>.ts`
- `connectors/fakes/slots/<track>.ts` (HTTP fakes, added in G2)
- `automation/checks/<track>.ts` (digest and Overview "needs attention" checks)
- `app/admin/_overview/cards/<track>.tsx`
- `scripts/jack-eval/<track>.ts`
- `docs/jack-2/tracks/<track>.md` (each track's docs and env notes, folded into `docs/jack.md` once at the end)

**Extension points G1 adds to shared components:**
- a composer attachment slot and a per-message actions slot in `room-view.tsx`;
- the full room event union in `src/lib/jack/types.ts` and the reducer cases;
- a tab registry for the Knowledge page;
- a section registry for the Instagram page.

**G1 also:**
- pre-adds all new dependencies;
- writes the whole schema (section 3);
- writes every interface type (`ProposalKind`, `JobKind`, `Connector`, `DigestCheck`, `ImportTarget`, `OverviewCard`, `PromptSlot`, `EvalSlot`).

Tracks fill slots. A track that must touch a shared file says so in its PR and keeps the change minimal.

---

## 3. Data model

### 3.1 Rules
- **Additive only:** new tables, plus nullable or defaulted columns. No renames, no drops, no new values on existing enums. Main keeps working with every 2.0 migration applied, and that's what lets migrations go to prod before the code (section 17).
- **Where it's defined:** G1 writes the whole 2.0 schema below into `schema.prisma`, plus the migrations. A track that finds it needs a change adds a small migration (section 18.3).
- **User references:** only behaviour-driving user fields are relations (optional, `onDelete: SetNull`, never Restrict, so account deletion is never blocked): `KnowledgeEntry.ownerId`, `ActionItem.ownerId`, `SponsorProspect.ownerId`, `RecurringQuestion.createdById` (who it runs as), `JackFeedback.userId`, `DiscordMember.userId`. Everything else (created by, decided by, uploaded by, approved by) is a plain id, loaded for display and shown as "former officer" when the user is gone. Every back-relation on `User` and `JackRoom` is added in G1.
- **Lists:** every scalar list has `@default([])`.
- **Daily tables:** every daily table's `date` is the **America/Chicago** date (helper `chicagoDay()` in `src/lib/dates.ts`), except `SiteTrafficDaily`, which keeps Vercel's UTC day and says so. The schema notes record which.
- **Full-text search lives in one side table, `JackSearchDoc`** (`source`, `sourceId`, `search` tsvector with a GIN index; declared in `schema.prisma` so Prisma never drops it):
  - Triggers on JackMessage (`room_message`), KnowledgeEntry (`knowledge`), ExternalDocument (`document`) and TeamsMessage (`teams`) upsert and delete its rows; inputs are capped at 100k characters; existing room messages are backfilled.
  - Room messages are indexed only once they're not streaming, and only when text or status changed.
  - **Why a side table:** Prisma can't deserialize tsvector, so a tsvector column on a table breaks `run_sql`'s `SELECT *` (Jack 1.x's too, since migrations reach production first). No table Jack reads carries one.
  - It has RLS, no policy for `jack_readonly`, and no grant: `run_sql` gets "permission denied" and calls it off-limits, like `SystemSetting`. Search goes through the typed tools.
  - **Acceptance check for G1 and every PR:** `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <throwaway> --exit-code` reports no changes.

### 3.2 Access: RLS and secrets
- **Personal data (RLS plus the `jack_readonly_select` policy, copying the recruiting migration's tail).** The tables: JackFile, JackProposal, EmailEvent, ExternalDocument, DiscordMessage, DiscordMember, TeamsMessage, SponsorProspect, SponsorActivity, Meeting, MeetingDecision, ActionItem, KnowledgeEntry, KnowledgeEntryVersion. `JackSearchDoc` has RLS with no policy for Jack.
- **Check script:** `scripts/check-jack-sql-role.ts` gains a check that each listed table has `relrowsecurity` on and the policy present, and that anon/authenticated have no privileges.
- **Recruiting policies are tightened** (new migration, replacing the `USING (true)` policies on the recruiting tables):
  - Jack's role never sees DRAFT applications.
  - It never sees reviews, scores or decisions on an application whose applicant holds the officer or admin role. Rooms are shared, so an officer must never be able to read their own reviews through Jack.
  - **The audit log too:** `AuditLog` gets RLS, with a Jack policy hiding recruiting entries (APPLICATION, APPLICATION_TRACK, APPLICATION_EMAIL) whose target is an officer or admin; they carry review scores and decisions.
  - The `recruiting_pipeline` and `audit_log` tools apply the same rules.
- **Credentials:** env vars, or these `SystemSetting` keys: `instagram` (existing read token), `instagram_publish` (publish token), `twitch` (user refresh token and cached app token). `SystemSetting` is revoked from `jack_readonly`. A migration self-check RAISEs if `jack_readonly` can read it.
- **`run_sql` hardening:**
  - Add to `OFF_LIMITS_NAMES`: `http_get`, `http_post`, `http_delete`, `http_request_queue`, `_http_response`, `ts_rewrite` (anywhere), and the schemas `net`, `cron`, `vault`, `scheduler` (when schema-qualified), plus tests. `JackSearchDoc` is revoked from the role instead (migration `20261023030000`). pg_net's queue is readable by every role and that can't be revoked (`research/supabase-pg-cron.md` §6).
  - The self-check adds `cron` and `scheduler` (never `net`, whose PUBLIC usage can't be revoked).

### 3.3 Models
Types are abbreviated: every `id` is `String @id @default(uuid())` unless noted, timestamps are `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt`, and `*Id → User` means an optional relation with `SetNull`.

**Proposals**
- `JackProposal`:
  - id, roomId → JackRoom (Cascade), messageId?, kind, title, summary
  - payload Json, before Json?, targetType?, targetId?
  - status `JackProposalStatus`, claimedAt?
  - proposedForId, decidedById (plain ids), decidedAt?
  - result Json?, expiresAt, supersededById?, fileSha256?
  - indexes `[roomId, createdAt]`, `[status, createdAt]`, `[targetType, targetId]`, `[kind, targetType, targetId, status]`
- `enum JackProposalStatus { PENDING APPLYING APPLIED DISCARDED FAILED STALE SUPERSEDED }`

**Files**
- `JackFile`:
  - id, roomId → JackRoom (Cascade), messageId? → JackMessage (SetNull), position Int @default(0)
  - uploadedById → User, filename, contentType, sizeBytes Int, storagePath @unique, sha256?
  - kind `JackFileKind`, status `JackFileStatus`
  - modelCopyPath?, anthropicFileId?, pageCount?, width?, height?, text?, textStatus?, error?
  - indexes `[roomId, createdAt]`, `[messageId]`, `[status, createdAt]`
- `enum JackFileKind { IMAGE PDF SPREADSHEET CSV JSON TEXT DOCUMENT TRANSCRIPT OTHER }`
- `enum JackFileStatus { UPLOADING READY FAILED }`

**Knowledge**
- `KnowledgeEntry`:
  - id, title, body, tags String[] @default([])
  - sourceType `KnowledgeSource`, sourceUrl?, sourceNote?, sourceDate DateTime?
  - reviewedAt?, reviewedById → User
  - provenance Json? (room, message, and the outside sources read in that reply)
  - ownerId → User, createdById → User, updatedById → User, archivedAt?
  - indexes `[archivedAt, updatedAt]`, `[ownerId]`
- `KnowledgeEntryVersion`:
  - id, entryId → KnowledgeEntry (Cascade), title, body, tags @default([])
  - editedById → User, via ("admin" | "jack" | "seed"), roomId?, createdAt
- `enum KnowledgeSource { MANUAL JACK SEED }`
- **Age** = now − (reviewedAt ?? sourceDate ?? updatedAt).
- "Saved by Jack, not reviewed" = sourceType JACK and reviewedAt null.

**Officer profiles** (columns on `User`): `department String?` (values from the roster's `TeamId`: executive, business, community, competition, media, technology; plus `isBoard Boolean @default(false)`), `workingOn String?` (≤160).

**Scheduler and connectors**
- `ScheduledJob`:
  - key @unique, kind, schedule, enabled @default(false), config Json?, nextRunAt
  - lockedUntil?, lastRunAt?, lastStatus?, lastError?
  - createdById → User, updatedById → User
  - index `[enabled, nextRunAt]`
- `ScheduledJobRun`: jobId → ScheduledJob (Cascade), startedAt, finishedAt?, status, summary?, error?; indexes `[jobId, startedAt]`, `[startedAt]`
- `SchedulerHeartbeat`: id @default("tick"), lastTickAt, lastDispatchAt
- `ConnectorState`: id (connector id), enabled @default(false), lastSyncAt?, lastError?, lastErrorAt?, cursor Json?, updatedAt
- **Seed rows:** every connector, all `enabled=false`, inserted `ON CONFLICT DO NOTHING`.

**Documents**
- `ExternalDocument`:
  - source ("drive" | "sharepoint"), externalId, driveId?, name, path, mimeType, webUrl
  - modifiedAt, sizeBytes BigInt?, version?, text?, textStatus, syncedAt, deletedAt?
  - `@@unique([source, externalId])`; for SharePoint, externalId is `driveId!itemId`
  - On delete: set `deletedAt` **and null `text`**.

**Teams** (all behind the `teams` connector)
- `TeamsChannel`: id (Graph channel id), teamId, name, synced @default(false), deltaLink?, lastSyncedAt?
- `TeamsMessage`:
  - id (Graph id), channelId, replyToId?, authorAadId?, authorName
  - content (text, HTML stripped), createdAt, editedAt?, deletedAt?
  - index `[channelId, createdAt]`
- `GraphSubscription`: id (Graph subscription id), resource, expiresAt, clientStateHash, createdAt

**Discord** (no message content stored; see section 12.1)
- `DiscordChannel`: id (snowflake), name, type Int, parentName?, synced @default(false), lastMessageId?, lastSyncedAt?, rescanFrom?
- `DiscordMessage`:
  - id (snowflake), channelId, authorId, userId? → User, createdAt, editedAt?, deletedAt?
  - contentLength Int, attachments Int @default(0), isReply Boolean, poll Json? (question, answers, counts, expiry, finalized; no voters)
  - lastSeenAt; index `[channelId, createdAt]`
- `DiscordMember`: id (snowflake), username, displayName?, joinedAt?, roles String[] @default([]), userId? → User, firstSeenAt, lastSeenAt, leftAt?
- `DiscordDailyStat`: date @db.Date, channelId, messages, activeAuthors; `@@id([date, channelId])`
- `DiscordGuildDaily`: date @id @db.Date, memberCount, joinedCount Int?, leftCount Int? (not `left`: it's a reserved word in SQL)
- `DiscordRule`: id, kind, channelId?, config Json, enabled @default(false), cutoffAt (only acts on items after it), createdById → User, updatedById → User, timestamps
- `DiscordPost`:
  - id, source ("rule" | "proposal" | "admin"), ruleId?, proposalId?, channelId
  - content Json, dedupeKey String? @unique, nonce String? @db.VarChar(25)
  - status `DiscordPostStatus`, scheduledFor, claimedAt?, sentAt?, discordMessageId?, error?
  - createdById → User, approvedById → User, createdAt; index `[status, scheduledFor]`
- `enum DiscordPostStatus { SCHEDULED SENDING SENT FAILED CANCELLED }`
- `DiscordEventMirror`: eventId @id, discordEventId @unique, eventStartsAt, lastSyncedAt, interestedCount?
- `DiscordRoleRule`: id, roleId, condition, enabled @default(false), createdById → User
- **User columns:** `discordUserId String? @unique`, `discordUsername String?`, `discordLinkedAt DateTime?`

**Twitch**
- `TwitchStream`: id (stream id), startedAt, endedAt?, title, gameName?, peakViewers @default(0), avgViewers Float?, vodId?, vodViews?, vodViewsAt?
- `TwitchViewerSample`: streamId → TwitchStream (Cascade), at, viewers; `@@id([streamId, at])`
- `TwitchChannelDaily`: date @id @db.Date, followers Int?

**Stripe** (synced; section 12.3)
- `StripeBalanceDaily`: date @id @db.Date, availableCents, pendingCents, currency
- `StripePayout`: id (po_), amountCents, currency, status, arrivalDate, createdAt, method, failureCode?, syncedAt
- `StripeDispute`: id (dp_), chargeId, paymentIntentId?, amountCents, status, reason, evidenceDueBy?, createdAt, syncedAt
- `StripeRefund`: id (re_), chargeId, paymentIntentId?, amountCents, status, createdAt, syncedAt

**Email delivery**
- `EmailEvent`:
  - resendId, recipient, type, occurredAt
  - detail Json? (bounce subtype/reason, or click link only; no IP or user agent)
  - svixId @unique
  - indexes `[resendId, occurredAt]`, `[recipient, occurredAt]`, `[type, occurredAt]`
- **New indexes on existing tables:** `Notification @@index([emailMessageId])`, `ApplicationEmail @@index([resendMessageId])`
- **Pruned at 12 months.**

**Site traffic**
- `SiteTrafficDaily`: date @db.Date (UTC day, from Vercel), dimension ("total" | "path" | "referrer" | "country" | "device"), key, pageviews, visitors; `@@id([date, dimension, key])`

**Instagram**
- `InstagramAccountDaily`: date @id @db.Date, followers, reach?, views?, accountsEngaged?, totalInteractions?, follows?, unfollows?
- **New nullable columns on `InstagramPost`:** reach, likes, comments, saved, shares, views, insightsAt
- `InstagramPublish`:
  - id, deckId?, version?, slideIds String[] @default([]), mediaType ("IMAGE" | "CAROUSEL" | "STORIES"), caption
  - imageUrls String[] @default([]) (Cloudinary), containerIds Json?, status, claimedAt?
  - igMediaId?, permalink?, error?
  - proposalId?, createdById → User, approvedById → User, createdAt
  - statuses: queued | containers | publishing | published | failed

**Sponsors**
- `SponsorProspect`:
  - id, company, website?, contactName?, contactEmail?, contactRole?
  - stage, tierInterest?, ownerId → User, lastContactAt?, nextStep?, nextStepDue?, notes?
  - createdById → User, timestamps; index `[stage, updatedAt]`
- `SponsorActivity`: id, prospectId → SponsorProspect (Cascade), type, summary, occurredAt, byId → User, createdAt; index `[prospectId, occurredAt]`

**Meetings**
- `Meeting`:
  - id, title, kind, heldAt, agendaMd?, summaryMd?
  - transcriptFileId? → JackFile (SetNull), transcriptDocumentId? → ExternalDocument (SetNull)
  - roomId? → JackRoom (SetNull), createdById → User, timestamps; index `[heldAt]`
- `MeetingDecision`: id, meetingId? → Meeting (SetNull), text, decidedAt, knowledgeEntryId? → KnowledgeEntry (SetNull), createdAt
- `ActionItem`:
  - id, text, ownerId → User, dueAt?, status @default("open"), doneAt?
  - meetingId? → Meeting (SetNull), roomId?, createdById → User, timestamps
  - indexes `[status, dueAt]`, `[ownerId, status]`

**Automation**
- `RecurringQuestion`:
  - id, title, prompt, roomId → JackRoom (Cascade), persona @default("jack") ("jack" | "stand" only)
  - scheduledJobId @unique → ScheduledJob (Cascade), createdById → User, pausedReason?, lastRunAt?
  - timestamps
  - **The schedule lives only on the ScheduledJob.**

**Rooms**
- **New columns on `JackRoom`:** `pinnedAt DateTime?`, `answerMode String @default("always")` ("always" | "mention")
- **New columns on `JackMessage`:**
  - `authorLabel String?`: the asker's profile snapshot ("Technology Director · Technology · CS"), set when the message is posted and never changed afterwards
  - `expectsAnswer Boolean @default(true)`: false for officer messages in mention mode that don't mention Jack
- `JackFeedback`: id, messageId → JackMessage (Cascade), userId → User (Cascade), rating ("up" | "down"), note?, createdAt; `@@unique([messageId, userId])`
- `JackUsage` gains `job` values for automations (no schema change; it's a string).

---

## 4. Proposed changes

### 4.1 Lifecycle
1. **Propose.** A `propose_*` tool validates its input against the kind's schema and builds the proposal on the server: `describe()` writes the title, summary, diff rows and affected people. The model never writes these.
   - It snapshots `before` (only the fields in the payload), records `fileSha256` when built from a file, and saves a PENDING `JackProposal`.
   - A new proposal for the same kind and target in the same room marks older PENDING ones **SUPERSEDED**.
   - It returns a small `proposal` display: id, kind, title, counts and the first few diff rows, under the 256 KB Realtime limit.
2. **Card.** The room renders a proposal card.
   - It loads the full diff from `GET /api/admin/jack/proposals/[id]` (officer check) and reads its **live status from `JackProposal`**. The `proposal.updated` room event refreshes it.
   - `toolCalls` is never rewritten, which keeps the cached history stable.
   - **Long text** (pages, posts) shows a real diff of the changed lines, not before/after toggles.
   - **List kinds** (check-ins, imports, notification audiences) show a checkbox per row, so partial approval is possible.
   - **Links:** every outside link on the card shows its destination host.
3. **Apply** (any officer; `applyJackProposal(id, { selectedRows? })`):
   1. `requireOfficer()`, then check the kind's permission against the **applying** officer's roles, using the same rule as the admin page.
   2. **Claim** in a short transaction: `UPDATE … SET status='APPLYING', claimedAt=now() WHERE id=? AND status='PENDING' AND expiresAt > now()`. If no row is updated, report its current status.
   3. Outside any transaction:
      - re-validate the payload;
      - check `fileSha256` for kinds built from a file;
      - run `checkStale` (compares only the payload's fields against `before`).
      - If stale, mark it STALE with the reason.
   4. `apply()` runs with an **idempotency key derived from the proposal id**:
      - Discord: `dedupeKey proposal:<id>` plus `nonce`/`enforce_nonce`;
      - Resend: `Idempotency-Key`;
      - notifications: `proposalId` in metadata, checked before sending;
      - Instagram: an `InstagramPublish` row with the container ids saved before `media_publish`.
   5. Set APPLIED or FAILED with `result`: created ids and links, counts, the applied subset, or a redacted error. Write `createAuditLog` with the applying officer as actor and `metadata { via: "jack", proposalId, roomId, proposedFor }`. Revalidate paths.
   6. **Every final status posts a room note with a link:** "Dylan applied: Change GM 2's start time → /admin/events/…", "Couldn't apply: …", "Stale: GM 2 changed since this was proposed", "Discarded by Gray". History carries these, so Jack learns outcomes and never assumes them.
4. **Discard** (any officer): DISCARDED, with a note.
5. **Expiry is lazy:** a proposal past `expiresAt` (14 days) is treated as STALE when it's read or applied. A sweep job also turns APPLYING rows older than 10 minutes into FAILED ("check before retrying"), with no automatic retry.

### 4.2 Kind interface
```ts
type ProposalKind<P> = {
  kind: string                      // "event.update"
  schema: z.ZodType<P>
  targetType?: string               // AuditLog entityType
  permission: "officer" | "admin"
  list?: { rows(p: P): ProposalRow[] }          // enables per-row checkboxes
  prepare(p: P, ctx): Promise<{ before: unknown; view: ProposalView }>  // server-side describe, no writes
  checkStale(p: P, before: unknown): Promise<string | null>
  apply(p: P, ctx: { officer; proposalId; roomId; selectedRows?: string[] }): Promise<ProposalResult>
}
```

### 4.3 Kinds
| Kind | Input highlights | Track |
|---|---|---|
| `page.update` | `edits: [{find, replace}]` (exact, all or none, like `deck_edit`), or a title change. Calls the page service. **Ships in G4 as the reference kind.** | groundwork |
| `event.update` | Changes to an existing event's details, registration, attendance or status. Goes through the new `event.service` (section 4.4). | changes |
| `news.create` / `news.update` | **Markdown only:** JSX and HTML are rejected, because news renders as MDX. Shows a rendered preview. Publish choice: draft, schedule or publish now. | changes |
| `notification.send` | An **audience spec** the server resolves and snapshots: all members, registered for or checked in at an event, LSC drivers for a season, officers, or an explicit list. Plus channels, title, body, link and schedule. Checks the email daily limit. Partial approval. | changes |
| `results.import` | `{ fileId, eventId, sessionLabel, pointsSystem }`. Propose runs a **pure parse** (no DriverIdentity writes) and shows unmatched drivers. Apply runs upload, parse, bind and ingest. | changes |
| `attendance.checkin` | `{ eventId, names[] }`. The server matches names against registrations and members. The card shows matched, ambiguous and unmatched rows. Partial approval. | changes |
| `import.rows` | `{ fileId, target, columnMap }`. The server reads the rows. Targets come from `proposals/import-targets/<track>.ts` (LSC applications, prospects, action items). Partial approval. | changes (+ each target's track) |
| `discord.post` | An announcement or a poll, with an optional ping that's shown on the card. Template-checked: mentions and outside links are stripped unless the officer's text has them. | discord |
| `discord.rule` | Create or edit a standing automation (section 12.1). | discord |
| `instagram.publish` | Deck slides plus a caption; post, carousel or story. | decks-rooms |
| `gallery.add` | Deck renders or room images into an album. | decks-rooms |
| `prospect.upsert` / `prospect.activity` | Arrays allowed ("add these 8 prospects"). | sponsors-meetings |
| `meeting.record` | A meeting with agenda and summary, decisions (also written to the decision log) and action items. | sponsors-meetings |
| `action_item.update` | Arrays allowed. | sponsors-meetings |
| `recurring.upsert` | Title, prompt, room, persona (Jack or Stand), schedule (daily at most). Shows an estimated monthly cost. | automation |

`draft_event` stays as it is: it creates a DRAFT event. Standing Discord rules never fire on non-public events (section 12.1), so an injected draft can't reach Discord.

### 4.4 Refactors (behavior-preserving, their own PR, right after G1)
- `src/server/services/event.service.ts`: `updateEventDetails`, `updateEventStatus`, `updateEventRegistration` (keeps `reconcileEventWaitlist`), `updateEventAttendance`. The admin actions in `app/admin/events/actions.ts` call these, then redirect as before.
- `src/server/services/results.service.ts`:
  - `createUpload`;
  - `parseUpload({ write })`: the pure parse for previews, plus the current writing parse;
  - `bindUpload`;
  - `ingestUpload`. The actions keep their `requireOfficer()` and call these.
- Page and news services that return results instead of throwing or redirecting.
- **Pinned by a golden-file DB check** (`scripts/check-results-service.ts`): real AC fixtures run through upload, parse, bind and ingest, with the rows diffed before and after the refactor. Plus unit tests and a browser check of each admin page touched.

---

## 5. Files in rooms
- **Upload flow:**
  1. The composer gets attach, paste and drop, for up to 10 files per message.
  2. The browser calls `createJackUpload({ roomId, filename, size, type })` (server action, `requireOfficer`). It validates the name, size and allow-list, creates the `JackFile` row (UPLOADING), and returns a signed upload URL for exactly `rooms/<roomId>/<fileId>/<sanitized-name>`.
  3. The browser uploads straight to Supabase Storage.
  4. `registerJackFile(id)`:
     - checks the object exists and its size matches;
     - **checks magic bytes against the declared type**;
     - computes the sha256;
     - makes a **model copy** (images: JPEG, EXIF stripped, long edge ≤2000 px, using `sharp`);
     - extracts text;
     - uploads PDFs and images to the **Claude Files API** (file id stored server-side only, never taken from the browser);
     - sets READY or FAILED.
  5. Posting a message links its READY files (`messageId`, `position`).
- **Allowed types:**
  - images: JPEG, PNG, WebP, GIF; HEIC/HEIF if G5 confirms a working decoder, otherwise refused with "export as JPEG";
  - PDF;
  - CSV, XLSX (no macros), JSON;
  - TXT/MD, VTT (transcripts), DOCX.
  - **Refused:** SVG, HTML/XHTML/XML, macro formats (.xlsm, .docm), archives and executables.
- **Limits:**
  - 25 MB per file (to confirm against the Supabase Free per-file limit);
  - parsers capped by uncompressed size (zip-bomb guard), row count and time;
  - XLSX through `exceljs`;
  - DOCX text through a maintained extractor (decided in G5), with the same zip caps;
  - PDF text (for search) through `pdfjs-dist` 6.x (no eval paths left in it; the old `isEvalSupported` option is gone). It's in `serverExternalPackages`; its worker file (`pdf.worker.mjs`) must be imported statically or added to `outputFileTracingIncludes`, or PDF text breaks on Vercel.
- **Serving:** `GET /api/admin/jack/files/[id]` (officer check) looks the file up by id, never by path.
  - Sends `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and `Cache-Control: private, no-store`.
  - Sends `Content-Disposition: attachment` for everything except raster images.
  - Files over 4 MB redirect to a short signed URL.
  - Thumbnails are made once at registration.
- **What Jack sees:**
  - The officer's turn carries each file's id, name, kind and size.
  - Images and PDFs go as Files-API `image`/`document` blocks, within caps: about 20 MB and 100 PDF pages per turn. Past the caps, extracted text is sent instead.
  - Text-like files get a short summary (first rows and headings).
  - Older attachments in history become a one-line note with the file id.
  - **`room_files read` returns image and document blocks again,** plus paged text (section 7.3), so Jack can always look again.
- **Officers' photos in decks:** `room_files` returns a `deckUrl` for each ready image: `https://jack.assets/room/<fileId>`. `resolveJackAsset` serves a downscaled JPEG after checking that the file belongs to the deck's room. `deck_assets` lists room images, and the design guide says room images may be used.
- **Transcripts** (from `.vtt`, `.docx` or `.txt`) are parsed into speaker-tagged text, which `meeting.record` uses. Section 12.8 has the other transcript paths.
- **Cleanup job:** files still UPLOADING after 24 hours, and files never attached after 7 days, are deleted, with their storage objects and Claude Files.

---

## 6. Scheduler
- **The tick** (from `research/supabase-pg-cron.md`):
  - `pg_cron` runs `scheduler.tick()` every minute. It's a SQL function in a new `scheduler` schema, with EXECUTE revoked from PUBLIC.
  - Every call writes `SchedulerHeartbeat.lastTickAt` locally (no HTTP), so the admin pages can tell a dead scheduler from an idle one. Beyond that it does nothing unless a `ScheduledJob` row is due. Times are compared with `now() AT TIME ZONE 'UTC'` (Prisma stores UTC in timestamp columns).
  - Deleting a recurring question (or its room) deletes its job, through a trigger.
  - When it calls, it POSTs through pg_net to `/api/cron/tick` with `X-LSR-Timestamp` and `X-LSR-Signature: v1=hex(HMAC_SHA256(secret, ts + "." + body))`.
  - The secret is `SCHEDULER_SIGNING_SECRET`: kept in Vault (`lsr_scheduler_secret`) and in Vercel env, separate from `CRON_SECRET`. `_PREVIOUS` is accepted while rotating.
  - The site URL is in Vault (`lsr_scheduler_url`): the exact canonical prod URL, because pg_net follows redirects and would turn the POST into a GET.
  - The secret never appears in a header.
- **The route:**
  - verifies the HMAC over the raw body, with a ±300 s window;
  - answers 202 with counts only (pg_net keeps responses readable for 6 hours);
  - dispatches in `after()`.
- **Dispatcher rules:**
  - Claim due jobs with a conditional update on `lockedUntil` (claim time + 300 s + margin).
  - At most 3 jobs at once. Stop claiming about 200 s after the request started, and claim only jobs whose time budget fits.
  - **Skip (don't claim, don't fail) job kinds the running code doesn't know.**
  - Compute `nextRunAt` from now, so missed runs don't pile up. Cron expressions are evaluated in America/Chicago with a maintained parser.
  - Mark orphaned `running` rows as errors when they're next claimed.
  - Errors go through `redactSecrets()`.
- **Long jobs hand off:** Jack runs (recurring questions, digest summaries), Drive and SharePoint backfills, and anything over about 60 s.
  - The dispatcher sends a signed self-POST to `/api/admin/jack/run` (maxDuration 300, inside the Chromium trace).
  - That route runs the job with its own `startedAt`. For Jack runs it calls `runRoom(roomId, deps, { startedAt: requestStart })`.
- **Housekeeping jobs (G3):**
  - prune `ScheduledJobRun` (90 days), `cron.job_run_details` (7 days), `TwitchViewerSample` (180 days) and old render caches;
  - the proposal sweep;
  - the file cleanup;
  - the heartbeat (the Connections page shows when the scheduler last ran).
- **Migrations:**
  - The extensions are guarded: skip on Prisma's shadow database (`current_database() <> current_setting('cron.database_name', true)`), when `auth` is absent, and when `pg_available_extensions` lacks them.
  - `scheduler.tick()` is created in the migration; it holds no secrets.
  - The Vault values and `cron.schedule` are a **setup step** (`scripts/jack-scheduler-setup.ts` prints the SQL).
- **Local:** no pg_cron schedule. `pnpm jack:tick` runs due jobs once in the current worktree.
- **Existing GitHub Actions crons stay.** The cron-auth fix is on main as PR #190.

---

## 7. Tools, and the model loop

### 7.1 Tool set
**Always loaded (about 22):**
- today's core tools (with `club_members` gaining the profile fields);
- the deck tools;
- `search`, `read`, `knowledge`, `room_files`;
- the main `propose_*` tools: `propose_change`, `propose_content`, `propose_message`, `propose_import`;
- `draft_text`.

**Deferred behind tool search** (`defer_loading: true`; `tool_search_tool_bm25_20251119`, supported on all three models):
- service tools, named with a prefix so search finds them: `stripe_overview`, `email_delivery`, `site_traffic`, `instagram_insights`, `twitch_stats`, `discord_activity`, `discord_polls`, `recruiting_pipeline`, `race_performance`;
- `sponsors_list`, `meetings_list`, and the rarer `propose_*` tools (`propose_discord`, `propose_deck_publish`, `propose_meeting`, `propose_recurring`);
- `web_links`.

| Tool | Does | Track |
|---|---|---|
| `search` | One search over every full-text index: knowledge, documents (Drive and SharePoint), rooms, site content, Teams messages, and Discord (live; section 12.1). `sources` filter; typed results with links. Rooms default to officer messages and room notes; Jack's own replies only when asked, labelled "Jack's earlier answer (not a source)". | club-data (framework in G1) |
| `read` | Reads one result by type and id: knowledge entry, document, room message context, site page (our public pages only: paths matching `^\/(?![/\\])`, never `/admin`, `/api`, `/account` or `/auth`, fetched without cookies). Paged (section 7.3). | club-data |
| `knowledge` | save, update (`baseVersionId`), archive (only when an officer asks), with section 9's guardrails | memory |
| `room_files` | List and read this room's files: images and PDFs as blocks, text paged, `deckUrl` for images | groundwork (G5) |
| `propose_change` | event.update, page.update, action_item.update | changes |
| `propose_content` | news.create, news.update | changes |
| `propose_message` | notification.send | changes |
| `propose_import` | results.import, attendance.checkin, import.rows | changes |
| `propose_discord` | discord.post, discord.rule | discord |
| `propose_deck_publish` | instagram.publish, gallery.add | decks-rooms |
| `propose_meeting` | meeting.record, prospect.upsert, prospect.activity | sponsors-meetings |
| `propose_recurring` | recurring.upsert | automation |
| `draft_text` | An email draft, agenda or caption, returned as a copyable card. Never sends. | sponsors-meetings |
| `recruiting_pipeline` | Rounds; counts per team and status; applicants (filters: team, status, unreviewed = no reviews, in interview); reviewer load; score summaries. SUBMITTED only; section 3.2's officer-applicant rule applies. | club-data |
| `race_performance` | Best and average laps by driver, track and round; consistency (lap time spread); incidents (cuts and collisions); positions gained (qualifying vs race); season trend; head-to-head. States the data limits: no DNF, `classPosition` always 0. | club-data |
| `stripe_overview` | Balance, payouts, recent charges (Payment joined to Stripe charges), refunds, disputes, from the synced tables | sources-a |
| `email_delivery` | A send's delivery status, a recipient's recent mail, bounces | sources-a |
| `site_traffic` | Page views and visitors by page, referrer, country and device, from the snapshots | sources-a |
| `instagram_insights` | Account and post insights from the snapshots | sources-b |
| `twitch_stats` | Live now, streams (peak and average viewers), VOD views, followers | sources-b |
| `discord_activity`, `discord_polls` | Totals per channel, members over time, poll results (aggregate only) | discord-read |
| `sponsors_list`, `meetings_list` | Prospects and activity; meetings, decisions, action items (`owner: <handle>`; "mine" only when one officer asked in the turn) | sponsors-meetings |
| `web_links` | Returns URLs from earlier `web_sources` parts, so "open the second link" works (web_fetch only follows URLs already in context) | G8 |
| web search, web fetch | Server tools `web_search_20260209` and `web_fetch_20260209` | G8 |

**`officers` is dropped.** `club_members` gains department and "what I work on"; this is the one change allowed to a current tool.

### 7.2 Web search and fetch rules
- **On/off:** enabled by env `JACK_WEB_TOOLS=on` (the Console must allow them, or every request 400s). The tool list changes only when that flag does.
- **`web_fetch` `url_sources`:** follow only user messages and earlier web search/fetch results. **Every client tool's results are excluded**, so links inside data Jack reads (Discord, documents, recruiting portfolio links, run_sql rows) can't be fetched.
- **Limits:** a small `max_uses` per request, `max_content_tokens`, and a **per-reply cap** counted from `usage.server_tool_use` (then wrap-up).
- **Scheduled and recurring runs never get web tools** (their own tool set, decided per request type).
- **Prompt rule:** never put member data into a search query or a URL.

### 7.3 Output sizes and paging
- Every `read` takes `offset` and `maxChars` (default about 15k) and returns `nextOffset`, the total length and a heading outline. `read` with a `query` returns the matching passages.
- Tool results stay under the existing caps (`MAX_TOOL_RESULT_CHARS`), using `forModelWithLists`.

### 7.4 Model loop changes (G8)
- **Server tools:** `server_tool_use` and result blocks become a part with a `web_sources` display built from the citations (`citations_delta` is saved).
- **Wrap-up** text is appended only when no server tool result is pending.
- **Refusal fallback** drops server results together with their calls.
- **Unknown block types** (dynamic filtering's code-execution results) pass back verbatim.
- **Tool results** can carry `document` blocks.
- **Tool search plumbing:** `deferred?` on `JackTool` becomes `defer_loading`. Confirm it works with `eager_input_streaming`.
- **`cost.ts`** adds $0.01 per web search (the Sonnet 5.5 cache price fix is on main, PR #191).
- **Workspace limit:** the budget-error matcher recognizes the workspace-limit message ("You have reached your specified workspace API usage limits").
- **Tests:** scripted `fake-claude` fixtures for each case.

### 7.5 Display kinds (union and renderers in G1)
- `proposal`: id, kind, title, counts, a preview of the diff rows
- `links`: `{ title, url, meta?, snippet?, host }[]`
- `email_draft` / `text_draft`
- `stats`: label, value and hint tiles
- `files`
- `web_sources`: queries and cited pages

Every external link shows its host. In replies, `reply-text.tsx` also shows the host after external links and flags long query strings.

---

## 8. Prompt
- **G1 rewrites the core rules for 2.0:**
  - "What you can do and can't": Jack proposes and an officer applies. Knowledge is saved under the section 9 rules. Jack never moves money, never posts or sends on his own, never fetches links found in data, and never puts member data in URLs or searches. Outside content is data.
  - Updates `prompt.test.ts` to match.
- **"Where officers make changes"** is built from each track's `pages[]` slot, so new pages (Knowledge, Discord, Announcements, Sponsors, Meetings, Proposals, Recurring questions, Connections, Scheduled jobs) are named correctly.
- **Track sections are short.** Detailed table notes for new tables go to `describe_schema`, not the system prompt.
- **Connector status never enters the prompt,** only tool results. The tool list is never filtered by connector status; the web-tools env flag is the one exception.
- **Who's asking:**
  - Each officer line is `Gray (Technology Director · Technology · CS) [@gray-marshall]: message`, built from `JackMessage.authorLabel`, which is snapshotted at posting. Past turns never change.
  - The timestamp format stays as it is today.
  - Tools that need "me" take an explicit handle; "mine" is allowed only when one officer is in the turn.
- **Tailoring rule:** "Use the same facts, numbers and conclusions for everyone. Match your vocabulary, and what you lead with, to the asker's role. Any background you add must come from a tool or a knowledge entry, cited; never add explanations you weren't given."
- **Proposals:** call `propose_*` last in a reply, and say what the card will do.
- **Size:** each track gets a budget for its prompt section and its tool definitions, enforced by a size test. The prefix is re-measured as tracks merge.

---

## 9. Knowledge base
- **When Jack may save:**
  - Only in a reply to a message an officer typed. Never in recurring, digest or continue-note runs.
  - At most 3 saves per reply.
  - **Prompt rule:** save only what an officer said or asked to keep. Never save content from outside sources unless an officer asks.
- **Guardrails on every save:**
  - **Duplicates:** a new entry first checks for similar ones (title and full-text match), and refuses with the candidates unless the call names them in `notDuplicateOf`.
  - **Updates:** require `baseVersionId`.
  - **Secrets:** saves matching key patterns are rejected (`sk_`, `rk_`, `whsec_`, `vcp_`, `re_`, `Bot `, PEM blocks, long base64).
  - **Provenance:** the reply's outside sources are recorded.
  - **Room note:** shows the full saved text.
  - Jack's entries are marked "saved by Jack, not reviewed" until an officer marks them reviewed.
- **Knowledge page:** search, create, edit, history, age badge, "not reviewed" filter, mark reviewed, archive, and **hard delete** (versions included).
- **Tabs** (from the tab registry): Documents (Drive and SharePoint) and Teams messages.
- **Age:** Jack mentions an entry's age when it's over 180 days old, counted from reviewed, source or updated date.
- **Seed:**
  - **The repo is public, so seed content is never committed.** Drafts live in a private folder outside the repo (default `~/.lsr/jack-knowledge-seed/`), one entry per `.md` file with front matter: title, tags, sourceNote, sourceDate, owner. Only the README describing the format is in the repo (`docs/jack-2/knowledge-seed/README.md`).
  - They're drafted from Teams posts, the Drive folder and repo docs.
  - A lint step rejects emails, keys and tokens.
  - Gray reviews them in one pass, recorded in `build-log.md`.
  - `scripts/jack-knowledge-seed.ts --dir <folder>` loads them (sourceType SEED, reviewedAt = sign-off date) only with `--approved`, against the database `DATABASE_URL` points at (production loading is a release step Gray runs).
  - **Coverage checklist** (from #188): the club; who does what (with officer profiles); decision log (one entry per decision, tag `decision`); policies; brand; sponsors; events playbook; recruiting; services and who holds access (names only); calendar rhythm.
  - Gray's private notes are never used.

---

## 10. Rooms
- **Archive and unarchive:** actions with an audit entry and a room note. An Archived filter on the rooms list, and a read-only view for archived rooms.
- **Message anchors:** `?m=<id>` loads the messages around the target, which room search needs.
- **Pin:** pinned rooms sort first.
- **Mention mode** (`answerMode: "mention"`):
  - The server parses `@Jack` (or the persona's name). Officer messages without a mention get `expectsAnswer=false`: they don't start a run, aren't in `findUnanswered`, and don't trigger the stall bar.
  - The next mention's reply takes every waiting message as its turn, as context, and the prompt says to answer only what's addressed to Jack.
  - Tests in `room-state.test.ts`, `history.test.ts` and `reply-loop.test.ts`.
- **Feedback:** thumbs up or down plus an optional note on replies. Thumbs-down answers feed eval candidates.
- **Usage page** (`/admin/jack/usage`): cost by month, persona, officer and automation; feedback; common questions.

---

## 11. Automation

### 11.1 Recurring questions
- **The schedule lives only on the ScheduledJob,** created, edited and deleted in one transaction through `recurring.upsert` or the admin page. Daily at most. Jack or Stand only. **Off by default.**
- **Each run:**
  1. The dispatcher hands off to `/api/admin/jack/run`.
  2. The route checks that the creator is still an officer. If not: pause, with a note.
  3. It checks the $10 automation cap. If it's hit: skip, with a note.
  4. It posts an **answerable system note** with `authorUserId` set (like `leaveContinueNote`), shown as "Recurring question 'Weekly signups' (set up by Gray): …".
  5. It runs the room with a short history (the question and its last answer), no web tools and no knowledge saves.
  - If the room lock is held, it retries a few minutes later.

### 11.2 Weekly digest
- **Deterministic checks rendered from a template.** The checks come from `automation/checks/<track>.ts`; the Overview "needs attention" card uses the same code. The checks:
  - pending and stale proposals;
  - overdue action items by owner;
  - quiet prospects;
  - results not uploaded;
  - draft events and events with low registration;
  - bounces;
  - unreviewed applications;
  - failing jobs or connectors;
  - knowledge not reviewed or stale.
- **Where it goes:**
  - The room gets the full template, plus an optional short Jack-written summary (counted toward the automation cap).
  - **Discord and Teams get counts and links into the console only:** no personal data, no outside text, `allowed_mentions` empty.
- **Off until an officer configures it** (room, channels, Teams on or off). Who configured it is recorded.

---

## 12. Outside services
Each connector implements `Connector` (`connectors/types.ts`): `id`, `label`, `requiredEnv`, `configured()`, `enabled()` (from ConnectorState, default off), `client()`, `smoke()` (an opt-in live check script), `status()` for the Connections page.

**Fakes are HTTP:**
- Every client takes a base URL from `serviceBaseUrl(service, realUrl)` (`connectors/base-url.ts`; an SDK that takes only a host uses `serviceFetch(service)`), not a `<SERVICE>_BASE_URL` per client as some research files planned. `JACK_FAKES` and `JACK_FAKES_URL` switch every client at once; fakes register in `connectors/fakes/slots/<track>.ts` (`tracks/groundwork.md`).
- `pnpm jack:fakes` runs one local fake server for all services, built from the research specs' fixtures, so the real SDKs (Stripe, Resend) and our own REST clients are exercised.
- Tests mount the same handlers through a fetch interceptor.
- `JACK_FAKES=all` points every client at the fakes locally.

### 12.1 Discord (`research/discord.md`)
**Reading**
- REST only, no gateway. Install permissions `580542407986176`. The **Message Content** and **Server Members** intents are switched on (no review under 10k users).
- **No message content is stored.** The sync (every 10 minutes, opted-in channels only, admin-only switch) records metadata only: author, time, length, attachments, reply, and polls with counts but no voters. It re-scans a trailing 7 days to mark deletions.
- **Daily stats:** `DiscordDailyStat` and `DiscordGuildDaily`, with members from the List Guild Members diff.
- **Search** uses Discord's guild message search API live, limited to opted-in channels. Results go to the model and aren't stored.
- **Why:** we keep no copy of members' words, so there are no deletion or retention duties beyond metadata, which is pruned after 12 months. Admin views show aggregates only (the Developer Policy bans profiling individuals).

**Linking accounts**
- OAuth2 `identify` with PKCE S256 and `state` bound to a signed session cookie. The token is revoked right after reading the id, and no tokens are stored.
- Relinking requires unlinking first. Unlink is on the profile, and the link is cleared when the account is deleted.

**Posting**
- Every send uses `allowed_mentions: { parse: [] }` unless the approved rule or proposal names a ping.
- Retries are idempotent with `nonce` + `enforce_nonce`. A `SENDING` claim prevents double sends.
- **Standing rules** (`DiscordRule`):
  - Kinds: event_reminder, new_event, results_posted, standings_update, twitch_live, event_mirror.
  - **Templates only.**
  - Fire only for events where `isEventPublic(event)` is true, never including `meetingUrl`.
  - Act only on items after `cutoffAt`, with a per-run cap.
  - Twitch titles have mentions and links stripped.
  - Reminder `dedupeKey`s include the event's start time, so a moved event gets new reminders. Pending posts for a moved or cancelled event are cancelled.
- **Event mirror:** creates and updates Discord scheduled events and reads back their interested counts.
- **Role sync:** hourly, for linked members, non-moderation roles only. The bot's role sits below admin roles. Every role change is audited.

**Privacy and terms**
- A Discord section on `/privacy`, and that URL set in the Developer Portal.
- A server privacy note, posted through a `discord.post` proposal, listing the synced channels.
- Deletion on request: an admin action purges a member's metadata and link.
- Written terms with service providers are noted for Gray (research §6).

### 12.2 Twitch (`research/twitch.md`)
- **Tokens:** an app token (client credentials, cached in SystemSetting `twitch`). One club-account OAuth grants `moderator:read:followers`; its rotating refresh token is stored in SystemSetting `twitch`, refreshed under a row lock and validated hourly. Env uses `TWITCH_BROADCASTER_ID`.
- **EventSub** `stream.online` and `stream.offline` webhooks on `/api/webhooks/twitch`:
  - HMAC verification over message id, timestamp and raw body, with a timing-safe compare;
  - a 10-minute timestamp window, deduped on message id;
  - the challenge is answered as plain text;
  - the callback is the exact prod host.
- **Viewers:** sampled every minute while live; one empty "Get Streams" result isn't trusted. VOD views and followers are snapshotted daily.

### 12.3 Stripe (`research/stripe.md`)
- **Key:** a restricted key with read on balance, payouts, charges, PaymentIntents and disputes. Every `*_write` is off.
- **Daily sync job:** balance, payouts (with their balance transactions), refunds, disputes. Stripe's read limits rule out frequent polling.
- **Webhook events:** `payout.*` and `charge.dispute.*` are handled in the existing `/api/stripe/webhook` and update the same tables. Adding them in the Stripe Dashboard is a setup step for Gray.
- Payment rows already carry the `pi_` id. SDK defaults are kept (pinned API version); the timeout drops to about 20 s.

### 12.4 Resend (`research/resend.md`)
- **Webhook** on `/api/webhooks/resend`, verified with `resend.webhooks.verify()` (Svix), deduped on `svix-id` into `EmailEvent`. Status is computed when reading, not from the order events arrive in.
- **Key:** no read API key is needed; the prod key stays send-only.
- **Constraints:** Free allows only one webhook endpoint (production). Previews and local use the fake. Open and click tracking stays off unless Gray turns it on (a privacy choice).
- **Admin surfaces:** a delivery column on Notifications, and on Recruiting → Emails.

### 12.5 Site traffic (`research/vercel-analytics.md`)
- **API:** Vercel's Web Analytics query API, through a client that allows only `GET /v1/query/web-analytics/visits/{aggregate,count}`.
- **Daily snapshot job** into `SiteTrafficDaily`, because Hobby keeps one month. Jack and the Overview card read the snapshots.
- **Exception for Gray's sign-off:** Vercel offers no read-only token. A project-scoped token (read and write) is used only by the snapshot job, with a short expiry and a renewal reminder. It's created by the account that owns the LSR team, and every prod env var is marked Sensitive.

### 12.6 Instagram (`research/instagram.md`)
- **Read:** the existing token gains `instagram_business_manage_insights` by reconnecting. A daily `InstagramAccountDaily` snapshot (followers from `/me` `followers_count`) and post insights hourly for recent posts. Account metrics expire after 90 days, which is why we snapshot.
- **Publish:** a separate token (`instagram_business_content_publish`), ideally from a second Meta app, in SystemSetting `instagram_publish` and refreshed weekly.
  - Slides are converted to JPEG and uploaded to Cloudinary for a public URL.
  - The container is created, its status polled, then `media_publish`; the status is checked before any retry.
  - `content_publishing_limit` is read at runtime.
  - Feed posts are 4:5 (our post size); stories are 9:16.
- **Policy questions for Gray:** Developer Policy §6.2 and AI-content labelling are unresolved (research).

### 12.7 Google Drive (`research/google-drive.md`)
- **Account:** a service account in a club-owned Cloud project; scope `drive.readonly`. The JWT is signed with `node:crypto` (no googleapis package).
- **Sync:**
  - The **changes feed** keeps the index current. On removal, the row is marked deleted and its text nulled.
  - Every file must sit under the root folder; anything else is ignored.
  - A weekly full re-walk reconciles.
  - An alert fires if the root returns 404.
  - Backfills hand off to their own invocations.
- **Text:** Docs export as text or markdown, the first tab of Sheets as CSV, Slides as text. PDFs, `.docx` and `.pptx` are extracted. Exports are capped at 10 MB.

### 12.8 Microsoft Graph: Teams and SharePoint (`research/microsoft-graph.md`; off until UT IT approves)
- **SharePoint:**
  - `Sites.Selected`, granted per site; delta sync into `ExternalDocument`. Graph search isn't available under Sites.Selected, so we use our own index.
  - Private and shared channels have their own sites, each needing a grant.
- **Teams messages:**
  - RSC `ChannelMessage.Read.Group` through a team-installed app.
  - Change-notification webhooks (`/api/webhooks/graph` and the lifecycle route; `clientState` checked in constant time; acknowledged within 3 s), with subscriptions renewed about every 48 hours.
  - A once-a-day delta reconcile (Microsoft allows polling once a day).
  - Deletions purge content.
- **Meeting transcripts, three paths:**
  1. always: upload a `.vtt` or `.docx` to a room;
  2. if SharePoint is granted: a "Transcripts" folder picked up as ExternalDocument;
  3. only if IT grants it: the transcript API.
- **Posting** (the digest only): a Teams Workflows webhook taking an Adaptive Card, at most 25 posts per 5 minutes. The webhook URL is a secret in env.
- **Env:** `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TEAM_ID`, `MS_SITE_ID`, `MS_DRIVE_ID`, `MS_CHANNEL_IDS`, `MS_GRAPH_CLIENT_STATE`, `TEAMS_WEBHOOK_URL`.
- **The UT IT request:** research §9 has a ready-to-send draft. Gray files it.

---

## 13. Admin console additions
| Where | What | Track |
|---|---|---|
| Members → Recruiting | Pipeline summary panel | club-data |
| Recruiting → Emails | Delivery status column | sources-a |
| Racing → Results; public driver profile | Best laps and form (public profile: only already-public results) | club-data |
| Jack → Rooms list | Search, Archived filter, pin | club-data, decks-rooms |
| **New: Content → Knowledge** | Entries (search, edit, history, review, delete) plus tabs: Documents, Teams messages | memory, documents |
| Profile editor and Members edit | Department, board flag, "what I work on", Discord link/unlink | memory, discord-read |
| Money → Payments | Stripe panel: balance, payouts, refunds, disputes | sources-a |
| System → Notifications | Delivery column, bounce list | sources-a |
| Content → Instagram | Insights, and publish history | sources-b, decks-rooms |
| Decks and graphics → deck page | Publish to Instagram, Add to gallery (Jack's caption prefilled) | decks-rooms |
| Overview | "Needs attention" (digest checks), site traffic, streams, Discord activity | automation, sources, discord |
| **New: Content → Streams** | Live status, streams, viewers, VODs | sources-b |
| **New: Community → Discord** | Connection, channels (admin sync switch), activity, polls, members over time, role-sync rules, linked members count | discord-read, discord-post |
| **New: Community → Announcements** | Standing rules, scheduled and sent posts, approved drafts | discord-post |
| **New: Club → Sponsors** | Prospects and activity | sponsors-meetings |
| **New: Club → Meetings, Action items** | Meetings (agenda copy page at `/admin/meetings/[id]/agenda`), decisions, items by owner | sponsors-meetings |
| **New: Jack → Proposals** | Every proposal and its status, pending first | groundwork (G4) |
| **New: Jack → Recurring questions** | Create, edit, pause, last runs, cost | automation |
| **New: Jack → Usage** | Cost by month, persona, officer and automation; feedback | decks-rooms |
| **New: System → Connections** | Every connector: configured or missing env, enabled switch (admin), last sync, last error, smoke test, Supabase storage usage | groundwork (G2) |
| **New: System → Scheduled jobs** | Jobs, runs, errors, enable switch, run now (admin), heartbeat | groundwork (G3) |

New nav groups: **Community** (Discord, Announcements) and **Club** (Meetings, Action items, Sponsors).

---

## 14. Security summary
- **Writes and posts:** proposals with claim-then-apply, the applying officer's permissions, idempotency keys, audit, and room notes for every outcome.
- **Standing posts:** templates only, public events only, no pings unless named.
- **Knowledge saves:** section 9's guardrails.
- **Exfiltration:**
  - `web_fetch` can't follow links from client tool results.
  - There's a per-reply search cap, and no web tools in automations.
  - The no-member-data-in-URLs rule.
  - External link hosts are shown on cards and in replies.
  - pg_net names are blocked in `run_sql`.
- **Files:** server-chosen paths, magic-byte checks, a refused-types list, safe serving headers, parsers with caps, and sha256 pinned on proposals.
- **Secrets:** env or revoked SystemSetting keys, `redactSecrets()` on stored errors, the HMAC-signed scheduler, and webhooks verified with timestamp windows and dedupe.
- **Privacy:**
  - RLS on every personal-data table, and tightened recruiting policies.
  - Discord metadata only; Drive and Teams deletions purge text; email events without IP or user agent, pruned at 12 months.
  - Account linking hardened.
- **Eval injection cases:** every outside source (section 16).

---

## 15. Setup and accounts
These are the steps Gray (or the named owner) must do. Each is mirrored on System → Connections as "missing: …". Launch can go ahead with any connector off.

| Service | Club-owned account | Who | Env / setting | External step | Verify |
|---|---|---|---|---|---|
| Supabase Storage | existing project | Gray | `SUPABASE_SERVICE_ROLE_KEY` (exists) | Create the bucket `jack` (private) via setup script; copy `jack/assets` from Blob | Connections: storage ok |
| Scheduler | existing project | Gray | `SCHEDULER_SIGNING_SECRET` | Enable pg_cron and pg_net in the dashboard; Vault secrets `lsr_scheduler_secret` and `lsr_scheduler_url`; run `jack-scheduler-setup` | Jobs page heartbeat |
| Web search | Anthropic org | Gray | `JACK_WEB_TOOLS=on` | Console → Capabilities: allow web search and fetch | smoke |
| Claude Files | Anthropic org | — | — | none (GA) | smoke |
| Discord | club Discord app (owner: club account) | Discord admin (Dylan or Gray) | `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Create the app; Message Content and Server Members on; Public Bot off; install with `580542407986176`; OAuth redirect URI; privacy URL | smoke |
| Twitch | club Twitch dev app | Twitch account owner (TBD) | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_BROADCASTER_ID`, `TWITCH_EVENTSUB_SECRET` | Create the app; one-time OAuth by the channel account; EventSub subscriptions (script) | smoke |
| Stripe | existing account | Gray | `STRIPE_READONLY_KEY` | Restricted key (permissions in research); add `payout.*` and `charge.dispute.*` to the webhook | smoke |
| Resend | existing account | Gray | `RESEND_WEBHOOK_SECRET` | Add the webhook endpoint | smoke |
| Site traffic | LSR Vercel team owner | team owner | `VERCEL_ANALYTICS_TOKEN`, project id | Project-scoped token, short expiry | smoke |
| Instagram | club Meta app(s) | Gray / Media lead | settings `instagram`, `instagram_publish` | Reconnect read token with insights; publish token from a second app | smoke |
| Google Drive | club Google account's Cloud project | Gray + Dylan | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID` | Create the service account; Dylan shares the folder as Viewer (no notification) | smoke |
| Teams / SharePoint | UT tenant | Gray → UT IT | the MS_* vars | File the IT request (research §9); install the RSC app; Workflows webhook for posting | smoke |

---

## 16. Eval
- **Harness PR in groundwork:**
  - per-track question slots `scripts/jack-eval/<track>.ts`;
  - `--as <handle>` per question;
  - cleanup of everything a question created: knowledge entries, proposals, files, recurring questions, Discord posts, events;
  - before a run, each connector's sync runs against its fake into `lsr_eval`;
  - the judge prompt is generated from the live tool list.
- **The refusal group is rewritten:** "proposes, doesn't apply". Checks confirm a PENDING proposal of the right kind exists and the target didn't change.
- **Every track adds questions** for its sources and runs its group on Jack only. One full three-model run happens at the end. Spend is tracked in the build log ($25 total).
- **Paired questions:** the same question asked as officers from different departments. The judge checks the facts match and that no explanation was added that no tool gave.
- **Injection cases,** one per outside source: a Discord message, a Drive document, a fetched page, an uploaded PDF, a spreadsheet cell. Each asserts no proposal echoing the injection, no knowledge save, no fetch of the injected URL, and no outside link carrying data.
- **Recruiting privacy case:** asked by an officer who is also an applicant.

---

## 17. Release plan
1. **Freeze the 2.0 migrations.** Consider squashing them into one, timestamped after main's latest. Rehearse with `prisma migrate deploy` on `lsr_eval`.
2. **Gray enables pg_cron and pg_net** in the Supabase dashboard.
3. **Apply the 2.0 migrations to prod before merging** (they're additive, so main keeps working), by running `migrate.yml` through `workflow_dispatch` on `jack-2` or by merging a migrations-only PR to main. This matters because `getSessionUser` reads whole User rows: deploying the code first would break sign-in until the migrations land.
4. **Merge `jack-2 → main`.** Vercel deploys.
5. **Setup steps** (section 15), then **turn connectors on one at a time**, each after its smoke test. Turn on the scheduler, then the jobs. **Turn on `proposals.sweep` first:** until it runs, an apply whose function died stays APPLYING, and an expired proposal gets its "Stale" note only when someone acts on it.
6. **Launch runbook** in `build-log.md`: the order, smoke checks, rollback (switch connectors off; code rollback is safe because the migrations are additive).

---

## 18. Build plan

### 18.1 PRs, in order
Each PR targets `jack-2`, gets CI plus a review agent that hasn't seen the code, and merges when green.

| # | PR | Depends on |
|---|---|---|
| G1 | Schema and migrations (all of section 3), RLS and recruiting policies, search triggers, scheduler schema and guarded extensions, slot files and interface types, display union and generic renderers, room event union and extension points, prompt rewrite and section split, `run_sql` hardening, `redactSecrets`, dependencies, CI on `jack-2` (plus `pnpm build`) | — |
| R | Behavior-preserving refactors (section 4.4) with the golden-file check | G1 |
| G2 | Connector framework, HTTP fakes server, Connections page | G1 |
| G3 | Scheduler: tick route, dispatcher, hand-off route, housekeeping jobs, Scheduled jobs page, setup script | G1 |
| G4 | Proposals: claim/apply, card, proposal route and event, Proposals page, `page.update` | G1 |
| G5 | Files: Supabase Storage backend (renders move too), upload/register/serve, model copies, Files API, `room_files`, deck room images; plus who's asking (`authorLabel`, profile fields in `club_members`) | G1 |
| G8 | Model loop 2.0: server tools, citations, tool search, document blocks, cost, `web_links` | G1 |
| E | Eval harness 2.0 | G1 |
| T1 | club-data: `search`/`read` framework and sources, `recruiting_pipeline`, `race_performance`, rooms search UI, recruiting panel, results/profile additions | G1, G8 |
| T2 | memory: knowledge (service, tool, page), seed tooling, profile editing | G1, G5 |
| T3 | changes: kinds from section 4.3 (except page.update), import targets for LSC applications | R, G4, G5 |
| T4 | sources-a: Stripe, Resend, site traffic | G2, G3 |
| T5 | sources-b: Twitch, Instagram insights | G2, G3 |
| T6 | documents: Drive, SharePoint, Teams (switchable) | G2, G3, T2 |
| T7 | discord-read: sync, search, polls, activity, linking, Discord page, privacy page | G2, G3 |
| T8 | discord-post: rules, posts, mirror, role sync, Announcements | T7, G4, T5 (twitch_live) |
| T9 | decks-rooms: Instagram publish, gallery add, deck page buttons, archive, anchors, mention mode, feedback, pin, usage | G4, G5, T5 |
| T10 | sponsors-meetings: prospects, meetings, action items, decision log, `draft_text`, import targets, agenda page | G4, G5, T2, T3 |
| T11 | automation: recurring questions, digest, checks wiring, Overview card | G3, G4, all tracks' checks |
| F | Eval run, security pass, docs fold-in, knowledge seed drafts, launch post draft, pre-merge checklist and runbook | all |

### 18.2 Working in parallel
- Agents work in their own git worktrees, from `jack-2`, on branches named `jack-2/<pr>`.
- `main` is merged into `jack-2` weekly, and open branches rebase after each merge.
- **Lockfile conflicts:** take `jack-2`'s lockfile and rerun `pnpm install`.

### 18.3 Local database rules (one shared local Supabase)
- **Only G1's migrations are applied with `prisma migrate dev`.**
- A track that needs a migration writes it with `prisma migrate diff`, applies it with `prisma db execute`, and marks it applied with `prisma migrate resolve --applied`. Its migration must be additive.
- **Never run `db:reset`** or `migrate dev` in a track worktree.
- No local pg_cron schedule. Use `pnpm jack:tick` per worktree. The dispatcher skips job kinds it doesn't know.

### 18.4 Done means
- tests (unit, route, and DB check scripts where behavior lives in the database);
- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` green;
- the migrate-diff check is clean;
- a browser check of every page touched, in light and dark mode and at 390 px;
- the track's docs file is written;
- eval questions are added;
- an independent review is done and its findings are addressed.
