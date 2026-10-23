import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackMessage: { aggregate: vi.fn() }, jackUsage: { aggregate: vi.fn() } }))
const spend = vi.hoisted(() => ({ getMonthSpend: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/jack/spend", async (original) => ({ ...(await original<typeof import("@/server/jack/spend")>()), getMonthSpend: spend.getMonthSpend }))

import { automationBudget, automationBudgetUsd, automationSpendUsd } from "./cap"

const NOW = new Date("2026-10-22T17:00:00Z")
const OCTOBER = { gte: new Date("2026-10-01T05:00:00Z"), lt: new Date("2026-11-01T05:00:00Z") }

beforeEach(() => {
  db.jackMessage.aggregate.mockResolvedValue({ _sum: { costUsd: "6.250000" } })
  db.jackUsage.aggregate.mockResolvedValue({ _sum: { costUsd: "0.500000" } })
  spend.getMonthSpend.mockResolvedValue({ month: "October", totalUsd: 20, budgetUsd: 50, byPersona: { jack: 20, lift: 0, stand: 0 } })
})

describe("the automation cap", () => {
  it("reads JACK_AUTOMATION_BUDGET_USD, defaulting to $10", () => {
    expect(automationBudgetUsd({})).toBe(10)
    expect(automationBudgetUsd({ JACK_AUTOMATION_BUDGET_USD: " 4.5 " })).toBe(4.5)
    expect(automationBudgetUsd({ JACK_AUTOMATION_BUDGET_USD: "0" })).toBe(0)
    expect(automationBudgetUsd({ JACK_AUTOMATION_BUDGET_USD: "-1" })).toBe(10)
    expect(automationBudgetUsd({ JACK_AUTOMATION_BUDGET_USD: "lots" })).toBe(10)
  })

  it("adds up replies to scheduled notes and side jobs other than naming rooms, in the Central Time month", async () => {
    expect(await automationSpendUsd(NOW)).toBe(6.75)
    expect(db.jackMessage.aggregate).toHaveBeenCalledWith({
      where: { kind: "assistant", costUsd: { not: null }, createdAt: OCTOBER, answers: { some: { kind: "system", scheduled: true } } },
      _sum: { costUsd: true },
    })
    expect(db.jackUsage.aggregate).toHaveBeenCalledWith({ where: { createdAt: OCTOBER, job: { not: "name_room" } }, _sum: { costUsd: true } })
  })

  it("says automations stop at their cap, or when Jack's whole budget is gone", async () => {
    expect(await automationBudget(NOW)).toEqual({ month: "October", spentUsd: 6.75, capUsd: 10, totalUsd: 20, budgetUsd: 50, stopped: null })
    db.jackMessage.aggregate.mockResolvedValue({ _sum: { costUsd: "9.600000" } })
    expect((await automationBudget(NOW)).stopped).toBe("automation_cap")
    db.jackMessage.aggregate.mockResolvedValue({ _sum: { costUsd: null } })
    db.jackUsage.aggregate.mockResolvedValue({ _sum: { costUsd: null } })
    spend.getMonthSpend.mockResolvedValue({ month: "October", totalUsd: 50.01, budgetUsd: 50, byPersona: { jack: 50.01, lift: 0, stand: 0 } })
    expect(await automationBudget(NOW)).toMatchObject({ spentUsd: 0, stopped: "monthly_budget" })
  })
})
