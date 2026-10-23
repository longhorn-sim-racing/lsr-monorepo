import { redactSecrets } from "@/lib/redact"
import { DIGEST_CHECKS } from "./registry"
import type { DigestCheck, DigestCheckResult } from "./types"

/**
 * Runs every track's "needs attention" check at one moment (design §11.2), for the weekly digest and the
 * Overview's "Needs attention" card. Each check runs on its own: one that fails or takes too long is
 * reported as such and never stops the others.
 */

/** The longest one check may take before it's reported as not finished */
export const CHECK_TIMEOUT_MS = 10_000

export type CheckOutcome = {
  check: Pick<DigestCheck, "id" | "label" | "href" | "order">
  /** Null when the check failed */
  result: DigestCheckResult | null
  /** Why it failed, redacted; for the console only (the room and the Overview), never posted outside */
  error: string | null
}

export type DigestReport = {
  /** The moment the checks were run for */
  at: Date
  /** Every check, in registry order */
  outcomes: CheckOutcome[]
}

const SEVERITY_RANK = { danger: 0, warning: 1, info: 2 } as const

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message || error.name : String(error), { maxLength: 300 })
}

async function runOne(check: DigestCheck, now: Date, signal: AbortSignal | undefined, timeoutMs: number): Promise<CheckOutcome> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout
  const brief = { id: check.id, label: check.label, href: check.href, order: check.order }
  let stop: () => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    const onAbort = () => reject(both.reason ?? new Error("stopped"))
    if (both.aborted) onAbort()
    both.addEventListener("abort", onAbort, { once: true })
    stop = () => both.removeEventListener("abort", onAbort)
  })
  stopped.catch(() => undefined)
  try {
    const result = await Promise.race([check.run({ now, signal: both }), stopped])
    return { check: brief, result, error: null }
  } catch (error) {
    const text = timeout.aborted ? `Didn't finish in ${Math.round(timeoutMs / 1000)} s` : errorText(error)
    console.error(`[automation] The check ${check.id} failed: ${text}`)
    return { check: brief, result: null, error: text }
  } finally {
    stop()
  }
}

/** Runs the checks (every registered one by default) for `now`, all at once */
export async function runDigestChecks({ now = new Date(), signal, timeoutMs = CHECK_TIMEOUT_MS, checks = DIGEST_CHECKS }: { now?: Date; signal?: AbortSignal; timeoutMs?: number; checks?: DigestCheck[] } = {}): Promise<DigestReport> {
  const outcomes = await Promise.all(checks.map((check) => runOne(check, now, signal, timeoutMs)))
  return { at: now, outcomes }
}

/** The checks that found something, most urgent first (danger, warning, info), then in their order */
export function needingAttention(report: DigestReport): (CheckOutcome & { result: DigestCheckResult })[] {
  return report.outcomes
    .filter((outcome): outcome is CheckOutcome & { result: DigestCheckResult } => Boolean(outcome.result && outcome.result.count > 0))
    .sort((a, b) => SEVERITY_RANK[a.result.severity] - SEVERITY_RANK[b.result.severity] || a.check.order - b.check.order)
}

/** The checks that failed or didn't finish */
export function failedChecks(report: DigestReport): CheckOutcome[] {
  return report.outcomes.filter((outcome) => outcome.error !== null)
}

/** How many things need attention in all */
export function attentionCount(report: DigestReport): number {
  return needingAttention(report).reduce((sum, outcome) => sum + outcome.result.count, 0)
}
