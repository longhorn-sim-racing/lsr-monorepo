import { describe, expect, it } from "vitest"
import { MAX_JOB_BUDGET_MS } from "./dispatcher"
import { JOB_KINDS } from "./registry"
import { scheduleProblem } from "./schedule"

/** Every track's registered jobs, checked against what the dispatcher can actually run */
describe("registered job kinds", () => {
  it("have a default schedule the scheduler accepts", () => {
    for (const kind of JOB_KINDS) expect(scheduleProblem(kind.defaultSchedule), kind.kind).toBeNull()
  })

  it("have a budget that fits one function (a longer job could never be claimed); over a minute should hand off", () => {
    for (const kind of JOB_KINDS) {
      expect(kind.budgetMs, kind.kind).toBeLessThanOrEqual(MAX_JOB_BUDGET_MS)
      if (!kind.handoff) expect(kind.budgetMs, `${kind.kind} runs inside the tick: hand it off if it needs more than 2 minutes`).toBeLessThanOrEqual(120_000)
    }
  })

  it("have a label and a description for the Scheduled jobs page", () => {
    for (const kind of JOB_KINDS) {
      expect(kind.label.trim(), kind.kind).not.toBe("")
      expect(kind.description.trim(), kind.kind).not.toBe("")
      expect(kind.kind, kind.kind).toMatch(/^[a-z0-9]+([.-][a-z0-9]+)*$/)
    }
  })
})
