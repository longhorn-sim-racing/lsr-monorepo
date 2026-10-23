import { afterEach, describe, expect, it, vi } from "vitest"
import type { JobKind } from "./types"

const fakeJob = (kind: string): JobKind => ({
  kind,
  label: kind,
  description: "A test job",
  defaultSchedule: "0 6 * * *",
  budgetMs: 30_000,
  run: async () => ({ summary: "Nothing to do", status: "skipped" }),
})

afterEach(() => {
  vi.doUnmock("./jobs/groundwork")
  vi.doUnmock("./jobs/proposals")
  vi.doUnmock("./jobs/sources-a")
  vi.doUnmock("./jobs/sources-b")
  vi.doUnmock("./jobs/discord-read")
  vi.resetModules()
})

describe("the job registry", () => {
  it("loads with unique kinds, each with a five-field schedule and a budget", async () => {
    const { JOB_KINDS, findJobKind } = await import("./registry")
    expect(new Set(JOB_KINDS.map((j) => j.kind)).size).toBe(JOB_KINDS.length)
    for (const job of JOB_KINDS) {
      expect(job.defaultSchedule.trim().split(/\s+/), job.kind).toHaveLength(5)
      expect(job.budgetMs, job.kind).toBeGreaterThan(0)
    }
    expect(findJobKind("nope")).toBeUndefined()
    // The proposal sweep is joined in by the registry itself, not by a track's slot file
    expect(findJobKind("proposals.sweep")?.label).toBe("Proposal sweep")
  })

  it("joins the tracks' jobs in track order and finds them by kind", async () => {
    vi.doMock("./jobs/discord-read", () => ({ JOBS: [fakeJob("discord.sync")] }))
    vi.doMock("./jobs/groundwork", () => ({ JOBS: [fakeJob("housekeeping.prune")] }))
    vi.doMock("./jobs/proposals", () => ({ JOBS: [] })) // the real sweep; left out of the order check
    vi.doMock("./jobs/sources-b", () => ({ JOBS: [] }))
    const { JOB_KINDS, findJobKind } = await import("./registry")
    // The room file jobs (jobs/files.ts) join the groundwork slot, after its own
    expect(JOB_KINDS.map((j) => j.kind)).toEqual(["housekeeping.prune", "files.cleanup", "discord.sync"])
    expect(findJobKind("discord.sync")?.label).toBe("discord.sync")
  })

  it("throws at load when two tracks register the same kind", async () => {
    vi.doMock("./jobs/sources-a", () => ({ JOBS: [fakeJob("stripe.sync")] }))
    vi.doMock("./jobs/discord-read", () => ({ JOBS: [fakeJob("stripe.sync")] }))
    await expect(import("./registry")).rejects.toThrow('Duplicate job kind "stripe.sync": registered by sources-a and discord-read')
  })
})
