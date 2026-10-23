import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  discordChannel: { findMany: vi.fn(), count: vi.fn() },
  discordDailyStat: { findMany: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
  discordGuildDaily: { findMany: vi.fn() },
  discordMessage: { findMany: vi.fn() },
  user: { count: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { discordActivity, discordChannels, discordPolls, discordWeek, lastDays } from "./discord"

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
// 1 PM Central on Thursday Oct 22
const NOW = new Date("2026-10-22T18:00:00.000Z")

beforeEach(() => {
  db.$queryRaw.mockResolvedValue([])
  db.discordChannel.findMany.mockResolvedValue([])
  db.discordDailyStat.findMany.mockResolvedValue([])
  db.discordGuildDaily.findMany.mockResolvedValue([])
  db.user.count.mockResolvedValue(0)
})

describe("lastDays", () => {
  it("is the last n Central days, today included, as dates and as instants", () => {
    const range = lastDays(7, NOW)
    expect(range.firstDay.toISOString()).toBe("2026-10-16T00:00:00.000Z")
    expect(range.lastDay.toISOString()).toBe("2026-10-22T00:00:00.000Z")
    expect(range.from.toISOString()).toBe("2026-10-16T05:00:00.000Z")
    expect(range.to.toISOString()).toBe("2026-10-23T05:00:00.000Z")
  })
})

describe("discordChannels", () => {
  it("lists channels (not threads) by category with their last 30 days, counting threads and their latest sync", async () => {
    db.discordChannel.findMany.mockResolvedValue([
      { id: "c1", name: "general", type: 0, parentId: null, parentName: "Club", synced: true, lastSyncedAt: new Date("2026-10-22T17:00:00Z") },
      { id: "c2", name: "setups", type: 15, parentId: null, parentName: "Racing", synced: true, lastSyncedAt: null },
      { id: "t1", name: "Monza help", type: 11, parentId: "c2", parentName: "setups", synced: false, lastSyncedAt: new Date("2026-10-22T17:50:00Z") },
      { id: "c3", name: "announcements", type: 5, parentId: null, parentName: "Club", synced: false, lastSyncedAt: null },
    ])
    db.discordDailyStat.groupBy.mockResolvedValue([{ channelId: "c2", _sum: { messages: 14 } }])
    const rows = await discordChannels(NOW)
    expect(rows.map((r) => [r.category, r.name, r.threads, r.messages30])).toEqual([
      ["Club", "announcements", 0, 0],
      ["Club", "general", 0, 0],
      ["Racing", "setups", 1, 14],
    ])
    expect(rows[2].lastSyncedAt?.toISOString()).toBe("2026-10-22T17:50:00.000Z")
  })
})

describe("discordActivity", () => {
  it("adds up messages per channel and day, fills empty days, and takes active members from distinct authors", async () => {
    db.discordDailyStat.findMany.mockResolvedValue([
      { date: day("2026-10-20"), channelId: "c1", messages: 5, activeAuthors: 3 },
      { date: day("2026-10-21"), channelId: "c1", messages: 9, activeAuthors: 4 },
      { date: day("2026-10-21"), channelId: "c2", messages: 2, activeAuthors: 2 },
    ])
    db.discordChannel.findMany.mockResolvedValue([
      { id: "c1", name: "general", parentName: "Club" },
      { id: "c2", name: "lsc-chat", parentName: "Racing" },
    ])
    db.$queryRaw.mockResolvedValueOnce([{ channelId: "c1", members: 6 }, { channelId: "c2", members: 2 }]).mockResolvedValueOnce([{ members: 7 }])
    db.discordGuildDaily.findMany.mockResolvedValue([{ date: day("2026-10-22"), memberCount: 403, joinedCount: 1, leftCount: 0 }])
    db.user.count.mockResolvedValue(12)

    const activity = await discordActivity({ days: 3, now: NOW })
    expect(activity.messages).toBe(16)
    expect(activity.activeMembers).toBe(7)
    expect(activity.daily.map((d) => [d.date.toISOString().slice(0, 10), d.messages])).toEqual([
      ["2026-10-20", 5],
      ["2026-10-21", 11],
      ["2026-10-22", 0],
    ])
    expect(activity.channels).toEqual([
      { id: "c1", name: "general", category: "Club", messages: 14, activeMembers: 6, busiestDay: day("2026-10-21"), busiestDayMessages: 9 },
      { id: "c2", name: "lsc-chat", category: "Racing", messages: 2, activeMembers: 2, busiestDay: day("2026-10-21"), busiestDayMessages: 2 },
    ])
    expect(activity.members).toEqual([{ date: day("2026-10-22"), memberCount: 403, joined: 1, left: 0 }])
    expect(activity.linkedMembers).toBe(12)
    // Distinct authors count threads toward their channel, and leave deleted messages out
    const sql = (db.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql
    expect(sql).toMatch(/coalesce\(c\."parentId", m\."channelId"\)/)
    expect(sql).toMatch(/"deletedAt" IS NULL/)
    expect(sql).not.toMatch(/authorId" AS|SELECT m\."authorId"/)
  })

  it("narrows to one channel", async () => {
    await discordActivity({ days: 7, channelId: "c1", now: NOW })
    expect(db.discordDailyStat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ channelId: "c1" }) }))
    expect((db.$queryRaw.mock.calls[0][0] as Prisma.Sql).values).toContain("c1")
  })
})

describe("discordPolls", () => {
  const poll = (question: string, extra: object) => ({ question, answers: [{ id: 1, text: "Mon", votes: 3 }, { id: 2, text: "Wed", votes: 5 }], multiselect: false, expiresAt: null, finalized: false, countedAt: "2026-10-20T00:00:00.000Z", ...extra })

  beforeEach(() => {
    db.discordChannel.findMany.mockResolvedValue([{ id: "c1", name: "general", parentId: null }, { id: "t1", name: "Monza help", parentId: "c2" }, { id: "c2", name: "setups", parentId: null }])
    db.discordMessage.findMany.mockResolvedValue([
      { id: "m1", channelId: "c1", createdAt: new Date("2026-10-21T00:00:00Z"), poll: poll("GM night?", { expiresAt: "2026-10-25T00:00:00.000Z" }) },
      { id: "m2", channelId: "t1", createdAt: new Date("2026-10-10T00:00:00Z"), poll: poll("Track?", { finalized: true, expiresAt: "2026-10-12T00:00:00.000Z" }) },
      { id: "m3", channelId: "c1", createdAt: new Date("2026-10-05T00:00:00Z"), poll: poll("Shirts?", { expiresAt: "2026-10-06T00:00:00.000Z", answers: [{ id: 1, text: "Yes", votes: null }] }) },
      { id: "m4", channelId: "c1", createdAt: new Date("2026-10-04T00:00:00Z"), poll: { not: "a poll" } },
    ])
  })

  it("says whether each poll is open, final or still closing, with totals only when every count is known", async () => {
    const { polls, matched } = await discordPolls({ days: 90, limit: 10, now: NOW })
    expect(matched).toBe(3)
    expect(polls.map((p) => [p.poll.question, p.status, p.totalVotes, p.channel])).toEqual([
      ["GM night?", "open", 8, "#general"],
      ["Track?", "final", 8, "#setups › Monza help"],
      ["Shirts?", "closing", null, "#general"],
    ])
  })

  it("filters by status and words, and keeps the limit", async () => {
    expect((await discordPolls({ days: 90, limit: 10, status: "open", now: NOW })).polls.map((p) => p.id)).toEqual(["m1"])
    expect((await discordPolls({ days: 90, limit: 10, status: "closed", now: NOW })).polls.map((p) => p.id)).toEqual(["m2", "m3"])
    expect((await discordPolls({ days: 90, limit: 10, search: "wed track", now: NOW })).polls.map((p) => p.id)).toEqual(["m2"])
    const limited = await discordPolls({ days: 90, limit: 1, now: NOW })
    expect([limited.polls.length, limited.matched]).toEqual([1, 3])
  })
})

describe("discordWeek", () => {
  it("compares the last 7 days with the 7 before, with the member count's change", async () => {
    db.discordDailyStat.groupBy.mockResolvedValue([
      { channelId: "c1", _sum: { messages: 80 } },
      { channelId: "c2", _sum: { messages: 40 } },
      { channelId: "c3", _sum: { messages: 0 } },
    ])
    db.discordDailyStat.aggregate.mockResolvedValue({ _sum: { messages: 100 } })
    db.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ members: 18 }])
    db.discordGuildDaily.findMany.mockResolvedValue([
      { date: day("2026-10-15"), memberCount: 400 },
      { date: day("2026-10-22"), memberCount: 403 },
    ])
    db.discordChannel.findMany.mockResolvedValue([{ id: "c1", name: "general" }, { id: "c2", name: "lsc-chat" }, { id: "c3", name: "quiet" }])
    db.discordChannel.count.mockResolvedValue(3)
    expect(await discordWeek(NOW)).toEqual({
      messages: 120,
      previousMessages: 100,
      activeMembers: 18,
      memberCount: 403,
      memberChange: 3,
      topChannels: [
        { name: "general", messages: 80 },
        { name: "lsc-chat", messages: 40 },
      ],
      synced: 3,
    })
    expect(db.discordDailyStat.aggregate).toHaveBeenCalledWith({ where: { date: { gte: day("2026-10-09"), lte: day("2026-10-15") } }, _sum: { messages: true } })
  })
})
