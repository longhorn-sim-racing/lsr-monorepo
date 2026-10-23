# Google Drive (read-only folder) for Jack 2.0

Researched 2026-10-22 from developers.google.com (Drive API v3 reference and guides), the live Drive v3 discovery document (revision `20261012`), Google Cloud IAM docs and Vercel's OIDC docs. Anything marked **UNVERIFIED** was not stated in a primary source I read.

## 1. What we'd use it for

The club keeps its working files (sponsor decks, meeting notes, budgets, rules drafts, event plans) in one Drive folder owned by a personal Gmail account. Jack 2.0 gets a **read-only** view of that folder through a Google Cloud **service account** (SA) that the owner shares the folder with as **Viewer**. A scheduled job (Supabase pg_cron + pg_net calling a Vercel route) walks the folder tree, exports Docs, Sheets and Slides to text, downloads PDFs, and indexes the text in Postgres. Jack's tools then search that index, fetch a document's current text on demand, and link officers to `webViewLink`. Re-syncs use the **changes feed** (`changes.list` with a saved page token), so each run only touches files that changed. Nothing writes to Drive, nothing moves money, and nothing runs as a long-lived process.

## 2. Auth and setup

**One-time setup (Google Cloud console, signed in as a club-controlled Google account):**
1. Create a project (for example `lsr-jack`). Use a club Gmail, **not** a utexas.edu account. A project with no organization is not subject to the "secure by default" policy `iam.disableServiceAccountKeyCreation` (listed as the managed constraint `iam.managed.disableServiceAccountKeyCreation` on the secure-by-default page), which is enforced by default on organizations created on or after 2024-05-03. A UT Workspace org could block key creation (that last point is an inference: consumer accounts have no organization resource, and Google's page only covers organizations).
2. Enable **Google Drive API** (`drive.googleapis.com`). Optionally enable **Google Sheets API** too, for multi-tab sheets (see 3e).
3. IAM & Admin → Service Accounts → Create service account (for example `jack-drive`). **Grant no IAM roles.** Cloud IAM roles don't grant access to Workspace data such as Drive files. Note the email: `jack-drive@lsr-jack.iam.gserviceaccount.com`.
4. Keys tab → Add key → Create new key → JSON. You can download it only once. Keys **never expire by default**, and an SA can hold at most 10 keys.
5. The **folder owner** opens Drive → right-click the folder → Share → pastes the SA email → role **Viewer** → **unticks "Notify people"** (SAs have no inbox) → Share. Viewer on a folder covers every file and subfolder inside it. No domain-wide delegation or admin role is needed.

**Scope:** `https://www.googleapis.com/auth/drive.readonly` ("See and download all your Google Drive files"). It's the narrowest scope that can both list a shared folder and read file content:
- `drive.file` only covers files the app created or opened, so it can't see a shared folder.
- `drive.metadata.readonly` can't download or export content.
- Google classes `drive.readonly` as **Restricted**. Verification and the security assessment apply to OAuth consent-screen apps. Google's "verification not needed" list includes "The app only accesses its own data (using a Service Account), and not user data (linked to a Google Account)", and separately "personal use (fewer than 100 users)". The SA JWT flow never shows a consent screen, so in practice nothing is triggered. **UNVERIFIED:** whether that exemption covers data a person shares *to* the SA. The second half of the wording ("not user data linked to a Google Account") cuts against us, since the folder belongs to a personal Gmail.

**Token flow (no `googleapis` package needed):** sign a JWT yourself with `node:crypto` and swap it for an access token.
- Header: `{"alg":"RS256","typ":"JWT","kid":"<private_key_id>"}` (`kid` is optional).
- Claims: `iss` = SA email; `scope` = `https://www.googleapis.com/auth/drive.readonly` (space-delimited if more than one); `aud` = `https://oauth2.googleapis.com/token`; `iat` = now (seconds); `exp` = at most `iat + 3600`. No `sub` (that is for domain-wide delegation only).
- Send `POST https://oauth2.googleapis.com/token` with `Content-Type: application/x-www-form-urlencoded`, `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion=<jwt>`.
- Response: `{"access_token":"ya29.c.…","expires_in":3600,"token_type":"Bearer"}`. There is **no refresh token**: sign a new JWT when the token expires. Cache it in module scope and re-mint about 5 minutes before expiry. Clock skew causes `invalid_grant`.
- Token errors to handle: `invalid_grant` (bad `iat`/`exp` or clock, wrong key, bad signature), `invalid_scope`, `invalid_client`, `disabled_client` (key disabled), `deleted_client`.
- The "self-signed JWT without OAuth" shortcut (`aud: https://drive.googleapis.com/`) works only for APIs that have a service definition in the googleapis GitHub repo. That repo's `google/apps/drive/` holds only `activity` and `labels`, with no Drive v3 definition, so by Google's own rule Drive v3 doesn't qualify. Don't use it.

```ts
import { createSign } from "node:crypto";
const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const iat = Math.floor(Date.now() / 1000);
const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }))}.${b64u(JSON.stringify({
  iss: email, scope: "https://www.googleapis.com/auth/drive.readonly",
  aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }))}`;
const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
// POST to GOOGLE_OAUTH_TOKEN_URL with URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
```

Package sizes, if we'd rather not hand-roll this: `google-auth-library@11.3.1` is about 0.78 MB unpacked (its `JWT` class does the same thing). `@googleapis/drive@27` is about 2.5 MB. The full `googleapis@188` is **about 246 MB**: avoid it. A hand-rolled `fetch` client is also the easiest thing to point at a fake.

**Keyless alternative (hardening, later):** Vercel OIDC → GCP Workload Identity Federation. It's available on all Vercel plans:
- Setup: a pool and provider with issuer `https://oidc.vercel.com/<team_slug>` (team issuer mode; global mode uses `https://oidc.vercel.com`) and mapping `google.subject = assertion.sub`. Then grant the principal `…/subject/owner:<team>:project:<project>:environment:production` the right to impersonate the SA: Google names the role Workload Identity User (`roles/iam.workloadIdentityUser`), and Vercel's console steps paste the principal into the SA's "Service account users role" field.
- Code: `google-auth-library`'s `ExternalAccountClient` (token URL `https://sts.googleapis.com/v1/token`, impersonation via `iamcredentials.googleapis.com/…:generateAccessToken`) plus `@vercel/oidc` `getVercelOidcToken`.
- Env vars: `GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL`, `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`. Vercel also lists `GCP_PROJECT_ID`, plus `GCP_AUDIENCE` if you use the provider's default audience.
- Trade-off: there's no key to leak, but local and preview runs get harder.
- APIs to enable (Google's WIF guide): IAM (`iam.googleapis.com`), Resource Manager (`cloudresourcemanager.googleapis.com`), IAM Service Account Credentials (`iamcredentials.googleapis.com`) and Security Token Service (`sts.googleapis.com`).

**Env vars (key-based v1):**

| Var | Value |
|---|---|
| `GOOGLE_DRIVE_SA_EMAIL` | `client_email` from the JSON key |
| `GOOGLE_DRIVE_SA_PRIVATE_KEY` | `private_key` PEM. Vercel stores `\n` literally, so use `.replace(/\\n/g, "\n")` |
| `GOOGLE_DRIVE_SA_KEY_ID` | `private_key_id` (optional, used as `kid`) |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | The shared folder's ID (the last part of its Drive URL) |
| `GOOGLE_DRIVE_API_BASE` | Default `https://www.googleapis.com`; points at the fake locally |
| `GOOGLE_OAUTH_TOKEN_URL` | Default `https://oauth2.googleapis.com/token`; points at the fake locally. Keep the JWT `aud` fixed to the real URL |

## 3. Endpoints we need

Base URL: `https://www.googleapis.com/drive/v3/`. Every call sends `Authorization: Bearer <access_token>`. The folder lives in a personal **My Drive**, not a shared drive, so `supportsAllDrives` and `includeItemsFromAllDrives` aren't needed. Passing `supportsAllDrives=true` anyway is harmless and future-proof. int64 fields (`size`, `version`) come back as **strings**.

### 3a. List a folder's children (recursive walk): `files.list`

`GET /drive/v3/files?q=…&fields=…&pageSize=1000&pageToken=…`
- `q`: `'<folderId>' in parents and trashed = false`. `parents` matches **direct children only**: there's no recursive operator. Walk breadth-first and queue every child whose `mimeType = application/vnd.google-apps.folder`.
- **Always add `trashed = false`.** The method "returns *all* files by default, including trashed files". Other users can still open the owner's trashed files until they're permanently deleted.
- `fields`: by default you get only `kind,id,name,mimeType`. Ask for `nextPageToken,incompleteSearch,files(id,name,mimeType,parents,modifiedTime,version,size,md5Checksum,webViewLink,trashed,shortcutDetails,capabilities/canDownload)`. Use the `a/b` form for nested fields; `*` is discouraged for performance.
- `pageSize`: maximum 1000 (higher values are coerced to 1000); the server may return fewer. Loop until `nextPageToken` is absent. The token is "typically valid for several hours". If it's rejected, restart from page 1.
- `corpora=user` (the default) and `spaces=drive` (the default). `orderBy` is optional; without it the order is arbitrary. Use `modifiedTime desc`, not `createdTime`, on large sets.

```json
{ "nextPageToken": "~!!~AI9FV7Q…",
  "incompleteSearch": false,
  "files": [
    { "id": "1aB…", "name": "Sponsor Deck F26", "mimeType": "application/vnd.google-apps.presentation",
      "parents": ["1Root…"], "modifiedTime": "2026-10-20T18:04:11.512Z", "version": "57",
      "webViewLink": "https://docs.google.com/presentation/d/1aB…/edit?usp=drivesdk",
      "trashed": false, "capabilities": { "canDownload": true } },
    { "id": "1cD…", "name": "budget.pdf", "mimeType": "application/pdf", "parents": ["1Sub…"],
      "modifiedTime": "2026-09-30T02:11:00.000Z", "version": "3", "size": "482113",
      "md5Checksum": "9e107d9d372bb6826bd81d3542a419d6", "trashed": false } ] }
```

Shortcuts (`application/vnd.google-apps.shortcut`) carry `shortcutDetails.targetId` and `targetMimeType`. Follow the target only if the SA can read it, and expect 404 when it can't.

### 3b. Full-text search: `files.list` with `fullText contains`

- `q`: `fullText contains 'sponsor packet' and trashed = false`.
  - `fullText` searches `name`, `description`, `indexableText` and file content.
  - It supports only `contains`, matched on **whole tokens**. Wrap a phrase in double quotes inside the single quotes for an exact match: `fullText contains '"lone star cup"'`.
  - Escape `'` and `\` with a backslash.
- Recursive scoping options:
  - **(a)** AND the search with an OR of every known folder ID: `(... ) and ('f1' in parents or 'f2' in parents …)`. The maximum `q` length is **UNVERIFIED**, so chunk the folder IDs.
  - **(b)** Search corpus-wide (the SA can only see what's shared with it), then drop any hit whose ID isn't in our synced index.
- **UNVERIFIED:** whether the `user` corpus includes files reached only through a shared *folder*. Google defines it as files the user created or opened, plus files "shared directly with the user". Treat Drive search as a fallback and **search our Postgres index first**.
- Results come back in **descending relevance order**, with no score exposed. `orderBy` is **not allowed** with `fullText` terms: it returns 400 `badRequest` "Sorting is not supported for queries with fullText terms. Results are always in descending relevance order." Check `incompleteSearch`.
- Errors: 400 `badRequest` (bad query syntax, or `orderBy` combined with `fullText`).

### 3c. Export Google Docs, Sheets and Slides: `files.export`

`GET /drive/v3/files/{fileId}/export?mimeType=<type>` returns the raw bytes, not JSON. **Exported content is limited to 10 MB.**

| Source mimeType | Export as | Notes |
|---|---|---|
| `application/vnd.google-apps.document` | `text/markdown` (best for Claude) or `text/plain` | `text/html` and `application/pdf` also exist |
| `application/vnd.google-apps.spreadsheet` | `text/csv` | **First sheet only**. Multi-tab: see 3e |
| `application/vnd.google-apps.presentation` | `text/plain` | All slides, flattened |
| `application/vnd.google-apps.drawing` | `image/png`, `image/jpeg`, `image/svg+xml`, `application/pdf` | Usually skip |

- Partial (`Range`) downloads are **not** supported on export.
- Errors:
  - Over 10 MB: 403 with reason `exportSizeLimitExceeded` and message "This file is too large to be exported." The reason string comes from community reports: **UNVERIFIED** in Google's docs. Fall back to the Docs or Sheets API, or skip with a note.
  - `alt=media` on a Workspace file: 403 `fileNotDownloadable` ("Only files with binary content can be downloaded. Use Export with Docs Editors files."). Google's error page shows this for `revisions.get`. `files.get` documents the same restriction ("`alt=media` only works if the file is stored in Drive") but not the reason string.
  - Google Vids: 403 `fileNotExportable`.
- **Quota cost of `export`:** **UNVERIFIED.** Assume the 200-unit "download" tier.

### 3d. Download PDFs and other blobs: `files.get?alt=media`

- `GET /drive/v3/files/{fileId}?alt=media` returns the raw bytes. A `Range: bytes=0-1048575` header gives partial downloads.
- It works only for content stored in Drive, not Docs Editors files.
- Check `capabilities.canDownload` first. The owner can set "viewers can't download" (`copyRequiresWriterPermission`, `downloadRestrictions.effectiveDownloadRestrictionWithContext.restrictedForReaders`), and a Viewer SA is then blocked (403, exact reason **UNVERIFIED**).
- Leave `acknowledgeAbuse` false: it only applies to the owner.
- Skip large files using `size` before downloading. Vercel functions buffer in memory and are capped at 300 s on Hobby (300 s is also Pro's default; Pro can raise it to 800 s).
- Use `md5Checksum` or `version` to skip unchanged blobs.
- Metadata only: `GET /drive/v3/files/{fileId}?fields=id,name,mimeType,parents,modifiedTime,version,trashed,webViewLink` costs 5 units.
- `files.download` (`POST /files/{id}/download`) is the long-running-operation variant: it returns `{name, done, response.downloadUri}` and you poll `GET /drive/v3/operations/{name}`. It's needed only for Google Vids, so **we don't use it**.
- For PDF text, either send the PDF bytes to Claude as a document block or extract the text ourselves. Drive itself offers no PDF-to-text read path (OCR conversion is a write).

### 3e. Multi-tab Sheets (optional)

- Sheets API v4 accepts our `drive.readonly` scope. You must enable the Sheets API in the project.
- First call `GET https://sheets.googleapis.com/v4/spreadsheets/{id}?fields=sheets.properties(title,sheetId)`, then `GET …/v4/spreadsheets/{id}/values:batchGet?ranges=Tab1&ranges=Tab2`, which returns `{valueRanges:[{range,values:[[…]]}]}`.
- Quota: 300 reads/min per project and **60 reads/min per user**. Our SA counts as one user.
- Another option is to export `xlsx` and parse it locally.

### 3f. Change detection: `changes.getStartPageToken` + `changes.list`

1. On first full sync, call `GET /drive/v3/changes/startPageToken` → `{"kind":"drive#startPageToken","startPageToken":"84213"}`. Store it before the walk so nothing is missed. The token **never expires**.
2. Each cron run, call `GET /drive/v3/changes?pageToken=<saved>&pageSize=1000&fields=nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType,file(id,name,mimeType,parents,modifiedTime,version,trashed,md5Checksum,size,webViewLink))`.
   - Defaults that matter: `includeRemoved=true`, `restrictToMyDrive=false` (so it **includes** "shared files which have not been added to My Drive", which is our case), `spaces=drive`. `pageToken` is required.
   - Changes arrive oldest first. Follow `nextPageToken`. On the last page, save `newStartPageToken`.
3. For each change:
   - `removed: true` (deleted, or the SA lost access, including the file being moved out of the folder): delete it from the index.
   - `file.trashed: true`: delete it from the index.
   - Otherwise keep it only if `file.parents` leads to the root through our known folder set. Then re-export it if `version` or `modifiedTime` changed. If it's a folder, walk it.

```json
{ "kind": "drive#changeList", "newStartPageToken": "84230",
  "changes": [
    { "changeType": "file", "fileId": "1aB…", "removed": false, "time": "2026-10-21T15:02:44.120Z",
      "file": { "id": "1aB…", "name": "Sponsor Deck F26", "mimeType": "application/vnd.google-apps.presentation",
                "parents": ["1Root…"], "modifiedTime": "2026-10-21T15:02:43.900Z", "version": "58", "trashed": false } },
    { "changeType": "file", "fileId": "1zZ…", "removed": true, "time": "2026-10-21T16:10:05.002Z" } ] }
```

- The changes feed covers **everything the SA can see**, including other files someone shares with the SA email. Always filter by our folder set.
- Fallback if the feed misbehaves for shared-folder descendants: a full re-walk comparing `version`. **UNVERIFIED in practice for inherited access, so smoke-test it.** That costs about 100 units per folder page and is cheap at club scale.
- `modifiedTime > '…'` in `q` only works per folder (it's not recursive), so the changes feed is the better primitive.

### Errors to handle (all endpoints)

Body shape: `{"error":{"code":403,"message":"…","errors":[{"domain":"usageLimits","reason":"rateLimitExceeded","message":"…"}]}}`. Google's Drive error examples show only `code`, `message` and `errors`. A `"status"` field or `details[]` (ErrorInfo) may also appear, but that's **UNVERIFIED** as guaranteed, so don't depend on it.

| HTTP | reason | Action |
|---|---|---|
| 400 | `badRequest` / `invalid`* | Bad `q` or `fields`, or `orderBy` with `fullText`. Log it, don't retry |
| 401 | `authError` | Re-mint the token once, then fail |
| 403 | `userRateLimitExceeded`, `rateLimitExceeded` | Exponential backoff: `min(2^n s + jitter ≤1 s, 32–64 s)` |
| 403 | `fileNotDownloadable`, `fileNotExportable`, `exportSizeLimitExceeded`* | Mark the file as unreadable, skip |
| 403 | API disabled (legacy `errors[].reason` `accessNotConfigured`*, or ErrorInfo reason `SERVICE_DISABLED`, domain `googleapis.com`) | Config error: alert an officer |
| 404 | `notFound` | Gone or no access: remove it from the index |
| 429 | `rateLimitExceeded` | Back off |
| 500/502/503/504 | — | Back off and retry |

\* reason string **UNVERIFIED** in primary docs (not on Drive's error page; seen only in community reports). `SERVICE_DISABLED` is defined in Google's `google/api/error_reason.proto`.

## 4. Webhooks / push notifications (optional; polling recommended)

- **Endpoints:** `POST /drive/v3/changes/watch?pageToken=<token>` (or `files/{id}/watch`) with body `{"id":"<uuid, ≤64 chars>","type":"web_hook","address":"https://<our-domain>/api/drive/notify","token":"<secret ≤256 chars>","expiration":<unix ms>}`. The response is a Channel: `{kind:"api#channel",id,resourceId,resourceUri,token,expiration}`.
- **Lifetime:** changes channels last at most **604800 s (1 week)**, files channels at most 86400 s (1 day), and the default is 1 hour. There is **no auto-renew**: re-watch with a new `id` before expiry (pg_cron could do this) and stop old channels with `POST /drive/v3/channels/stop {id, resourceId}`.
- **Address:** must be HTTPS with a valid (not self-signed) certificate, which Vercel provides. **No domain verification needed:** Google's API Console help says "Domain verification in the API Console is no longer required to make push notifications work with your domains."
- **Delivery:** `POST` with an **empty body**. Headers: `X-Goog-Channel-ID`, `X-Goog-Message-Number`, `X-Goog-Resource-ID`, `X-Goog-Resource-State` (`sync|add|remove|update|trash|untrash|change`), `X-Goog-Resource-URI`, and optionally `X-Goog-Changed` (`content,properties,parents,children,permissions`), `X-Goog-Channel-Expiration` and `X-Goog-Channel-Token`. Ignore unknown states, since Google may add more. The first message is `sync` (message number 1) and can arrive before the watch response. Later message numbers increase but aren't sequential.
- **"Signature" verification:** there's **no HMAC**. The only check is comparing `X-Goog-Channel-Token` to our secret with a timing-safe compare, plus matching `X-Goog-Channel-ID` against stored channel IDs. Reply `200` or `204` fast. Notifications carry no data, so the handler would just trigger the same `changes.list` sync.
- **Verdict:** a 15–30 minute pg_cron poll gives the same result with no channel bookkeeping. Skip push for v1.

## 5. Rate limits, quotas, plan limits, retention

- **New quota model** for Cloud projects created on or after **2026-05-01** (ours would be new): **1,000,000 quota units/min per project** and **325,000 units/min per user per project**.
  - Costs: read (`files.get` metadata) 5, list (`files.list`, presumably `changes.list` too) 100, download (`files.download`) 200, edit 50, other 5.
  - At club scale (a few hundred files) a full walk is well under 50k units.
- **Daily:** no request cap within the per-minute limits. The billing threshold is **400M units per project per day**, and you can't request an increase. Egress is 1 TB/day per project. Standard use is free, but exceeding quota "is planned to incur charges" later in 2026, with at least 90 days' notice. Set a billing alert if billing is ever attached.
- `changes.watch`, `files.watch` and `channels.stop` calls count against quota; notification deliveries don't.
- **Batch:** `POST https://www.googleapis.com/batch/drive/v3`, at most 100 calls per batch. It **does not reduce quota**.
- **gzip:** send `Accept-Encoding: gzip` and a `User-Agent` containing `gzip`.
- **Sheets API:** 300 reads/min per project, 60 per user, a 2 MB recommended payload and a 180 s timeout.
- **Retention and lifetimes:**
  - Access token: 1 h.
  - JWT `exp`: at most 1 h.
  - SA key: no expiry by default.
  - Changes `startPageToken`, `nextPageToken` and `newStartPageToken`: **don't expire**.
  - `files.list` `nextPageToken`: about "several hours".
  - `files.download` operation: at least 12 h (the discovery doc says 24 h).
  - Storage counts against the **owner's** Gmail quota (15 GB free tier). SAs have no storage quota, which doesn't matter for read-only use.
- **Vercel Hobby:** 300 s maximum per invocation. Make the sync resumable: persist the walk queue and change token between runs, and cap the files processed per run.

## 6. Gotchas, policy and privacy

- **Owner risk:** the folder lives in one person's Gmail. If they leave, delete the account or unshare, every call returns 404 or `removed`. Prefer a club-owned account, and alert when the root folder 404s.
- **Trash:** always add `trashed = false`. Trashed items stay readable to the SA until they're permanently deleted.
- **Scope breadth:** `drive.readonly` technically allows reading *anything* shared with the SA email. Keep the email private, and filter every result against the synced folder set so an outside share can't leak into Jack.
- **Download-restricted files:** they fail for a Viewer SA. Surface "can't read: owner restricted downloads" instead of erroring.
- **Shortcuts** point outside the tree. Only follow them if the target is inside our set, or treat them as links only.
- **Folder hierarchy:** `parents` holds a single parent (one parent per file in v3). Folder depth is at most 100 levels, and a folder holds at most 500k direct children.
- **Names aren't unique,** so key everything by `id`. IDs are stable across renames.
- **Workspace User Data policy:** it bans using Workspace API data "to create, train, or improve" AI/ML models (Anthropic's API doesn't train on our inputs by default). The ToS also prohibits "building databases (including databases for model training purposes)". Our index is an internal retrieval cache of the club's own files, not a model-training dataset, but **UNVERIFIED** whether Google would read that clause as covering it. Keep the index minimal (text plus metadata), and delete entries when files are removed.
- **Privacy:**
  - Drive files may contain member PII (sign-up sheets, emails). Per `feedback_jack_reads_everything`, Jack may read it.
  - Never send Drive text to public pages, and don't log file contents.
  - Store the SA key only in Vercel env vars (prod) and `~/.lsr` (local), never in the repo.
  - Rotate it by creating a new key and deleting the old one. Deleting a key doesn't revoke tokens already minted, which live up to 1 h.
- **Export quirks:**
  - CSV is first-sheet only.
  - Exports over 10 MB fail.
  - Export doesn't support partial (`Range`) downloads.
  - Workspace files have no `md5Checksum` or `headRevisionId`, so use `version` or `modifiedTime` for change checks.

## 7. How to fake it locally

Build a small HTTP fake (a Next route handler under `/api/dev/fake-google/*` or a standalone `tsx` server), selected by `GOOGLE_DRIVE_API_BASE` and `GOOGLE_OAUTH_TOKEN_URL`. Our client must use only those two base URLs.

**Fixture tree** (JSON on disk):
- A root folder with 2 levels of subfolders.
- A Doc, a multi-tab Sheet and a Slides deck, each with canned exports.
- PDF and PNG blobs.
- A shortcut, a trashed file and a download-restricted file.
- A >10 MB-export doc (flagged, not real bytes).
- A file shared to the SA **outside** the root.

The fake must reproduce:
1. **`POST /token`**: accept the form body, check `grant_type` is the jwt-bearer URN, decode the JWT and check `iss`/`scope`/`aud`/`exp - iat ≤ 3600`. Optionally verify RS256 against a test public key. Return `{access_token, expires_in: 3600, token_type: "Bearer"}`. Return `400 {"error":"invalid_grant","error_description":"…"}` for a bad or expired JWT.
2. **Bearer check** on every Drive call: a missing or unknown token gets `401` with reason `authError`. A switch should expire tokens early so we can test re-mint.
3. **`GET /drive/v3/files`**: a `q` parser for the subset we use.
   - Terms: `'id' in parents`, `trashed = true|false`, `mimeType = '…'` / `!=`, `name contains`, `fullText contains '…'` (token match, `"phrase"` support), `modifiedTime > '…'`, combined with `and`/`or`/`not`/parentheses, with `\'` escapes. Return `400 badRequest` on anything else.
   - Return trashed files unless they're filtered out.
   - `orderBy` together with `fullText contains` returns `400 badRequest`. `fullText` results come back in a stable "relevance" order.
   - `pageSize` (coerce >1000 to 1000), opaque `nextPageToken`, `incompleteSearch: false`. Google's docs say an unspecified `pageSize` returns "the entire list of files for non-shared drives" (the discovery default is 100). Our client always sends `pageSize=1000`, so the fake can default to 100.
   - **`fields` projection**: with no `fields`, return only `kind,id,name,mimeType`, so a missing `fields` shows up as a bug in tests.
   - int64 as strings.
4. **`GET /drive/v3/files/{id}`** (metadata, `fields`), `?alt=media` (bytes, `Range` → 206), and `404 notFound` for unknown or unshared IDs. `alt=media` on a Workspace type returns `403 fileNotDownloadable`. A restricted file returns 403.
5. **`GET /drive/v3/files/{id}/export?mimeType=`**: canned bytes per (source type, target type) pair. CSV holds the first sheet only. An oversize export returns `403 exportSizeLimitExceeded`. An unsupported pair returns 400.
6. **`GET /drive/v3/changes/startPageToken`** and **`GET /drive/v3/changes`**: an append-only change log (integer cursor as an opaque string).
   - `pageSize`, `nextPageToken`, and `newStartPageToken` only on the last page.
   - `removed: true` entries carry no `file`. Include changes for the outside-root file.
   - A test hook (`POST /_fake/mutate`) to rename, edit, move out, trash or delete files and append changes.
7. **Fault injection:** query flags or a control endpoint to return `403 userRateLimitExceeded`, `429`, `500` or `503` for the next N calls, to exercise backoff.
8. Optional: **`GET /v4/spreadsheets/{id}`** and **`…/values:batchGet`** on a fake Sheets base URL, if we use 3e.
9. Optional: push. A helper that POSTs an empty-body notification with the `X-Goog-*` headers (including `X-Goog-Channel-Token`) to our notify route.

## 8. Sources

- https://developers.google.com/identity/protocols/oauth2/service-account
- https://developers.google.com/workspace/guides/create-credentials
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- https://developers.google.com/workspace/drive/api/reference/rest/v3/changes
- https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list
- https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken
- https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/watch
- https://www.googleapis.com/discovery/v1/apis/drive/v3/rest (revision 20261012; parameter defaults, schemas)
- https://sheets.googleapis.com/$discovery/rest?version=v4 (Sheets scopes)
- https://developers.google.com/workspace/drive/api/guides/search-files
- https://developers.google.com/workspace/drive/api/guides/ref-search-terms
- https://developers.google.com/workspace/drive/api/guides/ref-export-formats
- https://developers.google.com/workspace/drive/api/guides/manage-downloads
- https://developers.google.com/workspace/drive/api/guides/long-running-operations
- https://developers.google.com/workspace/drive/api/guides/manage-changes
- https://developers.google.com/workspace/drive/api/guides/push
- https://developers.google.com/workspace/drive/api/guides/shortcuts
- https://developers.google.com/workspace/drive/api/guides/about-files
- https://developers.google.com/workspace/drive/api/guides/fields-parameter
- https://developers.google.com/workspace/drive/api/guides/performance
- https://developers.google.com/workspace/drive/api/guides/limits
- https://developers.google.com/workspace/drive/api/guides/handle-errors
- https://developers.google.com/workspace/sheets/api/limits
- https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- https://support.google.com/cloud/answer/13464323 (when verification is not needed)
- https://docs.cloud.google.com/iam/docs/keys-create-delete
- https://docs.cloud.google.com/resource-manager/docs/secure-by-default-organizations
- https://vercel.com/docs/oidc/gcp
- https://vercel.com/docs/functions/configuring-functions/duration
- https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers
- https://support.google.com/googleapi/answer/7072069 (push domain verification no longer required)
- https://github.com/googleapis/googleapis/tree/master/google/apps/drive (no Drive v3 service definition)
- https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto (`SERVICE_DISABLED`)
- npm registry (`google-auth-library` 11.3.1, `@googleapis/drive` 27.0.0, `googleapis` 188.0.0 unpacked sizes)
- Secondary (for `exportSizeLimitExceeded` only): https://forum.rclone.org/t/setting-exportsizelimit-for-drive-remotes/7130

## Checked

Re-verified 2026-10-22 against Google's Drive v3 reference and guides, the live discovery documents (Drive `20261012`, Sheets `20261019`), Google Cloud IAM docs, Vercel docs and the npm registry.

**Verified as written:**
- Endpoints and methods (from discovery): `GET files`, `GET files/{id}` (`alt=media`), `GET files/{id}/export` (`mimeType` required), `POST files/{id}/download`, `GET operations/{name}`, `GET changes/startPageToken`, `GET changes` (`pageToken` required), `POST changes/watch`, `POST files/{id}/watch`, `POST channels/stop`, and batch at `batch/drive/v3` (100 calls max, no quota saving).
- Scopes:
  - `drive.readonly` is accepted by every method we use, and by Sheets `spreadsheets.get` and `values.batchGet`.
  - `drive.metadata.readonly` is not accepted by `export`.
  - Google classes `drive.readonly` as Restricted.
- SA JWT flow:
  - Header and claims, `aud` = `https://oauth2.googleapis.com/token`, `exp` at most 1 h, the jwt-bearer `grant_type`, and no refresh token.
  - Error codes (`invalid_grant`, `invalid_scope`, `invalid_client`, `disabled_client`, `deleted_client`).
  - Keys: at most 10, never expire by default, downloadable once. Deleting a key doesn't revoke tokens already minted.
- `files.list`:
  - `pageSize` max 1000 (coerced), trashed files returned by default, default fields `kind,id,name,mimeType`, `corpora=user` and `spaces=drive` defaults.
  - `nextPageToken` "typically valid for several hours"; `in parents` matches direct parents only; `fullText` matches whole tokens, quoted phrases, and `\'` / `\\` escapes.
- Export: 10 MB limit, no `Range`, `text/markdown` for Docs, CSV/TSV first sheet only, `text/plain` for Slides, Vids → `fileNotExportable`.
- Download fields: `capabilities.canDownload`, `copyRequiresWriterPermission`, `downloadRestrictions.effectiveDownloadRestrictionWithContext.restrictedForReaders`, and `acknowledgeAbuse` applying only to owners or organizers.
- Changes feed defaults: `includeRemoved=true`, `restrictToMyDrive=false` (includes shared files not added to My Drive), `spaces=drive`. Changes arrive oldest first. All three change tokens "don't expire". `removed` covers "deletion or loss of access".
- Push:
  - `id` ≤64 chars, `token` ≤256 chars, `type: web_hook`; files channels last ≤1 day, changes ≤1 week, default 1 h; no auto-renew.
  - The header set, `sync` as message 1, and no HMAC (the channel token is the only check).
- Quotas (projects created on or after 2026-05-01):
  - 1,000,000 units/min per project and 325,000 per user; unit costs 5/100/200/50/5.
  - Daily: no request cap, a 400M-unit billing threshold that can't be raised, and 1 TB/day egress. Charges come later in 2026 with ≥90 days' notice.
  - Watch and stop calls count against quota; notifications don't. The backoff formula is as written.
- Other limits:
  - Sheets: 300/60 reads per minute, 2 MB payload, 180 s timeout.
  - Folders: one parent per file, 100 levels deep, 500,000 direct children per folder.
  - LROs last at least 12 h (the guide) or 24 h (the discovery doc). Vercel Hobby allows 300 s.
- Package sizes: 0.78 MB, 2.47 MB and 246 MB (as written). The secure-by-default date is 2024-05-03.

**Corrected:**
- `fullText` search results come back in **descending relevance order**. `orderBy` with `fullText` returns 400; the draft had said the order was arbitrary unless `orderBy` was set. Fixed in 3b and in the fake's spec.
- `X-Goog-Changed` values also include `properties`.
- Push domain verification: no longer required, per Google's API Console help. This resolves an UNVERIFIED item.
- Keyless WIF:
  - Added the four APIs to enable (IAM, Resource Manager, IAM Service Account Credentials, STS) and the `roles/iam.workloadIdentityUser` role.
  - Added the team/global issuer modes and Vercel's extra `GCP_PROJECT_ID` / `GCP_AUDIENCE` env vars.
  - This resolves an UNVERIFIED item.
- Self-signed JWT: resolved as **not usable**. The googleapis repo has no Drive v3 service definition (only `drive/activity` and `drive/labels`).
- The verification exemption quote now has its full wording ("…and not user data (linked to a Google Account)"), which weakens the case for the exemption.
- `SERVICE_DISABLED` is confirmed as an ErrorInfo reason (domain `googleapis.com`) in Google's `error_reason.proto`.
- Smaller fixes:
  - The `fileNotDownloadable` example in Google's docs is for `revisions.get`.
  - Drawings also export to JPEG and SVG.
  - The `files.list` `pageSize` default is documented as the "entire list" for non-shared drives.
  - The 300 s cap is Hobby's maximum; Pro can go to 800 s.
  - Added the managed constraint's name.

**Still UNVERIFIED:**
- Whether the `user` corpus (and so `fullText` search) includes files reached only through a shared folder.
- Maximum `q` length.
- Quota category and cost of `files.export`, and whether `changes.list` counts as a 100-unit "list" call.
- Reason strings `exportSizeLimitExceeded`, `accessNotConfigured` and `invalid` (community sources only).
- The 403 reason for a download-restricted file.
- Whether `status` / `details[]` always appear in error bodies.
- Whether the SA verification exemption covers data shared to the SA.
- Whether the changes feed reliably reports descendants of a shared folder (smoke-test it).
- How Google would read the "building databases" ToS clause for a retrieval index.
