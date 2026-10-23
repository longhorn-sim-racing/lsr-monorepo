import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ scheduledJob: { count: vi.fn(), findMany: vi.fn() }, schedulerHeartbeat: { findUnique: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("./registry", () => ({ findJobKind: (kind: string) => (kind === "discord.sync" ? { label: "Discord sync" } : undefined) }))

import { jobsFailing, schedulerStalled } from "./checks"

const now = new Date("2026-10-22T18:00:00Z")

beforeEach(() => {
  db.scheduledJob.count.mockResolvedValue(2)
  db.schedulerHeartbeat.findUnique.mockResolvedValue({ id: "tick", lastTickAt: new Date(now.getTime() - 60_000) })
})

describe("scheduler checks", () => {
  it("say nothing while the scheduler ticks, or while no job is on", async () => {
    expect(await schedulerStalled.run({ now })).toEqual({ count: 0, severity: "info", items: [] })
    db.scheduledJob.count.mockResolvedValue(0)
    db.schedulerHeartbeat.findUnique.mockResolvedValue(null)
    expect(await schedulerStalled.run({ now })).toMatchObject({ count: 0 })
  })

  it("flag jobs that are on when the scheduler stopped ticking, or never did", async () => {
    db.schedulerHeartbeat.findUnique.mockResolvedValue({ id: "tick", lastTickAt: new Date("2026-10-22T15:00:00Z") })
    expect(await schedulerStalled.run({ now })).toEqual({
      count: 1,
      severity: "danger",
      items: [{ title: "2 scheduled jobs are on, but the scheduler isn't ticking", href: "/admin/jobs", detail: "Last tick Oct 22, 10:00 AM CT" }],
    })
    db.schedulerHeartbeat.findUnique.mockResolvedValue(null)
    expect((await schedulerStalled.run({ now })).items[0].detail).toBe("It has never ticked")
  })

  it("list failing jobs by name with a link to each, never their error text", async () => {
    db.scheduledJob.findMany.mockResolvedValue([
      { id: "j1", key: "discord.sync", kind: "discord.sync", lastRunAt: new Date("2026-10-22T09:10:00Z") },
      { id: "j2", key: "recurring:q1", kind: "gone.kind", lastRunAt: null },
    ])
    const result = await jobsFailing.run({ now })
    expect(result).toEqual({
      count: 2,
      severity: "warning",
      items: [
        { title: "Discord sync failed", href: "/admin/jobs?job=j1", detail: "Last run Oct 22, 4:10 AM CT" },
        { title: "recurring:q1 failed", href: "/admin/jobs?job=j2", detail: undefined },
      ],
    })
    expect(db.scheduledJob.findMany.mock.calls[0][0].select).not.toHaveProperty("lastError")
  })
})
