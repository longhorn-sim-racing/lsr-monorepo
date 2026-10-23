import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ discordPost: { count: vi.fn(), findMany: vi.fn() }, discordChannel: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { discordPostsFailed } from "./discord-post"

const NOW = new Date("2026-10-23T17:00:00Z")

beforeEach(() => {
  vi.clearAllMocks()
  db.discordChannel.findMany.mockResolvedValue([{ id: "c1", name: "announcements" }])
})

describe("the failed Discord posts check", () => {
  it("is quiet when nothing failed this week", async () => {
    db.discordPost.count.mockResolvedValue(0)
    expect(await discordPostsFailed.run({ now: NOW })).toEqual({ count: 0, severity: "info", items: [] })
    expect(db.discordPost.count).toHaveBeenCalledWith({ where: { status: "FAILED", createdAt: { gte: new Date("2026-10-16T17:00:00Z") } } })
  })

  it("names the channel and where the post came from, never its text or the error, and links to Announcements", async () => {
    db.discordPost.count.mockResolvedValue(2)
    db.discordPost.findMany.mockResolvedValue([
      { channelId: "c1", source: "rule" },
      { channelId: "gone", source: "proposal" },
    ])
    const result = await discordPostsFailed.run({ now: NOW })
    expect(result).toEqual({
      count: 2,
      severity: "warning",
      items: [
        { title: "A post in #announcements from a standing rule failed", href: "/admin/announcements?view=problems", detail: "Check the channel, then retry or cancel it" },
        { title: "A post in #a channel from an applied proposal failed", href: "/admin/announcements?view=problems", detail: "Check the channel, then retry or cancel it" },
      ],
    })
    expect(db.discordPost.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: { channelId: true, source: true } }))
    expect(discordPostsFailed.href).toBe("/admin/announcements?view=problems")
  })
})
