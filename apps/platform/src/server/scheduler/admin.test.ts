import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JobKind } from "./types"

const db = vi.hoisted(() => ({ scheduledJob: { findMany: vi.fn(), createMany: vi.fn() } }))
const registry = vi.hoisted(() => ({ JOB_KINDS: [] as JobKind[] }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("./registry", () => registry)

import { ensureJobRows } from "./admin"

const kind = (name: string, extra: Partial<JobKind> = {}): JobKind => ({
  kind: name,
  label: name,
  description: "",
  defaultSchedule: "0 6 * * *",
  budgetMs: 1000,
  run: async () => ({ summary: "" }),
  ...extra,
})

const NOW = new Date("2026-10-22T15:00:00Z")

beforeEach(() => {
  registry.JOB_KINDS = [kind("discord.sync", { defaultSchedule: "*/10 * * * *" }), kind("stripe.sync"), kind("recurring.question", { singleton: false })]
  db.scheduledJob.createMany.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
})

describe("ensureJobRows", () => {
  it("creates a switched-off row, keyed by the kind, for each singleton kind that has none", async () => {
    db.scheduledJob.findMany.mockResolvedValue([{ key: "stripe.sync" }])

    expect(await ensureJobRows(NOW)).toEqual(["discord.sync"])

    expect(db.scheduledJob.findMany).toHaveBeenCalledWith({ where: { key: { in: ["discord.sync", "stripe.sync"] } }, select: { key: true } })
    expect(db.scheduledJob.createMany).toHaveBeenCalledWith({
      data: [{ key: "discord.sync", kind: "discord.sync", schedule: "*/10 * * * *", enabled: false, nextRunAt: new Date("2026-10-22T15:10:00Z") }],
      skipDuplicates: true,
    })
  })

  it("leaves kinds whose feature makes their rows (recurring questions) alone, and writes nothing when every row exists", async () => {
    db.scheduledJob.findMany.mockResolvedValue([{ key: "discord.sync" }, { key: "stripe.sync" }])
    expect(await ensureJobRows(NOW)).toEqual([])
    expect(db.scheduledJob.createMany).not.toHaveBeenCalled()
  })

  it("does nothing without registered kinds", async () => {
    registry.JOB_KINDS = []
    expect(await ensureJobRows(NOW)).toEqual([])
    expect(db.scheduledJob.findMany).not.toHaveBeenCalled()
  })
})
