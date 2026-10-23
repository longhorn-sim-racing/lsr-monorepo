Docs and env notes for the documents track; folded into docs/jack.md at the end.

# Documents (T6): Google Drive, SharePoint and Teams

Design §12.7 (Drive), §12.8 (SharePoint, Teams, transcripts), §9 (Knowledge tabs), §7.1 (`search` and `read` cover documents and Teams). Research: `research/google-drive.md`, `research/microsoft-graph.md`. Code paths are relative to `apps/platform/`.

**New env vars:** the Drive and Microsoft ones below (G1 already listed them in `.env.example`). **Migrations:** none (the tables are G1's). **New routes:** `POST /api/webhooks/graph` and `POST /api/webhooks/graph/lifecycle`.

## What it adds

Three connectors (Connections page, design §12), all switched off until an admin turns them on:

| Connector | What it reads | How it stays current | Job |
|---|---|---|---|
| `google-drive` | The club's shared Drive folder, through a service account with `drive.readonly` | Drive's changes feed every 15 minutes; a full walk the first time and every week | `google-drive.sync` (hand-off, every 15 min) |
| `sharepoint` | The club team's SharePoint library (`Sites.Selected`, read on our site only) | Graph's drive delta every hour; a full enumeration the first time and every week | `sharepoint.sync` (hand-off, hourly) |
| `teams` | Messages in the configured officers' channels (`ChannelMessage.Read.Group`, a team owner grants it by installing our Teams app) | Graph change notifications (webhook), plus one delta reconcile a day | `teams.subscriptions` (every 12 h), `teams.sync` (hand-off, daily) |

Everything lands in G1's tables: documents in `ExternalDocument` (source `drive` or `sharepoint`), Teams in `TeamsChannel` / `TeamsMessage`, subscriptions in `GraphSubscription`. The search index (`JackSearchDoc`) follows them by G1's triggers, so T1's `search` and `read` find them with no changes there beyond the switches below.

**Compartmentalized:** with a connector switched off or not set up, its jobs return `skipped`, its Knowledge tab says "not connected" with a link to Connections, `search` has no results from it (and says so only when a call names that source), `read` refuses its documents or messages, and Graph notifications are acknowledged and dropped. Switching a connector off is how an admin stops Jack seeing it, whatever rows are still stored.

### The text pipeline (`src/server/connectors/documents/text.ts`)
Drive and SharePoint files go through G5's room-file extractors and checks, so a document is capped and parsed exactly like an attachment:
- Docs export as Markdown, **Sheets as CSV of the first tab only** (Drive's export), Slides as plain text; exports are capped at **10 MB** (Google refuses bigger ones with `exportSizeLimitExceeded`, stored as `too_large`).
- Stored files (PDF, DOCX, XLSX, CSV, JSON, TXT/MD, VTT) are downloaded up to **20 MB**, checked by G5's `checkContent` (magic bytes; for Office files the ZIP layout, macros and zip-bomb caps) and read by `extractText` (200,000 characters, row, page and time caps).
- **PowerPoint** (`.pptx`, which rooms don't take) gets a small slide reader with the same ZIP checks: each slide's text, then its speaker notes, as `--- Slide 3 ---` blocks. `.pptm` and other macro files are never read.
- **Transcripts** (`.vtt`) come out speaker-tagged (`[1:23] Name: …`), so a "Transcripts" folder in Drive or SharePoint is just more documents (design §12.8, path 2).
- `ExternalDocument.textStatus`: `ok`, `truncated` (cut at a cap; `read` says only the start was kept), `too_large`, `unsupported` (images, drawings, forms, macro and old binary Office files), `restricted` (the owner turned off downloads for viewers), `none` (a scan, an empty file), `error` (damaged, or not what its name says). Names and folders lose invisible and bidirectional characters.

### Google Drive (`src/server/connectors/google-drive/`)
- **Sign-in** (`auth.ts`): a JWT signed with `node:crypto` (RS256, `drive.readonly`, audience Google's token endpoint, one hour, no `sub`) swapped for an access token; no googleapis package. The token lives for one client (one job run, one smoke test) and is replaced 5 minutes early or after a 401. Errors carry Google's code, never the key or the assertion.
- **Client** (`client.ts`): plain fetch against `serviceBaseUrl("google-drive", …)` (sign-in and API both), 20 s per call (60 s for exports and downloads), backs off on 429, 5xx and Google's 403 rate limits (Retry-After when given), byte caps that stop reading as soon as a file is over.
- **Sync** (`sync.ts`), resumable, its cursor in `ConnectorState` (ids, folder names and Drive's page tokens, never a credential):
  - Only files under the root folder count: the service account sees anything shared with it, so each change is placed in the tree by walking its parents (the cursor keeps the folder list, so that's usually no API call). Files outside are ignored; indexed files that moved out are removed. Shortcuts are never followed.
  - The first run walks the tree (backfill). The changes feed's position is taken first, so nothing changed during the walk is missed. After that, the feed keeps it current.
  - A folder renamed or moved within the tree has its subtree walked again (new paths); a folder that left the tree (moved out, trashed, unshared) makes the next walk a full one.
  - **Weekly full walk:** whatever it didn't see is removed (the reconcile).
  - Removed or trashed files: `deletedAt` set and **text nulled**.
  - **Root folder 404** (gone or unshared): nothing is walked, the feed still runs (it reports the folder's files removed, so they leave search), the job fails, and the connector's error starts with "Google Drive: the shared folder is gone…" (the digest check below looks for it). When the folder is back, a full walk runs.
  - Stops at the job's deadline (with 45 s kept back) and saves the cursor after each page.

### SharePoint (`src/server/connectors/sharepoint/`, `src/server/connectors/microsoft/graph.ts`)
- **Microsoft sign-in:** client credentials against `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` for `https://graph.microsoft.com/.default`; the token lives for one client (one invocation). The Graph client retries 429/503/504 after Retry-After, signs in again on a 401, follows next and delta links **only when they point at the Graph base** (the token never goes elsewhere), and downloads files through Graph's 302 to a pre-signed link fetched **without** the token, never stored or logged.
- **Sync:** the library's delta (`/drives/{MS_DRIVE_ID}/root/delta`) from the stored delta link; a full enumeration the first time and weekly, which removes files it didn't see. Items with a `deleted` facet are removed (text nulled). Delta items carry no path, so a file's folder comes from one GET of its parent per folder per run. A 410 Gone starts a fresh enumeration. `externalId` is `driveId!itemId`; `version` is the eTag.
- **Private and shared channels keep their files in sites of their own**, each needing its own `Sites.Selected` grant from IT; this connector reads the one library `MS_SITE_ID` / `MS_DRIVE_ID` names. A second library would be a second connector (or a list in env); not built.

### Teams (`src/server/connectors/teams/`)
- **Change notifications** (`subscriptions.ts`, `webhook.ts`, `notifications.ts`): one Graph subscription per configured channel on `/teams/{team}/channels/{channel}/messages` (created, updated, deleted; no resource data, so no certificate). The `teams.subscriptions` job creates missing ones, renews ones with under 36 hours left (they last at most 3 days; the job runs every 12 hours, so each is renewed about every 48 hours), replaces ones made with an older `MS_GRAPH_CLIENT_STATE` (rows keep the secret's SHA-256, never the secret) and deletes ones for channels no longer configured.
- **The webhook routes** (`/api/webhooks/graph`, `/api/webhooks/graph/lifecycle`):
  - fail closed: without `MS_GRAPH_CLIENT_STATE` every request gets 503, validation included;
  - `?validationToken=` is echoed as `text/plain` (`nosniff`, at most 1,024 characters);
  - the raw body is read once (1 MB cap); each notification's `clientState` is compared in constant time (SHA-256 of both, `timingSafeEqual`); mismatches are dropped and counted in the log, never their content;
  - **202 at once**, the work in `after()`: Graph wants an answer within 3 s.
  - Graph's basic notifications carry no signature or timestamp, so there's no time window to check, and no message id to dedupe on. Instead every notification must also name a subscription of ours made with the current secret, for a configured channel of our team; notifications carry no data, so each one makes us fetch the message from Graph, and a repeated one in a batch is fetched once. Saving the same message twice changes nothing.
  - While the connector is off, valid notifications are acknowledged and dropped.
- **Lifecycle events:** `reauthorizationRequired` renews; `subscriptionRemoved` makes a new subscription and catches that channel up with its delta; `missed` catches up (Graph doesn't send it for chat messages yet).
- **Daily reconcile** (`sync.ts`, `teams.sync`): Microsoft allows polling a channel **once a day**, so this is the only scheduled read. A channel's first sync lists its threads with replies (`$expand=replies`, 50 a page) and then takes a delta link (`TeamsChannel.deltaLink`); later runs follow it and re-read each changed thread's replies (delta lists thread starts only). Calls on one channel stay a second apart (Graph's per-channel limit). Channels taken out of `MS_CHANNEL_IDS` stop syncing and **their messages are deleted**. The channel's name comes from Graph when the app may read it (`ChannelSettings.Read.Group`), else the stored name or the id.
- **Messages** (`messages.ts`, `html.ts`): HTML becomes text (paragraphs and breaks as lines, `<at>` as "@Name", links as "text (address)", emoji, "(image)", "(attachment)"), capped at 20,000 characters. System events are skipped. **A deleted message keeps only who wrote it and when: `content` "" and `deletedAt`.** Only officer channels are synced; there are no member DMs.

### Search, read and the Knowledge page
- **Search switches** (shared edits in T1's sources): `sources/teams.ts` reads the switch through `teamsConnector.enabled()` (it read `ConnectorState` directly until now); `sources/documents.ts` searches and reads only sources whose connector is on (`enabledDocumentSources()` in `connectors/documents/sources.ts`), says "Google Drive and SharePoint aren't connected" when both are off, explains the new text statuses, and marks partial text.
- **Knowledge → Documents** (`app/admin/knowledge/_documents/documents-tab.tsx`, registered in `_tabs/documents.tsx`): the documents from switched-on sources: name (opens in Drive or SharePoint, the host shown), a badge when its text is partial or wasn't read, folder, where, modified; search over names, folders and text; a source filter; 50 a page. A notice names a source that isn't connected; with none connected, an empty state links to Connections.
- **Knowledge → Teams messages** (`teams-tab.tsx`): only while Teams is on (else "Teams isn't connected" and a link): excerpt, reply/edited marks, "Open in Teams" (host shown), channel, author, time; search over text and authors; a channel filter.
- Officers only (the page's own check); everything is read-only there.

### Digest checks (`automation/checks/documents.ts`)
- `documents.drive-folder` (danger, order 92): the shared Drive folder is gone or unshared (Drive switched on, its newest error is the missing folder). Links to Connections.
- `documents.sync-failing` (warning, order 93): Drive, SharePoint or Teams switched on with an error newer than its last sync. Names the service, links to Connections, never the error text.

### Prompt and schema notes
- `prompt-sections/documents.ts`: synced copies (a bit behind), cite the link, say when a document's text couldn't be read instead of guessing, Sheets are their first tab, transcripts are speaker-tagged. Page line for the two Knowledge tabs.
- `tools/schema-notes-slots/documents.ts`: ExternalDocument, TeamsChannel, TeamsMessage, GraphSubscription for `describe_schema`.

## Env vars

| Name | Connector | What |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | google-drive | The service account's JSON key file, pasted whole (its `client_email` and `private_key` sign in; `private_key_id` becomes the JWT's `kid`). Sensitive. Already in `redactSecrets()`'s list |
| `GOOGLE_DRIVE_FOLDER_ID` | google-drive | The shared folder's id (the last part of its Drive URL). Changing it starts the index over |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | sharepoint, teams | The Entra app registration in UT's tenant. The secret is Sensitive |
| `MS_SITE_ID`, `MS_DRIVE_ID` | sharepoint | The site IT granted, and its document library's drive id (`b!…`) |
| `MS_TEAM_ID`, `MS_CHANNEL_IDS` | teams | The club team's id, and the channels to read, comma-separated (`19:…@thread.tacv2`; anything else is left out, and Connections says so) |
| `MS_GRAPH_CLIENT_STATE` | teams | A random secret (up to 128 characters) Graph sends back with each notification. Sensitive. Without it the webhook routes refuse everything |

`TEAMS_WEBHOOK_URL` (posting the digest to Teams) belongs to the automation track; nothing here posts anywhere.

## Setup (Gray)

**Google Drive** (research §2):
1. In a club-owned Google account (not utexas.edu), create a Cloud project, enable the Google Drive API, create a service account with **no IAM roles**, and download a JSON key.
2. Have the folder's owner share it with the service account's `client_email` as **Viewer**, with "Notify people" unticked.
3. In Vercel (Production, Sensitive): `GOOGLE_SERVICE_ACCOUNT_JSON` = the key file's contents; `GOOGLE_DRIVE_FOLDER_ID` = the folder id. Redeploy.
4. Connections → Google Drive → **Run smoke test** ("Read the folder …"), then switch it on. Scheduled jobs → `google-drive.sync` → on. The first runs walk the folder (a few runs for a big one); Knowledge → Documents fills in.
5. Key rotation: make a new key, update the env var, redeploy, then delete the old key (tokens already issued last up to an hour).

**SharePoint and Teams** (off until UT IT approves; research §2 and §9 has the ready-to-send request):
1. File the IT request: an app registration in UT's tenant, `Sites.Selected` with a `read` grant on our site (and on any private or shared channel's site we want), permission to install our Teams app with `ChannelMessage.Read.Group` (RSC), and confirmation that team RSC consent isn't disabled.
2. Our Teams app manifest needs `webApplicationInfo` with the app's id and `authorization.permissions.resourceSpecific` = `ChannelMessage.Read.Group` (Application). A **team owner** installs it in the club team. Adding `ChannelSettings.Read.Group` lets the sync read channel names; without it channels show by id until named.
3. Vercel (Production, Sensitive where secret): the `MS_*` values above. `MS_GRAPH_CLIENT_STATE`: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Channel ids are in each channel's link ("Get link to channel", the `19:…` part, URL-decoded).
4. The site's address must be `https://www.longhornsimracing.org` (Graph only calls https, and the subscription job builds the webhook URLs from the site URL).
5. Connections: smoke-test and switch on **SharePoint** and **Microsoft Teams**. Scheduled jobs: turn on `sharepoint.sync`; for Teams, run `teams.subscriptions` first (Graph calls `/api/webhooks/graph` to validate it), then turn on `teams.sync` (its first run copies each channel).
6. Tell the team that Jack reads those channels (installing the app is the consent; members should know).

**Transcripts:** with SharePoint or Drive connected, officers save a meeting's `.vtt` (or `.docx`) into a "Transcripts" folder and it's searchable speaker-tagged. The Graph transcript API (path 3) is not built: it needs tenant-wide permissions IT is unlikely to grant.

## Trying it locally (fakes, nothing real)
The fakes (`connectors/google-drive/fake/`, `connectors/microsoft/fake/`) hold a made-up folder, library and two channels ("Fixture …" names), with test hooks under `/_fake/*` (mutate the data, emit notifications, fail calls, expire tokens).

```bash
cd apps/platform
pnpm jack:fakes        # in its own terminal: http://127.0.0.1:3999 lists google-drive and microsoft-graph
```

In `.env.local` (all fixture values from `fake/fixtures.ts`):
```
JACK_FAKES=all
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","client_email":"jack-drive@lsr-fixture.iam.gserviceaccount.com","private_key":"<any PEM key, \n-escaped>"}
GOOGLE_DRIVE_FOLDER_ID=fixture-root
MS_TENANT_ID=fixture-tenant
MS_CLIENT_ID=fixture-client-id
MS_CLIENT_SECRET=fixture-client-secret
MS_SITE_ID=fixture.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222
MS_DRIVE_ID=b!fixture-drive
MS_TEAM_ID=fbe2bf47-0000-4000-8000-000000000001
MS_CHANNEL_IDS=19:fixture-general@thread.tacv2,19:fixture-sponsorship@thread.tacv2
MS_GRAPH_CLIENT_STATE=fixture-client-state-0123456789abcdef
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```
A key for the fake (it checks the JWT's claims, not the key): `node -e "const {generateKeyPairSync}=require('crypto');console.log(JSON.stringify(generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey))"` (paste the quoted output as `private_key`).

Then, on **your own** local database (switches on a shared one affect every worktree): Connections → smoke-test and switch on the three; `pnpm jack:tick --job google-drive.sync`, `--job sharepoint.sync`, `--job teams.subscriptions` (the fake calls your dev server's webhook to validate; `NEXT_PUBLIC_SITE_URL` must be the dev server), `--job teams.sync`. Knowledge → Documents and Teams messages fill in; ask Jack about the storage closet inventory. To see a live notification: `curl -X POST http://127.0.0.1:3999/microsoft-graph/_fake/mutate -d '{"op":"post","channelId":"19:fixture-general@thread.tacv2","text":"Hello"}'` then `curl -X POST http://127.0.0.1:3999/microsoft-graph/_fake/emit -d '{"messageId":"<the id it returned>"}'`.

**DB check** (local only, writes only rows it deletes again, never touches ConnectorState):
```bash
NODE_ENV=production pnpm exec tsx scripts/check-jack-documents.ts
```
It runs the stores, the search triggers, the Knowledge tabs' queries and the real Drive and SharePoint syncs against their fakes (started in-process on a free port) into throwaway sources.

## Eval
- Questions (`scripts/jack-eval/tracks/documents.ts`): a count from a Drive document, a speaker from a SharePoint transcript, a time from a Teams message, a Drive document whose text can't be read (judged), and the **Drive injection case** (`safety-injected-drive-doc`: the fake "Sponsor Outreach Notes" plants an instruction and a `*.example` link). Each needs `search` and `read`, and is skipped when its record isn't in the eval copy.
- Fake data (`seed/documents.ts`): with `pnpm jack:fakes` running, `pnpm jack:eval:prepare` syncs the fakes into the eval copy with the real sync code (each time from scratch, since the fakes' change positions reset on restart) and switches `google-drive`, `sharepoint` and `teams` on **in the eval copy only**.
- Nothing these tools do writes anything, so the eval cleanup needs no change.

## Tests
`connectors/documents/text.test.ts` (readers, checks, PowerPoint, caps, names), `google-drive/{auth,client,sync}.test.ts` (the JWT signed with a throwaway key and verified, sign-in errors, token reuse, retries, paging, exports, downloads; the sync: parent-walk filtering, outside files, shortcuts, trash, deletions, moves out, folder renames, a folder leaving the tree, the missing root and its return, the weekly reconcile, deadlines, no credentials in the cursor), `microsoft/graph.test.ts` (sign-in, retries, refused foreign links, the token-free download), `sharepoint/sync.test.ts` (paths, transcripts, paging and resume, delta changes, 410, the weekly reconcile), `teams/{messages,sync,subscriptions,notifications}.test.ts` (HTML, resources, backfill with replies, delta, edits and deletions, dropped channels, per-channel pacing, subscription upkeep and 409, notification and lifecycle handling and what's dropped), `app/api/webhooks/graph/route.test.ts` (validation echo, fail-closed, clientState, 202 then `after()`, sizes), `scheduler/jobs/documents.test.ts` (skips, the Drive job and the missing folder), `automation/checks/documents.test.ts`, and additions to `jack/search/search.test.ts`.

## Choices made here
- **Env names follow design §15 and G1's `.env.example`** (`GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID`), not the research file's `GOOGLE_DRIVE_SA_*`: one key file to paste, already redacted by name.
- One Drive job does everything (the feed, the first walk, the weekly walk), handing off every 15 minutes, instead of separate feed and walk jobs: one switch for Gray, and a walk that needs several runs simply continues.
- A connector switched off hides its documents and messages everywhere (search, read, the tabs), as T1 did for Teams.
- Folder changes in Drive: a renamed or moved-in folder gets its subtree walked; a folder leaving the tree makes a full walk (Drive doesn't report each child, and our rows don't keep folder ids).
- SharePoint paths under a renamed folder update at the weekly enumeration (delta reports the folder, not its children).
- Taking a channel out of `MS_CHANNEL_IDS` deletes its synced messages (privacy first; they come back if it's added again).
- Graph notifications: no dedupe table (Graph's basic notifications have no message id; processing is idempotent, and repeats within a batch are fetched once). No timestamp window (Graph sends none).

## Notes for the next PRs
- **sponsors-meetings (T10):** `Meeting.transcriptDocumentId` can point at an `ExternalDocument` in a Transcripts folder; its `text` is already speaker-tagged like G5's VTT extractor.
- **automation (T11):** the digest checks are `documents.drive-folder` and `documents.sync-failing`. Posting the digest to Teams (`TEAMS_WEBHOOK_URL`, Workflows) isn't built here.
- **Other connectors' registry tests:** `connectors/registry.test.ts` now compares only the ids it mocks, since real connectors sit in the other slots.
- **Not verified live** (no access yet): Graph's channel-message delta (no REST reference page; the research marks its options UNVERIFIED), whether `Sites.Selected` covers drive delta and children (expected), the reply resource format in notifications (both forms parsed), and whether Drive's changes feed reports every descendant of a shared folder (the weekly walk is the safety net). Smoke tests and the first real runs will show.
