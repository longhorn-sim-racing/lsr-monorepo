import { NextResponse } from "next/server"
import { getSiteUrl } from "@/lib/site-url"
import { verifySchedulerRequest } from "@/lib/scheduler-signature"
import { runAfterResponse } from "@/server/after-response"
import { countDueJobs, dispatchDueJobs } from "@/server/scheduler/dispatcher"
import { recordDispatch } from "@/server/scheduler/heartbeat"

/**
 * The scheduler's entry point (Jack 2.0, design §6). pg_cron's scheduler.tick() posts here through
 * pg_net when a ScheduledJob is due, signed with SCHEDULER_SIGNING_SECRET (src/lib/scheduler-signature.ts).
 * It answers 202 with the number of due jobs and nothing else, since pg_net keeps response bodies for 6
 * hours where any database role can read them, then runs the jobs after the response (they share this
 * function's 300 s).
 *
 * Only POST: a redirect on the way would turn pg_net's POST into a GET, which gets a 405 here.
 */

export const dynamic = "force-dynamic"
// Runs up to the project's default time limit, 300 s (FUNCTION_MAX_MS in the dispatcher); no route sets maxDuration

/** pg_net's tick body is under 100 bytes */
const MAX_BODY_CHARS = 4_096

export async function POST(request: Request) {
  const startedAt = Date.now()
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false }, { status: 413 })
  const check = verifySchedulerRequest(request.headers, rawBody, "tick", { nowMs: startedAt })
  if (!check.ok) {
    console.warn(`[scheduler] Refused a tick: ${check.reason}`)
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  let due: number
  try {
    const now = new Date(startedAt)
    const [count] = await Promise.all([countDueJobs(now), recordDispatch(now)])
    due = count
  } catch (error) {
    console.error("[scheduler] Tick failed:", error)
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  if (due > 0) {
    const baseUrl = handoffBaseUrl(request)
    runAfterResponse(async () => {
      const result = await dispatchDueJobs({ startedAt, baseUrl })
      if (result.unknown.length || result.deferred.length) {
        console.info(`[scheduler] Dispatch: ${result.started.length} started, unknown kinds skipped: ${result.unknown.join(", ") || "none"}; left for the next tick: ${result.deferred.join(", ") || "none"}`)
      }
    }, "[scheduler] Dispatch failed:")
  }
  return NextResponse.json({ ok: true, due }, { status: 202 })
}

/**
 * Where hand-off jobs are posted: production's canonical address (the tick's own URL), and elsewhere the
 * address this request came in on, so a local dev server on any port hands off to itself. Local pg_cron
 * reaches the dev server as host.docker.internal, a name only containers can be sure to resolve
 */
function handoffBaseUrl(request: Request): string {
  if (process.env.VERCEL_ENV === "production") return getSiteUrl()
  const url = new URL(request.url)
  if (url.hostname === "host.docker.internal") url.hostname = "localhost"
  return url.origin
}
