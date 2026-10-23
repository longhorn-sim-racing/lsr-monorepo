import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JobKind } from "@/server/scheduler/types"

const db = vi.hoisted(() => ({ scheduledJob: { findUnique: vi.fn(), update: vi.fn() } }))
const guards = vi.hoisted(() => ({ requireRole: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const kinds = vi.hoisted(() => new Map<string, JobKind>())

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/audit/log", () => audit)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/scheduler/registry", () => ({ findJobKind: (kind: string) => kinds.get(kind) }))

import { changeScheduledJobSchedule, runScheduledJobNow, setScheduledJobEnabled } from "./actions"

const NOW = new Date("2026-10-22T15:00:00Z")

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    key: "housekeeping.job-runs",
    kind: "housekeeping.job-runs",
    schedule: "10 4 * * *",
    enabled: false,
    nextRunAt: new Date("2026-01-01T10:10:00Z"),
    lockedUntil: null,
    ...overrides,
  }
}

const register = (kind: string, extra: Partial<JobKind> = {}) =>
  kinds.set(kind, { kind, label: "Prune job history", description: "", defaultSchedule: "10 4 * * *", budgetMs: 1000, run: async () => ({ summary: "" }), ...extra })

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
  kinds.clear()
  register("housekeeping.job-runs")
  guards.requireRole.mockResolvedValue({ id: "admin-1" })
  db.scheduledJob.findUnique.mockResolvedValue(job())
  db.scheduledJob.update.mockResolvedValue({})
  return () => vi.useRealTimers()
})

describe("scheduled job actions", () => {
  it("are for admins only: officers get an answer, not a change", async () => {
    const notAdmin = Object.assign(new Error("Requires one of the following roles: admin"), { name: "NotAuthorizedError" })
    guards.requireRole.mockRejectedValue(notAdmin)
    for (const result of [await setScheduledJobEnabled("job-1", true), await runScheduledJobNow("job-1"), await changeScheduledJobSchedule("job-1", "0 5 * * *")]) {
      expect(result).toEqual({ ok: false, error: "Only admins can change scheduled jobs." })
    }
    expect(guards.requireRole).toHaveBeenCalledWith("admin")
    expect(db.scheduledJob.update).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("don't mistake a failed session lookup for 'not an admin'", async () => {
    guards.requireRole.mockRejectedValue(new Error("Can't reach database server"))
    await expect(setScheduledJobEnabled("job-1", true)).rejects.toThrow("Can't reach database server")
    expect(db.scheduledJob.update).not.toHaveBeenCalled()
  })

  describe("setScheduledJobEnabled", () => {
    it("turns a job on with its next run from now (not the stale one), and audits it", async () => {
      const result = await setScheduledJobEnabled("job-1", true)
      expect(result).toEqual({ ok: true, data: { enabled: true, nextRun: "in 18 hours" } })
      expect(db.scheduledJob.update).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { enabled: true, nextRunAt: new Date("2026-10-23T09:10:00Z"), updatedById: "admin-1" } })
      expect(audit.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: "admin-1", actionType: "SCHEDULED_JOB_ENABLED", entityType: "SCHEDULED_JOB", entityId: "job-1", summary: "Turned on the scheduled job Prune job history" })
      )
    })

    it("turns a job off, even one this code doesn't know", async () => {
      db.scheduledJob.findUnique.mockResolvedValue(job({ kind: "removed.kind", key: "removed.kind", enabled: true }))
      expect(await setScheduledJobEnabled("job-1", false)).toMatchObject({ ok: true, data: { enabled: false } })
      expect(db.scheduledJob.update.mock.calls[0][0].data).toMatchObject({ enabled: false })
      expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "SCHEDULED_JOB_DISABLED" }))
    })

    it("won't turn on a kind this code doesn't know, or a job whose schedule can't be read", async () => {
      db.scheduledJob.findUnique.mockResolvedValue(job({ kind: "removed.kind" }))
      expect(await setScheduledJobEnabled("job-1", true)).toMatchObject({ ok: false, error: expect.stringContaining("doesn't know this job") })
      db.scheduledJob.findUnique.mockResolvedValue(job({ schedule: "whenever" }))
      expect(await setScheduledJobEnabled("job-1", true)).toMatchObject({ ok: false, error: expect.stringContaining("can't be read") })
      expect(db.scheduledJob.update).not.toHaveBeenCalled()
    })

    it("writes nothing when the switch is already where it's asked to be, or the job is gone", async () => {
      db.scheduledJob.findUnique.mockResolvedValue(job({ enabled: true }))
      expect(await setScheduledJobEnabled("job-1", true)).toMatchObject({ ok: true })
      db.scheduledJob.findUnique.mockResolvedValue(null)
      expect(await setScheduledJobEnabled("job-1", true)).toMatchObject({ ok: false, error: expect.stringContaining("doesn't exist") })
      expect(await setScheduledJobEnabled("", true)).toMatchObject({ ok: false })
      expect(db.scheduledJob.update).not.toHaveBeenCalled()
      expect(audit.createAuditLog).not.toHaveBeenCalled()
    })
  })

  describe("runScheduledJobNow", () => {
    it("moves an enabled job's next run to now and says whether it's running already", async () => {
      db.scheduledJob.findUnique.mockResolvedValue(job({ enabled: true }))
      expect(await runScheduledJobNow("job-1")).toEqual({ ok: true, data: { running: false } })
      expect(db.scheduledJob.update).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { nextRunAt: NOW, updatedById: "admin-1" } })
      expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "SCHEDULED_JOB_RUN_NOW", entityId: "job-1" }))

      db.scheduledJob.findUnique.mockResolvedValue(job({ enabled: true, lockedUntil: new Date(NOW.getTime() + 60_000) }))
      expect(await runScheduledJobNow("job-1")).toEqual({ ok: true, data: { running: true } })
    })

    it("asks for the job to be turned on first", async () => {
      expect(await runScheduledJobNow("job-1")).toMatchObject({ ok: false, error: expect.stringContaining("Turn the job on first") })
      expect(db.scheduledJob.update).not.toHaveBeenCalled()
    })
  })

  describe("changeScheduledJobSchedule", () => {
    it("saves a valid schedule, tidied, with its next run from now, and audits before and after", async () => {
      const result = await changeScheduledJobSchedule("job-1", "  0   5 * * * ")
      expect(result).toEqual({ ok: true, data: { schedule: "0 5 * * *", description: "Daily at 5:00 AM CT" } })
      expect(db.scheduledJob.update).toHaveBeenCalledWith({ where: { id: "job-1" }, data: { schedule: "0 5 * * *", nextRunAt: new Date("2026-10-23T10:00:00Z"), updatedById: "admin-1" } })
      expect(audit.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: "SCHEDULED_JOB_SCHEDULE_CHANGED", before: expect.objectContaining({ schedule: "10 4 * * *" }), after: expect.objectContaining({ schedule: "0 5 * * *" }) })
      )
    })

    it("explains what's wrong with a schedule it can't use", async () => {
      expect(await changeScheduledJobSchedule("job-1", "every day")).toMatchObject({ ok: false, error: expect.stringContaining("five fields") })
      expect(await changeScheduledJobSchedule("job-1", "*/10 * * * * *")).toMatchObject({ ok: false, error: expect.stringContaining("five fields") })
      expect(await changeScheduledJobSchedule("job-1", "0 25 * * *")).toMatchObject({ ok: false, error: expect.stringContaining("can run") })
      expect(db.scheduledJob.update).not.toHaveBeenCalled()
    })

    it("leaves per-feature jobs (recurring questions) to their own page", async () => {
      register("recurring.question", { singleton: false })
      db.scheduledJob.findUnique.mockResolvedValue(job({ kind: "recurring.question", key: "recurring:q1" }))
      expect(await changeScheduledJobSchedule("job-1", "0 5 * * *")).toMatchObject({ ok: false, error: expect.stringContaining("page that created it") })
      expect(db.scheduledJob.update).not.toHaveBeenCalled()
    })
  })
})
