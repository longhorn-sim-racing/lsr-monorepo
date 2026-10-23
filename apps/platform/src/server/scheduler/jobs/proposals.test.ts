import { beforeEach, describe, expect, it, vi } from "vitest"

const service = vi.hoisted(() => ({ sweepProposals: vi.fn() }))
vi.mock("@/server/jack/proposals/service", () => service)

import { JOBS, proposalSweepJob } from "./proposals"
import type { JobContext } from "../types"

function context() {
  const lines: string[] = []
  const ctx: JobContext = {
    signal: new AbortController().signal,
    deadline: Date.now() + 30_000,
    log: (line) => lines.push(line),
    config: null,
    job: { id: "job-1", key: "proposals.sweep" },
  }
  return { ctx, lines }
}

beforeEach(() => {
  service.sweepProposals.mockReset()
})

describe("the proposal sweep job", () => {
  it("is the slot's one job", () => {
    expect(JOBS).toEqual([proposalSweepJob])
    expect(proposalSweepJob.kind).toBe("proposals.sweep")
  })

  it("passes the run's signal on and reports what it swept", async () => {
    service.sweepProposals.mockResolvedValue({ failed: 1, expired: 3 })
    const { ctx, lines } = context()
    expect(await proposalSweepJob.run(ctx)).toEqual({ summary: "Failed 1 stuck apply, expired 3 proposals", counts: { failed: 1, expired: 3 } })
    expect(service.sweepProposals).toHaveBeenCalledWith({ signal: ctx.signal })
    expect(lines).toEqual(["1 stopped partway through applying: marked failed", "3 expired: marked stale"])
  })

  it("says so when there's nothing to sweep", async () => {
    service.sweepProposals.mockResolvedValue({ failed: 0, expired: 0 })
    const { ctx, lines } = context()
    expect(await proposalSweepJob.run(ctx)).toEqual({ summary: "Nothing to sweep", counts: { failed: 0, expired: 0 } })
    expect(lines).toEqual([])
  })

  it("lets a failed sweep throw, for the dispatcher to record", async () => {
    service.sweepProposals.mockRejectedValue(new Error("database is down"))
    await expect(proposalSweepJob.run(context().ctx)).rejects.toThrow("database is down")
  })
})
