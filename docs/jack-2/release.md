# Jack 2.0 release runbook

The steps Gray follows to ship Jack 2.0 (#188): what to check before merging `jack-2 → main` (#189), the merge itself, then turning each part on, one at a time. It's put together from the track docs' setup and release sections, the design's release plan and the build log.

- **Who runs it:** Gray, as an admin. Some steps need another account's owner; each section says who.
- **The order matters** in sections 1 and 2. In section 3 most services stand alone (each says what it needs first), so skipping one leaves the rest working. Launch can go ahead with every connector off. [design §15]
- **The pattern in section 3:** accounts and keys, env vars in Vercel (then redeploy), outside settings, the smoke test on System → Connections, the switch, then the jobs on System → Scheduled jobs. Off always works.
- **Sources:** each step ends with where it came from, in brackets. `design §n` is `docs/jack-2/design.md`, `build log` is `docs/jack-2/build-log.md`, and a track name (`groundwork`, `files`, `sources-a`…) is `docs/jack-2/tracks/<track>.md`. `added here` marks a step no doc has: reasoning, or what earlier PRs showed. Commands run from the repo root.
- **The three security PRs (#222, #223, #224)** merged into `jack-2` on 10/23. #224 adds the twelfth migration (1.6). #223 changes render keys, so every deck in a room renders again once after the deploy. #222 makes the notifications cron hold scheduled announcement emails the day's email limit can't take; they show as failed on Notifications with a note to retry after the reset.

## 1. Before merging

### 1.1 Land what's still open
1. Merge the open PRs into `jack-2`: the Phase F PRs (F-docs #226, this runbook #225, and the fixes from the wave 2b security pass). The security fixes #222, #223 and #224 are already in. [build log: Status]
2. Merge the four fixes waiting on `main`, then merge `main` into `jack-2` so the release carries them. Checked with `git merge-tree` on 10/23 against `jack-2` with #222–#224 and F-docs in; if step 1 brings in anything else that touches these files, run `git merge-tree --write-tree --name-only origin/jack-2 origin/main` (after fetching) for the current list. [build log: Log, 10/22 and 10/23; merge check: added here]
   - #190: every cron route refuses all requests when `CRON_SECRET` is unset. **Conflicts** in `docs/deployment.md`: #222 added a sentence to the same notification-cron paragraph. Keep both sentences (#222's note on holding announcement emails past the day's limit, and #190's "Every cron route refuses all requests when `CRON_SECRET` is not set…"). The recruiting paragraph merges on its own, losing its recruiting-only `CRON_SECRET` sentence as #190 intends.
   - #191: Sonnet 5.5 cache reads priced at $0.10 per million tokens. Merges cleanly, `docs/jack.md`'s price table included.
   - #195: `run_sql` refuses `ts_rewrite`. **Conflicts** in `src/server/jack/tools/run-sql.ts` and `run-sql.test.ts`, and, once F-docs is in, in `docs/jack.md`'s list of off-limits names. Keep `jack-2`'s side in all three: it already refuses `ts_rewrite` (and more), and its `docs/jack.md` already lists it.
   - #216: the Stripe webhook no longer logs the request body on a bad signature. Merges cleanly.

### 1.2 Gates from the build log
- **Production upload path (G5): passed 10/23 on local Supabase Storage.** All 19 end-to-end checks with `JACK_FILE_STORE=supabase`, a browser upload, render-check, a deck's slides and exports. Production Storage is first used in 1.8 (the bucket) and 2.3 (render-check and the first room upload). [build log: Log, 10/23; files: Release gate]
- **Live model checks (G8, G6): passed 10/23.** Tool search with streamed tool input, `url_sources` naming the deferred `web_links`, dynamic filtering on Sonnet and Haiku, Claude Files, and the PDF link probe. [build log: Log, 10/23]
- **Security review of wave 2b**, and its fixes merged. Waves 1 and 2a were reviewed on 10/23 (their fixes are #222–#224). [build log: Log, 10/23]
- **The eval**: one full run on all three models, on `lsr_eval`, with the spend recorded in the build log; the release PR's checklist also has "Eval run against Jack today". The dry run passed 108 of 110 per model on 10/23, and the two failing checks were fixed. How to run it: `tracks/eval.md`. [design §16; #189 checklist]
- **Docs folded in** (`docs/jack.md`, `CLAUDE.md`, `docs/local-dev.md`, `.env.example`), and the launch post drafted. [build log: Status; design §18.1, F]
- **The build log's future:** its first line says it's removed or folded into `docs/jack.md` before the release merges. Decide which (section 5). [build log: intro]

### 1.3 CI and the preview
1. Locally, on an up-to-date `jack-2`: `pnpm --filter @lsr/platform lint`, `typecheck`, `test` and `build`. [design §18.4]
2. The migration drift check reports no difference: `pnpm --filter @lsr/platform exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <a throwaway local database> --exit-code`. [design §3.1]
3. #189 is a draft, so CI and Vercel skip it. Mark it ready for review, then push a commit to `jack-2` (an empty one is fine) so Vercel builds the preview. [CLAUDE.md: Contributing; `docs/deployment.md`]
4. CI on #189 is green: lint, typecheck, unit tests, build. [`.github/workflows/ci.yml`]
5. The preview **deployed**, not just built:
   - It didn't stop at "Deploying outputs" with "No more than 12 Serverless Functions" (Hobby's limit). #215 brought it to 7 functions; recheck it on this PR. [build log: Log, 10/23 and Wave 2a calls]
   - It isn't marked "build-rate-limit" (Hobby's build rate limit, hit on 10/23). If it is, wait and redeploy. [build log: Log, 10/23]
6. If sign-in on the preview sends you back to the live site, check officer pages on production after the merge instead (2.3). [added here: earlier PRs' previews did this]

### 1.4 Rehearse the migrations
- `lsr_eval` (a production copy, refreshed 10/22) was migrated to 2.0 on 10/23, before wave 2b merged. `pnpm --filter @lsr/platform jack:eval:prepare --skip-seed` applies the ones it doesn't have yet (wave 2b's and #224's) the same way, with `prisma migrate deploy`. [design §17 step 1; build log: Log, 10/23; eval: Try it locally]
- For a full rehearsal, make a fresh copy of production the way `lsr_eval` was made and run `jack:eval:prepare --db=<lsr_eval…> --skip-seed` on it: all twelve should apply cleanly, and a second run should apply nothing. A copy skips the scheduler migration's pg_cron and pg_net step (it only runs in the database pg_cron runs in), so this doesn't rehearse that part; 1.7's checks cover it on production. [eval: Try it locally; `scripts/jack-eval/prepare.ts` header; `20261023020000_jack2_scheduler` header]
- Then check Jack's SQL role still reads only what it should: `pnpm --filter @lsr/platform exec tsx scripts/check-jack-sql-role.ts` (after `scripts/jack-local-sql-role.ts`, so the role can log in; both refuse anything but a local database). It checks the database `DATABASE_URL` and `JACK_DATABASE_URL` name, and from `.env.local` that's the shared local dev database (migrated piecemeal), not the copy you just migrated. To check the copy, set both in the shell to the same local URLs with the copy's name as the database; the role belongs to the whole local server, so the password `jack-local-sql-role.ts` set works there too. [design §3.2; both scripts' headers]

### 1.5 Enable pg_cron and pg_net
In the Supabase dashboard: pg_cron under Integrations → Cron, pg_net under Database → Extensions. Do this **before** the migrations. The scheduler migration then finds both and only adds its own schema and function. [design §17 step 2; `scripts/jack-scheduler-setup.ts`; groundwork: Scheduler, Setup 1]

### 1.6 Apply the migrations to production
They go to production **before** the code merges. They're additive (new tables, nullable or defaulted columns, indexes, functions, triggers and policies), so `main`'s code keeps working with them. The order matters the other way round: sign-in reads whole `User` rows, so deploying the code first would break sign-in until the migrations landed. [design §17 step 3; design §3.1]

| # | Migration | What it adds | From |
|---|---|---|---|
| 1 | `20261023000000_jack2_core` | The whole 2.0 schema: new tables and enums; new columns on `User` (officer profile, Discord link), `JackRoom`, `JackMessage` and `InstagramPost`; the search index (`JackSearchDoc`) and its triggers, with existing room messages indexed; the trigger that deletes a recurring question's job; row level security and Jack's read policy on the personal-data tables; one `ConnectorState` row per connector, all off | G1 (#192) |
| 2 | `20261023010000_jack2_recruiting_privacy` | Tighter recruiting policies for Jack's SQL role (no drafts, nothing about officers' own applications), and row level security on `AuditLog` with a policy hiding those entries from Jack | G1 (#192) |
| 3 | `20261023020000_jack2_scheduler` | The `scheduler` schema and `scheduler.tick()` (creates pg_cron and pg_net only if they're available and not yet on) | G1 (#192) |
| 4 | `20261023030000_jack2_search_revoke` | Takes the search index away from Jack's SQL role | G1 follow-up (#196) |
| 5 | `20261023041400_jack2_proposal_view` | `JackProposal.view` (nullable) | G4 (#201) |
| 6 | `20261023060000_jack2_scheduled_notes` | `JackMessage.scheduled` (default false) | G8 (#198) |
| 7 | `20261023070000_jack2_discord_thread_parent` | `DiscordChannel.parentId` (nullable) | T7 (#214) |
| 8 | `20261024004000_jack2_stripe_charges` | The `StripeCharge` table | T4 (#210) |
| 9 | `20261024010000_jack2_twitch_eventsub` | The `TwitchEventSubMessage` table | T5 (#213) |
| 10 | `20261024020000_jack2_document_name_search` | `jack2_document_vector()`; re-indexes synced documents (none yet in production) | I2 (#217) |
| 11 | `20261024020500_jack2_note_job_key` | `JackMessage.jobKey` (nullable) and an index | T11 (#220) |
| 12 | `20261024021500_jack2_discord_thread_owner` | `DiscordChannel.ownerId` (nullable); row level security and Jack's read policy on `DiscordChannel` | #224 |

Several migrations check themselves and stop with an error if something is off (row level security off on a personal-data table, Jack's role able to write, read the search index or use the `cron` and `scheduler` schemas). If one fails, Prisma stops there, applies nothing after it, and records it as failed; later deploys refuse until that's resolved. Read the error, check what of it was applied, fix the cause, then `pnpm --filter @lsr/platform exec prisma migrate resolve --rolled-back <migration name>` and deploy again. [the checks: the migrations themselves; what Prisma does on a failure: added here]

**How.** Either way it's `prisma migrate deploy` (`pnpm --filter @lsr/platform db:deploy`) on the `jack-2` code:
- **From Gray's machine** (the plan), on a `jack-2` checkout, with production's connection strings set in this shell only (never in a file in the repo):
  ```bash
  export DATABASE_URL='<production DATABASE_URL>'
  export DIRECT_URL='<production DIRECT_URL>'
  pnpm --filter @lsr/platform exec prisma migrate status   # check the host it names, and the 12 migrations not yet applied
  pnpm --filter @lsr/platform db:deploy
  pnpm --filter @lsr/platform exec prisma migrate status   # "Database schema is up to date!"
  ```
  Prisma also reads `apps/platform/.env` (the local database), but values set in the shell win; `migrate status` names the host it's on, so check that first. If the direct host doesn't answer (it's IPv6-only), use the session pooler on port 5432 for `DIRECT_URL`, as the migrate workflow does. There's no backup this way unless you take one first. [Gray's plan for this release, and Prisma's env handling: added here; the pooler: `.github/workflows/migrate.yml` header]
- **Or from GitHub:** Actions → Database Migrate → Run workflow, branch `jack-2`. It takes an encrypted backup of production first, then runs `db:deploy` with the `PRODUCTION_*` secrets. [`.github/workflows/migrate.yml`; design §17 step 3]

### 1.7 Checks after the migrations
1. `prisma migrate status` against production says it's up to date. [as in 1.6]
2. The live site, still on `main`'s code, works: sign in, open `/admin`, open an event, and ask Jack something in a room (Jack 1.x reads the new schema). [design §3.1; design §17]
3. In the Supabase SQL editor:
   ```sql
   SELECT id, enabled FROM "ConnectorState" ORDER BY id;                         -- 10 rows, all false
   SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');      -- both
   SELECT to_regprocedure('scheduler.tick()') IS NOT NULL;                       -- true
   SELECT has_table_privilege('jack_readonly', 'public."SystemSetting"', 'SELECT'),
          has_table_privilege('jack_readonly', 'public."JackSearchDoc"', 'SELECT'); -- false, false
   ```
   [design §3.2; G1 migrations]

### 1.8 Supabase Storage: the bucket, before the deploy
After the merge, Supabase Storage is where deck renders, exports, screenshots and room files go. Until the bucket exists, every store call fails with "Bucket not found": deck screenshots and room uploads fail, and render-check shows it. [files: Setup (production)]
1. With production's `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in the shell (from the Supabase dashboard; the script reads `.env.local` and `.env` too but never overrides the shell):
   ```bash
   pnpm --filter @lsr/platform exec tsx scripts/jack-storage-setup.ts --dry-run
   pnpm --filter @lsr/platform exec tsx scripts/jack-storage-setup.ts
   ```
   It prints the project host first. It creates the private bucket `jack`, 50 MB per file, with an allow-list of the types Jack stores. Running it again updates those settings. [files: Setup 1; script header]
2. Copy the stored screenshots slides point at (`jack/assets/*`) from Vercel Blob: add `--copy-from-blob`. It needs `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` with a fresh `VERCEL_OIDC_TOKEN` from `vercel env pull`. It skips what's already there. Renders and exports aren't copied; they're made again on first view. [files: Setup 2; design §2.1]
3. No new env vars: production already has `SUPABASE_SERVICE_ROLE_KEY` (Jack broadcasts with it). Don't set `JACK_FILE_STORE` in production; the default there is Supabase. [files: The file store; files: Setup]

### 1.9 Env vars before the merge
- `SCHEDULER_SIGNING_SECRET` can go in now (3.1, step 1): `main` doesn't read it, and the merge's deploy then has it. [groundwork: Scheduler, Env]
- A connector's env vars can also go in early, to save redeploys later: a connector stays off until an admin switches it on. Two exceptions act as soon as they're deployed: `JACK_WEB_TOOLS` (3.4) and `JACK_AUTOMATION_BUDGET_USD` (3.15). [groundwork: Connectors; design §1 principle 11]
- Never set `JACK_FAKES` or `JACK_FAKES_URL` in Vercel. Fakes are ignored on production (`VERCEL_ENV=production`) anyway. [groundwork: HTTP fakes]

## 2. Merge and deploy

### 2.1 Merge
1. Merge #189 (`jack-2 → main`). Vercel deploys production. [design §17 step 4]
2. The push changes `prisma/migrations/`, so the Database Migrate workflow runs: it backs up production and finds nothing left to apply. Check it finished green. [`docs/deployment.md`: Database migrations]
3. Run `scripts/jack-storage-setup.ts --copy-from-blob` again (as in 1.8). It skips what it copied and picks up screenshots saved since. [files: Setup 2]

### 2.2 The deployment
- The build passed, and the deployment didn't stop at "Deploying outputs" over 12 functions. [build log: Wave 2a calls]
- Runtime logs show no new errors in the first minutes (Vercel → the project → Logs). [added here]

### 2.3 Check production
Signed in as an admin:
1. **Overview** (`/admin`): the "Needs attention" card leads; the source cards (traffic, streams, Discord) stay hidden until their services are set up. [automation: Needs attention; sources-a; sources-b; discord-read]
2. **System → Connections** (`/admin/connections`): every connector listed as Off or Not set up, with env var names marked set or missing (names only). The Scheduler panel says Not set up until 3.1. The File storage panel shows Supabase Storage, the `jack` bucket (private, 50 MB per file) and its usage. [groundwork: The Connections page]
3. **System → Scheduled jobs** (`/admin/jobs`): every job listed, all off. Opening the page creates their rows. [groundwork: Adding a job kind; `src/app/admin/jobs/page.tsx`]
4. **`/api/admin/jack/render-check`**: `"ok": true`, `"store": { "kind": "supabase", "ok": true }`, and the runtime is Vercel. [files: Setup 3]
5. **A Jack room:** ask a question; attach a photo and a PDF and ask what's in them (with Claude Files off, the photo goes inline and the PDF as text); ask Jack to propose a small page edit, check the card, then Discard it. [files: Attaching files; groundwork: Proposals]
6. **A deck** made before the release: its slides render (the first view of each renders again), and a slide with a screenshot shows it. [files: Setup 2; #223]
7. **The new pages open:** Proposals, Recurring questions, Usage, Knowledge, Discord, Announcements, Streams, Instagram, Sponsors, Meetings, Action items, plus Payments, Notifications, Recruiting and Results. Then `/privacy` (section 2.4, Discord) and a driver's public profile. Light and dark, and at phone width. [design §13]

## 3. Turning things on
One service at a time; check each works before the next. For each: env vars in Vercel (Production; Sensitive where marked), then redeploy (Vercel only reads env changes on a new deployment). The smoke test works while a connector is switched off; switching on without a passing smoke test asks first. [groundwork: The Connections page; design §1 principle 11; design §17 step 5]

### 3.1 Scheduler
- **Who:** Gray (Vercel, Supabase).
- **Before:** pg_cron and pg_net on (1.5), migrations applied (1.6).

1. Make a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Put it in Vercel as `SCHEDULER_SIGNING_SECRET` (Production, Sensitive) and redeploy, unless it went in before the merge (1.9). Keep it separate from `CRON_SECRET`, and keep the value for step 3 (a Sensitive value can't be read back from Vercel). [groundwork: Scheduler, Setup 2]
2. Check the tick address doesn't redirect: `curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -X POST https://www.longhornsimracing.org/api/cron/tick` must print `401`. A 3xx means it redirects (pg_net would turn the POST into a GET); 404 means the route isn't deployed. [`scripts/jack-scheduler-setup.ts`, step d]
3. `pnpm --filter @lsr/platform jack:scheduler-setup --no-db` prints the SQL. Replace `<SCHEDULER_SIGNING_SECRET>` with the same value, run it in the Supabase SQL editor, and don't save the filled-in SQL anywhere. It sets the Vault values `lsr_scheduler_secret` and `lsr_scheduler_url` (`https://www.longhornsimracing.org/api/cron/tick`, exact), schedules `lsr-scheduler-tick` every minute, and adds `lsr-cron-history-cleanup` (daily). It never prints the production secret. `--no-db` because without it the script creates job rows in whatever `DATABASE_URL` points at, which on your machine is the local database; `/admin/jobs` already made production's. [groundwork: Scheduler, Setup 3; script header]
4. Within a minute, the Scheduler panel on Scheduled jobs (and Connections) says **Ticking**. [groundwork: Scheduler, Setup 4]
5. Turn on jobs (Scheduled jobs, admin), **`proposals.sweep` first**: until it runs, an apply whose function died stays APPLYING, and an expired proposal gets its "Stale" note only when someone acts on it. Then `housekeeping.job-runs`, `housekeeping.cron-history` and `housekeeping.twitch-samples`. Turning a job on sets its next run from now. [design §17 step 5; groundwork: Proposals, Env vars and setup; groundwork: Scheduler, Housekeeping]

- **Watch:** the Scheduler panel shows the last tick and dispatch, whether `lsr-scheduler-tick` is scheduled and active, and pg_net's answers from the last 6 hours: 401 = the Vault secret and `SCHEDULER_SIGNING_SECRET` differ; 3xx or 405 = the address redirects; 404 = the route isn't deployed. `proposals.sweep` runs every 10 minutes. The Overview flags "Scheduler not ticking" and failing jobs. [groundwork: Scheduler, When something's wrong]
- **Pause:** `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'lsr-scheduler-tick'), active := false);` (printed by the setup script, with Resume and Remove). [groundwork: Scheduler]

### 3.2 Supabase Storage
- **Done before the merge** (1.8), and checked with render-check (2.3).
1. Turn on `files.cleanup` (daily, 4:15 AM CT): it deletes uploads still uploading after 24 hours and files never posted after 7 days, with their stored copies. [files: Setup 4; files: Cleanup job]
- **Watch:** Connections → File storage: the bucket's size against the Free plan's 1 GB (warning at 80%, danger at 95%), and room files by status. Egress is 5 GB a month on Free. A missing bucket shows as a danger notice. [groundwork: The Connections page; files: Supabase Free limits]

### 3.3 Claude Files
- **Who:** Gray. Nothing to set up at Anthropic: the Files API is GA and free, and `ANTHROPIC_API_KEY` is already set. Optional: a dedicated `jack` workspace with its own key (files belong to the key's workspace; after a move, Jack uploads copies again as they're used). [files: G6, Setup and release 1]
1. Connections → **Claude Files** → Run smoke test ("Uploaded, found and deleted a test file"), then switch it on. [files: G6, Setup and release 2]
2. In a room, attach a photo and a PDF and ask what's in them. [files: G6, Setup and release 3]
- **Watch:** no `[jack] Couldn't upload file` lines in the function log; the Connections row shows a recent sync. Copies expire at Anthropic after 30 days. [files: G6]
- **Off:** photos go inline and PDFs as text at once; copies already uploaded stay until their files are deleted or expire. [files: G6, Setup and release 4]

### 3.4 Web search and fetch
- **Who:** Gray.
1. Anthropic Console → Settings → Capabilities: **web search** and **web fetch** allowed. They were on for Jack's key during the 10/23 live checks; check they still are. If either is off, every reply that includes them fails with a 400. [groundwork: Model loop 2.0, Env and setup; build log: Log, 10/23]
2. Vercel: `JACK_WEB_TOOLS=on` (Production), redeploy. There's no switch on Connections: this env var is the switch, and every room reply gets the web tools once it's deployed. [groundwork: Model loop 2.0]
3. Smoke test (paid): in a room, "Search the web for the FIA's esports program and give me the link." Expect a "Searched the web (… cited)" part with hosts, and a function log line `[jack] Reply … N web searches, M pages opened`. Then "open the first link": expect a `web_links` call and "Read <host>". [groundwork: Model loop 2.0, Smoke test]
4. The PDF link probe passed on 10/23, so PDFs go to Claude as documents with web fetch on. Run it again only if the web fetch tool version has changed (`web_fetch_20260209` in `src/server/jack/web-tools.ts`): `ANTHROPIC_API_KEY=… pnpm --filter @lsr/platform exec tsx scripts/check-jack-web-fetch-documents.ts` (paid, a few cents). [files: G6, Setup and release 5]
- **Watch:** Jack → Usage. A search costs $0.01 plus 35,000 to 53,000 input tokens (dynamic filtering reads results in code execution). A reply is told to wrap up after 8 searches or 5 pages. Recurring questions and the digest never get web tools. [build log: Log, 10/23; groundwork: Model loop 2.0, Limits]
- **Off:** remove `JACK_WEB_TOOLS` (or set it to anything but `on`) and redeploy. [groundwork: Model loop 2.0, Web search and fetch]

### 3.5 Stripe (read only)
- **Who:** Gray (existing Stripe account).
1. Stripe Dashboard → Developers → API keys → **Create restricted key**, named `jack-read`: **Read** on Balance, Payouts, Charges (covers refunds) and Disputes; everything else None, every Write off. Copy it (a live restricted key isn't shown again). [sources-a: Setup, Stripe 1]
2. Vercel: `STRIPE_READONLY_KEY` (Production only, Sensitive), redeploy. The client refuses anything but `rk_…`, and a live key outside production. The checkout key (`STRIPE_SECRET_KEY`) isn't touched. [sources-a: Setup, Stripe 2; Stripe]
3. Stripe → Developers → Webhooks → the existing endpoint (`/api/stripe/webhook`) → add `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`, `payout.canceled`, `payout.reconciliation_completed`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`. The signing secret doesn't change. [sources-a: Setup, Stripe 3]
4. Connections → **Stripe (read only)** → Run smoke test (the balance, payouts, charges and disputes of the last 30 days), switch on, then turn on `stripe.sync` (daily, 5 AM CT). Its first run looks back 400 days. [sources-a: Setup, Stripe 4]
- **Watch:** Money → Payments → the Stripe panel (balance, payouts, refunds, disputes; a dispute that needs a response gets a red notice). The webhook stores payout and dispute events even while the connector is off. [sources-a: Stripe]

### 3.6 Resend delivery events
- **Who:** Gray (existing Resend account). The production key stays send-only; no read key is needed. [sources-a: Resend]
1. Resend → Webhooks → **Add webhook**: `https://www.longhornsimracing.org/api/webhooks/resend` (the exact host: a redirect counts as a failure). Events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`. Leave opened and clicked off (section 5). [sources-a: Setup, Resend 1]
2. Copy its signing secret into Vercel as `RESEND_WEBHOOK_SECRET` (Production, Sensitive), redeploy. Until then the route answers 503 and Resend retries for about a day. [sources-a: Setup, Resend 2; Resend]
3. Connections → **Resend delivery events** → Run smoke test (checks the secret, says the connector is off). Then, together: switch Resend on, and turn on `email-events.prune` (daily). Nothing is stored before it's on, and the prune keeps the 12-month promise on `/privacy`. [sources-a: Setup, Resend 3]
4. Send a test notification to yourself and run the smoke test again: it should say when the last event was stored. [sources-a: Setup, Resend 4]
- **Watch:** System → Notifications → the Delivery tab and column; Recruiting → Emails' Delivery column; the `email.bounces` check. Free allows one webhook endpoint (production's). [sources-a: Resend; design §12.4]
- **Off:** switch Resend off; events are acknowledged and dropped (and gone for good). Deleting the webhook in Resend stops them being sent. [sources-a: Setup, Resend 5]

### 3.7 Site traffic
- **Who:** the account that owns the LSR Vercel team (Gray's own login can't see it). [sources-a: Setup, Site traffic 1]
1. That account: Account Settings → Tokens → **Create**, scoped to the LSR team and the project, with an expiry (a year at most; put a reminder in the calendar a week before), named `lsr-site-traffic`. [sources-a: Setup, Site traffic 1]
2. Vercel: `VERCEL_ANALYTICS_TOKEN` (Production, Sensitive) and `VERCEL_ANALYTICS_PROJECT_ID` (Production; the project's `prj_…` id). Web Analytics must be on for the project. Redeploy. [sources-a: Setup, Site traffic 2]
3. Connections → **Site traffic (Vercel Web Analytics)** → Run smoke test (yesterday's page views and top pages), switch on, then turn on `site-traffic.snapshot` (daily, 3:30 AM CT). Its first run fills the last 29 days. [sources-a: Setup, Site traffic 3]
- **Watch:** the Overview's Site traffic card. If the smoke test answers 400 about the filter, `PUBLIC_PAGES_FILTER` (`src/server/connectors/site-traffic/client.ts`) is the one line to change: the filter that leaves out `/admin` hasn't met the live API yet. [sources-a: Site traffic; Not verified live]
- **This token is read-write** (Vercel has none read-only): a decision for Gray (section 5). [design §12.5]

### 3.8 Twitch
- **Who:** whoever holds the club Twitch account's login (design §15 leaves the owner to be named), plus an admin on the site.
1. Log in to dev.twitch.tv/console as the **club** account (2FA on). Register an application: client type **Confidential**, OAuth redirect URL exactly `https://www.longhornsimracing.org/api/admin/twitch/callback`. Copy the Client ID and make a New Secret. [sources-b: Setup, Twitch 1]
2. Find the channel's numeric user id (`TWITCH_BROADCASTER_ID`). Make the EventSub secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. [sources-b: Setup, Twitch 2]
3. Vercel (Production): `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (Sensitive), `TWITCH_BROADCASTER_ID`, `TWITCH_EVENTSUB_SECRET` (Sensitive). Redeploy. [sources-b: Setup, Twitch 3]
4. Content → Streams → **Connect the club account** (an admin), signed in to Twitch as the club account (sign out of a personal one first; Twitch shows which account). Only the club channel's grant is kept. [sources-b: Setup, Twitch 4]
5. Subscribe the webhooks from a machine with the same four values set in the shell (Sensitive values can't be read back from Vercel, so use your own copy): `pnpm --filter @lsr/platform exec tsx scripts/twitch-eventsub.ts` shows the plan; add `--apply` to create `stream.online` and `stream.offline`. It waits for Twitch's challenge and says when both are enabled. The script also reads `apps/platform/.env.local`, and if that still has `JACK_FAKES=twitch` (or `all`) from trying it locally, it talks to the local fake instead. So also set `JACK_FAKES=none` in the same shell (not an empty value, which PowerShell drops), and check the first line says "on the REAL Twitch" before adding `--apply`. [sources-b: Setup, Twitch 5; Try it locally; `scripts/twitch-eventsub.ts`]
6. Connections → **Twitch** → Run smoke test ("Read @…, offline; club account @… OK, N followers"), switch on, then turn on `twitch.live` (every minute), `twitch.daily` and `twitch.token-check` (hourly). [sources-b: Setup, Twitch 6]
- **Watch:** the first `twitch.live` runs, then a real go-live: Content → Streams shows it live within seconds, its title a few seconds later. `twitch.live` adds one run row a minute to Scheduled jobs. If Streams says Twitch revoked the webhooks, run the EventSub script with `--apply` again. [sources-b: Release steps 3; Jobs; EventSub webhook]
- **Before ever deleting the Twitch app:** `scripts/twitch-eventsub.ts --remove --apply`. [sources-b: Setup, Twitch 7]

### 3.9 Instagram insights
- **Who:** Gray or the Media lead (whoever holds the Meta app). No env vars: it uses the feed's token in Admin → Instagram. [sources-b: Instagram insights; design §15]
1. In the Meta app's Instagram use case, give the token `instagram_business_basic` and `instagram_business_manage_insights` (still read only), generate it, and paste it on Content → Instagram, in the Connection panel (**Paste a new access token**), not in Publishing. The feed keeps working with it. [sources-b: Setup, Instagram insights 1; `src/app/admin/instagram/client.tsx`]
2. Connections → **Instagram insights** → Run smoke test ("Read @…: N followers; yesterday's reach …"; a missing permission fails with code 10), switch on, then turn on `instagram.account-daily` and `instagram.post-insights`. [sources-b: Setup, Instagram insights 2]
- **Watch:** Content → Instagram → Insights. Days before the first snapshot stay empty. Follows and unfollows need 100+ followers (Instagram's rule). [sources-b: Instagram insights; Setup 3]

### 3.10 Instagram publishing
- **Who:** Gray or the Media lead. **Read the policy questions first** (section 5). [decks-rooms: Setup 5]
1. A **second Meta app** ("LSR Jack Publisher", type Business), so the feed's read token can never publish. In it: Instagram → API setup with Instagram business login; add the club account (it must be public); generate a token **signed in as the club account** with `instagram_business_basic` and `instagram_business_content_publish` only. [decks-rooms: Setup 1]
2. Content → Instagram → **Publishing** (an admin): paste the token and Connect. It's checked first: the club's account, able to publish, not the feed's token. It's stored in SystemSetting `instagram_publish`, never in env. [decks-rooms: Setup 2; The connector, token and jobs]
3. Connections → **Instagram publishing** → Run smoke test ("Read @…: N of 50 API posts used in the last 24 hours; Cloudinary answered"; it posts nothing), then switch on. It needs Cloudinary's env, already set in production. [decks-rooms: Setup 3; The connector, token and jobs]
4. Turn on `instagram-publish.finish` (every 5 minutes) and `instagram-publish.token` (Mondays). [decks-rooms: Setup 4]
5. First real post: a test graphic as a **story** (gone in 24 hours) from a deck page. Check the history shows it Posted with a link, the room note and the audit entry. Then a carousel. [decks-rooms: Release steps 3]
- **Watch:** Content → Instagram → Publishing's history; the `instagram-publish.attention` check (failed posts, posts still on their way after 20 minutes, a token near expiry). The site caps posts at 10 a rolling day. A password change on the club account kills the token: paste a new one. [decks-rooms: Digest check; Setup 6]

### 3.11 Google Drive
- **Who:** Gray (a club-owned Google account), and the shared folder's owner.
1. In a club-owned Google account (not utexas.edu): create a Cloud project, enable the Google Drive API, create a service account with **no IAM roles**, and download a JSON key. [documents: Setup, Google Drive 1]
2. The folder's owner shares it with the service account's `client_email` as **Viewer**, with "Notify people" unticked. [documents: Setup, Google Drive 2]
3. Vercel (Production, Sensitive): `GOOGLE_SERVICE_ACCOUNT_JSON` (the key file's contents) and `GOOGLE_DRIVE_FOLDER_ID` (the last part of the folder's URL). Redeploy. [documents: Setup, Google Drive 3]
4. Connections → **Google Drive** → Run smoke test ("Read the folder …"), switch on, then turn on `google-drive.sync` (every 15 minutes, handed off). [documents: Setup, Google Drive 4]
- **Watch:** Content → Knowledge → Documents fills in; a big folder takes a few runs. The `documents.drive-folder` check fires if the folder is gone or unshared; after a day of that, every Drive document's text is removed. [documents: Setup 4; Google Drive]
- **Key rotation:** make a new key, update the env var, redeploy, then delete the old key. [documents: Setup, Google Drive 5]

### 3.12 Discord: reading
- **Who:** a Discord server admin and the app's owner (the club account), plus Gray.
1. **Create the app** (discord.com/developers/applications), owned by the club account. [discord-read: Setup 1]
   - General Information: copy the Application ID. Privacy Policy URL `https://www.longhornsimracing.org/privacy#discord`; Terms of Service URL `https://www.longhornsimracing.org/terms`.
   - Bot: Reset Token and copy it once. **Public Bot off**; "Requires OAuth2 Code Grant" off. Privileged Gateway Intents: **Server Members** and **Message Content** on.
   - OAuth2: copy the Client Secret; add the redirect `https://www.longhornsimracing.org/api/discord/oauth/callback`.
2. **Install the bot**, logged in as the app's owner (Manage Server on the club server): `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=580542407986176&guild_id=<GUILD_ID>&disable_guild_select=true`. That's View Channels, Send Messages, Embed Links, Read Message History, Manage Roles, Create Events and Send Polls. Place the bot's role just above the roles role sync will hand out and below every officer and admin role. Deny View Channel on channels it must never read. [discord-read: Setup 2; discord-post: Setup 1]
3. Vercel (Production, Sensitive): `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` (Developer Mode → right-click the server → Copy Server ID), `DISCORD_CLIENT_ID` (the Application ID), `DISCORD_CLIENT_SECRET`. Redeploy. `DISCORD_OAUTH_REDIRECT_URI` is optional (the default is the callback above); `DISCORD_APPLICATION_ID` isn't read by the code. [discord-read: Setup 3; Env vars]
4. **Discord Developer Terms §12(a)** (section 5): confirm before the next step. Switching on is what makes Jack's live search work, and the first sync puts data in Supabase and through Vercel. [discord-read: Setup 4]
5. Connections → **Discord** → Run smoke test ("Read …: N members, M channels; Message Content and Server Members intents on; the bot's role sits below the admin roles"), then switch on. [discord-read: Setup 5; discord-post: smoke test]
6. **Post the server privacy note** before opting channels in, listing the channels you're about to opt in, and pin it. The text is in `tracks/discord-read.md` ("The server privacy note"). Post it by hand, or through the site once posting is set up (3.13, step 2). [discord-read: Setup 6; discord-post: Setup 5]
7. Community → **Discord**: opt in those channels (the first run reads back 90 days). Keep officer-only channels out unless the officers agree. [discord-read: Setup 7]
8. Turn on `discord.sync` (every 10 minutes), `discord.rescan` (hourly), `discord.members` (hourly) and `discord.prune` (daily). [discord-read: Setup 8]
- **Watch:** Community → Discord (messages, active members, channels, polls) and the Overview's Discord card. A failing sync shows on the connector and in the failing-jobs check. Deletion requests are handled on Community → Discord (admins). [discord-read: Community → Discord; Deletion on request]

### 3.13 Discord: posting, rules and role sync
- **Who:** Gray (admin). After 3.12.
1. **Pings:** for a role posts may ping, switch on "Allow anyone to @mention this role" in Discord. The bot isn't given Mention @everyone (section 5). [discord-post: Setup 2]
2. Community → **Announcements** → Posting channels (admins): pick the channels the bot may post in. The privacy note can then go out from Announcements → Server privacy note (Copy for Jack, or Post it myself). [discord-post: Setup 4 and 5]
3. **Standing rules** (Announcements → New rule, or ask Jack): event reminders, new events, results, standings, Twitch live, the event mirror. Switching one on asks first; it acts only on what happens after that. [discord-post: Setup 6; Standing rules]
4. **Role sync** (Community → Discord → Role sync): add rules, switch them on. Roles with moderation powers are refused. [discord-post: Setup 7; Role sync]
5. Turn on `discord.posts` (every 2 minutes) **first**, then `discord.rules` (every 5 minutes), `discord.event-mirror` (every 15 minutes) and `discord.role-sync` (hourly). [discord-post: Setup 8]
- **Watch:** Announcements → Posts (Scheduled, Sent, Failed and cancelled); the "Discord posts that failed" check; role changes in the audit log. A post more than 6 hours late is cancelled, not sent. [discord-post: The outbox; Digest check]

### 3.14 SharePoint and Teams
- **Who:** Gray, UT IT, and a team owner. **Off until UT IT approves.** [documents: Setup, SharePoint and Teams; design §12.8]
1. File the IT request (`docs/jack-2/research/microsoft-graph.md` §9 has a draft): an app registration in UT's tenant, `Sites.Selected` with a read grant on our site (and on any private or shared channel's site we want), permission to install our Teams app with `ChannelMessage.Read.Group` (RSC), and confirmation that team RSC consent isn't disabled. [documents: Setup 1]
2. The Teams app manifest gets `webApplicationInfo` with the app's id and `ChannelMessage.Read.Group` (Application) under `authorization.permissions.resourceSpecific`; add `ChannelSettings.Read.Group` so channel names show. A **team owner** installs it in the club team. [documents: Setup 2]
3. Vercel (Production; Sensitive for the secrets): `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (Sensitive), `MS_SITE_ID`, `MS_DRIVE_ID` (SharePoint); `MS_TEAM_ID`, `MS_CHANNEL_IDS` (comma-separated `19:…` ids), `MS_GRAPH_CLIENT_STATE` (Sensitive; `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) (Teams). Redeploy. [documents: Setup 3; Env vars]
4. Connections: smoke-test and switch on **SharePoint** and **Microsoft Teams**. Scheduled jobs: turn on `sharepoint.sync`; for Teams, run `teams.subscriptions` first (Graph calls `/api/webhooks/graph` to validate it), then turn on `teams.sync`. [documents: Setup 5]
5. Tell the team that Jack reads those channels (installing the app is the consent). [documents: Setup 6]
- **Watch:** Content → Knowledge → Documents and Teams messages; the `documents.sync-failing` check. Taking a channel out of `MS_CHANNEL_IDS` deletes its synced messages. [documents: Knowledge page; Teams]

### 3.15 Recurring questions and the weekly digest
- **Who:** any officer for questions and the digest's room; an admin for where the digest posts outside the console.
- **Before:** the scheduler ticking (3.1). Nothing here runs until it does, and the page says so. [automation: Release 3]
1. **Recurring questions:** nothing to set up. Officers create them on Jack → **Recurring questions** (or Jack proposes one); each ships off. [automation: Setup 1]
2. **The digest in a room:** on the same page, pick the room, day and time, keep or drop Jack's summary, turn it on. "Preview what it would post now" shows both copies first. [automation: Setup 2; Jack → Recurring questions]
3. **The digest on Discord** (admin, after 3.12): pick the channel in the digest's settings. It must be a posting channel (3.13): the settings list only those, and the digest doesn't post to a channel taken off the list. [automation: Setup 3; Sending to Discord]
4. **The digest on Teams** (admin; needs Workflows allowed in UT's tenant, unverified): in the Teams channel, ⋯ → Workflows → "Post to a channel when a webhook request is received", who can trigger: **Anyone**; add a co-owner to the flow. Copy its URL into Vercel as `TEAMS_WEBHOOK_URL` (Production, Sensitive), redeploy. Connections → **Teams digest posts** → Run smoke test (it posts one test card), switch on. Tick "Post to Teams" in the digest's settings. [automation: Setup 4]
5. Optional: `JACK_AUTOMATION_BUDGET_USD` changes the $10 a month automations may spend (inside Jack's $50). [automation: Setup 5]
- **Watch:** each question's Last runs on the page; Jack → Usage (the Automations meter against the cap); the `automation.cap` and `recurring.paused` checks. A Jack run costs about $0.12, a Stand run under a cent (estimate). [automation: The automation cap; Estimated monthly cost]

## 4. Knowledge seed
Run after the migrations are in production. The scripts run from a `jack-2` checkout against the production database, so the code doesn't need to be merged first. [memory: Setup steps (release); build log: Wave 1 calls]
1. **Backfill officer profiles** with the badge sync. It reads no `.env` file and prefers `DIRECT_URL` when both are set. Dry run first, and read the plan: besides departments and board seats, it gives roster officers the officer role and their roster titles, and removes the officer role, title, department and board seat from anyone else who has them (admins are never changed, only reported). Then apply:
   ```bash
   DATABASE_URL='<production>' pnpm --filter @lsr/platform exec tsx scripts/sync-officer-badges.ts
   DATABASE_URL='<production>' pnpm --filter @lsr/platform exec tsx scripts/sync-officer-badges.ts --apply --actor <your email or handle>
   ```
   This has to come first: the seed gives a department's entries to that department's one board officer. [memory: Officer profiles; Seed tooling]
2. **Gray reviews the drafts** in the private seed folder (`~/.lsr/jack-knowledge-seed/`, outside the repo), including the open questions at the end of its `_index.md`. Record the sign-off date in the build log. [design §9; build log: Log, 10/22 later]
3. **Lint and plan** (writes nothing): `DATABASE_URL='<production>' pnpm --filter @lsr/platform exec tsx scripts/jack-knowledge-seed.ts --dir ~/.lsr/jack-knowledge-seed`. The loader reads `apps/platform/.env.local` and `.env` too, but never over what's set in the shell. [knowledge-seed README: Loading]
4. **Load:** the same command with `--approved=<sign-off date> --actor <your handle>`. Entries load as SEED, reviewed as of that date, each with a version and an audit entry. Running it again never undoes changes made on the site (they're skipped and listed; `--overwrite` replaces them). [knowledge-seed README: Loading; memory: Seed tooling]
5. Check Content → Knowledge: the entries, their owners and tags. Ask Jack something one of them answers. [added here]

## 5. Decisions for Gray before switching things on
1. **Discord Developer Terms §12(a)** (before 3.12): written terms with the service providers that see Discord API data (Anthropic, Supabase, Vercel). Their standard terms and DPAs probably cover it; confirm it. [discord-read: Setup 4; research: discord.md §6]
2. **Instagram** (before 3.10): [decks-rooms: Policy questions for Gray]
   - Developer Policy §6.2 and Platform Terms §5.a.i: worth one read before publishing goes on.
   - AI labelling: `is_ai_generated` is an option, off by default (unverified that it shows Instagram's visible label). If every Jack graphic should get it, flip the dialog's default and the kind's description.
   - Posts a day: the site's cap is 10 (`CLUB_DAILY_POSTS` in `src/server/jack/publish/instagram.ts`).
3. **The Vercel token exception** (before 3.7): Vercel has no read-only token, so site traffic uses a project-scoped read-write token, only in the daily snapshot job, with a short expiry. [design §12.5; build log: For Gray to sign off]
4. **Resend** (before 3.6): [design §12.4; sources-a: Setup, Resend 1; build log: For Gray to sign off]
   - The production key stays send-only, and delivery data comes by webhook (the second key exception).
   - Open and click tracking stays off unless you turn it on for the domain. If you do, update the Resend line on `/privacy` first, then add the opened and clicked events to the webhook.
5. **Discord @everyone** (3.13): the bot can't ping @everyone or @here unless it's given Mention @everyone, which also lets it ping every role. [discord-post: Setup 2]
6. **Which Discord channels** to opt in, and whether any officer-only channel is in. [discord-read: Setup 7]
7. **Discord "totals only" is a convention**, not a database permission: `run_sql` can read `DiscordMessage.authorId`. If it should be a hard control, revoke `jack_readonly`'s SELECT on `DiscordMessage` and grant a column list without `authorId`. [discord-read: Limits]
8. **Room notes after account deletion** still name people ("<name> applied: …", "Saved in knowledge for <name>"); deleting an account clears only the message labels. Keep or change. [#224: Noticed, not changed]
9. **Who owns the club Twitch account** and its developer app (design §15 says TBD). [design §15]
10. **The build log and `docs/jack-2/`**: remove before the release merges, fold into `docs/jack.md`, or keep. [build log: intro]
11. **Migrations from your machine or the workflow** (1.6): the workflow takes a backup first. [design §17 step 3]

## 6. Rollback

### 6.1 Switch one thing off
- **A connector:** System → Connections → its switch. Off always works and is audited. Its jobs then return "skipped", its tools say it isn't connected, and the pages say so. [groundwork: The Connections page]
  - Webhooks while off: Resend's events are acknowledged and dropped; Twitch notifications are dropped; Graph notifications are acknowledged and dropped. Stripe's payout and dispute events are still stored (they're Stripe's own signed messages). [sources-a; sources-b; documents]
  - Drive, SharePoint and Teams: a connector switched off hides its documents and messages everywhere, whatever rows are stored. [documents: What it adds]
  - Discord: due posts wait; when posting resumes, any more than 6 hours late are cancelled, not sent. Instagram publishing: posts on their way wait; when it's back on, one more than 2 hours past its approval fails instead of going up late. [discord-post: Jobs; decks-rooms: How a post goes out]
- **A job:** System → Scheduled jobs → its switch (admins). [groundwork: Scheduler, Choices made here]
- **Discord posts:** any officer can pause a rule (its scheduled posts are cancelled) or cancel a scheduled post on Announcements. [discord-post: Standing rules; Announcements]
- **Recurring questions and the digest:** Off on Jack → Recurring questions. [automation: Jack → Recurring questions]
- **Web tools:** remove `JACK_WEB_TOOLS` and redeploy. [groundwork: Model loop 2.0]

### 6.2 Stop everything scheduled
`SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'lsr-scheduler-tick'), active := false);` in the Supabase SQL editor. Nothing scheduled runs (syncs, posts, recurring questions, the digest). The GitHub Actions crons (notifications, recruiting, Instagram feed) aren't affected. [groundwork: Scheduler, When something's wrong; design §6]

### 6.3 Roll the code back
Vercel → Deployments → the last production deployment from before the merge. The schema is safe for it because the migrations are additive: `main`'s code ran on them between 1.6 and 2.1. [design §17 step 6; `docs/deployment.md`]
- **Pause the tick first (6.2).** With old code, `/api/cron/tick` is a 404, and any job switched on stays due, so pg_cron would call it every minute. [groundwork: Scheduler, How it fits together; When something's wrong]
- **Instant Rollback** only reaches it if nothing has been deployed to production since the merge: on Hobby, Vercel rolls back only to the deployment just before the current one, and every redeploy in section 3 adds one. Otherwise, **Redeploy** that deployment. A redeploy is an ordinary production deployment, so the next push to `main` puts 2.0 live again while the tick is still paused. Either way, to make the rollback last, open a revert of #189's merge on `main`, or hold merges to `main` until 2.0 goes forward again. [Vercel docs: Instant Rollback, Hobby limit; the rest added here]
- Webhooks pointed at the new routes get 404s: Resend retries and may disable the endpoint; Twitch revokes subscriptions after repeated failures (run the EventSub script again after going forward); Graph subscriptions lapse within 3 days. The existing Stripe endpoint keeps working; the old code ignores payout and dispute events. [sources-a: Resend delivery events; Stripe; sources-b: EventSub webhook; documents: Teams]
- Jack 1.x reads deck files from Vercel Blob again. What the copy took is still in Blob (it doesn't delete), but renders, exports, screenshots and room files saved since the merge are only in Supabase. [files: The file store; files: Setup (production) 2; `scripts/jack-storage-setup.ts`]
- **Rooms under the old code:** Jack 1.x ignores 2.0's room settings. Mention-mode rooms answer every message again, and the first post in one gets Jack 1.x answering the side messages waiting since the last mention along with it (they're officer messages nobody has answered). Archived rooms drop out of the list and can't be opened (1.x shows only rooms that aren't archived, and has no way to unarchive); pins are ignored. Pending proposals can't be applied or discarded until 2.0 is back. [`main`'s `src/server/jack/reply-loop.ts` (`ANSWERABLE`) and `rooms.ts`; added here]

### 6.4 What the migrations leave behind
A code rollback doesn't undo the migrations, and they don't need undoing. What stays: [design §3.1; design §17]
- the new tables (empty, or holding what was synced) and the new nullable or defaulted columns;
- the `scheduler` schema and `scheduler.tick()`; once 3.1 is done, the pg_cron jobs `lsr-scheduler-tick` and `lsr-cron-history-cleanup`, and the Vault values `lsr_scheduler_secret` and `lsr_scheduler_url` (remove them with the "Remove" line the setup script prints);
- the search triggers, which keep indexing room messages and knowledge into `JackSearchDoc` (harmless to the old code);
- row level security and Jack's read policies on the new personal-data tables, and the tighter recruiting and audit log policies (Jack 1.x reads less, by design);
- the `ConnectorState` rows; settings rows written after launch (`twitch`, `instagram_publish`, `discord_posting`, `discord_purged`);
- the `jack` Storage bucket and its files.

## 7. After launch
Things that come back later:
- **Site traffic token:** when it expires, the snapshot fails with "make a new project-scoped token". Make one and update `VERCEL_ANALYTICS_TOKEN`. [sources-a: Setup, Site traffic 4]
- **Twitch:** when Content → Streams says Twitch revoked the webhooks, run `scripts/twitch-eventsub.ts --apply` again. [sources-b: Setup, Twitch 5]
- **Rotating `SCHEDULER_SIGNING_SECRET`:** set `SCHEDULER_SIGNING_SECRET_PREVIOUS` to the old value and `SCHEDULER_SIGNING_SECRET` to the new one, redeploy, update Vault with the setup SQL, then remove `_PREVIOUS`. [groundwork: Scheduler, Rotating the secret]
- **The PDF link probe:** run it again whenever the web fetch tool version changes (3.4). [files: G6, Setup and release 5]
- **The `@napi-rs/canvas` override** in the root `package.json`: remove it once a newer release is two weeks old (from 11/04), run `pnpm install` and commit the lockfile. [groundwork: intro]
