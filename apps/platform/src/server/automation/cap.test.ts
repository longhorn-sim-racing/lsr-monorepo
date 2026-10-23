import { beforeEach, describe, expect, it, vi } from "vitest"

const tables = () => ({
  jackMessage: { aggregate: vi.fn(), findMany: vi.fn() },
  jackUsage: { aggregate: vi.fn() },
  recurringQuestion: { findMany: vi.fn() },
})
const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  jackMessage: { aggregate: vi.fn(), findMany: vi.fn() },
  jackUsage: { aggregate: vi.fn() },
  recurringQuestion: { findMany: vi.fn() },
}))
const spend = vi.hoisted(() => ({ getMonthSpend: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/jack/spend", async (original) => ({ ...(await original<typeof import("@/server/jack/spend")>()), getMonthSpend: spend.getMonthSpend }))

import { automationBudget, automationBudgetUsd, automationInFlightUsd, automationSpendUsd, CAP_LOCK, underWay, withAutomationCap, type AutomationBudget } from "./cap"
import { typicalRunUsd } from "./recurring/estimate"

const NOW = new Date("2026-10-22T17:00:00Z")
const OCTOBER = { gte: new Date("2026-10-01T05:00:00Z"), lt: new Date("2026-11-01T05:00:00Z") }
const JACK_RUN = typicalRunUsd("jack")
const STAND_RUN = typicalRunUsd("stand")

/** Spent so far, and nothing under way */
function spent(table: ReturnType<typeof tables> | typeof db, usd: string | null) {
  table.jackMessage.aggregate.mockResolvedValue({ _sum: { costUsd: usd } })
  table.jackUsage.aggregate.mockResolvedValue({ _sum: { costUsd: null } })
  table.jackMessage.findMany.mockResolvedValue([])
  table.recurringQuestion.findMany.mockResolvedValue([])
}

beforeEach(() => {
  db.jackMessage.aggregate.mockResolvedValue({ _sum: { costUsd: "6.250000" } })
  db.jackUsage.aggregate.mockResolvedValue({ _sum: { costUsd: "0.500000" } })
  db.jackMessage.findMany.mockResolvedValue([])
  db.recurringQuestion.findMany.mockResolvedValue([])
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
    expect(await automationBudget(NOW)).toEqual({ month: "October", spentUsd: 6.75, reservedUsd: 0, capUsd: 10, totalUsd: 20, budgetUsd: 50, stopped: null })
    db.jackMessage.aggregate.mockResolvedValue({ _sum: { costUsd: "9.600000" } })
    expect((await automationBudget(NOW)).stopped).toBe("automation_cap")
    db.jackMessage.aggregate.mockResolvedValue({ _sum: { costUsd: null } })
    db.jackUsage.aggregate.mockResolvedValue({ _sum: { costUsd: null } })
    spend.getMonthSpend.mockResolvedValue({ month: "October", totalUsd: 50.01, budgetUsd: 50, byPersona: { jack: 50.01, lift: 0, stand: 0 } })
    expect(await automationBudget(NOW)).toMatchObject({ spentUsd: 0, stopped: "monthly_budget" })
  })
})

describe("runs under way", () => {
  it("counts each scheduled note still waiting at a typical run of its persona, and each answer still being written less what it cost so far", async () => {
    db.jackMessage.findMany.mockImplementation(async ({ where }) =>
      where.kind === "system"
        ? [{ jobKey: "recurring:q-jack" }, { jobKey: "recurring:q-stand" }, { jobKey: "digest.weekly" }, { jobKey: "recurring:q-deleted" }]
        : [{ persona: "jack", costUsd: "0.020000" }, { persona: "stand", costUsd: "1.000000" }],
    )
    db.recurringQuestion.findMany.mockResolvedValue([
      { id: "q-jack", persona: "jack" },
      { id: "q-stand", persona: "stand" },
    ])
    // Jack for the Jack question, the digest and the deleted question; Stand for one; the streaming Jack answer less its $0.02; the Stand answer already over its estimate adds nothing
    const expected = 3 * JACK_RUN + STAND_RUN + (JACK_RUN - 0.02)
    expect(await automationInFlightUsd(NOW)).toBeCloseTo(expected, 5)
    const [waiting, answering] = db.jackMessage.findMany.mock.calls.map(([args]) => args.where)
    expect(waiting).toEqual({ kind: "system", scheduled: true, answeredById: null, createdAt: { gte: new Date(NOW.getTime() - 45 * 60_000) } })
    expect(answering).toEqual({ kind: "assistant", status: "streaming", createdAt: { gte: OCTOBER.gte }, answers: { some: { kind: "system", scheduled: true } } })
    expect(db.recurringQuestion.findMany).toHaveBeenCalledWith({ where: { id: { in: ["q-jack", "q-stand", "q-deleted"] } }, select: { id: true, persona: true } })
  })

  it("stops automations once what's spent plus what's under way reaches the cap, and says so", async () => {
    db.jackMessage.aggregate.mockResolvedValue({ _sum: { costUsd: String(10 - JACK_RUN / 2) } })
    db.jackUsage.aggregate.mockResolvedValue({ _sum: { costUsd: null } })
    expect((await automationBudget(NOW)).stopped).toBeNull()
    db.jackMessage.findMany.mockImplementation(async ({ where }) => (where.kind === "system" ? [{ jobKey: "digest.weekly" }] : []))
    const budget = await automationBudget(NOW)
    expect(budget).toMatchObject({ reservedUsd: JACK_RUN, stopped: "automation_cap" })
    expect(underWay(budget)).toBe(" (counting the runs under way)")
    expect(underWay({ ...budget, spentUsd: 10.1 })).toBe("")
  })
})

describe("checking the cap and starting a run in one step", () => {
  /**
   * Transactions as Postgres runs them under the lock: each on its own connection (its own tables, set up
   * by `prepare` when it gets the lock), one after another
   */
  function serialTransactions(prepare: (tx: ReturnType<typeof tables>) => void) {
    let queue: Promise<unknown> = Promise.resolve()
    const locks: string[] = []
    const opened: ReturnType<typeof tables>[] = []
    db.$transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>, options: unknown) => {
      const tx = { ...tables(), $executeRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => locks.push(`${sql.join("?")} ${JSON.stringify(values)} ${JSON.stringify(options)}`)) }
      opened.push(tx)
      const run = queue.then(() => {
        prepare(tx)
        return work(tx)
      })
      queue = run.catch(() => undefined)
      return run
    })
    return { locks, opened }
  }

  it("takes the cap's lock in a transaction, reads where automations stand in it, and gives `start` that transaction", async () => {
    const { locks, opened } = serialTransactions((tx) => spent(tx, "1.000000"))
    db.jackMessage.aggregate.mockRejectedValue(new Error("read outside the transaction"))
    const seen: { budget: AutomationBudget; db: unknown }[] = []
    const result = await withAutomationCap(NOW, async (budget, tx) => {
      seen.push({ budget, db: tx })
      return "asked"
    })
    expect(result).toBe("asked")
    expect(locks).toEqual([`SELECT pg_advisory_xact_lock(hashtext(?)) ${JSON.stringify([CAP_LOCK])} {"maxWait":10000,"timeout":30000}`])
    expect(seen[0].db).toBe(opened[0])
    expect(seen[0].budget).toMatchObject({ month: "October", spentUsd: 1, reservedUsd: 0, capUsd: 10, totalUsd: 20, stopped: null })
    // Jack's whole month is read once, before the lock
    expect(spend.getMonthSpend).toHaveBeenCalledTimes(1)
  })

  it("lets only as many runs due together start as the cap has room for: each sees the notes the earlier ones posted", async () => {
    const posted: { jobKey: string }[] = []
    // $9.95 of $10 spent, and every note posted so far still waiting for its answer
    serialTransactions((tx) => {
      spent(tx, "9.950000")
      tx.jackMessage.findMany.mockImplementation(async ({ where }: { where: { kind: string } }) => (where.kind === "system" ? posted.map((note) => ({ ...note })) : []))
    })
    const run = (jobKey: string) =>
      withAutomationCap(NOW, async (budget) => {
        if (budget.stopped) return "skipped"
        posted.push({ jobKey })
        return "asked"
      })
    expect(await Promise.all(["recurring:a", "recurring:b", "recurring:c", "recurring:d"].map(run))).toEqual(["asked", "skipped", "skipped", "skipped"])
    expect(posted).toEqual([{ jobKey: "recurring:a" }])
  })
})
