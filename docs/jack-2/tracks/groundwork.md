Docs and env notes for the groundwork track; folded into docs/jack.md at the end.

- **`@napi-rs/canvas` override.** The root `package.json` pins `pdfjs-dist>@napi-rs/canvas` to 1.0.10 (`pnpm.overrides`), because the newest release (1.0.13) was a day old when pdfjs-dist was added on 10/22. Remove the override once a newer release is at least two weeks old (from 11/04), then run `pnpm install` and commit the lockfile.

## Scheduler (G3)

Scheduled work for 2.0 (design §6; research: `research/supabase-pg-cron.md`). pg_cron runs `scheduler.tick()` every minute; when a `ScheduledJob` row is due, it posts a signed request to the site, and the site runs the job.

### How it fits together
- **The tick** (SQL, migration `20261023020000_jack2_scheduler`): writes `SchedulerHeartbeat.lastTickAt` on every call, then posts to `lsr_scheduler_url` through pg_net only when an enabled job is due and unlocked. It signs `v1=hex(HMAC_SHA256(secret, ts + "." + body))` over the jsonb text it sends; the secret never travels (pg_net's queue is readable by every database role).
- **`POST /api/cron/tick`** (`src/app/api/cron/tick/route.ts`): reads the raw body, verifies it (`src/lib/scheduler-signature.ts`: ±300 s, current or previous secret, constant time, fails closed with no secret), records `lastDispatchAt`, answers `202 { ok, due }` (counts only: pg_net keeps response bodies 6 hours where any role can read them), then dispatches in `after()`. 401 for anything unsigned or stale, 405 for a GET (what a redirect would turn pg_net's POST into).
- **The dispatcher** (`src/server/scheduler/dispatcher.ts`):
  - claims each due job with a conditional update (enabled, due, no live lock), setting `lockedUntil` = claim + 360 s and `nextRunAt` = the next run after now in America/Chicago (`schedule.ts`, cron-parser), so missed runs don't pile up;
  - runs at most 3 jobs at once, stops claiming 200 s into the request, and only claims an inline job whose `budgetMs` fits before 290 s;
  - skips kinds this code doesn't know (never claims or fails them);
  - marks a run still `running` from a dead function as failed when its job is next claimed;
  - records each run in `ScheduledJobRun`; errors and summaries go through `redactSecrets()`. A job that ignores its abort signal is recorded as failed 5 s past its deadline and keeps its lock until the lock runs out, so no other tick starts it meanwhile.
- **Hand-offs:** a kind with `handoff: true` is claimed, then posted to `POST /api/admin/jack/run` with `{ jobId, runId, lockedUntil }`, signed over `"run." + ts + "." + body` so a tick's signature can't be replayed there. The route swaps the lock using the exact `lockedUntil` as a one-time token (a replay gets 409), answers 202 and runs the job in `after()` with its own 300 s. It sits under `/api/admin/jack/**`, so the Chromium binary is traced into it. Hand-offs go to the canonical site in production and to the tick request's own origin elsewhere.
- **Housekeeping** (`jobs/groundwork.ts`, all daily around 4 AM CT, all off until an admin turns them on): `housekeeping.job-runs` (runs older than 90 days), `housekeeping.cron-history` (`cron.job_run_details` older than 7 days, skipped where there's no pg_cron), `housekeeping.twitch-samples` (`TwitchViewerSample` older than 180 days).
- **Checks** (`automation/checks/groundwork.ts`): "Scheduler not ticking" (jobs are on but no tick for 10 minutes) and "Failing scheduled jobs" (names and links only, never error text).

### Adding a job kind (for the tracks)
Add a `JobKind` to your `src/server/scheduler/jobs/<track>.ts`:
- `kind` (stable, saved on the row: `discord.sync`), `label`, `description`, `defaultSchedule` (five-field cron, Central time), `budgetMs`.
- Inline jobs keep `budgetMs` at 2 minutes or less; anything longer (Jack runs, backfills) sets `handoff: true` (up to 290 s). `registered-kinds.test.ts` checks every kind.
- `run(ctx)` gets `signal` (aborted at the deadline: stop and return what's done), `deadline`, `startedAt` (pass it to `runRoom` as `startedAt`), `log(line)`, the row's `config` and `job: { id, key }`. Return `{ summary, counts?, status? }`; return `status: "skipped"` when your connector is off or not configured; throw on failure. Never log secrets or personal data.
- Jobs may run again after a crash or a lock timeout, so make them idempotent.
- A kind with one job gets its row from `ensureJobRows()` (the Scheduled jobs page and the setup script call it), keyed by the kind and switched off. Kinds whose feature creates one job per row (recurring questions: `recurring:<id>`) set `singleton: false` and create their own `ScheduledJob` rows; their schedules aren't editable on the Jobs page.
- Try it locally with `pnpm --filter @lsr/platform jack:tick --job <key>` (runs it now even while switched off).

### Env
- `SCHEDULER_SIGNING_SECRET`: 32+ random bytes, hex. The same value goes in Vault as `lsr_scheduler_secret`. Separate from `CRON_SECRET`. Without it every tick and hand-off is refused.
- `SCHEDULER_SIGNING_SECRET_PREVIOUS`: only while rotating.

### Setup (production, Gray)
1. Enable pg_cron and pg_net in the Supabase dashboard; the 2.0 migrations are applied.
2. Make a secret (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), set it in Vercel as `SCHEDULER_SIGNING_SECRET` (Production, Sensitive) and redeploy.
3. `pnpm --filter @lsr/platform jack:scheduler-setup` prints the SQL: Vault values (`lsr_scheduler_secret`, `lsr_scheduler_url` = `https://www.longhornsimracing.org/api/cron/tick`, exact, no redirects), `cron.schedule('lsr-scheduler-tick', '* * * * *', 'select scheduler.tick()')`, a daily `cron.job_run_details` cleanup, and checks. Replace the secret placeholder and run it in the SQL editor. It never prints the production secret. It also creates the job rows in the database `DATABASE_URL` points at (`--no-db` skips that).
4. Check `/admin/jobs`: the Scheduler panel says "Ticking" within a minute. Then turn jobs on.

**Rotating the secret:** in Vercel set `SCHEDULER_SIGNING_SECRET_PREVIOUS` to the old value and `SCHEDULER_SIGNING_SECRET` to the new one, redeploy, update Vault with the setup SQL, then remove `_PREVIOUS`.

**When something's wrong:** the Scheduler panel shows the last tick, whether pg_cron's tick job is scheduled and active (and its last run), and how the site answered pg_net in the last 6 hours: 401 = the Vault secret and `SCHEDULER_SIGNING_SECRET` differ; 3xx or 405 = the URL redirects; 404 = the route isn't deployed. Pause with `cron.alter_job(..., active := false)` (in the printed SQL).

### Locally
- There's no pg_cron schedule on the shared local database. `pnpm --filter @lsr/platform jack:tick` runs the due jobs once, in-process (hand-off jobs too); `--job <key>` runs one job now; `--http [url]` sends a signed tick like pg_cron's to a running dev server (default `http://localhost:3000/api/cron/tick`; needs `SCHEDULER_SIGNING_SECRET` in `.env.local`, the same in both). All refuse non-local targets.
- Prefer `--job` to switching jobs on: a switched-on job runs from every worktree that ticks the shared database.
- `pnpm --filter @lsr/platform exec tsx scripts/check-scheduler.ts` checks the database side (SQL and Node signatures agree, claim races, the hand-off token, orphans, `ensureJobRows`, the prune SQL), writing only rows it deletes again.
- `jack:scheduler-setup --local [--port 3113]` prints the same SQL for the local stack (`http://host.docker.internal:<port>`), only if you really want pg_cron calling a dev server; undo it with the printed "Remove" line.

### Choices made here
- The lock is claim + 360 s (the design's "300 s + margin"), longer than any function lives, so a lock that ran out means its run is gone.
- Run now needs the job switched on (it moves `nextRunAt` to now; the next tick runs it). Turning a job on sets its next run from now, so a job that's been off doesn't run straight away.
- Officers see the Jobs page read-only; switching, Run now and schedule changes are admin-only and audited (`SCHEDULED_JOB`).
- `JobKind` gained `singleton?: false` and `JobContext` gained `startedAt`.
