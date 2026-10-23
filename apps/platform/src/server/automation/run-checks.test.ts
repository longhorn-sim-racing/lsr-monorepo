import { describe, expect, it, vi } from "vitest"

vi.mock("./registry", () => ({ DIGEST_CHECKS: [] }))

import { attentionCount, failedChecks, moreThanShown, needingAttention, runDigestChecks } from "./run-checks"
import type { DigestCheck, DigestCheckResult } from "./types"

const NOW = new Date("2026-10-26T14:00:00Z")
/** Built from pieces so it never looks like a real key in the repo */
const FAKE_KEY = "sk_" + "live_" + "a1b2c3d4".repeat(3)
const check = (id: string, order: number, run: DigestCheck["run"]): DigestCheck => ({ id, label: id, href: `/admin/${id}`, order, run })
const found = (count: number, severity: DigestCheckResult["severity"]): DigestCheck["run"] => async () => ({ count, severity, items: [{ title: "x", href: "/admin" }] })

describe("running the checks", () => {
  it("runs every check at the same moment, and sorts what needs attention by urgency, then order", async () => {
    const seen: Date[] = []
    const report = await runDigestChecks({
      now: NOW,
      checks: [
        check("quiet", 1, async ({ now }) => (seen.push(now), { count: 0, severity: "info", items: [] })),
        check("fyi", 2, found(3, "info")),
        check("late", 50, found(1, "warning")),
        check("soon", 40, found(2, "warning")),
        check("broken", 90, found(1, "danger")),
      ],
    })
    expect(seen).toEqual([NOW])
    expect(report.at).toBe(NOW)
    expect(report.outcomes.map((o) => o.check.id)).toEqual(["quiet", "fyi", "late", "soon", "broken"])
    expect(needingAttention(report).map((o) => o.check.id)).toEqual(["broken", "soon", "late", "fyi"])
    expect(attentionCount(report)).toBe(7)
  })

  it("keeps going when a check throws, with its error redacted for the console", async () => {
    const report = await runDigestChecks({
      now: NOW,
      checks: [check("bad", 1, async () => Promise.reject(new Error(`Stripe said 401 for ${FAKE_KEY}`))), check("good", 2, found(1, "warning"))],
    })
    const [bad] = failedChecks(report)
    expect(bad.check.id).toBe("bad")
    expect(bad.result).toBeNull()
    expect(bad.error).toMatch(/^Stripe said 401 for /)
    expect(bad.error).not.toContain(FAKE_KEY)
    expect(needingAttention(report).map((o) => o.check.id)).toEqual(["good"])
  })

  it("stops waiting for a slow check, and passes it a signal that says so", async () => {
    let aborted = false
    const report = await runDigestChecks({
      now: NOW,
      timeoutMs: 30,
      checks: [
        check("slow", 1, ({ signal }) => new Promise((resolve) => signal?.addEventListener("abort", () => ((aborted = true), resolve({ count: 1, severity: "info", items: [] }))))),
      ],
    })
    expect(aborted).toBe(true)
    expect(report.outcomes[0]).toMatchObject({ result: null, error: "Didn't finish in 0 s" })
  })

  it("stops every check when the caller's signal aborts", async () => {
    const controller = new AbortController()
    controller.abort(new Error("the job ran out of time"))
    const report = await runDigestChecks({ now: NOW, signal: controller.signal, checks: [check("never", 1, () => new Promise(() => {}))] })
    expect(report.outcomes[0]).toMatchObject({ result: null, error: "the job ran out of time" })
  })
})

describe("\"and N more\"", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `${i}`, href: "/admin" }))

  it("is the count past what's shown when the items are the things counted", () => {
    expect(moreThanShown({ count: 12, severity: "info", items: items(5) }, 3)).toBe(9)
    expect(moreThanShown({ count: 3, severity: "info", items: items(3) }, 3)).toBe(0)
    expect(moreThanShown({ count: 2, severity: "info", items: items(2) }, 3)).toBe(0)
  })

  it("counts items, not the count, when a check says how many items it left out", () => {
    // 6 bounced addresses on 4 emails, every email listed
    expect(moreThanShown({ count: 6, severity: "info", items: items(4), moreItems: 0 }, 3)).toBe(1)
    // 20 overdue items over 10 owners, the check lists 8
    expect(moreThanShown({ count: 20, severity: "info", items: items(8), moreItems: 2 }, 3)).toBe(7)
  })
})
