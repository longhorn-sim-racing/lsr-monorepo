# Jack 2.0 design

The plan for everything in #188. It's written for the people and agents building it: read this before touching code. Background facts live in `docs/jack-2/research/` (`codebase-*.md` for this repo, `<service>.md` for outside APIs). How Jack works today is in `docs/jack.md`.

Status: **draft for the build**. Changes to it are logged in `build-log.md` under Decisions.

---

## 1. Principles (from #188, binding)
1. **Officers approve every change and every post Jack writes.** Jack *proposes*; an officer presses Apply. Two exceptions:
   - standing automations officers set up themselves (reminders and the like);
   - knowledge entries, which Jack saves directly.
2. **Jack never moves money.** No tool or proposal kind creates charges, refunds or payouts.
3. **The website is the only way to talk to Jack.** Discord and Teams get posts, never prompts. Nothing reads a Discord or Teams message as an instruction to Jack.
4. **All rooms are shared** with every officer. No private rooms.
5. **Outside content is data, not instructions:** web pages, documents, Discord and Teams messages, emails, file uploads. The prompt says so, and nothing Jack reads can make a change happen without an officer pressing Apply.
6. **Jack cites sources:** a link to the room, document, page, post or record.
7. **Jack is never the only way to see information.** Every source has a place in the admin console (section 9).
8. **Keys are read-only or restricted and live only in env (Vercel).** Jack never sees them, and no table stores a credential except the existing Instagram token setting.
9. **Budget stays $50/month.** Scheduled runs and recurring questions count toward it, and the budget check covers them.
10. **Everything works locally against fakes,** and every outside service is switchable: missing config or a switched-off service means Jack says "not connected" and the app keeps working.

---

## 2. Architecture

```
src/server/jack/            Jack's reply loop, prompt, tools (existing) + new:
  proposals/                proposed-change framework (registry, apply, staleness)
  files/                    files attached to room messages
  knowledge/                knowledge base service + search
  tools/<area>.ts           new tools, grouped per area (see section 7)
  prompt-sections/          the system prompt, one file per area, joined in fixed order
src/server/connectors/      outside services, used by Jack AND admin pages
  types.ts, registry.ts     Connector interface, status, fake switch
  <service>/                client.ts (real), fake.ts (fake), sync.ts (jobs), types.ts
src/server/scheduler/       job registry, dispatcher, run log
src/app/api/cron/tick       the one route pg_cron calls every minute
src/app/api/webhooks/<svc>  inbound webhooks (twitch, resend, blob uploads)
src/app/admin/...           new pages (section 9)
```

**Why connectors sit outside `jack/`:** the admin pages use the same clients. Jack's tools and the pages read the same tables and call the same functions, which is what keeps Jack from being the only window.

**Read from our tables, not live, where possible.** Discord messages, Twitch streams, Drive and SharePoint documents, email events and Instagram insights are synced into our database by scheduled jobs and webhooks, then read from there. That's fast, testable, survives outages, and gives the admin pages history. Only Stripe balance and payouts and site traffic are fetched live, with a short cache.

### 2.1 Plug-in slots (how parallel tracks avoid merge conflicts)
Groundwork creates one file per track for every shared registry, each starting empty:
- `tools/registry/<track>.ts` exports `TOOLS: AnyJackTool[]`. `tools/index.ts` concatenates them in a fixed order **after** the current tools (the order is part of the cached prompt).
- `prompt-sections/<track>.ts` exports a string. `prompt.ts` joins them in a fixed order.
- `tools/schema-notes/<track>.ts` exports notes text and table notes, merged into the existing notes.
- `proposals/kinds/<track>.ts` exports proposal kinds.
- `scheduler/jobs/<track>.ts` exports job kinds.
- `connectors/registry.ts` lists every connector from the start (each in its own folder).
- `app/admin/_overview/cards/<track>.tsx` exports Overview cards. The Overview page renders them all.
- `components/admin/shell/admin-nav.ts` gets every new nav entry in groundwork.

Tracks only edit their own slot files and their own folders. If a track must touch a shared file, it says so in its PR and keeps the change minimal.

**Tracks:** `club-data`, `memory`, `sources`, `documents`, `discord`, `changes`, `automation`, `sponsors-meetings`, `decks-rooms`.

---

## 3. Data model

All new tables are created in the groundwork migration(s), so tracks don't fight over `schema.prisma`. A track that needs a change adds its own migration, timestamped inside its range (section 12). Prisma models below are the spec; names are final unless a review finds a problem.

**Access rules** (see `research/codebase-infra.md` §1):
- **Personal data** (members' messages, contact details, transcripts) gets RLS plus the `jack_readonly_select` policy, copying the recruiting migration's tail.
- **Nothing here holds secrets,** so nothing is revoked from Jack.
- **Jack's own bookkeeping** is plain.

### 3.1 Proposals
```prisma
model JackProposal {
  id           String             @id @default(uuid())
  roomId       String
  messageId    String?            // the reply that proposed it
  kind         String             // registry key, e.g. "event.update"
  title        String             // "Change GM 2's start time"
  summary      String             // one-line description for lists and the audit log
  payload      Json               // validated by the kind's schema
  before       Json?              // snapshot of what it changes, for the diff and the staleness check
  targetType   String?            // AuditLog entityType, e.g. "EVENT"
  targetId     String?
  status       JackProposalStatus @default(PENDING)
  proposedForId String?           // the officer whose message led to it
  decidedById  String?
  decidedAt    DateTime?
  result       Json?              // what applying did: created ids, counts, links, or the error
  expiresAt    DateTime           // PENDING proposals go STALE after 14 days
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt
  room         JackRoom           @relation(fields: [roomId], references: [id], onDelete: Cascade)
  @@index([roomId, createdAt])
  @@index([status, createdAt])
  @@index([targetType, targetId])
}
enum JackProposalStatus { PENDING APPLIED DISCARDED FAILED STALE }
```

### 3.2 Files in rooms
```prisma
model JackFile {
  id           String   @id @default(uuid())
  roomId       String
  messageId    String?  // set when the message that carries it is posted
  uploadedById String?
  filename     String
  contentType  String
  sizeBytes    Int
  blobPath     String   @unique // private Blob path, jack-files/<roomId>/<id>/<filename>
  sha256       String?
  kind         JackFileKind
  /// Text extracted for search and for the model (CSV, JSON, plain text, spreadsheet → CSV); capped
  text         String?
  status       JackFileStatus @default(UPLOADING)
  createdAt    DateTime @default(now())
  room         JackRoom @relation(fields: [roomId], references: [id], onDelete: Cascade)
  @@index([roomId, createdAt])
  @@index([messageId])
}
enum JackFileKind { IMAGE PDF SPREADSHEET JSON TEXT OTHER }
enum JackFileStatus { UPLOADING READY FAILED }
```

### 3.3 Knowledge base
```prisma
model KnowledgeEntry {
  id          String   @id @default(uuid())
  title       String
  body        String   // Markdown
  tags        String[]
  sourceType  KnowledgeSource @default(MANUAL)
  sourceUrl   String?
  sourceNote  String?  // e.g. "Teams General, Dylan, 9/28"
  ownerId     String?  // who keeps it current
  createdById String?
  updatedById String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  archivedAt  DateTime?
  versions    KnowledgeEntryVersion[]
  @@index([archivedAt, updatedAt])
}
model KnowledgeEntryVersion {
  id        String   @id @default(uuid())
  entryId   String
  title     String
  body      String
  tags      String[]
  editedById String?
  via       String   // "admin" | "jack" | "seed"
  roomId    String?
  createdAt DateTime @default(now())
  entry     KnowledgeEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)
  @@index([entryId, createdAt])
}
enum KnowledgeSource { MANUAL JACK SEED }
```
Full-text search: a generated `tsvector` column plus a GIN index, added in hand-written SQL. Prisma ignores it; queries use `$queryRaw` with `websearch_to_tsquery('english', …)`. The same goes for `JackMessage.content` (room search) and `ExternalDocument.text`.

### 3.4 Officer profiles
New columns on `User`: `department String?` and `workingOn String?` (≤160 characters). Allowed departments live in code (`src/lib/officers.ts`): Technology, Competition, Community, Business, Media, Board. Officers edit them on their profile editor; admins edit them on Members.

### 3.5 Scheduler
```prisma
model ScheduledJob {
  id           String   @id @default(uuid())
  key          String   @unique   // "discord.sync", "digest.weekly", "recurring:<id>", …
  kind         String             // job registry key
  schedule     String             // cron expression in America/Chicago, e.g. "0 9 * * 1"
  enabled      Boolean  @default(true)
  config       Json?
  nextRunAt    DateTime
  lockedUntil  DateTime?
  lastRunAt    DateTime?
  lastStatus   String?            // ok | error | skipped
  lastError    String?
  createdById  String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  runs         ScheduledJobRun[]
  @@index([enabled, nextRunAt])
}
model ScheduledJobRun {
  id         String   @id @default(uuid())
  jobId      String
  startedAt  DateTime @default(now())
  finishedAt DateTime?
  status     String   // running | ok | error | skipped
  summary    String?
  error      String?
  job        ScheduledJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  @@index([jobId, startedAt])
}
```

### 3.6 Connectors
```prisma
model ConnectorState {
  id           String   @id   // connector id: "discord", "twitch", …
  enabled      Boolean  @default(true)   // admin switch (Teams, Discord, …)
  lastSyncAt   DateTime?
  lastError    String?
  lastErrorAt  DateTime?
  cursor       Json?    // sync position (message ids, page tokens)
  updatedAt    DateTime @updatedAt
}
```

### 3.7 Documents (Drive, SharePoint)
```prisma
model ExternalDocument {
  id           String   @id @default(uuid())
  source       String   // "drive" | "sharepoint"
  externalId   String
  name         String
  path         String   // folder path inside the shared folder or site
  mimeType     String
  webUrl       String
  modifiedAt   DateTime
  sizeBytes    Int?
  text         String?  // extracted text, capped (default 200k chars)
  textStatus   String   // ok | too_large | unsupported | error
  syncedAt     DateTime
  deletedAt    DateTime?
  @@unique([source, externalId])
  @@index([source, modifiedAt])
}
```

### 3.8 Discord
Personal data, so RLS plus the Jack read policy on DiscordMessage, DiscordMember and DiscordPollVote.
```prisma
model DiscordChannel {
  id            String   @id          // snowflake
  name          String
  type          Int
  parentName    String?
  synced        Boolean  @default(false)  // officers choose which channels sync
  lastMessageId String?
  lastSyncedAt  DateTime?
  updatedAt     DateTime @updatedAt
}
model DiscordMessage {
  id          String   @id            // snowflake
  channelId   String
  authorId    String
  authorName  String
  userId      String?                 // linked member
  content     String
  createdAt   DateTime
  editedAt    DateTime?
  attachments Int      @default(0)
  replyToId   String?
  poll        Json?                   // question, answers, counts, expiry, finalized
  deletedAt   DateTime?
  @@index([channelId, createdAt])
  @@index([authorId, createdAt])
}
model DiscordDailyStat {
  date          DateTime @db.Date
  channelId     String
  messages      Int
  activeAuthors Int
  @@id([date, channelId])
}
model DiscordGuildDaily {
  date        DateTime @id @db.Date
  memberCount Int
  joined      Int?
  left        Int?
}
model DiscordRule {                        // standing automations, set up by officers
  id          String   @id @default(uuid())
  kind        String                       // event_reminder | new_event | results_posted | standings_update | twitch_live | event_mirror
  channelId   String?
  config      Json                         // e.g. { offsetsMinutes: [1440, 60], mention: "@here" }
  enabled     Boolean  @default(true)
  createdById String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
model DiscordPost {
  id               String   @id @default(uuid())
  source           String                  // rule | proposal | admin
  ruleId           String?
  proposalId       String?
  channelId        String
  content          Json                    // { content, embeds?, poll? } exactly as sent
  dedupeKey        String?  @unique        // e.g. "event_reminder:<eventId>:1440", so a rule never posts twice
  status           DiscordPostStatus @default(SCHEDULED)
  scheduledFor     DateTime
  sentAt           DateTime?
  discordMessageId String?
  error            String?
  createdById      String?
  createdAt        DateTime @default(now())
  @@index([status, scheduledFor])
}
enum DiscordPostStatus { SCHEDULED SENT FAILED CANCELLED }
model DiscordEventMirror {
  eventId         String   @id             // our Event
  discordEventId  String   @unique
  lastSyncedAt    DateTime
  interestedCount Int?
}
model DiscordRoleRule {
  id        String  @id @default(uuid())
  roleId    String                          // Discord role snowflake
  condition String                          // "officer" | "lsc_driver_current_season" | …
  enabled   Boolean @default(true)
}
```
Linking accounts: new `User.discordUserId String? @unique` and `User.discordUsername String?`, set through Discord OAuth (identify scope) from the member's profile.

### 3.9 Twitch
```prisma
model TwitchStream {
  id           String   @id   // Twitch stream id
  startedAt    DateTime
  endedAt      DateTime?
  title        String
  gameName     String?
  peakViewers  Int      @default(0)
  avgViewers   Float?
  vodId        String?
  vodViews     Int?
  samples      TwitchViewerSample[]
}
model TwitchViewerSample {
  streamId  String
  at        DateTime
  viewers   Int
  stream    TwitchStream @relation(fields: [streamId], references: [id], onDelete: Cascade)
  @@id([streamId, at])
}
model TwitchChannelDaily {
  date      DateTime @id @db.Date
  followers Int
}
```

### 3.10 Email delivery (Resend)
```prisma
model EmailEvent {
  id         String   @id @default(uuid())
  resendId   String                  // matches Notification.emailMessageId / ApplicationEmail.resendMessageId
  type       String                  // email.delivered | email.bounced | email.complained | email.opened | email.clicked | …
  occurredAt DateTime
  detail     Json?
  svixId     String   @unique        // webhook delivery id, so retries don't double-count
  @@index([resendId, occurredAt])
}
```
The Notifications page gets a delivery column; Jack's `email_delivery` tool joins EmailEvent to Notification and ApplicationEmail.

### 3.11 Instagram
Insights are snapshotted daily in `InstagramAccountDaily { date @id, followers, reach, profileViews, accountsEngaged }`, and new nullable columns on `InstagramPost` (reach, likes, comments, saves, shares, views, insightsAt). Publishing is recorded in `InstagramPublish { id, deckId?, version?, caption, mediaType, igMediaId?, permalink?, status, error?, createdById, approvedById, createdAt }`.

### 3.12 Sponsors (RLS: contact details)
```prisma
model SponsorProspect {
  id           String   @id @default(uuid())
  company      String
  website      String?
  contactName  String?
  contactEmail String?
  contactRole  String?
  stage        String   // idea | researching | contacted | talking | committed | declined | dormant
  tierInterest String?  // matches the sponsor tiers in src/lib/sponsors (gold, silver, …)
  ownerId      String?  // officer in charge
  lastContactAt DateTime?
  nextStep     String?
  nextStepDue  DateTime?
  notes        String?
  createdById  String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  activities   SponsorActivity[]
  @@index([stage, updatedAt])
}
model SponsorActivity {
  id         String   @id @default(uuid())
  prospectId String
  type       String   // email_sent | reply | meeting | call | note | stage_change
  summary    String
  occurredAt DateTime
  byId       String?
  createdAt  DateTime @default(now())
  prospect   SponsorProspect @relation(fields: [prospectId], references: [id], onDelete: Cascade)
  @@index([prospectId, occurredAt])
}
```

### 3.13 Meetings (RLS on Meeting: transcripts can hold anything said)
```prisma
model Meeting {
  id           String   @id @default(uuid())
  title        String
  kind         String   // board | tech | general | department | other
  heldAt       DateTime
  agendaMd     String?
  summaryMd    String?
  transcriptFileId String? // JackFile
  roomId       String?  // the room it was worked on in
  createdById  String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  decisions    MeetingDecision[]
  actionItems  ActionItem[]
  @@index([heldAt])
}
model MeetingDecision {
  id        String   @id @default(uuid())
  meetingId String?
  text      String
  decidedAt DateTime
  knowledgeEntryId String? // its entry in the decision log
  createdAt DateTime @default(now())
  meeting   Meeting? @relation(fields: [meetingId], references: [id], onDelete: SetNull)
}
model ActionItem {
  id         String   @id @default(uuid())
  text       String
  ownerId    String?
  dueAt      DateTime?
  status     String   @default("open") // open | done | dropped
  doneAt     DateTime?
  meetingId  String?
  roomId     String?
  createdById String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  meeting    Meeting? @relation(fields: [meetingId], references: [id], onDelete: SetNull)
  @@index([status, dueAt])
  @@index([ownerId, status])
}
```

### 3.14 Automation
```prisma
model RecurringQuestion {
  id          String   @id @default(uuid())
  title       String
  prompt      String
  schedule    String   // cron in America/Chicago
  roomId      String   // where Jack answers
  persona     String   @default("jack")
  enabled     Boolean  @default(true)
  createdById String   // the officer it runs as
  lastRunAt   DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```
The weekly digest is a built-in ScheduledJob (`digest.weekly`) with its settings in `config`: which checks, which room, Discord channel, Teams on or off.

### 3.15 Rooms
- `JackRoom` gets `pinnedAt DateTime?` and `answerMode String @default("always")` ("always" | "mention").
- New model `JackFeedback { id, messageId, userId, rating ("up"|"down"), note?, createdAt; @@unique([messageId, userId]) }`.
- `JackMessage` gets `fileIds String[]`, the attachments in posting order.

---

## 4. Proposed changes

### 4.1 Flow
1. A Jack tool named `propose_*` validates its input against the kind's schema, loads the current state, and saves a `JackProposal`: PENDING, with `before`, a `payload` holding only the changes, and a human `title`/`summary`.
2. The tool returns a `proposal` display, and Jack's reply ends with it. The room shows a **proposal card**:
   - the title and a diff table (field, now, proposed);
   - for long text, a before/after toggle;
   - the people affected, for notifications;
   - **Apply** and **Discard** buttons, and "Open in editor" where an admin page edits the same thing.
3. **Any officer can press Apply** (rooms are shared). The server action `applyJackProposal(id)`:
   1. runs `requireOfficer()`;
   2. locks the proposal row `FOR UPDATE` and refuses anything not PENDING;
   3. re-validates the payload;
   4. runs the kind's `checkStale(before)`, which compares the target's current values (or `updatedAt`) with `before`. On a mismatch it marks the proposal STALE with a message: "GM 2 changed since this was proposed; ask Jack again".
   5. checks the kind's permission with the **applying** officer's roles, the same rule as the admin page (e.g. only admins change officer accounts);
   6. runs `apply(payload, { officer })` through the kind's service function;
   7. writes `createAuditLog` with the applying officer as actor and `metadata: { via: "jack", proposalId, roomId, proposedFor }`;
   8. revalidates paths;
   9. sets APPLIED with `result`, posts a room note ("Dylan applied: Change GM 2's start time"), and broadcasts the update.
4. **Discard:** any officer; status DISCARDED; room note.
5. **Expiry:** PENDING proposals go STALE after 14 days, through a scheduler job.
6. **Jack learns the outcome** through the room notes in history, so he never assumes something was applied.

### 4.2 Kind interface
```ts
type ProposalKind<P> = {
  kind: string                       // "event.update"
  schema: z.ZodType<P>
  targetType?: string                // AuditLog entityType
  permission: "officer" | "admin"
  describe(p: P, before: unknown): ProposalView   // title, summary, diff rows, affected people, links
  checkStale(p: P, before: unknown): Promise<string | null>
  apply(p: P, ctx: { officer: SessionOfficer; proposalId: string; roomId: string }): Promise<ProposalResult>
}
```
The registry is `proposals/registry.ts`, collecting `proposals/kinds/<track>.ts`.

### 4.3 Kinds (owner track)
| Kind | What applying does | Track |
|---|---|---|
| `event.update` | Edits an existing event (details, registration, attendance, status) through a new `updateEventFromInput` service shared with the admin action | changes |
| `news.create` / `news.update` | Creates a draft post or edits one (publishing stays a separate choice in the payload: draft, schedule or publish now) | changes |
| `page.update` | Edits a Page's body or title through `savePage`'s logic (the LSC rules page included) | changes |
| `notification.send` | `sendBulkNotification` to an explicit user list, with channels, title, body, link and optional schedule; checks the email daily limit | changes |
| `results.import` | Creates the upload from a room file, parses it, binds it to the event, and ingests (the logic moves into a `results.service`) | changes |
| `attendance.checkin` | Manual check-ins for matched members (`checkInUser` MANUAL); unmatched names listed, not applied | changes |
| `import.rows` | Spreadsheet rows into a supported target: LSC applications, prospects, action items, check-ins | changes |
| `discord.post` | Schedules or sends an announcement or poll (`DiscordPost`, source proposal) | discord |
| `discord.rule` | Creates or edits a standing automation | discord |
| `instagram.publish` | Publishes deck slides (post, carousel or story) with a caption | decks-rooms |
| `gallery.add` | Adds deck renders (or room images) to a gallery album through Cloudinary | decks-rooms |
| `prospect.upsert` / `prospect.activity` | Creates or edits a prospect, or logs an activity | sponsors-meetings |
| `meeting.record` | Creates a Meeting with agenda, summary, decisions (also written to the decision log) and action items | sponsors-meetings |
| `action_item.update` | Marks items done, reassigns them, sets due dates | sponsors-meetings |
| `recurring.upsert` | Creates or edits a recurring question | automation |

`draft_event` stays as it is: it creates a DRAFT event, which is already safe.

### 4.4 Refactors this needs (careful: these touch live admin paths)
- `updateEvent` logic → `src/server/services/event.service.ts` `updateEventFromInput(id, input, actor)`. The admin action calls it, then redirects as before.
- `ingestUpload` / `previewParseResult` / `bindEventToUpload` / `uploadResult` → `src/server/services/results.service.ts`. The actions call it after `requireOfficer()`.
- `savePage` and `createPost`/`updatePost` → service functions that return results instead of throwing or redirecting.
- Each refactor ships with tests that pin the old behavior, and admin pages keep working exactly as before. Check in the browser.

---

## 5. Files in rooms
- **Upload:** the composer gets an attach button (and paste/drop) for up to 10 files of 25 MB each. The browser uploads straight to the private Blob store with `uploadPresigned`. The server issues the token through `handleUploadPresigned` with `requireOfficer()`, an allow-list of content types, and a size limit (see `research/vercel-blob-client-upload.md`).
- **Registering:** after upload the browser calls `registerJackFile`, which checks the blob exists, records size and sha256, extracts text, and sets READY. Posting a message carries its `fileIds`. Without a store configured, locally, files go to `.jack-renders/files/` through the existing file-store fallback, and the upload goes through a local route.
- **What Jack gets:**
  - **Images and PDFs** go into the officer's turn as image/document blocks, capped per turn (10 images, 5 PDFs, model limits from `research/anthropic-tools.md`).
  - **Text-like files** (CSV, JSON, TXT, spreadsheets converted to CSV) are summarized in the turn (name, size, first rows), and Jack reads them in full with the `room_files` tool.
  - Older attachments in history become a one-line note, so they aren't sent again on every turn.
- **Spreadsheets:** XLSX → CSV with a maintained, safe parser (chosen during the build: no macros, no formulas evaluated). CSV is parsed with a small, well-tested parser.
- **Room UI:** attachment chips on messages; images as thumbnails, opened through an officer-checked route that serves Blob content.

---

## 6. Scheduler
- **pg_cron runs one job every minute** that calls `POST /api/cron/tick` through pg_net, with `Authorization: Bearer <secret>` read from Supabase Vault (`vault.decrypted_secrets`, name `jack_cron_secret`). The secret never appears in `cron.job`.
- The route checks the secret with the fail-closed helper (`isAuthorizedCronRequest`), answers 202 right away, and runs due jobs in `after()`.
- **Dispatcher:**
  - Picks jobs where `enabled AND nextRunAt <= now()`.
  - Claims each with a conditional update on `lockedUntil` (no double runs), runs it with a time budget (default 50 s, max 240 s), and records a `ScheduledJobRun`.
  - Computes the next run from the cron expression in America/Chicago (a maintained cron parser).
  - One failing job never blocks the others.
- **Jobs must be resumable:** they work in chunks, keep their position in `ConnectorState.cursor` or `config`, and stop before their time budget.
- **Migrations:**
  - The groundwork migration enables `pg_cron` and `pg_net`, guarded for the shadow database and for non-Supabase databases (see `research/codebase-infra.md` §2).
  - The cron schedule itself and the Vault secret are a **setup step**, not a migration, because they hold the site URL and a secret: `scripts/jack-scheduler-setup.ts` prints the SQL, or runs it with a confirmation.
- **Local:** `pnpm jack:tick` runs due jobs once. Local pg_cron can call `http://host.docker.internal:3000/api/cron/tick`.
- **Existing GitHub Actions crons stay** (notifications, recruiting, instagram). Moving them is out of scope.
- **Admin page "Scheduled jobs"** (System): every job, its schedule, last run, status and errors; enable or disable; run now (admin only).

---

## 7. Jack's tools
Grouped so the tool list stays manageable: one tool per source, with a `view` or `action` input where it helps. Current tools stay unchanged and in their current order. New tools are appended per track.

| Track | Tools | Notes |
|---|---|---|
| club-data | `recruiting` | Rounds, counts per team and status, applicant lists (filters: team, status, unreviewed = no reviews), reviewer load, score summaries. **Submitted applications only; hides reviews of the asker's own application.** |
| club-data | `race_performance` | Driver summary, laps by session, compare drivers, season trend, incidents. |
| club-data | `site_content` | `search` across published news, pages, events, gallery albums and Instagram captions; `read` one public page of our site by path. |
| club-data | `room_search` | Search every room's messages; returns links to the message. |
| memory | `knowledge` | `search`, `read`, `save` (create or update; direct, with a room note and audit entry), `archive`. Mentions an entry's age when it's over 180 days old. |
| memory | `officers` | Officers with title, department, major, grad year, "what I work on". |
| documents | `documents` | `search` and `read` across Drive and SharePoint (ExternalDocument). |
| documents | `teams` | Search the synced Teams channel messages (only when connected). |
| sources | `stripe` | Balance, recent payouts, disputes, refunds (live, read-only). |
| sources | `email_delivery` | Delivery status for a notification send, a recipient, or recent bounces. |
| sources | `site_traffic` | Views and visitors by page, referrer, country and device for a date range. |
| sources | `instagram` | Account and post insights. |
| sources | `twitch` | Live now, recent streams with peak and average viewers, VOD views, followers. |
| sources | web search + web fetch | Anthropic server tools (`web_search_20260209`, `web_fetch_20260209`) with `max_uses` limits. Not for Stand if the model doesn't support them. |
| discord | `discord` | `channels`, `search`, `activity`, `polls`, `linked_members`. |
| discord | `propose_discord_post`, `propose_discord_rule` | Proposals. |
| changes | `propose_event_update`, `propose_news_post`, `propose_page_update`, `propose_notification` | Proposals. |
| changes | `room_files` | List and read files attached in this room. |
| changes | `propose_results_import`, `propose_checkins`, `propose_import` | Proposals from room files. |
| automation | `propose_recurring_question` | Proposal. |
| sponsors-meetings | `sponsors` | Prospects, activity, quiet prospects. |
| sponsors-meetings | `propose_prospect`, `draft_email` | `draft_email` returns an email draft card with a copy button, never sends. |
| sponsors-meetings | `meetings` | Meetings, decisions, action items; `mine` = the asker's open items. |
| sponsors-meetings | `propose_meeting_record`, `propose_action_items`, `agenda_draft` | `agenda_draft` returns an agenda with a copy page link. |
| decks-rooms | `propose_instagram_publish`, `propose_gallery_add` | Proposals. |

**Tool count and prompt size:** about 45 tools. The groundwork PR measures the cached prefix (tools plus system prompt) and the cost of a cold start. If the prefix passes about 45k tokens, or answers get worse on the eval, move rarely used tools behind **tool search** (`defer_loading`; see `research/anthropic-tools.md`) rather than cutting features.

**Display kinds** (added to `parts.ts` in groundwork, so tracks don't edit the union):
- `proposal`: id, kind, title, status, diff rows, people, links, result
- `links`: a list of `{ title, url, meta?, snippet? }`, for search results, documents, rooms and knowledge
- `email_draft`: to, subject, body
- `stats`: a row of `{ label, value, hint? }` tiles
- `files`: attachments
- `web_sources`: the search queries and cited pages

---

## 8. Who's asking
- The officer turn in history becomes: `[Thu, Oct 22, 7:00 PM CT]` then `Gray (Technology Director · Technology · CS): message`. The profile parts appear only when they exist. Built from current profile data; a profile edit changes the room's cache once, which is acceptable.
- The tool context gets `actor.profile`, so tools like `meetings mine` know who "me" is.
- Prompt rule: "Same facts, numbers and conclusions for everyone. Adjust only how much background you explain, based on the asker's role. In a room with several officers, write for the asker but keep it useful to all."
- Eval: paired questions asked as officers from different departments; the judge checks the facts match.

---

## 9. Admin console additions (Jack is never the only way)
| Where | What | Track |
|---|---|---|
| Members → Recruiting | Pipeline summary panel (counts per team and status, unreviewed) | club-data |
| Racing → Results / public driver profile | Best laps and form per driver (public profile shows only already-public results) | club-data |
| Jack → Rooms list | Search box (room search) | club-data |
| **New: Content → Knowledge** | Entries: search, create, edit, history, age badge; a Documents tab listing synced Drive/SharePoint files | memory, documents |
| Members → profile editor and Members edit | Department, "what I work on" | memory |
| Money → Payments | Stripe panel: balance, payouts, disputes | sources |
| System → Notifications | Delivery column (delivered, bounced, opened) and bounce list | sources |
| Content → Instagram | Insights: followers over time, reach, top posts | sources |
| Overview | Site traffic card; streams card; Discord activity card; digest-style "needs attention" card | sources, discord, automation |
| **New: Content → Streams** | Live status, recent streams, viewers, VODs | sources |
| **New: Community → Discord** | Connection, channels (sync on/off), activity charts, polls, linked members, role sync rules | discord |
| **New: Community → Announcements** | Standing rules, scheduled and sent posts, drafts from proposals | discord |
| **New: Business → Sponsors** | Prospect list and detail with activity | sponsors-meetings |
| **New: Club → Meetings, Action items** | Meetings with agenda, summary, decisions; action items by owner | sponsors-meetings |
| **New: Jack → Proposals** | Every proposal and its status (pending first) | changes |
| **New: Jack → Recurring questions** | Create, edit, pause; last runs | automation |
| **New: Jack → Usage** | Cost by month, persona and officer; feedback; common questions | decks-rooms |
| **New: System → Connections** | Every connector: configured?, enabled switch (admin), last sync, last error | groundwork |
| **New: System → Scheduled jobs** | See section 6 | groundwork |

The nav gets two new groups, **Community** (Discord, Announcements) and **Club** (Meetings, Action items, Sponsors). Exact grouping is a design call logged in the build log.

---

## 10. Outside services
Each connector follows `connectors/types.ts`:
```ts
type Connector<C> = {
  id: string                         // "discord"
  label: string                      // "Discord"
  configured(env): { ok: boolean; missing: string[] }
  enabled(): Promise<boolean>        // ConnectorState.enabled (admin switch)
  client(): C | null                 // real client, or the fake when JACK_FAKES includes this id (or "all"), or null
}
```
- **Fakes** live next to the real client, implement the same interface, are deterministic, and return realistic data shaped exactly like the API (fixtures from the research specs).
- `JACK_FAKES=all` in local `.env` turns them all on. Tests use the fakes directly.
- **Contract tests** run each fake's fixtures through the same parsing code the real client uses.

Service decisions, with details in `research/<service>.md`:
- **Discord:** REST only, no gateway. Posting with the bot token. Sync every 10 minutes for opted-in channels, paging with `after`. Polls from the message `poll` field. Scheduled events for the event mirror. Role sync reconciles every hour for linked members. OAuth (identify) links accounts.
  - Env: `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DISCORD_CLIENT_SECRET`.
- **Twitch:** app access token. EventSub webhooks (stream.online and stream.offline) on `/api/webhooks/twitch`, verified with HMAC. Viewer sampling every minute while live, plus a 10-minute live check as a fallback. A daily followers snapshot.
  - Env: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL_LOGIN`, `TWITCH_EVENTSUB_SECRET`.
- **Stripe:** a separate restricted read-only key. Live calls, cached 5 minutes. Env: `STRIPE_READONLY_KEY`.
- **Resend:** webhook on `/api/webhooks/resend`, verified with Svix, into EmailEvent. Env: `RESEND_WEBHOOK_SECRET`.
- **Site traffic:** per `research/vercel-analytics.md`. If there's no supported API, record page views ourselves with a minimal first-party counter, decided in that track.
- **Instagram:** existing token. Insights need `instagram_business_manage_insights` and publishing needs `instagram_business_content_publish`: reconnecting with those scopes is a setup step. Daily insights snapshot. Publishing gives Instagram a short-lived presigned Blob URL.
- **Google Drive:** service account, `drive.readonly`, the shared folder ID. A sync job every 6 hours (changed files by `modifiedTime`) exports Docs, Sheets and Slides as text or CSV and extracts PDF text.
  - Env: `GOOGLE_SERVICE_ACCOUNT_JSON` (base64), `GOOGLE_DRIVE_FOLDER_ID`.
- **Microsoft Graph (Teams, SharePoint):** built to switch off, with ConnectorState disabled by default. Narrowest permissions per `research/microsoft-graph.md`. The digest and other posts to Teams go through the simplest allowed path (likely a Workflows webhook).
  - Env: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TEAM_ID`, `MS_SITE_ID`, `TEAMS_WEBHOOK_URL`.
- **Web search and fetch:** server tools. Cost per search goes into the usage tally (`cost.ts`).

---

## 11. Security notes
- **Prompt injection through outside content can't make anything happen by itself.** Every write is a proposal an officer applies, and every post is a proposal or a standing rule an officer set up. Proposal cards show exactly what will change.
- **web_fetch:** check during the build that it can only fetch URLs the conversation already contains (search results or text from an officer), and set `blocked_domains` for our own admin and API paths. A fetched page could try to steer Jack into putting member data into a URL; the prompt forbids putting member data into URLs or searches.
- **Deck renders keep the existing allow-list.** Room files are served only to officers.
- **Personal-data tables** get RLS plus the Jack read policy. Prod has no anon/authenticated USAGE on public, but local does, so RLS still matters.
- **Recruiting privacy** is as described in section 7.
- **Webhooks:** each verifies its signature, rejects old timestamps (where the service sends one), and is idempotent by delivery id.
- **The cron route** fails closed.
- **Outbound posts** (Discord, Teams, Instagram, notifications) all record who approved them and what was sent. Standing rules record who created them.

---

## 12. Build plan
- **Branches:** `jack-2/<track>` from `jack-2`, each with a PR into `jack-2` that gets an independent review before merge. Groundwork merges first.
- **Migration timestamp ranges**, so order is stable:
  - groundwork `20261023…`
  - club-data `202610240…`
  - memory `202610241…`
  - documents `202610242…`
  - sources `202610243…`
  - discord `202610244…`
  - changes `202610245…`
  - automation `202610246…`
  - sponsors-meetings `202610247…`
  - decks-rooms `202610248…`
- **Groundwork (G), in order:**
  1. G1: schema and migrations for section 3, plus the slot files from section 2.1
  2. G2: connector framework, ConnectorState, the Connections page
  3. G3: scheduler (dispatcher, tick route, setup script, jobs page)
  4. G4: proposal framework, the card, the Proposals page
  5. G5: files in rooms
  6. G6: who's asking plus officer profile fields
  7. G7: the new display kinds and the prompt-section split
  - G2–G7 can run in parallel once G1 merges.
- **Tracks** run in parallel after groundwork, each owning its slot files.
- **Every PR:**
  - tests (unit, plus route tests for webhooks and actions);
  - `pnpm lint`, `pnpm typecheck` and `pnpm test` green;
  - a local browser check of every page it touches;
  - docs updated (`docs/jack.md` and the admin guide);
  - a review agent that hasn't seen the code.
- **End:** eval on `lsr_eval` with fakes, measured against Jack today; a security pass; docs; the knowledge seed for Gray's review; the launch post draft; the pre-merge checklist in `build-log.md`.
