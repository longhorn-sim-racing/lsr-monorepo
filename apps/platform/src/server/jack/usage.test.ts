import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  jackMessage: { findMany: vi.fn() },
  jackUsage: { groupBy: vi.fn() },
  jackFeedback: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  jackRoom: { findMany: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import {
  attributeSpend,
  commonWords,
  feedbackForMonth,
  firstQuestions,
  getUsageOverview,
  monthFromKey,
  monthKeyOf,
  monthlyCosts,
  monthsBack,
  spendBySource,
  summarizeMonths,
  usageMonth,
  type ReplyCostRow,
} from "./usage"

const NOW = new Date("2026-10-22T17:00:00Z")

beforeEach(() => {
  db.$queryRaw.mockResolvedValue([])
  db.jackMessage.findMany.mockResolvedValue([])
  db.jackUsage.groupBy.mockResolvedValue([])
  db.jackFeedback.groupBy.mockResolvedValue([])
  db.jackFeedback.count.mockResolvedValue(0)
  db.jackFeedback.findMany.mockResolvedValue([])
  db.jackRoom.findMany.mockResolvedValue([])
})

describe("months", () => {
  it("goes by the Central Time month", () => {
    expect(monthKeyOf(new Date("2026-10-01T05:30:00Z"))).toBe("2026-10") // 12:30 AM Oct 1, CDT
    expect(monthKeyOf(new Date("2026-10-01T04:30:00Z"))).toBe("2026-09") // 11:30 PM Sep 30
  })

  it("builds a month from its key, across a daylight-saving change, and refuses anything else", () => {
    expect(monthFromKey("2026-11")).toEqual({ key: "2026-11", label: "November 2026", start: new Date("2026-11-01T05:00:00Z"), end: new Date("2026-12-01T06:00:00Z") })
    expect(monthFromKey("2026-12")!.end).toEqual(new Date("2027-01-01T06:00:00Z"))
    for (const key of ["2026-13", "2026-1", "26-10", "2026-10-01", ""]) expect(monthFromKey(key), key).toBeNull()
  })

  it("shows this month unless ?month= names a real month that has started", () => {
    expect(usageMonth(undefined, NOW).key).toBe("2026-10")
    expect(usageMonth("2026-08", NOW).key).toBe("2026-08")
    expect(usageMonth(["2025-12", "2026-01"], NOW).key).toBe("2025-12")
    expect(usageMonth("2026-11", NOW).key).toBe("2026-10")
    expect(usageMonth("nonsense", NOW).key).toBe("2026-10")
  })

  it("counts months back across a new year, newest first", () => {
    expect(monthsBack(monthFromKey("2026-02")!, 4).map((m) => m.key)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"])
  })
})

describe("cost by month", () => {
  const months = monthsBack(monthFromKey("2026-10")!, 3)

  it("adds replies and side jobs up per month and persona, with zeros for quiet months", () => {
    const replies = [
      { month: "2026-10", persona: "jack", calls: 10, cost: 1.25 },
      { month: "2026-10", persona: "lift", calls: 2, cost: 0.75 },
      { month: "2026-09", persona: "jack", calls: 1, cost: 0.1 },
    ]
    const sideJobs = [
      { month: "2026-10", persona: "stand", calls: 3, cost: 0.003 },
      { month: "2026-10", persona: "mystery", calls: 1, cost: 9 },
      { month: "2025-01", persona: "jack", calls: 1, cost: 9 },
    ]
    const result = summarizeMonths(months, [...replies, ...sideJobs], replies)
    expect(result.map((m) => [m.month.key, m.byPersona, m.totalUsd, m.replies])).toEqual([
      ["2026-10", { jack: 1.25, lift: 0.75, stand: 0.003 }, 2.003, 12],
      ["2026-09", { jack: 0.1, lift: 0, stand: 0 }, 0.1, 1],
      ["2026-08", { jack: 0, lift: 0, stand: 0 }, 0, 0],
    ])
  })

  it("asks the database for both tables, bucketed by Central Time month, between the months' UTC bounds", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ month: "2026-10", persona: "jack", calls: 4, cost: 0.4 }]).mockResolvedValueOnce([{ month: "2026-10", persona: "stand", calls: 1, cost: 0.01 }])
    const result = await monthlyCosts(months)
    const [replies, sideJobs] = db.$queryRaw.mock.calls.map((call) => call[0] as Prisma.Sql)
    expect(replies.sql).toContain(`FROM "JackMessage"`)
    expect(replies.sql).toContain(`kind = 'assistant' AND "costUsd" IS NOT NULL`)
    expect(sideJobs.sql).toContain(`FROM "JackUsage"`)
    for (const sql of [replies, sideJobs]) {
      expect(sql.sql).toContain(`AT TIME ZONE 'UTC') AT TIME ZONE`)
      expect(sql.values).toEqual(expect.arrayContaining(["America/Chicago", "2026-08-01T05:00:00.000Z", "2026-11-01T05:00:00.000Z"]))
    }
    expect(result[0]).toMatchObject({ totalUsd: 0.41, replies: 4 })
  })
})

describe("by officer and automation", () => {
  const reply = (cost: number, start?: ReplyCostRow["answers"][number]): ReplyCostRow => ({ costUsd: cost, answers: start ? [start] : [] })

  it("puts each reply on the officer who started it, recurring questions and side jobs apart, highest cost first", () => {
    const spenders = attributeSpend(
      [
        reply(0.5, { authorUserId: "gray", scheduled: false, author: { displayName: "Gray" } }),
        reply(0.25, { authorUserId: "gray", scheduled: false, author: { displayName: "Gray" } }),
        reply(0.3, { authorUserId: "dylan", scheduled: false, author: { displayName: "Dylan" } }),
        reply(0.2, { authorUserId: "gray", scheduled: true, author: { displayName: "Gray" } }),
        reply(0.05, { authorUserId: null, scheduled: false, author: null }),
        reply(0.01),
      ],
      [
        { job: "name_room", persona: "stand", calls: 4, costUsd: 0.004 },
        { job: "digest_summary", persona: "stand", calls: 1, costUsd: 0.02 },
      ]
    )
    expect(spenders.map((s) => [s.label, s.kind, s.calls, s.costUsd])).toEqual([
      ["Gray", "officer", 2, 0.75],
      ["Dylan", "officer", 1, 0.3],
      ["Recurring questions", "automation", 1, 0.2],
      ["Former officers", "officer", 1, 0.05],
      ["Automation: digest_summary", "automation", 1, 0.02],
      ["Replies to no message (older or deleted)", "unlinked", 1, 0.01],
      ["Naming rooms (Stand)", "side_job", 4, 0.004],
    ])
  })

  it("asks for the message that started each reply: a scheduled note first, else the newest it answered", async () => {
    db.jackUsage.groupBy.mockResolvedValue([{ job: "name_room", persona: "stand", _sum: { costUsd: 0.002 }, _count: { _all: 2 } }])
    const month = monthFromKey("2026-10")!
    const spenders = await spendBySource(month)
    const args = db.jackMessage.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ createdAt: { gte: month.start, lt: month.end }, kind: "assistant", costUsd: { not: null } })
    expect(args.select.answers).toMatchObject({
      where: { OR: [{ kind: "user", expectsAnswer: true }, { kind: "system", continues: true }, { kind: "system", scheduled: true }] },
      orderBy: [{ scheduled: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: 1,
    })
    expect(spenders).toEqual([{ key: "side:name_room", label: "Naming rooms (Stand)", kind: "side_job", calls: 2, costUsd: 0.002 }])
  })
})

describe("feedback", () => {
  it("counts the month's ratings and lists its thumbs-down with the question and the answer, cut short", async () => {
    db.jackFeedback.groupBy.mockResolvedValue([
      { rating: "up", _count: { _all: 7 } },
      { rating: "down", _count: { _all: 2 } },
      { rating: "meh", _count: { _all: 1 } },
    ])
    db.jackFeedback.count.mockResolvedValue(1)
    const at = new Date("2026-10-20T15:00:00Z")
    db.jackFeedback.findMany.mockResolvedValue([
      { id: "f1", note: "  Wrong date  ", createdAt: at, user: { displayName: "Dylan" }, message: { id: "r1", roomId: "room-1", content: "GM 2 is on   **Thursday**.", room: { title: "GM 2" }, answers: [{ content: "When is GM 2?" }] } },
      { id: "f2", note: " ", createdAt: at, user: { displayName: "Gray" }, message: { id: "r2", roomId: "room-2", content: "x".repeat(400), room: { title: null }, answers: [] } },
    ])
    const month = monthFromKey("2026-10")!
    const { counts, down } = await feedbackForMonth(month)

    expect(counts).toEqual({ up: 7, down: 2, notes: 1 })
    expect(db.jackFeedback.count).toHaveBeenCalledWith({ where: { createdAt: { gte: month.start, lt: month.end }, rating: "down", note: { not: null } } })
    expect(down[0]).toEqual({ id: "f1", at, by: "Dylan", note: "Wrong date", messageId: "r1", roomId: "room-1", roomTitle: "GM 2", question: "When is GM 2?", reply: "GM 2 is on Thursday." })
    expect(down[1]).toMatchObject({ note: null, question: null, roomTitle: null })
    expect(down[1].reply).toHaveLength(280)
    expect(down[1].reply.endsWith("…")).toBe(true)
  })
})

describe("common questions", () => {
  const room = (id: string, question: string, title: string | null = id) => ({ id, title, question })

  it("counts the words in each room's first message once per room, leaving out everyday words, most rooms first", () => {
    const words = commonWords([
      room("r1", "How many members registered for GM 2? Members only please"),
      room("r2", "Which members paid their LSC entry fee?"),
      room("r3", "What's the LSC schedule?"),
      room("r4", "@Jack can you show me the members' list"),
      room("r5", "Make 3 slides for GM 2"),
    ])
    expect(words.map((w) => [w.word, w.rooms])).toEqual([
      ["members", 3],
      ["gm", 2],
      ["lsc", 2],
    ])
    expect(words[0].examples.map((e) => e.roomId)).toEqual(["r1", "r2", "r4"])
  })

  it("keeps it to words in enough rooms, and as many as asked", () => {
    const rooms = [room("r1", "budget sponsors decks"), room("r2", "budget sponsors"), room("r3", "budget")]
    expect(commonWords(rooms, { minRooms: 3 }).map((w) => w.word)).toEqual(["budget"])
    expect(commonWords(rooms, { limit: 1 }).map((w) => w.word)).toEqual(["budget"])
    expect(commonWords(rooms, { examples: 1 })[0].examples).toHaveLength(1)
    expect(commonWords([])).toEqual([])
  })

  it("loads each room's first officer message, skipping the eval's rooms and rooms with none", async () => {
    db.jackRoom.findMany.mockResolvedValue([
      { id: "r1", title: "GM 2", messages: [{ content: "When is GM 2?" }] },
      { id: "r2", title: null, messages: [] },
      { id: "r3", title: null, messages: [{ content: "   " }] },
    ])
    const month = monthFromKey("2026-10")!
    expect(await firstQuestions(month)).toEqual([{ id: "r1", title: "GM 2", question: "When is GM 2?" }])
    const args = db.jackRoom.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ createdAt: { gte: month.start, lt: month.end }, NOT: { id: { startsWith: "jack-eval-" } } })
    expect(args.select.messages).toMatchObject({ where: { kind: "user" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1 })
  })
})

describe("getUsageOverview", () => {
  it("shows the chosen month within the last twelve, against the cap", async () => {
    vi.stubEnv("JACK_MONTHLY_BUDGET_USD", "40")
    db.$queryRaw.mockResolvedValueOnce([{ month: "2026-09", persona: "jack", calls: 3, cost: 1.5 }]).mockResolvedValueOnce([])
    const usage = await getUsageOverview("2026-09", NOW)
    expect(usage).toMatchObject({ month: { key: "2026-09" }, current: false, budgetUsd: 40, selected: { totalUsd: 1.5, replies: 3 }, rooms: 0, words: [] })
    expect(usage.months.map((m) => m.month.key)).toHaveLength(12)
    expect(usage.months[0].month.key).toBe("2026-10")
    expect(db.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it("adds up a month older than the table's twelve on its own", async () => {
    db.$queryRaw.mockResolvedValue([])
    const usage = await getUsageOverview("2025-01", NOW)
    expect(usage.month.key).toBe("2025-01")
    expect(usage.selected.month.key).toBe("2025-01")
    expect(db.$queryRaw).toHaveBeenCalledTimes(4)
  })
})
