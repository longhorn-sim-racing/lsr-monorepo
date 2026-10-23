import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ recurringQuestion: { count: vi.fn(), findMany: vi.fn() } }))
const cap = vi.hoisted(() => ({ automationSpendUsd: vi.fn(), automationBudgetUsd: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("../cap", () => cap)

import { automationCap, CHECKS, pausedQuestions } from "./automation"

const NOW = new Date("2026-10-26T17:00:00Z")

beforeEach(() => {
  cap.automationBudgetUsd.mockReturnValue(10)
  cap.automationSpendUsd.mockResolvedValue(2)
  db.recurringQuestion.count.mockResolvedValue(0)
  db.recurringQuestion.findMany.mockResolvedValue([])
})

it("registers both checks with console links", () => {
  expect(CHECKS.map((c) => [c.id, c.href])).toEqual([
    ["automation.cap", "/admin/jack/usage"],
    ["recurring.paused", "/admin/jack/recurring"],
  ])
})

describe("the automation cap check", () => {
  it("is quiet under 80%, warns from there, and is urgent at the cap", async () => {
    expect(await automationCap.run({ now: NOW })).toEqual({ count: 0, severity: "info", items: [] })
    expect(cap.automationSpendUsd).toHaveBeenCalledWith(NOW)
    cap.automationSpendUsd.mockResolvedValue(8.5)
    expect(await automationCap.run({ now: NOW })).toEqual({
      count: 1,
      severity: "warning",
      items: [{ title: "Automations: $8.50 of $10 this month", href: "/admin/jack/recurring", detail: "85% of the cap" }],
    })
    cap.automationSpendUsd.mockResolvedValue(10.01)
    expect(await automationCap.run({ now: NOW })).toMatchObject({ severity: "danger", items: [{ detail: "Recurring questions and digest summaries are skipped until the 1st" }] })
  })
})

describe("paused recurring questions", () => {
  it("lists the ones a run paused itself, with why", async () => {
    db.recurringQuestion.count.mockResolvedValue(1)
    db.recurringQuestion.findMany.mockResolvedValue([{ id: "q-1", title: "Weekly signups", pausedReason: "its room is archived" }])
    const result = await pausedQuestions.run({ now: NOW })
    expect(db.recurringQuestion.count).toHaveBeenCalledWith({ where: { pausedReason: { not: null }, scheduledJob: { enabled: false } } })
    expect(result).toEqual({ count: 1, severity: "warning", items: [{ title: "Weekly signups", href: "/admin/jack/recurring?q=q-1", detail: "Paused: its room is archived" }] })
  })
})
