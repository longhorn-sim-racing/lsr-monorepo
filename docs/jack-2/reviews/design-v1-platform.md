## Findings

1. **Major, §6 Scheduler (tick auth): Jack's SQL role can read the tick secret.**
   - **Problem:** the design has pg_net send `Authorization: Bearer <secret>` from Vault, checked by `isAuthorizedCronRequest`. `research/supabase-pg-cron.md` §6.1 says why that fails. `net.http_request_queue` and `net._http_response` grant all privileges to PUBLIC, and that can't be revoked (supabase_admin owns them). So "a queued request's headers, including a Vault value written into a header, can be read by Jack's SQL tool".
   - **Evidence:** `run_sql`'s name filter (`isOffLimitsName`, `src/server/jack/tools/run-sql.ts:105`) blocks `pg_*` names but not `net.*`. This breaks principle 8. If the value is reused from `CRON_SECRET`, it also unlocks the GitHub Actions cron routes. `src/lib/recruiting/cron-auth.ts` only compares Bearer strings, so it can't check a signed request.
   - **Second trap:** `codebase-infra.md` §2 says to add `net` to the jack_readonly USAGE self-check. The pg_cron research corrects this: PUBLIC always has USAGE on `net`, so that check would RAISE and fail the migration every time.
   - **Fix:**
     - Adopt research §3.6 as written: a `scheduler.tick()` SQL function with the SQL gate, HMAC over `ts + "." + body` in `X-LSR-Timestamp` / `X-LSR-Signature`, a ±300 s window, and verification against the raw request text.
     - Use a dedicated `SCHEDULER_SIGNING_SECRET`, never `CRON_SECRET`, plus a new verifier tested with the research's test vector.
     - Add `net`, `cron` and `vault` to run_sql's off-limits names.
     - State in G1: add `cron` and `scheduler` to the self-check, but not `net`.

2. **Major, §6 and §3.14 (scheduled Claude runs): recurring questions and the digest can't run reliably inside the tick's `after()`.**
   - **Time budget:** `runRoom` (`reply-loop.ts:136`) measures its deadline from `startedAt`. It won't start an answer with less than 150 s left (`RUN_TIMING.minAnswerMs`, line 72). Instead it leaves the message for "the next post or an officer clicking Ask him to continue", and no one clicks in an unattended scheduled run.
   - **Two failure modes:**
     - With per-job budgets up to 240 s, one long job (or a few 50 s ones) ahead of a recurring question leaves it under 150 s, so it silently never answers.
     - If the dispatcher passes a fresh `startedAt`, the run's 280 s deadline goes past the function's 300 s. The reply dies mid-stream, and the 6-minute stale lock later closes it as an error.
   - **Chromium:** `next.config.ts` only traces Chromium into `/admin/jack/**` and `/api/admin/jack/**`. Any deck tool called from `/api/cron/tick` can't launch the browser.
   - **Fix:** the tick never runs Claude itself.
     - It saves the prompt as an unanswered officer-kind message (author = `createdById`).
     - It sends a signed self-POST to a route under `/api/admin/jack/…`, which gets its own 300 s and the Chromium trace. That route calls `runRoom(roomId, deps, { startedAt: requestStart })`. If an officer's run already holds the room, that run answers the message.
     - Do the same for any job over about 60 s, such as the Drive backfill. Research §3.6 point 6 already recommends this.

3. **Major, §6 Dispatcher: no overall time limit per tick, no lock length, and concurrency is unspecified.**
   - **Problem:** each job has a budget (default 50 s, max 240 s), but one tick can claim several jobs that come due together (Discord sync, Twitch sample, Drive sync, the post sender, expiry).
     - Run one after another, they pass 300 s, later jobs are killed, and their `ScheduledJobRun` rows stay `running` forever.
     - Run in parallel, they compete for Prisma's per-instance pool (`pool_timeout=15` in `src/server/db.ts`) and fail with P2024.
   - **Lock length:** `lockedUntil` isn't specified. If it's shorter than the function's lifetime, the next tick re-claims a job that's still running.
   - **Connections:** more concurrent runs also make it likelier that jack_readonly hits its `CONNECTION LIMIT 5`.
   - **Fix:**
     - Stop claiming at about 200 s after the request started, and claim only jobs whose budget fits.
     - Set `lockedUntil` to claim time + 300 s + a margin.
     - Run at most 2 to 3 jobs at once.
     - Compute `nextRunAt` from now, so missed runs don't pile up.
     - Mark orphaned `running` rows as errors on the next claim.
     - Add cleanup jobs for `ScheduledJobRun` and `cron.job_run_details` (never cleaned; about 1,440 rows a day, research §5).

4. **Major, §4.1 Apply: holding the proposal lock across outside side effects can double-post or time out.**
   - **Problem:** steps 2 to 9 lock the proposal `FOR UPDATE`, then `apply()` posts to Discord, publishes to Instagram, sends notifications, or ingests results.
     - The ingest opens its own 20 s transaction on another connection (`src/app/admin/results/actions.ts:292`, `:584-585`).
     - Prisma interactive transactions time out after 5 s by default. When that happens, the outer transaction rolls back after the post, publish or email already went out, the proposal stays PENDING, and a second Apply repeats it.
     - `JackProposalStatus` has no in-progress state to stop this.
   - **Fix:** claim, then apply.
     - In a short transaction, set `status='APPLYING'` where `id=?` and `status='PENDING'` (add APPLYING to the enum).
     - Run checkStale, the permission check and `apply` outside any transaction, then set APPLIED or FAILED with `result`.
     - Give each side-effecting kind an idempotency key from the proposal id:
       - Discord: `nonce` with `enforce_nonce`;
       - `DiscordPost.dedupeKey = "proposal:<id>"`;
       - Resend: `Idempotency-Key`;
       - Instagram: an `InstagramPublish` row keyed by the proposal.
     - Have the expiry job turn APPLYING rows older than 10 minutes into FAILED, with "check before retrying".

5. **Major, §12 launch: deploying the release before its migrations breaks sign-in across the site.**
   - **Problem:** §3.4 and §3.8 add columns to `User`. `getSessionUser` reads the whole row (`prisma.user.findUnique({ include: … })`, `src/server/auth/session.ts:78`).
     - Every signed-in request errors with "column does not exist" from the moment Vercel serves the build until `migrate.yml` finishes (it takes a pg_dump first).
     - `codebase-infra.md` §1: "neither waits for the other".
     - The same run also creates the pg_cron extension. Its availability on the Free plan is UNVERIFIED (research §5), and if it fails, every later migration is blocked.
   - **Fix:**
     - Apply the 2.0 migrations to prod before the release merge: `migrate.yml` already has `workflow_dispatch` (run it on `jack-2`, backup included), or use a migrations-only PR. They're additive, so main keeps working.
     - Turn on pg_cron and pg_net in the dashboard first, and also guard `CREATE EXTENSION` with a `pg_available_extensions` check.

6. **Major, §3.3 full-text search: the next Prisma migration will drop the hand-written tsvector columns and indexes.**
   - **Problem:** "Prisma ignores it" is wrong for columns. `prisma migrate dev` compares the migrations' end state with `schema.prisma` and generates `DROP COLUMN` / `DROP INDEX` for whatever the schema doesn't declare.
     - Nine tracks generate migrations in parallel (§12). The first one after room search, knowledge search or document search lands can silently remove it.
     - Nothing fails; searches just return nothing.
   - **Fix:**
     - Declare the column (`searchVector Unsupported("tsvector")?`) and `@@index([searchVector], type: Gin)` in `schema.prisma`. Prisma can't express GENERATED, so keep the column current with a trigger.
     - For `JackMessage`, update it only when a reply finishes, since content is rewritten many times while streaming.
     - Make every PR's review check that its generated SQL drops nothing it shouldn't.

7. **Major, §5 What Jack gets: attachment caps count files, but Claude's limits are on bytes.**
   - **Problem:** uploads allow 25 MB per file and 10 files.
     - Claude's limits: 32 MB per request, at most 10 MB of base64 per image (`anthropic-tools.md` §3d). Base64 adds 33%.
     - One 25 MB PDF is about 33 MB, which is over the limit. Three 8 MB phone photos are too.
     - The design never says how the bytes reach Claude. Base64 is re-sent on every tool round (up to 30 on deck replies).
     - The officer route that serves originals hits the 4.5 MB response cap.
     - HEIC photos aren't accepted by Claude.
     - Once attachments become one-line notes, Jack can't look at them again.
   - **Fix:**
     - At registration, make a model copy. Images become JPEG or WebP at most 2576 px on the long edge; that needs `sharp`, which isn't in `package.json`.
     - PDFs go to the Files API once, with `anthropicFileId` stored on `JackFile`, server-side only (research §6.2).
     - Cap total attachment bytes per turn (about 20 MB) and PDF pages. Refuse or convert HEIC.
     - Send originals over 4 MB as signed-link redirects, as the deck routes already do.
     - Let `room_files` return image and document blocks, so Jack can look at an attachment again after it has become a note.

8. **Major, §5 and §10 Blob: nothing tracks the Hobby Blob quota, and going over takes Blob down for up to 30 days.**
   - **Limits:** `research/vercel-blob-client-upload.md` §5 says Hobby includes 2,000 Advanced ops a month (every put, part or list, plus dashboard browsing) and 10,000 Simple ops (cache-miss get or head). Over the limit: "you will not be able to access Vercel Blob… wait until 30 days".
   - **Today:** each slide render writes 5 blobs (`decks/renders.ts:94-95`), so about 400 slide renders a month already reach the cap.
   - **What 2.0 adds:**
     - uploads and their model copies;
     - publish and gallery renders;
     - a thumbnail `get()` every time someone views it through the officer route;
     - image bytes fetched again for every turn.
   - **Fix:**
     - Count ops in `jackFileStore` and show them on System → Connections, with a warning at 70%.
     - Make thumbnails once at registration and serve them with `private, max-age, immutable` (paths have random suffixes, so they never change).
     - Fold `meta.json` into fewer writes.
     - Decide early whether the club should move to Pro.

9. **Major, §10 Twitch: an app token alone doesn't reliably deliver #188's "followers", and storing tokens conflicts with principle 8.**
   - **Problem:** `research/twitch.md` §2 says the follower endpoint documents a user token with `moderator:read:followers`; the follower total with an app token is UNVERIFIED.
     - App tokens can't be refreshed, so they have to be cached.
     - Tokens must be validated every hour.
     - Keeping stats beyond 24 hours is "generally" compliant only with the broadcaster's OAuth grant (§6).
   - **Conflict:** principle 8 allows no stored credential except the Instagram token, so there's nowhere to keep a rotating refresh token or the cached app token. The design also uses `TWITCH_CHANNEL_LOGIN` where the research uses `TWITCH_BROADCASTER_ID`.
   - **Fix:**
     - Add a one-time club-account OAuth with that one scope.
     - Store the refresh token and cached app token in a `SystemSetting` row, which jack_readonly can't read.
     - Refresh under a row lock, and add an hourly validate job.
     - Amend principle 8 to allow credentials in env or in SystemSetting.

10. **Major, §5, §10 and §12: missing setup steps will block whole pieces at launch.**
    - **Blob uploads:** `handleUploadPresigned` throws "Missing webhook public key" on every call when `BLOB_WEBHOOK_PUBLIC_KEY` is unset (`node_modules/@vercel/blob/dist/client.js:317-319`). Existing store connections must also opt in. The design's env lists don't mention it, so G5 fails everywhere.
    - **Web search and fetch:** an org admin must turn them on in Console → Capabilities. If they're off, any request that includes them returns 400 (`anthropic-tools.md` §2), which would be every reply. Make web search a switchable connector that leaves the tools out when off.
    - **Discord:** the Message Content and Server Members intents must be turned on. Without Message Content, synced content is blank and member polls are omitted (`discord.md` R3, R6). A public privacy policy URL is also required.
    - **Site traffic:** the token must be created by whoever owns the LSR Hobby team (Gray's login got 403). It's read+write on the prod project, with no read-only option.
    - **Scheduler:**
      - the signing secret's env var name;
      - the Vault entries;
      - an exact canonical URL with no redirect, since pg_net follows redirects and may turn the POST into a GET (§6.3).
    - **Fix:** one setup table (variable, owner, Production/Preview), mirrored on System → Connections as "missing: …".

11. **Major, §12: there's no way to test against real services before the one-shot release.**
    - **Problem:** every inbound path (pg_net tick, Twitch EventSub, Resend webhooks, Blob callbacks) only reaches production.
      - Previews are behind Vercel Authentication and can't sign in.
      - Resend Free has one webhook endpoint.
      - Migrations deploy only from main.
    - **Consequence:** the plan tests only against fakes. About 10 connectors make their first real calls on launch day, together, and `ConnectorState.enabled` defaults to true.
    - **Fix:**
      - Default `enabled` to false and turn connectors on one at a time after merge, each with a smoke script.
      - Before merge, run the outbound connectors locally against real keys or sandboxes, and run pg_cron, pg_net and Vault on local Supabase (research §7).
      - Test webhooks through a tunnel (Twitch CLI `event trigger`, Resend CLI `webhooks listen`).
      - Add a launch runbook to the pre-merge checklist.

12. **Minor, §6: tick frequency vs Hobby compute.**
    - **Problem:** without a gate, the tick is 43,200 invocations a month, each loading Next and Prisma. Hobby includes 4 hours of Active CPU a month (research §5), shared with Chromium and the site.
    - **Fix:**
      - Gate in SQL: only POST when a job is due.
      - Keep a heartbeat row so a dead scheduler shows up (§6.9).
      - Line periodic jobs up on shared minutes.
      - Watch the Usage page in the first week.

13. **Minor, §10 Drive: the initial sync takes days and misses deletions.**
    - **Problem:** one 50 s run at roughly 1 to 3 s per export indexes about 20 to 40 docs. At one run every 6 hours, a few hundred files take days, and the knowledge seed depends on them.
      - A `modifiedTime` query isn't recursive and doesn't report removals (`google-drive.md` §3f).
      - Exports are capped at 10 MB.
      - Uploaded .docx and .pptx files aren't Google Docs and need their own extraction.
    - **Fix:** use the changes feed. While there's a backlog, set `nextRunAt` to now + 1 minute, or hand the backfill to its own invocation.

14. **Minor, §5 and Meetings: transcripts depend on UT IT granting Graph access, which it likely won't.**
    - **Problem:** `microsoft-graph.md` §3h: "Expect IT to say no; start with the manual-export fallback". In that fallback, officers upload the recap's .vtt or .docx file, but §5 only handles CSV, JSON, TXT and XLSX, and `JackFileKind` has no DOCX.
    - **Fix:** accept `.vtt` as TEXT and extract text from `.docx`.

15. **Minor, §7 web search and fetch.**
    - (a) **Follow-up fetches fail:** web_fetch only fetches URLs from user messages, client tool results or earlier search results, not from Claude's own text (§3c). History replays earlier replies as text, so a follow-up like "open the second link" fails with `url_not_in_prior_context`. Fix: a client tool that returns URLs saved on earlier `web_sources` parts.
    - (b) **Wrap-up can 400:** `model-loop.ts` appends the wrap-up text after the tool results. If the turn has a `server_tool_use` still waiting for its result, extra text gives a 400 (§6.5). Send only the tool results in that case.
    - (c) **`blocked_domains` won't work:** path entries never match for fetch, and setting both allowed and blocked domains is a 400. The real control is `url_sources.client_tool_results` excluding run_sql, recruiting and Discord results, plus `max_uses` and `max_content_tokens`.
    - (d) **Fallback orphan:** `DROPPED_BEFORE_FALLBACK` (`model-loop.ts:402`) drops `server_tool_use` but not its result, so a refusal fallback after a search sends an orphaned result (400).
    - (e) **Cost:** `cost.ts` doesn't add the $0.01 per search.

16. **Minor, §2 site traffic "fetched live".** The Hobby API only sees the last month (`vercel-analytics.md` §5), so questions about earlier months fail and the Overview card has no history. Fix: the daily snapshot job the research proposes, with live calls only for today.

17. **Minor, §1.9 budget: build and eval spend share the live Console limit.**
    - **Shared cap:** the build log says test spend is "shared with live Jack's $50 Console limit", and the in-app spend meter doesn't count evals. Repeated 2.0 evals can trip the Console limit, and every live reply then gets the 400. Live spend itself is tiny ($0.54 of replies in October in the 10/22 prod copy), so scheduled runs fit within $50; the risk is the shared cap.
    - **Fix:** a separate `jack-dev` workspace and key with its own limit.
    - **Prompt size:** at about 1 to 2 replies a day, almost every reply starts with a cold cache. Judge the 45-tool prompt by its cold cost, about $0.11 per Jack reply (twice that on Lift). That argues for deferring rarely used tools early.

18. **Minor, §3 schema gaps in G1.**
    - §3.8 says RLS goes on `DiscordMember` and `DiscordPollVote`, but neither model is defined. "Members who left" also needs a member snapshot to compare against.
    - `EmailEvent` has no `recipient` column and no RLS, though the webhook payloads carry addresses (`resend.md` §4 step 7).
    - Define these in G1, since tracks aren't supposed to edit `schema.prisma`.

19. **Minor, scope gap: #188's "officers' photos can go into decks" has no design.** Slides only load Google Fonts, Cloudinary, the public site and `jack.assets` (`resolveJackAsset`, `decks/renders.ts:111-115`). Room files sit in private Blob, so slides can't use them. Fix: serve `jack.assets/files/<jackFileId>` (a downscaled copy) and list room images in `deck_assets`.

## Keep

1. **Sync into our own tables, with Jack and the admin pages reading the same rows.** It fits serverless, survives outages, and keeps history past Twitch VOD expiry, Resend's 30-day retention and the analytics 1-month window.
2. **One pg_cron tick plus a `ScheduledJob` table, with schedules computed in America/Chicago in app code.** pg_cron itself only runs in GMT. This keeps schedules editable, visible to Jack and testable with a fake clock, and leaves the existing GitHub Actions crons alone.
3. **Browser-to-private-Blob uploads through the presigned (OIDC) flow.** No read-write token, and no server action or function body in the upload path, so the 1 MB and 4.5 MB limits never apply.
4. **Apply re-validates, checks staleness against `before`, uses the applying officer's permissions, and audits "applied by an officer, proposed by Jack".** Keep all of this in the claim-then-apply rework.
5. **Tools appended in a fixed order after today's, measuring the cached prompt in groundwork, and tool search instead of cutting features.**