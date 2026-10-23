/**
 * LOCAL ONLY: one scheduler tick (Jack 2.0, design §6). There's no pg_cron schedule on the local database
 * (it's shared by every worktree), so this stands in for it: it runs the due jobs once, in this process,
 * the way /api/cron/tick does after pg_cron calls it. Hand-off jobs run here too.
 *
 *   pnpm --filter @lsr/platform jack:tick                   # run the jobs that are on and due
 *   pnpm --filter @lsr/platform jack:tick --job <key>       # run one job now, on or off, due or not
 *   pnpm --filter @lsr/platform jack:tick --http [url]      # send a signed tick to a running dev server instead,
 *                                                           # like pg_cron would (default http://localhost:3000/api/cron/tick)
 *
 * Prefer --job over switching a job on: switched-on jobs run from every worktree that ticks. Refuses unless
 * DATABASE_URL (or the --http URL) points at 127.0.0.1 or localhost.
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

const LOCAL_HOSTS = ["127.0.0.1", "localhost"]
const args = process.argv.slice(2)
const flag = (name: string) => args.indexOf(name)
const valueAfter = (name: string) => {
  const at = flag(name)
  const next = at >= 0 ? args[at + 1] : undefined
  return next && !next.startsWith("--") ? next : undefined
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname
  } catch {
    return ""
  }
}

async function sendSignedTick(url: string) {
  if (!LOCAL_HOSTS.includes(hostOf(url))) throw new Error(`Refusing to send a tick to "${url}": local servers only.`)
  const { signSchedulerRequest, tickBody } = await import("../src/lib/scheduler-signature")
  const now = Date.now()
  const body = tickBody(Math.floor(now / 1000), randomUUID())
  const response = await fetch(url, { method: "POST", headers: { ...signSchedulerRequest(body, "tick", { nowMs: now }), "user-agent": "pg_net/0.20.4 (jack:tick)" }, body, redirect: "manual" })
  console.log(`${url} answered ${response.status}: ${await response.text()}`)
  if (response.status === 401) console.log("A 401 means the server's SCHEDULER_SIGNING_SECRET isn't the one in this folder's .env.local.")
  if (response.status !== 202) process.exitCode = 1
}

async function main() {
  if (flag("--http") >= 0) return sendSignedTick(valueAfter("--http") ?? "http://localhost:3000/api/cron/tick")

  const host = hostOf(process.env.DATABASE_URL)
  if (!LOCAL_HOSTS.includes(host)) throw new Error(`Refusing to run: DATABASE_URL points at "${host || "nothing"}", not the local database.`)
  // Quiet: src/server/db.ts reuses this client instead of making one that logs every query
  const prisma = new PrismaClient({ log: ["warn", "error"], datasourceUrl: process.env.DATABASE_URL })
  globalThis.prisma = prisma

  const { ensureJobRows } = await import("../src/server/scheduler/admin")
  const { dispatchDueJobs, runOneJob } = await import("../src/server/scheduler/dispatcher")
  const { recordDispatch } = await import("../src/server/scheduler/heartbeat")

  try {
    const created = await ensureJobRows()
    if (created.length) console.log(`Created (switched off): ${created.join(", ")}`)

    const runIds: string[] = []
    const key = valueAfter("--job")
    if (flag("--job") >= 0) {
      if (!key) throw new Error("Name the job: --job <key> (the keys are on /admin/jobs)")
      const result = await runOneJob(key)
      if (!result.ok) throw new Error(result.error)
      runIds.push(result.runId)
    } else {
      const startedAt = Date.now()
      await recordDispatch(new Date(startedAt), { tick: true })
      const result = await dispatchDueJobs({ startedAt, handoff: "inline" })
      if (result.due === 0) console.log("Nothing is due. Jobs that are on show their next run on /admin/jobs; run one anyway with --job <key>.")
      if (result.unknown.length) console.log(`Skipped (this code doesn't know the kind): ${result.unknown.join(", ")}`)
      if (result.deferred.length) console.log(`Left for the next tick: ${result.deferred.join(", ")}`)
      if (result.lost.length) console.log(`Claimed by another tick first: ${result.lost.join(", ")}`)
      if (result.started.length) {
        const runs = await prisma.scheduledJobRun.findMany({ where: { startedAt: { gte: new Date(startedAt) }, job: { key: { in: result.started.map((s) => s.key) } } }, select: { id: true } })
        runIds.push(...runs.map((run) => run.id))
      }
    }

    const runs = await prisma.scheduledJobRun.findMany({ where: { id: { in: runIds } }, include: { job: { select: { key: true } } }, orderBy: { startedAt: "asc" } })
    for (const run of runs) {
      const took = run.finishedAt ? `${((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1)} s` : "still running"
      console.log(`\n${run.job.key}: ${run.status} (${took})`)
      if (run.summary) console.log(`  ${run.summary.replace(/\n/g, "\n  ")}`)
      if (run.error) console.log(`  error: ${run.error}`)
      if (run.status === "error") process.exitCode = 1
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
