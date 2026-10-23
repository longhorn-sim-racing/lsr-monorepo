/**
 * Prints the SQL that turns the scheduler on (Jack 2.0, design §6 and §15). It never runs that SQL: paste
 * it into the Supabase SQL editor (production) or psql. It sets the two Vault values scheduler.tick()
 * reads, schedules the every-minute tick in pg_cron, and adds a daily cleanup of pg_cron's run log.
 *
 * It also creates the ScheduledJob rows for every job kind (switched off) in the database DATABASE_URL
 * points at, as the Scheduled jobs page does; --no-db skips that.
 *
 *   pnpm --filter @lsr/platform jack:scheduler-setup                       # production (the canonical site)
 *   pnpm --filter @lsr/platform jack:scheduler-setup --url https://…       # another site's address
 *   pnpm --filter @lsr/platform jack:scheduler-setup --local [--port 3000] # a local dev server, reached from the database's container
 *
 * The secret is never printed for production: the SQL has a placeholder to replace with the value of
 * SCHEDULER_SIGNING_SECRET in Vercel. --local uses SCHEDULER_SIGNING_SECRET from .env.local (or prints a new
 * one to add there).
 */
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { PrismaClient } from "@prisma/client"
import { CANONICAL_SITE_URL } from "../src/lib/site-url"

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) continue
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

const TICK_PATH = "/api/cron/tick"
const args = process.argv.slice(2)
const has = (name: string) => args.includes(name)
const valueAfter = (name: string) => {
  const at = args.indexOf(name)
  const next = at >= 0 ? args[at + 1] : undefined
  return next && !next.startsWith("--") ? next : undefined
}

/** A SQL string literal */
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`

function tickUrl(): { url: string; local: boolean } {
  if (has("--local")) {
    const port = Number(valueAfter("--port") ?? 3000)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port takes a port number")
    // The database runs in Docker; host.docker.internal is the machine running the dev server
    return { url: `http://host.docker.internal:${port}${TICK_PATH}`, local: true }
  }
  const base = valueAfter("--url") ?? CANONICAL_SITE_URL
  const url = new URL(base)
  if (url.protocol !== "https:") throw new Error("Use an https:// address (or --local)")
  // pg_net follows redirects and a 301/302 turns its POST into a GET: the exact host and path, nothing after
  return { url: `${url.origin}${TICK_PATH}`, local: false }
}

function localSecret(): { secret: string; isNew: boolean } {
  const existing = process.env.SCHEDULER_SIGNING_SECRET?.trim()
  return existing ? { secret: existing, isNew: false } : { secret: randomBytes(32).toString("hex"), isNew: true }
}

function vaultValue(name: string, value: string, description: string): string {
  return `  SELECT id INTO v_id FROM vault.secrets WHERE name = ${literal(name)};
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(${literal(value)}, ${literal(name)}, ${literal(description)});
  ELSE
    PERFORM vault.update_secret(v_id, ${literal(value)});
  END IF;`
}

function setupSql(url: string, secret: string): string {
  return `-- 1. Vault: the signing secret and the exact address scheduler.tick() posts to (set, or replaced)
DO $setup$
DECLARE
  v_id uuid;
BEGIN
${vaultValue("lsr_scheduler_secret", secret, "Signs scheduler ticks; the same value as SCHEDULER_SIGNING_SECRET")}
${vaultValue("lsr_scheduler_url", url, "Where scheduler.tick() posts: the exact canonical URL, no redirects")}
END
$setup$;

-- 2. The tick, every minute (pg_cron upserts by name, so running this again is safe)
SELECT cron.schedule('lsr-scheduler-tick', '* * * * *', 'select scheduler.tick()');

-- 3. pg_cron never cleans up its run log (the tick adds 1,440 rows a day): keep 7 days, pruned daily at 09:17 UTC
SELECT cron.schedule('lsr-cron-history-cleanup', '17 9 * * *', $$DELETE FROM cron.job_run_details WHERE coalesce(end_time, start_time) < now() - interval '7 days'$$);

-- 4. Check: both jobs are listed and active, and within a minute the heartbeat moves
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE 'lsr-%';
SELECT "lastTickAt", "lastDispatchAt" FROM "SchedulerHeartbeat";
-- Once a job is on and due, the site's answers (202 = good, 401 = the secrets differ):
-- SELECT id, status_code, error_msg, content, created FROM net._http_response ORDER BY created DESC LIMIT 5;

-- Pause:   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'lsr-scheduler-tick'), active := false);
-- Resume:  SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'lsr-scheduler-tick'), active := true);
-- Remove:  SELECT cron.unschedule('lsr-scheduler-tick'); SELECT cron.unschedule('lsr-cron-history-cleanup');`
}

async function ensureRows(): Promise<void> {
  let host = ""
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname
  } catch {}
  if (!host) {
    console.log("-- (DATABASE_URL isn't set, so no job rows were created; the Scheduled jobs page creates them on first visit.)")
    return
  }
  const prisma = new PrismaClient({ log: ["warn", "error"], datasourceUrl: process.env.DATABASE_URL })
  globalThis.prisma = prisma
  try {
    const { ensureJobRows } = await import("../src/server/scheduler/admin")
    const created = await ensureJobRows()
    console.log(`-- Job rows on ${host}: ${created.length ? `created ${created.join(", ")} (switched off)` : "all present"}. Turn jobs on at /admin/jobs.`)
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  const { url, local } = tickUrl()
  const steps: string[] = []

  if (local) {
    const { secret, isNew } = localSecret()
    console.log(`-- LOCAL scheduler setup: pg_cron in the local Supabase will call ${url}
-- The local database is shared by every worktree: once this is scheduled, every enabled job runs from
-- whichever server listens on that port. For one worktree, \`pnpm jack:tick\` is usually the better choice.
-- Undo with the "Remove" line at the end.${isNew ? `\n--\n-- Add this line to apps/platform/.env.local first (and restart the dev server):\n--   SCHEDULER_SIGNING_SECRET=${secret}` : ""}
`)
    console.log(setupSql(url, secret))
  } else {
    steps.push(
      "-- Before this:",
      "--   a. Enable pg_cron (Integrations → Cron) and pg_net (Database → Extensions) in the Supabase dashboard,",
      "--      and apply the migrations (scheduler.tick() comes from 20261023020000_jack2_scheduler).",
      "--   b. Make a secret: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      "--      Put it in Vercel as SCHEDULER_SIGNING_SECRET (Production, Sensitive) and redeploy.",
      "--   c. Replace <SCHEDULER_SIGNING_SECRET> below with the same value. Don't save the filled-in SQL anywhere.",
      `--   d. Check the address doesn't redirect: an unsigned POST must answer 401, not 3xx:`,
      `--        curl -s -o /dev/null -w "%{http_code} %{redirect_url}\\n" -X POST ${url}`,
      "",
    )
    console.log(steps.join("\n"))
    console.log(setupSql(url, "<SCHEDULER_SIGNING_SECRET>"))
  }

  console.log("")
  if (has("--no-db")) console.log("-- (--no-db: job rows not checked.)")
  else await ensureRows()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
