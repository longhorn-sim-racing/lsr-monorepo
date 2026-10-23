# Supabase pg_cron + pg_net scheduler (research spec)

Researched 2026-10-22 from Supabase's docs (raw sources on GitHub), the pg_cron and pg_net READMEs and source, and Vercel's docs. Some facts were also checked against our local CLI stack (`supabase/postgres:17.11.0.004`), using only read-only queries or transactions that were rolled back; those are marked **(verified locally)**. Anything still unconfirmed is marked **UNVERIFIED**.

## 1. What we'd use it for

Jack 2.0 needs scheduled work: digests, recurring questions, Discord posts, data syncs and resuming long Claude turns. It has to run with no always-on server, and Vercel Hobby can't provide it, because Hobby crons run at most **once a day with ±59 min precision**. A pg_cron job inside our Supabase Postgres can wake up every minute and use pg_net to POST to a Vercel route (`/api/cron/tick`). That route then dispatches whatever is due from our own table.

This setup could also replace the three GitHub Actions crons: notifications every 15 min, recruiting every 15 min and Instagram hourly. GitHub pauses those after 60 days without commits, and two of them fail open when `CRON_SECRET` is unset.

**Recommendation: one "tick" job, not one pg_cron job per task.**

| | One pg_cron job per task | **One tick job + `ScheduledJob` table (recommended)** |
|---|---|---|
| Schedules live in | `cron.job` (SQL, GMT only) | Our Prisma table, editable from the admin UI and readable by Jack |
| Time zone / DST | GMT only (`cron.timezone` needs a restart) | Computed in app code in `America/Chicago` |
| Secrets in DB | One signed request per job | One signing routine |
| Tests | Need a real DB | Vitest with a fake clock |
| Granularity | Down to 1 s | 1 min (or `'30 seconds'` if ever needed) |
| Vercel invocations | Only when a job fires | Up to 43,200/mo, cut to "only when something is due" by a SQL gate (§3.6) |

## 2. Auth and setup

### 2.1 Enable the extensions
- **Dashboard:** go to Integrations → Cron and enable `pg_cron`. Then go to Database → Extensions, search "pg_net" and enable it.
- **SQL (what we'd do, inside a Prisma migration):** Supabase's documented forms are:
  - `create extension pg_cron with schema pg_catalog;` (it creates the `cron` schema)
  - `create extension pg_net with schema extensions;` (its objects go in the `net` schema; putting it in `extensions` keeps it out of `public` and satisfies Security Advisor)

  The docs also add `grant usage on schema cron to postgres; grant all privileges on all tables in schema cron to postgres;`. Locally, `postgres` already holds those privileges after `CREATE EXTENSION`, with grant option (verified locally).
- Both libraries are already in `shared_preload_libraries` locally, alongside `supabase_vault` (installed, 0.3.1) and `pgcrypto` (in `extensions`) (verified locally). `postgres` is **not** a superuser, but it can still create both extensions, because Supabase's supautils allows it (verified locally).
- **Shadow-database trap (verified locally):** `prisma migrate dev` replays migrations on a fresh database in the same cluster. There, `CREATE EXTENSION pg_cron` fails with `ERROR: can only create extension in database postgres` and `DETAIL: Jobs must be scheduled from the database configured in cron.database_name`. The `extensions` schema doesn't exist there either. Guard the migration the same way `20261013033000_jack_rooms` does. This also skips the local `lsr_eval` copy, which is what we want:
```sql
DO $sched$
BEGIN
  IF current_database() <> coalesce(current_setting('cron.database_name', true), 'postgres')
     OR to_regnamespace('extensions') IS NULL THEN
    RAISE NOTICE 'Not the Supabase postgres database (shadow/eval copy); skipping pg_cron/pg_net';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
  CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;
  -- the functions, cron.schedule(...) and checks from §3 go here too
END $sched$;
```
- Versions: locally pg_cron is **1.6.4** and pg_net is **0.20.4**. Supabase's current image release (`postgres17: 17.11.0.007` in `supabase/postgres` `ansible/postgres_release.yml`) builds the same two as its newest versions (`nix/ext/versions.json`), so hosted should match. Our project's actual installed/default version is still **UNVERIFIED**, because it depends on the project's image. Check with `select name, default_version, installed_version from pg_available_extensions where name in ('pg_cron','pg_net');`. Seconds-level schedules need Postgres ≥ 15.1.1.61; we're on PG 17.
- Disabling: `drop extension pg_cron` **permanently deletes all jobs**. `drop extension pg_net` deletes queued requests and stored responses, and breaks Database Webhooks.

### 2.2 Secrets and env vars
Nothing here involves OAuth or token lifetimes. Auth is our own shared secret.

| Where | Name | Value |
|---|---|---|
| Vercel env (Production) | `SCHEDULER_SIGNING_SECRET` | 32+ random bytes, hex |
| Vercel env (rotation only) | `SCHEDULER_SIGNING_SECRET_PREVIOUS` | Old value, accepted for a grace period |
| Supabase Vault (prod) | `lsr_scheduler_secret` | Same value as `SCHEDULER_SIGNING_SECRET` |
| Supabase Vault (prod) | `lsr_scheduler_url` | `https://<canonical prod host>/api/cron/tick` (no redirect; see §6) |
| Vault (local) | Same names | URL `http://host.docker.internal:3000/api/cron/tick` (resolves inside `supabase_db_platform`, verified locally) |

- Create Vault secrets **by hand** in the Dashboard Vault UI or the SQL editor, never in a migration, which would put them in git: `select vault.create_secret('<value>', 'lsr_scheduler_secret', 'tick HMAC key');`. The signature is `vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null) → uuid`, and names are unique.
- Rotate with `vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)`. Update `SCHEDULER_SIGNING_SECRET_PREVIOUS`, then the Vault secret, then `SCHEDULER_SIGNING_SECRET`.
- Read in SQL: `select decrypted_secret from vault.decrypted_secrets where name = 'lsr_scheduler_secret'`. The `postgres` role, which owns the jobs, can SELECT that view (verified locally). `jack_readonly` has no USAGE on `vault` (verified locally).
- Locally, set the two Vault secrets with a small script (like `scripts/jack-local-sql-role.ts`). Alternatively, use the commented `[db.vault]` block in `config.toml`. It isn't in the CLI config docs, but the CLI source (`apps/cli-go/pkg/vault/batch.go`, called from `internal/db/start/start.go`) shows how it works. Each key is a Vault secret name and each value a secret, e.g. `lsr_scheduler_secret = "env(LSR_SCHEDULER_SECRET)"`. The CLI upserts them with `vault.create_secret`/`vault.update_secret` when it sets up the local DB (`supabase start` on a fresh volume, `supabase db reset`). `supabase db push` has an include-vault option that would write them to the linked hosted project, so leave it off. Prisma's `pnpm db:reset` doesn't run this step.
- **Narrowest permissions:** jobs run as the role that scheduled them, and pg_cron's RLS shows each role only its own jobs. Schedule as `postgres` (the migration user), never as `jack_readonly`. Put our SQL in a new `scheduler` schema with `REVOKE EXECUTE ... FROM PUBLIC`.

## 3. Endpoints we need

pg_cron has no HTTP API. Its "endpoints" are SQL functions and tables, plus the one HTTP route we write.

### 3.1 `cron.schedule` / `cron.unschedule` / `cron.alter_job`
```sql
cron.schedule(job_name text, schedule text, command text) → bigint      -- upserts by name
cron.schedule(schedule text, command text) → bigint                    -- unnamed; avoid
cron.schedule_in_database(job_name, schedule, command, database, username default null, active default true) → bigint
cron.unschedule(job_name text) → boolean   |   cron.unschedule(job_id bigint) → boolean
cron.alter_job(job_id bigint, schedule text default null, command text default null,
               database text default null, username text default null, active boolean default null) → void
```
- Schedule syntax: 5-field Vixie cron in **GMT**, with `$` allowed for the last day of the month. For sub-minute schedules, use `'[1-59] seconds'` (e.g. `'30 seconds'`), which **can't be combined** with other fields.
- Job names are case-sensitive and can't be renamed. Scheduling an existing name replaces that job. Uniqueness is per role (`UNIQUE (jobname, username)`), so the same name scheduled by another role makes a second job.
- Upstream pg_cron revokes `EXECUTE` on `cron.alter_job` and `cron.schedule_in_database` from PUBLIC. On Supabase, `postgres` has `EXECUTE` on both after `CREATE EXTENSION` (verified locally, rolled back).
- `cron.unschedule('missing')` raises `ERROR: could not find valid entry for job 'missing'` (pg_cron source). Guard it with `IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = ...)`.
- Pause and resume with `select cron.alter_job((select jobid from cron.job where jobname='lsr-scheduler-tick'), active := false);`
```sql
SELECT cron.schedule('lsr-scheduler-tick', '* * * * *', 'SELECT scheduler.tick()');
SELECT cron.schedule('lsr-cron-history-cleanup', '17 9 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$$);
```

### 3.2 `cron.job` and `cron.job_run_details` (read for health checks)
Columns (verified locally):
- `cron.job`: `jobid, schedule, command, nodename, nodeport, database, username, active, jobname`
- `cron.job_run_details`: `jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time`
```sql
select jobid, status, return_message, start_time, end_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'lsr-scheduler-tick')
order by start_time desc limit 3;
```
```json
[{"jobid":3,"status":"succeeded","return_message":"SELECT 1","start_time":"2026-10-22T18:01:00.012Z","end_time":"2026-10-22T18:01:00.031Z"},
 {"jobid":3,"status":"failed","return_message":"job startup timeout","start_time":"2026-10-22T18:00:00.010Z","end_time":"2026-10-22T18:00:05.010Z"}]
```
- `status` is one of `starting | running | sending | connecting | succeeded | failed`.
- Failure messages seen in the source: `job startup timeout`, `server restarted`, `job canceled`, `connection failed`, or the SQL error text.
- **"succeeded" only means the request was queued.** The HTTP outcome is in `net._http_response` (§3.4).

### 3.3 `net.http_post`
```sql
net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
              headers jsonb default '{"Content-Type": "application/json"}',
              timeout_milliseconds int default 5000) → bigint   -- request id; SECURITY DEFINER
```
- `SECURITY DEFINER` comes from Supabase's install (verified locally). Upstream `sql/pg_net.sql` doesn't declare it.
- The default timeout is **5000 ms in 0.20.4** (verified locally). Supabase's docs page still says 2000, so always pass the timeout explicitly.
- The body is sent as `convert_to(body::text, 'UTF8')`, the jsonb text form (verified in the function source).
- The function **raises if Content-Type isn't exactly `application/json`**, and adds that header if you leave it out. The check is a plain string comparison, so even `application/json; charset=utf-8` raises `Content-Type header must be "application/json"`.
- The request is queued in `net.http_request_queue` and sent **only after the calling transaction commits**. The background worker (libcurl multi) sends it with `User-Agent: pg_net/<version>` and **follows redirects**.
- Also available: `net.http_get(url, params, headers, timeout_milliseconds) → bigint`.

### 3.4 `net._http_response` (unlogged, kept for `pg_net.ttl` = 6 h)
Columns: `id` (= request id), `status_code`, `content_type`, `headers jsonb`, `content text`, `timed_out bool`, `error_msg text`, `created timestamptz`.
```json
[{"id":42,"status_code":202,"content_type":"application/json","content":"{\"ok\":true,\"due\":2}","timed_out":false,"error_msg":null},
 {"id":41,"status_code":null,"timed_out":true,"error_msg":"Timeout of 10000 ms reached. Total time: 10001.200000 ms (DNS time: 1.100000 ms, TCP/SSL handshake time: 40.200000 ms, HTTP Request/Response time: 9959.900000 ms)"}]
```
- The timeout text comes from `src/errors.c` (`"Timeout of %d ms reached. Total time: %f ms (DNS time: %f ms, TCP/SSL handshake time: %f ms, HTTP Request/Response time: %f ms)"`). `%f` prints six decimals. The source comment misspells "Respose", but the real output says "Response".
- Transport errors produce `status_code null`, `timed_out false` and `curl_easy_strerror()` text in `error_msg` (verified in `src/core.c`). The exact strings depend on the libcurl version.
- To find failures: `where status_code >= 400 or error_msg is not null order by created desc`.
- `cron.job_run_details` does not record the request id. If we need the link, our function should log it (§3.6).

### 3.5 Vault
See §2.2: `vault.create_secret`, `vault.update_secret`, and the `vault.decrypted_secrets` view (`id, name, description, secret, decrypted_secret, key_id, nonce, created_at, updated_at`).

### 3.6 Our side: `scheduler.tick()` (SQL) → `POST /api/cron/tick` (Next.js)
The SQL function lives in a migration and contains no secrets. It only sends a request when something is due. It signs the request with an HMAC and does **not** send the raw secret (see §6, point 1).
```sql
CREATE SCHEMA IF NOT EXISTS scheduler;
CREATE OR REPLACE FUNCTION scheduler.tick() RETURNS bigint LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_url text; v_secret text; v_ts text; v_body jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."ScheduledJob" WHERE enabled AND "nextRunAt" <= now()) THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'lsr_scheduler_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'lsr_scheduler_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN RAISE NOTICE 'scheduler: vault secrets missing'; RETURN NULL; END IF;
  v_ts   := floor(extract(epoch FROM now()))::bigint::text;
  v_body := jsonb_build_object('kind', 'tick', 'ts', v_ts::bigint, 'nonce', gen_random_uuid());
  RETURN net.http_post(
    url := v_url, body := v_body, timeout_milliseconds := 10000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-LSR-Timestamp', v_ts,
      'X-LSR-Signature', 'v1=' || encode(extensions.hmac(v_ts || '.' || v_body::text, v_secret, 'sha256'), 'hex')));
END $$;
REVOKE EXECUTE ON FUNCTION scheduler.tick() FROM PUBLIC;
```
`ScheduledJob` is a proposed table with `enabled`, `nextRunAt`, `leaseUntil`, `cron`, `tz` and `handler`. `pgcrypto`'s `hmac()` gives the same hex as Node's `createHmac('sha256', key)`. Test vector: key `k`, message `1700000000.{}` → `c6ef4734033cee2367414a0939385eca0397754aa7a59716da7463a9298b5146` (verified locally in both).

**What the route receives:**
```
POST /api/cron/tick
Content-Type: application/json
User-Agent: pg_net/0.20.4
X-LSR-Timestamp: 1792692060
X-LSR-Signature: v1=<64 hex>

{"ts": 1792692060, "kind": "tick", "nonce": "5f0c..."}
```
The body is in jsonb text form: keys sorted by length then bytes, with `": "` and `", "` separators (verified locally).

**What the route does:**
1. Read `await req.text()` first and **verify against the raw text**. Never re-serialize the JSON before checking.
2. Reject with **401** if the timestamp is missing, more than 300 s from now, or the signature doesn't match. Compare with `timingSafeEqual` on equal-length buffers, and fail closed when the env secret is unset, like `src/lib/recruiting/cron-auth.ts`. Accept `_PREVIOUS` during rotation.
3. Return **202** `{"ok":true,"due":n}` quickly, and run the work in `after()` from `next/server`. Work in `after()` shares the function's `maxDuration` (300 s on Hobby).
4. Claim due rows atomically, so overlapping ticks or a replayed request can't double-run: `UPDATE "ScheduledJob" SET "leaseUntil" = now() + interval '5 min' WHERE id IN (SELECT id ... WHERE enabled AND "nextRunAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) FOR UPDATE SKIP LOCKED) RETURNING ...`.
5. Run each claimed job. Set `nextRunAt` from the job's cron and `tz` (computed **from now**, so missed runs don't pile up), and write a run row.
6. Give long jobs, such as a Jack digest, their own signed POST to a per-job route, so each one gets its own 300 s.

**Errors to handle:** 401 (bad signature or stale timestamp), 405 (a redirect turned the POST into a GET), 5xx and timeouts (seen only in `net._http_response`), and the route not being deployed yet (404).

## 4. Webhooks/events

There are no inbound vendor webhooks. The only event is our own signed request from pg_net (§3.6):
- **Signature:** `X-LSR-Signature: v1=hex(HMAC_SHA256(secret, X-LSR-Timestamp + "." + rawBody))`.
- **Freshness:** a ±300 s window.
- **Replays:** a request replayed within the window only re-runs the idempotent claim. Optionally, store the `nonce` with a unique constraint to drop exact replays.
- pg_net has **no retries**. A failed tick is retried by the next minute's tick, because `nextRunAt` is still in the past.

## 5. Rate limits and quotas, plan limits, data retention

**pg_cron (Supabase guidance):**
- Run **≤ 8 jobs concurrently** and keep **each job ≤ 10 minutes**.
- `cron.max_running_jobs` = 32.
- Only one instance of a given job runs at a time; an overlapping trigger is queued.
- Each run opens a DB connection, because `cron.use_background_workers=off` (verified locally). Supabase's pg_cron debugging KB says the same for hosted: "up to 32 concurrent jobs, each using a database connection". Those connections count against the **Nano/Free limit of 60 direct connections** (200 pooler clients).

**`cron.job_run_details`:**
- It is **never cleaned up**, and unscheduling a job doesn't remove its rows.
- A `* * * * *` job adds 1,440 rows a day, so the 7-day cleanup job keeps it to about 10k rows.

**pg_net:**
- Built for ≤ 200 req/s, with `pg_net.batch_size` = 200.
- Responses are kept 6 h (`pg_net.ttl`). Changing it needs `ALTER SYSTEM`, which on hosted means asking Support for `grant alter system on parameter pg_net.ttl to postgres`.
- Both tables are **unlogged**, so they're lost on a crash.
- pg_net's unreleased `master` caps timeouts with `pg_net.max_timeout_ms` (default 600000). It isn't in 0.20.4 (verified locally) or in the latest tag, v0.20.5 (verified in source).

**Supabase Free plan:**
- **Database size 500 MB.** Above that the project goes **read-only**, and all writes fail, including cron jobs (SQLSTATE 25006).
- **Pausing:** a project with "low activity over a 7-day period" is paused. The docs measure "user database activity" and "user queries", and they don't say whether pg_cron runs count. That stays **UNVERIFIED** (a staff forum reply says yes). Prod traffic keeps us active anyway.
- **Plan gating:** the docs mention no Free-plan restriction on pg_cron, pg_net or Vault. They aren't stated as available on Free either, so treat Free-plan availability as **UNVERIFIED** until enabled on the project.

**Time zone:** `cron.timezone` is `GMT`. It's a postmaster setting (restart plus `ALTER SYSTEM`), so we can't change it on hosted (**UNVERIFIED** whether Support would). That's another reason to keep local-time logic in app code.

**Vercel Hobby:**
- 1,000,000 function invocations/month, 4 CPU-hrs Active CPU, 360 GB-hrs memory, 300 s max duration.
- An ungated every-minute tick is 43,200 invocations a month. The SQL gate makes most ticks free.

## 6. Gotchas, policy/terms constraints, privacy notes

1. **Every login role can read and write pg_net's queue, including `jack_readonly` (verified locally; Supabase KB).**
   - What's granted: `net` gives USAGE to PUBLIC, and `net.http_request_queue` and `net._http_response` give **all privileges to PUBLIC**.
   - Can't revoke: `supabase_admin` owns them, so a `REVOKE` run as `postgres` only warns `no privileges could be revoked`. Supabase says to treat this as a platform constraint.
   - Effect: a queued request's headers, including a Vault value written into a header, can be read by Jack's SQL tool. That's why we sign with an HMAC instead of sending `Bearer <secret>`.
   - Effect: Jack's role could also **INSERT** into the queue, and the worker would send it. Only the read-only transaction in Jack's tool prevents that, so keep it strict (no multi-statement strings).
   - **Don't add `net` to the `jack_readonly` USAGE self-check.** It would always fail. This corrects `codebase-infra.md`. Do add `cron` and `scheduler`: `cron` has no PUBLIC USAGE (verified locally), even though `cron.job` grants SELECT to PUBLIC.
2. **Response bodies sit in `net._http_response` for 6 h** and are readable by the same roles. The tick route must return nothing sensitive, just counts.
3. **Redirects:** pg_net sets `CURLOPT_FOLLOWLOCATION`. pg_net 0.20.4 sends the POST with `CURLOPT_POSTFIELDS` and doesn't set `CURLOPT_POSTREDIR` (verified in `src/core.c`). libcurl's `CURLOPT_POSTREDIR` default is 0, so on a 301/302/303 it turns the POST into a GET (libcurl docs). 307/308 keep the method. Point `lsr_scheduler_url` at the exact canonical host and path: no apex↔www hop and no trailing-slash redirect.
4. **Vercel Deployment Protection:** preview URLs require Vercel auth, so only the production URL can be ticked.
5. **Migrations deploy separately** (`docs/deployment.md`). Scheduling `lsr-scheduler-tick` before the route ships is harmless, because the gate sends nothing until `ScheduledJob` has enabled rows, and a 404 is only logged. `cron.schedule` upserts, so re-running the migration is safe. Whether jobs survive `pnpm db:reset` (Prisma reset) is **UNVERIFIED**; the migration re-creates them either way.
6. Don't use the Dashboard's "HTTP request" cron form with secret headers. Studio's `buildHttpRequestCommand` (`apps/studio/components/interfaces/Integrations/CronJobs/CronJobs.utils.tsx`) writes the headers as a literal `headers:='{...}'::jsonb` string into the job command. They then sit in plain text in `cron.job.command` and `job_run_details.command` (verified in source). Use `scheduler.tick()`.
7. **Vault keys are per project.** A `pg_dump`/restore into a new project can't decrypt the secrets until the root key is copied over with the Management API's `pgsodium` endpoint. Pause/restore and PITR keep the key.
8. pg_net is labelled **beta** ("function signatures may change"). A major Postgres upgrade (or turning on Database Webhooks) re-applies pg_net's default grants. The upgrade also revokes `EXECUTE` on `net.http_get`/`net.http_post` from PUBLIC and grants it to `postgres`, `anon`, `authenticated`, `service_role` and `supabase_functions_admin` (KB). Our job runs as `postgres`, so it keeps working. `jack_readonly` would lose `EXECUTE`, but it could still INSERT into the queue table.
9. If the pg_cron scheduler process dies (check `pg_stat_activity where application_name ilike 'pg_cron scheduler'`), jobs silently stop. The fix is a fast reboot in the dashboard.
   - **Monitor it:** the route records `lastTickAt`, and a check (or Jack's digest) flags when it's more than 10 min old.
   - With the gate on, quiet periods send nothing. So either have `tick()` also update a heartbeat row, or check `cron.job_run_details` directly.
10. Nothing in pg_cron or pg_net moves money. Scheduled handlers must keep to the club rule: no refunds or charges from code.

## 7. How to fake it locally

- **Integration runs use the real stack.** The local CLI image has pg_cron 1.6.4 and pg_net 0.20.4 preloaded, plus Vault and pgcrypto (verified locally).
  1. Apply the migration and set the two Vault secrets with the local script (URL `http://host.docker.internal:3000/api/cron/tick`).
  2. Run `pnpm dev`, then watch `select id,status_code,timed_out,error_msg,content from net._http_response order by created desc limit 5;`.
  3. To speed things up, `select cron.alter_job(<id>, schedule := '10 seconds');`.
- **Unit tests (Vitest, no DB) need fakes that reproduce:**
  - `buildPgNetTick({ secret, nowSec, nonce })` → `{ method: 'POST', headers, rawBody }`.
    - `rawBody` must be in **jsonb text form** (`{"ts": 1792692060, "kind": "tick", "nonce": "…"}`), with keys ordered by length then bytes and `": "`/`", "` separators. Don't use `JSON.stringify`.
    - `headers` must include `Content-Type: application/json`, `User-Agent: pg_net/0.20.4`, `X-LSR-Timestamp` and `X-LSR-Signature: v1=<hex>`.
    - Include the test vector from §3.6 so the SQL and Node signers can't drift.
  - Route tests:
    - 202 when valid.
    - 401 for a bad signature, a stale or future timestamp (more than 300 s off), a missing header, or an unset env secret.
    - The previous secret is accepted during rotation.
    - The body is verified as raw text (re-ordered JSON must fail).
  - A dispatcher with a **fake clock and a fake `ScheduledJob` repo** that checks:
    - Due selection and lease claiming (two overlapping ticks must not double-run).
    - Next run is computed from now, so missed runs don't pile up.
    - `America/Chicago` DST edges (2026-11-01 fall-back and 2027-03-14 spring-forward).
  - Fixture rows for any health check that reads the DB:
    - `cron.job_run_details` with each `status` value and the `return_message`s from §3.2.
    - `net._http_response`: a success (202), a timeout (`status_code null, timed_out true`, "Timeout of N ms reached…") and a transport error (`timed_out false`, curl strerror).

## 8. Sources

Supabase docs, read as the raw sources in `github.com/supabase/supabase/apps/docs/content/`:
- https://supabase.com/docs/guides/cron (`guides/cron.mdx`)
- https://supabase.com/docs/guides/cron/install (`guides/cron/install.mdx`)
- https://supabase.com/docs/guides/cron/quickstart (`guides/cron/quickstart.mdx`)
- https://supabase.com/docs/guides/database/extensions/pg_net (`guides/database/extensions/pg_net.mdx`)
- https://supabase.com/docs/guides/database/extensions/pg_cron (a stub pointing to Cron)
- https://supabase.com/docs/guides/functions/schedule-functions (and partial `_partials/pg_net_queued_key.mdx`)
- https://supabase.com/docs/guides/database/vault
- KB: "Database roles can read request headers queued by pg_net" (`troubleshooting/database-roles-can-read-request-headers-queued-by-pg_net-ad6357.mdx`)
- KB: "Revoking access to pg_net objects has no effect" (`troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16.mdx`)
- KB: "pg_cron debugging guide" (`troubleshooting/pgcron-debugging-guide-n1KTaz.mdx`)
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://supabase.com/docs/guides/platform/compute-and-disk
- https://supabase.com/docs/guides/platform/database-size
- https://supabase.com/docs/guides/local-development/cli/config

pg_cron and pg_net:
- https://github.com/citusdata/pg_cron (README, `src/job_metadata.c`, `src/pg_cron.c`)
- https://github.com/supabase/pg_net (README, `src/core.c`, `src/errors.c`)

Vercel:
- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://vercel.com/docs/plans/hobby
- https://vercel.com/docs/limits
- https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package (`after()` / `waitUntil`)

Forum (informal, used only for the pausing note): https://github.com/orgs/supabase/discussions/13121

## Checked

Checked 2026-10-22 against the Supabase docs' raw sources (`guides/cron*.mdx`, `guides/database/extensions/pg_net.mdx`, `guides/database/vault.mdx`, `guides/platform/{database-size,compute-and-disk,free-project-pausing}.mdx`, the pg_net and pg_cron KB articles) and source code. The source code checked was pg_cron `main` (`pg_cron.sql`, the upgrade scripts, `src/pg_cron.c`, `src/job_metadata.c`), pg_net `v0.20.4`, `v0.20.5` and `master` (`sql/pg_net.sql`, `src/core.c`, `src/errors.c`, `src/worker.c`, README), `supabase/vault` SQL, `supabase/postgres` (`ansible/postgres_release.yml`, `nix/ext/versions.json`), the Supabase CLI (`pkg/vault/batch.go`, `internal/db/start/start.go`) and Studio (`CronJobs.utils.tsx`). Also checked: Vercel's cron, Hobby and `after()` docs, libcurl's `CURLOPT_POSTREDIR` docs, and the local stack (read-only, or rolled back).

**Verified as written:**
- Enabling pg_cron (`with schema pg_catalog`, plus the two grants) and pg_net (`with schema extensions`). Dropping pg_cron deletes all jobs. Dropping pg_net loses queued requests and stops Database Webhooks.
- The guard error `can only create extension in database …` and its DETAIL text.
- Signatures: `cron.schedule`/`unschedule`/`alter_job`/`schedule_in_database`, `net.http_post`, `vault.create_secret`/`update_secret`. Vault names are unique (partial unique index).
- Upsert by name. The `could not find valid entry for job '%s'` error. The six `status` values and the failure messages.
- GMT default and the postmaster-level `cron.timezone`. The `$` and `[1-59] seconds` syntax. Seconds schedules need Postgres ≥ 15.1.1.61. Overlapping runs are queued. `cron.max_running_jobs` is 32, and `job_run_details` is never cleaned up.
- pg_net: default timeout 5000 in source vs 2000 in the docs, the Content-Type check, `convert_to(body::text,'UTF8')`, sending after commit, `FOLLOWLOCATION`, `User-Agent: pg_net/<ver>`, `ttl` 6 h, `batch_size` 200, 200 req/s, unlogged tables, beta label, and PUBLIC grants on `net` objects.
- Supabase's guidance of ≤ 8 concurrent jobs, ≤ 10 min each. Free: 500 MB then read-only (SQLSTATE 25006), Nano at 60 direct and 200 pooler connections, paused after "low activity over a 7-day period". Vault keys are per project, with the Management API `pgsodium` endpoint.
- Vercel Hobby: crons once per day with ±59 min, 1M invocations, 4 CPU-hrs, 360 GB-hrs, 300 s max. `after()` runs within the route's max duration.
- The HMAC test vector (openssl and pgcrypto) and the jsonb text form.

**Corrected:**
- The §3.4 timeout example now uses pg_net's real format: "Response", not the source comment's "Respose", and six-decimal `%f` values.
- The example timestamps were 1761156060, which is 2025-10-22. They're now 1792692060 (2026-10-22T18:01:00Z), to match the run rows.
- `pg_net.max_timeout_ms` exists only on unreleased `master`, not in "newer" releases (v0.20.5 doesn't have it).
- Added nuances:
  - Job names are unique per role.
  - `alter_job`/`schedule_in_database` EXECUTE is revoked from PUBLIC upstream, but `postgres` has it on Supabase.
  - `SECURITY DEFINER` on `http_post` comes from Supabase, not upstream.
  - Content-Type must match exactly.
  - Upgrade EXECUTE grants: `postgres` keeps them; `jack_readonly` loses EXECUTE but can still INSERT into the queue.

**Resolved (was UNVERIFIED):**
- `[db.vault]` behaviour (from the CLI source).
- A POST becomes a GET on 301/302/303 in pg_net (no `POSTREDIR`).
- The Dashboard HTTP-request form writes headers literally into the command (Studio source).
- Hosted jobs each use a DB connection (KB).
- The current Supabase image ships pg_cron 1.6.4 and pg_net 0.20.4.

**Still UNVERIFIED:**
- Our hosted project's actual installed extension versions.
- Whether pg_cron runs count as activity for Free-plan pausing.
- Whether the Free plan is gated for pg_cron/pg_net/Vault. No docs or pricing page mention a restriction or confirm availability.
- Whether Support would change `cron.timezone`.
- Whether jobs survive Prisma's `pnpm db:reset`.
- The exact libcurl strerror strings.
