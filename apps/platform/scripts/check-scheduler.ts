/**
 * LOCAL ONLY: checks the scheduler's database behavior against the real local Postgres (the unit tests
 * fake Prisma). Run it after changing the dispatcher or the scheduler migration:
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-scheduler.ts
 *
 * - SQL and Node sign a tick the same way (pgcrypto's hmac over the jsonb text scheduler.tick() builds).
 * - Two claims racing for one job: exactly one wins, every time (Postgres re-checks the WHERE).
 * - A hand-off's lock round-trips through timestamp(3) exactly, works once, and a replay is refused.
 * - Runs a dead function left "running" are failed on the next claim; finishing lets go of the job.
 * - ensureJobRows() run twice at once doesn't trip over itself.
 * - The pg_cron prune and the health reads run (the prune inside a transaction that's rolled back).
 *
 * The local database is shared, so it only writes rows it deletes again (keys starting "check:") and
 * leaves every other row alone. Refuses unless DATABASE_URL points at 127.0.0.1 or localhost.
 */
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { PrismaClient } from "@prisma/client"

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

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`)
}

async function main() {
  let host = ""
  try {
    host = new URL(process.env.DATABASE_URL ?? "").hostname
  } catch {}
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error(`Refusing to run: DATABASE_URL points at "${host || "nothing"}", not the local database.`)

  const prisma = new PrismaClient({ log: ["warn", "error"], datasourceUrl: process.env.DATABASE_URL })
  globalThis.prisma = prisma
  const { schedulerSignature, verifySchedulerSignature } = await import("../src/lib/scheduler-signature")
  const { acceptHandoff, claimJob, finishRun, ORPHANED_RUN_ERROR, LOCK_MS } = await import("../src/server/scheduler/dispatcher")
  const { ensureJobRows } = await import("../src/server/scheduler/admin")
  const { getSchedulerHealth } = await import("../src/server/scheduler/heartbeat")

  const prefix = `check:${randomUUID().slice(0, 8)}`
  const createdKinds: string[] = []
  const job = (suffix: string, extra: Record<string, unknown> = {}) =>
    prisma.scheduledJob.create({ data: { key: `${prefix}:${suffix}`, kind: `${prefix}.kind`, schedule: "*/5 * * * *", enabled: true, nextRunAt: new Date(Date.now() - 60_000), ...extra } })

  try {
    // 1. The SQL signer (as scheduler.tick() signs) and the Node verifier agree
    const secret = randomUUID()
    const [signed] = await prisma.$queryRaw<{ ts: string; body: string; signature: string }[]>`
      WITH t AS (SELECT floor(extract(epoch FROM now()))::bigint::text AS ts)
      SELECT t.ts, b.body::text AS body, 'v1=' || encode(extensions.hmac(t.ts || '.' || b.body::text, ${secret}, 'sha256'), 'hex') AS signature
      FROM t, LATERAL (SELECT jsonb_build_object('kind', 'tick', 'ts', t.ts::bigint, 'nonce', gen_random_uuid()) AS body) b`
    const verified = verifySchedulerSignature({ timestamp: signed.ts, signature: signed.signature, rawBody: signed.body, env: { SCHEDULER_SIGNING_SECRET: secret } })
    check("a tick signed in SQL verifies in Node", verified.ok, signed.body)
    check("Node's signature matches SQL's byte for byte", schedulerSignature(secret, signed.ts, signed.body) === signed.signature)

    // 2. Claim races: one winner every time
    let raceOk = true
    for (let i = 0; i < 10; i++) {
      const row = await job(`race-${i}`)
      const claims = await Promise.all([claimJob(row, Date.now()), claimJob(row, Date.now()), claimJob(row, Date.now())])
      const winners = claims.filter(Boolean).length
      const runs = await prisma.scheduledJobRun.count({ where: { jobId: row.id } })
      if (winners !== 1 || runs !== 1) raceOk = false
    }
    check("three claims racing for a job: exactly one wins, one run row (10 tries)", raceOk)

    // 3. Hand-off lock as a one-time token through timestamp(3)
    const handed = await job("handoff")
    const claim = await claimJob(handed, Date.now())
    if (!claim) throw new Error("Couldn't claim the hand-off job")
    const request = { jobId: handed.id, runId: claim.runId, lockedUntil: claim.lockedUntil.toISOString() }
    const routeStart = Date.now()
    const first = await acceptHandoff(request, routeStart)
    // Its kind isn't registered, so the route refuses it after taking the lock: the run is failed and the job let go
    const firstRun = await prisma.scheduledJobRun.findUnique({ where: { id: claim.runId } })
    check("the hand-off lock round-trips exactly (taken over, then refused for its unknown kind)", !first.ok && /doesn't know/.test(first.error) && firstRun?.status === "error", !first.ok ? first.error : "accepted")
    const replay = await acceptHandoff(request, routeStart + 1000)
    check("a replayed hand-off is refused", !replay.ok && /isn't waiting/.test(replay.error))
    const afterHandoff = await prisma.scheduledJob.findUnique({ where: { id: handed.id } })
    check("the refused hand-off let go of the job", afterHandoff?.lockedUntil === null)

    // 4. Orphans and finishing
    const orphaned = await job("orphan", { lockedUntil: new Date(Date.now() - 1000) })
    const deadRun = await prisma.scheduledJobRun.create({ data: { jobId: orphaned.id, status: "running", startedAt: new Date(Date.now() - LOCK_MS - 60_000) } })
    const next = await claimJob(orphaned, Date.now())
    const dead = await prisma.scheduledJobRun.findUnique({ where: { id: deadRun.id } })
    check("a run left running by a dead function is failed on the next claim", dead?.status === "error" && dead.error === ORPHANED_RUN_ERROR)
    if (!next) throw new Error("Couldn't claim the orphan job")
    const locked = await prisma.scheduledJob.findUnique({ where: { id: orphaned.id } })
    check("the claim sets the lock and the next run", !!locked?.lockedUntil && locked.nextRunAt > new Date())
    await finishRun(orphaned.id, next, { status: "ok", summary: "Checked" })
    const finished = await prisma.scheduledJob.findUnique({ where: { id: orphaned.id } })
    const run = await prisma.scheduledJobRun.findUnique({ where: { id: next.runId } })
    check("finishing records the run and lets go of the job", finished?.lockedUntil === null && finished.lastStatus === "ok" && run?.status === "ok" && run.summary === "Checked")

    // 5. ensureJobRows twice at once
    const before = new Set((await prisma.scheduledJob.findMany({ select: { key: true } })).map((r) => r.key))
    const [a, b] = await Promise.all([ensureJobRows(), ensureJobRows()])
    createdKinds.push(...new Set([...a, ...b].filter((key) => !before.has(key))))
    const again = await ensureJobRows()
    check("ensureJobRows is safe to run at once from two places, then does nothing", again.length === 0, createdKinds.length ? `created ${createdKinds.join(", ")}` : "rows were already there")

    // 6. The pg_cron prune (rolled back) and the health reads
    let pruneOk = false
    try {
      await prisma.$transaction(async (tx) => {
        const [found] = await tx.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('cron.job_run_details') IS NOT NULL AS present`
        if (found?.present) await tx.$executeRaw`DELETE FROM cron.job_run_details WHERE coalesce(end_time, start_time) < now() - interval '7 days'`
        pruneOk = true
        throw new Error("rollback")
      })
    } catch (error) {
      if (!(error instanceof Error && error.message === "rollback")) throw error
    }
    check("the pg_cron prune runs as the app's database user", pruneOk)
    const health = await getSchedulerHealth()
    check("the health reads work (pg_cron and pg_net tables)", health.cron !== null && health.delivery !== null, `state ${health.state}, tick job ${health.cron && "scheduled" in health.cron && health.cron.scheduled ? "scheduled" : "not scheduled"}`)
  } finally {
    await prisma.scheduledJob.deleteMany({ where: { key: { startsWith: `${prefix}:` } } })
    if (createdKinds.length) await prisma.scheduledJob.deleteMany({ where: { key: { in: createdKinds }, enabled: false } })
    await prisma.$disconnect()
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll scheduler checks passed")
  if (failures) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
