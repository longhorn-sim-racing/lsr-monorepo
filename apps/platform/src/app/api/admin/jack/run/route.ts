import { NextResponse } from "next/server"
import { verifySchedulerRequest } from "@/lib/scheduler-signature"
import { runAfterResponse } from "@/server/after-response"
import { acceptHandoff, parseHandoffRequest, runHandoff } from "@/server/scheduler/dispatcher"

/**
 * Long scheduled jobs (Jack runs, backfills) get their own invocation here (Jack 2.0, design §6): the
 * dispatcher claims the job and posts its id, signed with the scheduler secret for this route only (a
 * tick's signature doesn't verify here). The route takes the claim over, answers 202, and runs the job
 * after the response with a deadline counted from this request's start. It sits under /api/admin/jack so
 * the Chromium binary is traced into it, for jobs that render.
 *
 * There's no officer session: the signature is the authorization. A replayed request finds the claim
 * already taken over and gets a 409.
 */

export const dynamic = "force-dynamic"
// Runs up to the project's default time limit, 300 s (FUNCTION_MAX_MS in the dispatcher); no route sets maxDuration

const MAX_BODY_CHARS = 4_096

export async function POST(request: Request) {
  const startedAt = Date.now()
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false }, { status: 413 })
  const check = verifySchedulerRequest(request.headers, rawBody, "run", { nowMs: startedAt })
  if (!check.ok) {
    console.warn(`[scheduler] Refused a hand-off: ${check.reason}`)
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  const body = parseHandoffRequest(rawBody)
  if (!body) return NextResponse.json({ ok: false, error: "Expected a job id, run id and lock" }, { status: 400 })

  let accepted: Awaited<ReturnType<typeof acceptHandoff>>
  try {
    accepted = await acceptHandoff(body, startedAt)
  } catch (error) {
    console.error("[scheduler] Hand-off failed:", error)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
  if (!accepted.ok) return NextResponse.json({ ok: false, error: accepted.error }, { status: 409 })

  const { handoff } = accepted
  runAfterResponse(() => runHandoff(handoff, startedAt), "[scheduler] Handed-off job failed:")
  return NextResponse.json({ ok: true }, { status: 202 })
}
