import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

const connector = vi.hoisted(() => ({ client: vi.fn() }))
const queries = vi.hoisted(() => ({ discordActivity: vi.fn(), discordJoinsByMonth: vi.fn(), discordPolls: vi.fn() }))
const state = vi.hoisted(() => ({ readConnectorState: vi.fn() }))
const db = vi.hoisted(() => ({ discordChannel: { findMany: vi.fn() } }))

vi.mock("@/server/connectors/discord/connector", () => ({ discordConnector: connector, DISCORD_OFF: "Discord isn't connected." }))
vi.mock("@/server/queries/discord", () => queries)
vi.mock("@/server/connectors/state", () => state)
vi.mock("@/server/db", () => ({ prisma: db }))

import { discordActivityTool, discordPollsTool } from "./discord"
import { TOOLS } from "./registry/discord-read"

const ctx = { roomId: "room-1", actor: { userId: "u1", displayName: "Gray" } }
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

const activity = {
  firstDay: day("2026-10-16"),
  lastDay: day("2026-10-22"),
  messages: 120,
  activeMembers: 18,
  channels: [
    { id: "c1", name: "general", category: "Club", messages: 90, activeMembers: 15, busiestDay: day("2026-10-18"), busiestDayMessages: 30 },
    { id: "c2", name: "lsc-chat", category: "Racing", messages: 30, activeMembers: 8, busiestDay: day("2026-10-20"), busiestDayMessages: 12 },
  ],
  daily: Array.from({ length: 7 }, (_, i) => ({ date: new Date(day("2026-10-16").getTime() + i * 86_400_000), messages: 10 + i, byChannel: {} })),
  members: [
    { date: day("2026-10-16"), memberCount: 400, joined: 2, left: 0 },
    { date: day("2026-10-22"), memberCount: 403, joined: 1, left: 1 },
  ],
  linkedMembers: 12,
}

const poll = (question: string, status: "open" | "final" | "closing", votes: (number | null)[]) => ({
  id: `m-${question}`,
  channelId: "c1",
  channel: "#general",
  postedAt: day("2026-10-10"),
  status,
  totalVotes: votes.some((v) => v === null) ? null : votes.reduce<number>((n, v) => n + (v ?? 0), 0),
  poll: { question, answers: votes.map((v, i) => ({ id: i + 1, text: `Answer ${i + 1}`, votes: v })), multiselect: false, expiresAt: "2026-10-12T00:00:00.000Z", finalized: status === "final", countedAt: votes.some((v) => v === null) ? null : "2026-10-12T00:00:00.000Z" },
})

beforeEach(() => {
  connector.client.mockResolvedValue({ guildId: "g" })
  state.readConnectorState.mockResolvedValue({ lastSyncAt: new Date("2026-10-22T18:00:00Z") })
  queries.discordActivity.mockResolvedValue(activity)
  queries.discordJoinsByMonth.mockResolvedValue([{ month: "2026-09", joined: 20 }])
  db.discordChannel.findMany.mockResolvedValue([
    { id: "c1", name: "general", synced: true },
    { id: "c3", name: "memes", synced: false },
  ])
})

describe("the discord-read tools", () => {
  it("are discord_activity and discord_polls, both behind tool search, reading only, within the track's size budget", () => {
    expect(TOOLS.map((t) => [t.name, Boolean(t.deferred), Boolean(t.writes)])).toEqual([
      ["discord_activity", true, false],
      ["discord_polls", true, false],
    ])
    const size = TOOLS.reduce((n, tool) => n + JSON.stringify({ name: tool.name, description: tool.description, input_schema: z.toJSONSchema(tool.input) }).length, 0)
    expect(size).toBeLessThanOrEqual(4_000)
  })

  it("say Discord isn't connected while it's off, without reading anything", async () => {
    connector.client.mockResolvedValue(null)
    const outs = [await discordActivityTool.run(discordActivityTool.input.parse({}), ctx), await discordPollsTool.run(discordPollsTool.input.parse({}), ctx)]
    for (const out of outs) expect(out).toMatchObject({ label: "Discord isn't connected", forModel: expect.stringMatching(/Discord isn't connected/) })
    expect(queries.discordActivity).not.toHaveBeenCalled()
    expect(queries.discordPolls).not.toHaveBeenCalled()
  })
})

describe("discord_activity", () => {
  it("gives totals, per-channel counts and members over time, never anyone's own activity", async () => {
    const out = await discordActivityTool.run(discordActivityTool.input.parse({ days: 7 }), ctx)
    const result = JSON.parse(out.forModel)
    expect(result).toMatchObject({
      period: { from: "2026-10-16", to: "2026-10-22", days: 7 },
      messages: 120,
      activeMembers: 18,
      membersNow: 403,
      memberChange: { from: "2026-10-16", to: "2026-10-22", change: 3 },
      joined: 3,
      left: 1,
      linkedMembers: 12,
      note: expect.stringMatching(/never broken down by person/),
    })
    expect(result.channels[0]).toEqual({ channel: "#general", category: "Club", messages: 90, activeMembers: 15, busiestDay: "2026-10-18", busiestDayMessages: 30 })
    expect(result.messagesOverTime).toHaveLength(7)
    expect(out.forModel).not.toMatch(/authorId|username|"by"/)
    expect(out.displays?.map((d) => d.kind)).toEqual(["stats", "chart", "table"])
    expect(queries.discordActivity).toHaveBeenCalledWith(expect.objectContaining({ days: 7, channelId: undefined }))
    expect(queries.discordJoinsByMonth).not.toHaveBeenCalled()
  })

  it("groups a long period by week and adds joins by month", async () => {
    const daily = Array.from({ length: 60 }, (_, i) => ({ date: new Date(day("2026-08-24").getTime() + i * 86_400_000), messages: 1, byChannel: {} }))
    queries.discordActivity.mockResolvedValue({ ...activity, daily })
    const out = await discordActivityTool.run(discordActivityTool.input.parse({ days: 60 }), ctx)
    const result = JSON.parse(out.forModel)
    // 2026-08-24 is a Monday: 60 days are 8 full weeks and 4 days
    expect(result.messagesOverTime[0]).toEqual({ period: "week of 2026-08-24", messages: 7 })
    expect(result.messagesOverTime).toHaveLength(9)
    expect(result.joinsByMonth).toEqual([{ month: "2026-09", joined: 20, note: "current members only" }])
  })

  it("narrows to one synced channel by name, and refuses one that isn't synced or doesn't exist", async () => {
    await discordActivityTool.run(discordActivityTool.input.parse({ channel: "#General" }), ctx)
    expect(queries.discordActivity).toHaveBeenCalledWith(expect.objectContaining({ channelId: "c1" }))
    expect(await discordActivityTool.run(discordActivityTool.input.parse({ channel: "memes" }), ctx)).toMatchObject({ isError: true, forModel: expect.stringMatching(/isn't synced/) })
    expect(await discordActivityTool.run(discordActivityTool.input.parse({ channel: "nope" }), ctx)).toMatchObject({ isError: true, forModel: expect.stringMatching(/No Discord channel called #nope\. Channels: #general\./) })
  })
})

describe("discord_polls", () => {
  it("gives each poll's answers with votes and percentages, and whether the counts are final", async () => {
    queries.discordPolls.mockResolvedValue({ polls: [poll("GM 2 night?", "final", [12, 19, 5]), poll("Next track?", "open", [null, null])], matched: 2 })
    const out = await discordPollsTool.run(discordPollsTool.input.parse({}), ctx)
    const result = JSON.parse(out.forModel)
    expect(result.polls[0]).toMatchObject({
      question: "GM 2 night?",
      channel: "#general",
      status: "closed, final counts",
      totalVotes: 36,
      answers: [
        { answer: "Answer 1", votes: 12, percent: 33 },
        { answer: "Answer 2", votes: 19, percent: 53 },
        { answer: "Answer 3", votes: 5, percent: 14 },
      ],
    })
    expect(result.polls[1]).toMatchObject({ status: "open (counts so far)", totalVotes: null, note: expect.stringMatching(/hasn't reported counts/) })
    expect(result.note).toMatch(/voters are never read/)
    expect(out.displays?.map((d) => d.kind)).toEqual(["table"])
    expect(queries.discordPolls).toHaveBeenCalledWith({ days: 90, status: "all", search: undefined, limit: 10 })
  })

  it("charts a single poll, and says plainly when nothing matches", async () => {
    queries.discordPolls.mockResolvedValue({ polls: [poll("GM 2 night?", "final", [12, 19, 5])], matched: 1 })
    const one = await discordPollsTool.run(discordPollsTool.input.parse({ search: "GM" }), ctx)
    expect(one.displays?.map((d) => d.kind)).toEqual(["table", "chart"])

    queries.discordPolls.mockResolvedValue({ polls: [], matched: 0 })
    const none = await discordPollsTool.run(discordPollsTool.input.parse({ status: "open", search: "track" }), ctx)
    expect(none.forModel).toBe("No open polls matching “track” in the last 90 days in the synced Discord channels.")
  })
})
