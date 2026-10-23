import { afterEach, describe, expect, it, vi } from "vitest"
import { chicagoDay } from "@/lib/dates"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { discordClient } from "./client"
import { FAKE_CHANNELS, FAKE_DISCORD, FAKE_POLLS } from "./fake/data"
import { discordFake } from "./fake/handlers"
import { memoryDiscordStore } from "./memory-store"
import { authorHash } from "./metadata"
import { DiscordRateLimiter } from "./rate-limit"
import { snowflakeTime } from "./snowflake"
import { chicagoDayBounds, daysBetween, DiscordMembersIntentError, refreshChannels, rescan, syncMembers, syncMessages, type SyncContext } from "./sync"
import type { DiscordMessage } from "./types"

afterEach(() => {
  vi.unstubAllGlobals()
})

const DAY = 86_400_000

type Setup = { fakes: MountedFakes; memory: ReturnType<typeof memoryDiscordStore>; ctx: SyncContext }

/** The fake server, an in-memory store with these channels opted in, and a sync context over both */
function setup(options: { synced?: string[]; purged?: string[]; linked?: Record<string, string>; token?: string } = {}): Setup {
  const fakes = mountFakes([discordFake])
  const memory = memoryDiscordStore({ channels: (options.synced ?? []).map((id) => ({ id, synced: true })), purged: options.purged, linked: options.linked })
  const client = discordClient({ token: options.token ?? FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() })
  return { fakes, memory, ctx: { client, store: memory.store } }
}

async function hook(fakes: MountedFakes, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${fakes.origin}/discord/_fake/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  return response.status === 204 ? null : response.json()
}

/** Every message the fake holds in a channel, oldest first (as the bot with the intent sees them) */
async function fakeHistory(ctx: SyncContext, channelId: string): Promise<DiscordMessage[]> {
  return (await ctx.client.messages(channelId, { limit: 100 })).reverse()
}

describe("refreshChannels", () => {
  it("keeps the channels that can hold messages (switched off), with their category, and active threads under their channel", async () => {
    const { memory, ctx } = setup()
    const { channels, activeThreads } = await refreshChannels(ctx)
    const byName = new Map(channels.map((c) => [c.name, c]))
    expect([...byName.keys()].sort()).toEqual(["Lounge", "Monza setup help", "announcements", "general", "lsc-chat", "setups"])
    expect(byName.get("general")).toMatchObject({ parentName: "Club", parentId: null, synced: false })
    expect(byName.get("setups")).toMatchObject({ type: 15, parentName: "Racing" })
    expect(byName.get("Monza setup help")).toMatchObject({ parentId: FAKE_CHANNELS.setups, parentName: "setups", synced: false })
    expect(activeThreads.size).toBe(1)
    // Categories and the channel the bot can't see aren't kept
    expect(memory.channels.has(FAKE_CHANNELS.clubCategory)).toBe(false)
    expect(memory.channels.has(FAKE_CHANNELS.officers)).toBe(false)
  })

  it("never changes an admin's switch", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    await refreshChannels(ctx)
    expect(memory.channels.get(FAKE_CHANNELS.general)).toMatchObject({ synced: true, name: "general" })
  })
})

describe("syncMessages", () => {
  it("stores metadata only, for opted-in channels and their threads, and builds daily stats with threads counted in their channel", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general, FAKE_CHANNELS.setups] })
    const result = await syncMessages(ctx)
    expect(result).toMatchObject({ channels: 1, threads: 1, unfinished: 0, problems: [] })

    const rows = [...memory.messages.values()]
    const channels = new Set(rows.map((r) => r.channelId))
    expect(channels).toEqual(new Set([FAKE_CHANNELS.general, [...memory.channels.values()].find((c) => c.name === "Monza setup help")!.id]))
    expect(result.added).toBe(rows.length)
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["attachments", "authorId", "channelId", "contentLength", "createdAt", "deletedAt", "editedAt", "id", "isReply", "lastSeenAt", "poll"])
      expect(row.contentLength).toBeGreaterThan(0)
    }
    expect(rows.some((r) => r.isReply)).toBe(true)
    expect(rows.some((r) => r.attachments > 0)).toBe(true)

    // The cursor is the newest message read
    const general = memory.channels.get(FAKE_CHANNELS.general)!
    const history = await fakeHistory(ctx, FAKE_CHANNELS.general)
    expect(general.lastMessageId).toBe(history[history.length - 1].id)
    expect(general.lastSyncedAt).toBeInstanceOf(Date)

    // Daily stats: the thread's messages count toward #setups, not a channel of their own
    const stats = [...memory.daily.values()]
    expect(new Set(stats.map((s) => s.channelId))).toEqual(new Set([FAKE_CHANNELS.general, FAKE_CHANNELS.setups]))
    const total = stats.filter((s) => s.channelId === FAKE_CHANNELS.general).reduce((n, s) => n + s.messages, 0)
    expect(total).toBe(rows.filter((r) => r.channelId === FAKE_CHANNELS.general).length)
    for (const stat of stats) expect(stat.activeAuthors).toBeLessThanOrEqual(stat.messages)
  })

  it("keeps polls with their counts and no voters, including the bot's own, and skips the bot's other messages", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.announcements, FAKE_CHANNELS.lscChat] })
    await syncMessages(ctx)
    const polls = [...memory.messages.values()].filter((r) => r.poll).map((r) => r.poll!)
    expect(polls.map((p) => p.question).sort()).toEqual([FAKE_POLLS.gmNight.question, FAKE_POLLS.nextTrack.question])
    const gm = polls.find((p) => p.question === FAKE_POLLS.gmNight.question)!
    expect(gm).toMatchObject({ finalized: true, multiselect: false })
    expect(gm.answers.map((a) => [a.text, a.votes])).toEqual(FAKE_POLLS.gmNight.answers.map((text, i) => [text, FAKE_POLLS.gmNight.counts[i]]))
    expect(JSON.stringify(polls)).not.toMatch(/voter|user/i)
    const bot = [...memory.messages.values()].filter((r) => r.authorId === FAKE_DISCORD.botUserId)
    expect(bot).toHaveLength(1)
    expect(bot[0].poll?.question).toBe(FAKE_POLLS.gmNight.question)
  })

  it("reads back only `backfillDays` the first time, then only what's new", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    await syncMessages(ctx, { backfillDays: 10 })
    const cutoff = Date.now() - 10 * DAY - 60_000
    expect([...memory.messages.values()].every((r) => r.createdAt.getTime() >= cutoff)).toBe(true)
    const before = memory.messages.size

    await hook(fakes, "POST", "messages", { channelId: FAKE_CHANNELS.general, content: "Practice tonight at 8?" })
    const second = await syncMessages(ctx, { backfillDays: 10 })
    expect(second.added).toBe(1)
    expect(memory.messages.size).toBe(before + 1)
    // Only what came after the cursor was asked for
    const asked = fakes.requests.filter((r) => r.path === `/api/v10/channels/${FAKE_CHANNELS.general}/messages`).at(-1)!
    expect(new URL(asked.url).searchParams.get("after")).toBeTruthy()
  })

  it("leaves out members whose data was purged", async () => {
    const plain = setup({ synced: [FAKE_CHANNELS.general] })
    await syncMessages(plain.ctx)
    const someone = [...plain.memory.messages.values()][0].authorId
    vi.unstubAllGlobals()

    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general], purged: [authorHash(someone)] })
    await syncMessages(ctx)
    expect(memory.messages.size).toBeGreaterThan(0)
    expect([...memory.messages.values()].some((r) => r.authorId === someone)).toBe(false)
  })

  it("reports a channel it can't read and carries on with the rest", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    // An opted-in channel the bot lost access to
    memory.channels.set(FAKE_CHANNELS.officers, { id: FAKE_CHANNELS.officers, name: "officers", type: 0, parentId: null, parentName: null, synced: true, lastMessageId: null, lastSyncedAt: null, rescanFrom: null })
    const result = await syncMessages(ctx)
    expect(result.problems).toEqual([{ channel: "#officers", error: "Discord answered 403 (code 50001 Missing Access) on GET /channels/:id/messages" }])
    expect([...memory.messages.values()].some((r) => r.channelId === FAKE_CHANNELS.general)).toBe(true)
  })

  it("leaves a channel for the next run, not as a failure, when Discord rate limits it for longer than the client waits", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat] })
    await refreshChannels(ctx)
    await hook(fakes, "POST", "rate-limit", { times: 1, retryAfter: 64, path: FAKE_CHANNELS.general })
    const result = await syncMessages(ctx)
    expect(result).toMatchObject({ unfinished: 1, problems: [] })
    expect([...memory.messages.values()].some((m) => m.channelId === FAKE_CHANNELS.lscChat)).toBe(true)
    expect(memory.channels.get(FAKE_CHANNELS.general)?.lastMessageId).toBeNull()
  })

  it("stops on a rejected token", async () => {
    const { ctx } = setup({ synced: [FAKE_CHANNELS.general], token: "wrong" })
    await expect(syncMessages(ctx)).rejects.toMatchObject({ status: 401 })
  })

  it("starts nothing new past its deadline, and says what's left", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat] })
    await refreshChannels(ctx)
    const result = await syncMessages({ ...ctx, deadline: Date.now() + 1_000 })
    expect(result).toMatchObject({ added: 0, unfinished: 2 })
    expect(memory.messages.size).toBe(0)
  })
})

describe("rescan", () => {
  it("marks deleted what's gone, updates edits, and adds anything the sync missed", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    await syncMessages(ctx)
    const history = await fakeHistory(ctx, FAKE_CHANNELS.general)
    const recent = history.filter((m) => snowflakeTime(m.id).getTime() > Date.now() - 5 * DAY)
    const [gone, edited] = recent
    await hook(fakes, "DELETE", `messages/${FAKE_CHANNELS.general}/${gone.id}`)
    await hook(fakes, "PATCH", `messages/${FAKE_CHANNELS.general}/${edited.id}`, { content: "edited text that is a fair bit longer than before" })
    const late = (await hook(fakes, "POST", "messages", { channelId: FAKE_CHANNELS.general, content: "posted after the sync" })) as DiscordMessage

    const result = await rescan(ctx)
    expect(result).toMatchObject({ deleted: 1, added: 1, unfinished: 0, problems: [] })
    expect(memory.messages.get(gone.id)?.deletedAt).toBeInstanceOf(Date)
    expect(memory.messages.get(edited.id)).toMatchObject({ editedAt: expect.any(Date), contentLength: "edited text that is a fair bit longer than before".length, deletedAt: null })
    expect(memory.messages.has(late.id)).toBe(true)
    expect(memory.channels.get(FAKE_CHANNELS.general)?.rescanFrom).toBeNull()
    // Deleted messages drop out of the day's stats
    const day = chicagoDay(new Date(gone.timestamp)).getTime()
    const stat = [...memory.daily.values()].find((s) => s.date.getTime() === day && s.channelId === FAKE_CHANNELS.general)
    const live = [...memory.messages.values()].filter((m) => m.channelId === FAKE_CHANNELS.general && !m.deletedAt && chicagoDay(m.createdAt).getTime() === day)
    expect(stat?.messages ?? 0).toBe(live.length)
  })

  it("never marks anything deleted outside the window it read", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    await syncMessages(ctx)
    const old = (await fakeHistory(ctx, FAKE_CHANNELS.general)).find((m) => snowflakeTime(m.id).getTime() < Date.now() - 10 * DAY)
    // fakeHistory reads the newest 100; read further back for an old one
    const oldId = old?.id ?? [...memory.messages.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0].id
    await hook(fakes, "DELETE", `messages/${FAKE_CHANNELS.general}/${oldId}`)
    expect((await rescan(ctx)).deleted).toBe(0)
    expect(memory.messages.get(oldId)?.deletedAt).toBeNull()
  })

  it("keeps the last known poll counts when Discord leaves them out, and takes new ones when it sends them", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.lscChat] })
    await syncMessages(ctx)
    const poll = () => [...memory.messages.values()].find((m) => m.poll?.question === FAKE_POLLS.nextTrack.question)!.poll!
    expect(poll().answers.map((a) => a.votes)).toEqual(FAKE_POLLS.nextTrack.counts)

    await hook(fakes, "POST", "polls", { hideResults: true })
    await rescan(ctx)
    expect(poll().answers.map((a) => a.votes)).toEqual(FAKE_POLLS.nextTrack.counts)

    await hook(fakes, "POST", "polls", { hideResults: false, counts: [8, 4, 11, 2], finalize: true })
    await rescan(ctx)
    expect(poll()).toMatchObject({ finalized: true })
    expect(poll().answers.map((a) => a.votes)).toEqual([8, 4, 11, 2])
  })

  it("refreshes a stored poll older than the window until it's finalized", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.announcements] })
    await syncMessages(ctx)
    const row = [...memory.messages.values()].find((m) => m.poll?.question === FAKE_POLLS.gmNight.question)!
    // As if the last read was before Discord finalized it
    row.poll = { ...row.poll!, finalized: false, answers: row.poll!.answers.map((a) => ({ ...a, votes: 1 })) }
    const result = await rescan(ctx)
    expect(result.polls).toBe(1)
    expect(memory.messages.get(row.id)?.poll).toMatchObject({ finalized: true })
    expect(memory.messages.get(row.id)?.poll?.answers.map((a) => a.votes)).toEqual(FAKE_POLLS.gmNight.counts)
  })

  it("picks up threads archived in the window under their channel", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups] })
    await syncMessages(ctx)
    await rescan(ctx)
    const spa = [...memory.channels.values()].find((c) => c.name === "Spa wet setup")
    expect(spa).toMatchObject({ parentId: FAKE_CHANNELS.setups, synced: false })
    expect(spa?.lastMessageId).toBeTruthy()
  })

  it("saves where a pass cut short got to, marks deletions only up to there, and carries on from there next time", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    // More than one page of recent messages
    for (let i = 0; i < 120; i++) await hook(fakes, "POST", "messages", { channelId: FAKE_CHANNELS.general, content: `message ${i}` })
    await syncMessages(ctx)
    const window = (await ctx.store.liveMessageIds(FAKE_CHANNELS.general, new Date(Date.now() - 7 * DAY), new Date())).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
    const [early, late] = [window[0], window[window.length - 1]]
    await hook(fakes, "DELETE", `messages/${FAKE_CHANNELS.general}/${early}`)
    await hook(fakes, "DELETE", `messages/${FAKE_CHANNELS.general}/${late}`)

    // The run's time runs out after its first page
    let pages = 0
    const client = { ...ctx.client, messages: async (...args: Parameters<SyncContext["client"]["messages"]>) => (pages++, ctx.client.messages(...args)) }
    const cut = await rescan({
      ...ctx,
      client,
      get deadline() {
        return pages ? Date.now() : Date.now() + 60_000
      },
    } as SyncContext)
    expect(cut).toMatchObject({ unfinished: 1, deleted: 1 })
    expect(memory.messages.get(early)?.deletedAt).toBeInstanceOf(Date)
    expect(memory.messages.get(late)?.deletedAt).toBeNull()
    const resumeAt = memory.channels.get(FAKE_CHANNELS.general)?.rescanFrom
    expect(resumeAt).toBeInstanceOf(Date)

    const next = await rescan(ctx)
    expect(next).toMatchObject({ unfinished: 0, deleted: 1 })
    expect(memory.messages.get(late)?.deletedAt).toBeInstanceOf(Date)
    expect(memory.channels.get(FAKE_CHANNELS.general)?.rescanFrom).toBeNull()
    // The second pass started where the first stopped, not at the window's start
    const asked = fakes.requests.filter((r) => r.path === `/api/v10/channels/${FAKE_CHANNELS.general}/messages`).map((r) => new URL(r.url).searchParams.get("after")!)
    expect(asked.some((after) => snowflakeTime(after).getTime() >= resumeAt!.getTime() - 1)).toBe(true)
  })
})

describe("syncMembers", () => {
  it("stores the members (never bots), links linked accounts, and counts today's joins", async () => {
    const someone = (await (async () => {
      const { ctx } = setup()
      return (await ctx.client.members({ limit: 5 })).find((m) => !m.user.bot)!.user.id
    })())!
    vi.unstubAllGlobals()
    const { memory, ctx } = setup({ linked: { [someone]: "user-1" } })
    const result = await syncMembers(ctx)
    expect(result).toMatchObject({ members: 40, joined: 40, left: 0, complete: true, memberCount: 40 })
    expect(memory.members.has(FAKE_DISCORD.botUserId)).toBe(false)
    expect(memory.members.get(someone)?.userId).toBe("user-1")
    expect([...memory.guildDays.values()]).toEqual([{ memberCount: 40, joinedCount: result.joinedToday, leftCount: 0 }])
  })

  it("marks members missing from a complete list as left, and adds new ones", async () => {
    const { fakes, memory, ctx } = setup()
    await syncMembers(ctx)
    const leaving = [...memory.members.keys()][7]
    await hook(fakes, "DELETE", `members/${leaving}`)
    const joined = (await hook(fakes, "POST", "members", { username: "new.driver" })) as { user: { id: string } }
    const result = await syncMembers(ctx)
    expect(result).toMatchObject({ joined: 1, left: 1, memberCount: 40, leftToday: 1 })
    expect(result.joinedToday).toBeGreaterThanOrEqual(1)
    expect(memory.members.get(leaving)?.leftAt).toBeInstanceOf(Date)
    expect(memory.members.get(joined.user.id)).toMatchObject({ username: "new.driver", leftAt: null })
  })

  it("leaves purged members out", async () => {
    const first = setup()
    await syncMembers(first.ctx)
    const someone = [...first.memory.members.keys()][3]
    vi.unstubAllGlobals()
    const { memory, ctx } = setup({ purged: [authorHash(someone)] })
    await syncMembers(ctx)
    expect(memory.members.has(someone)).toBe(false)
    expect(memory.members.size).toBe(39)
  })

  it("says to switch on the Server Members intent when Discord refuses the list", async () => {
    const { fakes, ctx } = setup()
    await hook(fakes, "POST", "intents", { guildMembers: false })
    await expect(syncMembers(ctx)).rejects.toBeInstanceOf(DiscordMembersIntentError)
  })
})

describe("Central days", () => {
  it("runs a day from midnight to midnight Central, through a daylight saving change", () => {
    const { start, end } = chicagoDayBounds(new Date("2026-11-01T00:00:00Z"))
    expect(start.toISOString()).toBe("2026-11-01T05:00:00.000Z")
    expect(end.toISOString()).toBe("2026-11-02T06:00:00.000Z")
  })

  it("lists every day between two instants", () => {
    expect(daysBetween(new Date("2026-10-19T12:00:00Z"), new Date("2026-10-22T03:00:00Z")).map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"])
  })
})
