import { afterEach, describe, expect, it, vi } from "vitest"
import { chicagoDay } from "@/lib/dates"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { DiscordApiError, discordClient } from "./client"
import { FAKE_CHANNELS, FAKE_DISCORD, FAKE_POLLS } from "./fake/data"
import { discordFake } from "./fake/handlers"
import { memoryDiscordStore } from "./memory-store"
import { DiscordRateLimiter } from "./rate-limit"
import { snowflakeTime } from "./snowflake"
import { chicagoDayBounds, daysBetween, DiscordMembersIntentError, refreshChannels, rescan, syncMembers, syncMessages, type SyncContext } from "./sync"
import { CHANNEL_TYPE, type DiscordMessage } from "./types"

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

/** A member who posts in #general */
async function poster(ctx: SyncContext): Promise<string> {
  return (await fakeHistory(ctx, FAKE_CHANNELS.general)).find((m) => !m.author.bot)!.author.id
}

/** The client's message reads, with `purge` run just before page number `page` (counting from 0) is handed back */
function purgeAfterPage(ctx: SyncContext, purge: () => void, page: number): SyncContext["client"]["messages"] {
  let read = 0
  return async (...args) => {
    const result = await ctx.client.messages(...args)
    if (read++ === page) purge()
    return result
  }
}

describe("refreshChannels", () => {
  it("keeps the channels that can hold messages (switched off), with their category, and no thread of a channel that isn't opted in", async () => {
    const { memory, ctx } = setup()
    const { channels, activeThreads } = await refreshChannels(ctx)
    const byName = new Map(channels.map((c) => [c.name, c]))
    expect([...byName.keys()].sort()).toEqual(["Lounge", "announcements", "general", "lsc-chat", "setups"])
    expect(byName.get("general")).toMatchObject({ parentName: "Club", parentId: null, synced: false })
    expect(byName.get("setups")).toMatchObject({ type: 15, parentName: "Racing" })
    // A thread's title is a member's words: nothing from #setups while it's off
    expect(activeThreads.size).toBe(0)
    expect(memory.channels.has(FAKE_CHANNELS.monzaThread)).toBe(false)
    // Categories and the channel the bot can't see aren't kept
    expect(memory.channels.has(FAKE_CHANNELS.clubCategory)).toBe(false)
    expect(memory.channels.has(FAKE_CHANNELS.officers)).toBe(false)
  })

  it("keeps the active public threads of an opted-in channel under it, never a private thread", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups] })
    const real = ctx.client.activeThreads
    const privateThread = { id: "1142880731136999999", type: CHANNEL_TYPE.privateThread, name: "Private chat", parent_id: FAKE_CHANNELS.setups }
    const client = { ...ctx.client, activeThreads: async (signal?: AbortSignal) => ({ threads: [...(await real(signal)).threads, privateThread] }) }
    const { activeThreads } = await refreshChannels({ ...ctx, client } as SyncContext)
    expect([...activeThreads]).toEqual([FAKE_CHANNELS.monzaThread])
    expect(memory.channels.get(FAKE_CHANNELS.monzaThread)).toMatchObject({ name: "Monza setup help", parentId: FAKE_CHANNELS.setups, parentName: "setups", synced: false })
    expect(memory.channels.has(privateThread.id)).toBe(false)
  })

  it("never changes an admin's switch", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    await refreshChannels(ctx)
    expect(memory.channels.get(FAKE_CHANNELS.general)).toMatchObject({ synced: true, name: "general" })
  })

  it("keeps who started a thread, and only that for a channel", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups] })
    const owner = await threadOwner(ctx, FAKE_CHANNELS.monzaThread)
    await refreshChannels(ctx)
    expect(memory.channels.get(FAKE_CHANNELS.monzaThread)).toMatchObject({ name: "Monza setup help", ownerId: owner })
    expect(memory.channels.get(FAKE_CHANNELS.setups)?.ownerId).toBeNull()
  })

  it("stores a thread a purged member started as “a thread”, without their title or id, and still counts the replies in it", async () => {
    const owner = await threadOwner(setup().ctx, FAKE_CHANNELS.monzaThread)
    vi.unstubAllGlobals()
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups], purged: [owner] })
    await syncMessages(ctx)
    expect(memory.channels.get(FAKE_CHANNELS.monzaThread)).toMatchObject({ name: "a thread", ownerId: null, parentId: FAKE_CHANNELS.setups })
    expect(JSON.stringify([...memory.channels.values()])).not.toContain("Monza setup help")
    const replies = [...memory.messages.values()].filter((m) => m.channelId === FAKE_CHANNELS.monzaThread)
    expect(replies.length).toBeGreaterThan(0)
    expect(replies.some((m) => m.authorId === owner)).toBe(false)
    expect([...memory.daily.values()].some((s) => s.channelId === FAKE_CHANNELS.setups)).toBe(true)
  })

  it("never writes a title back once its starter is purged: a purge renames it, and later syncs keep it so", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups] })
    const owner = await threadOwner(ctx, FAKE_CHANNELS.monzaThread)
    await syncMessages(ctx)
    memory.purge(owner)
    await syncMessages(ctx)
    await rescan(ctx)
    expect(memory.channels.get(FAKE_CHANNELS.monzaThread)).toMatchObject({ name: "a thread", ownerId: null })
  })

  it("keeps a thread untitled when its starter is purged after the run read the list, before it saved the channels", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups] })
    const owner = await threadOwner(ctx, FAKE_CHANNELS.monzaThread)
    const client = {
      ...ctx.client,
      activeThreads: async (signal?: AbortSignal) => {
        const list = await ctx.client.activeThreads(signal)
        memory.purge(owner)
        return list
      },
    }
    await syncMessages({ ...ctx, client } as SyncContext)
    expect(memory.channels.get(FAKE_CHANNELS.monzaThread)).toMatchObject({ name: "a thread", ownerId: null })
  })
})

/** Who started a thread in the fake server */
async function threadOwner(ctx: SyncContext, threadId: string): Promise<string> {
  const active = (await ctx.client.activeThreads()).threads
  const archived = (await ctx.client.archivedThreads(FAKE_CHANNELS.setups)).threads
  return [...active, ...archived].find((t) => t.id === threadId)!.owner_id!
}

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

    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general], purged: [someone] })
    await syncMessages(ctx)
    expect(memory.messages.size).toBeGreaterThan(0)
    expect([...memory.messages.values()].some((r) => r.authorId === someone)).toBe(false)
  })

  it("stores none of a member's messages once they're purged in the middle of the run", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    const someone = await poster(ctx)
    // More than a page from them
    for (let i = 0; i < 120; i++) await hook(fakes, "POST", "messages", { channelId: FAKE_CHANNELS.general, content: `lap ${i}`, authorId: someone })
    // The purge lands after the first page is read, before it's written
    const client = { ...ctx.client, messages: purgeAfterPage(ctx, () => memory.purge(someone), 1) }
    await syncMessages({ ...ctx, client } as SyncContext, { backfillDays: 60 })
    expect(memory.messages.size).toBeGreaterThan(0)
    expect([...memory.messages.values()].some((m) => m.authorId === someone)).toBe(false)
  })

  it("reports a channel it can't read and carries on with the rest", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    // An opted-in channel the bot lost access to
    memory.channels.set(FAKE_CHANNELS.officers, { id: FAKE_CHANNELS.officers, name: "officers", type: 0, parentId: null, parentName: null, ownerId: null, synced: true, lastMessageId: null, lastSyncedAt: null, rescanFrom: null })
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

  it("keeps nothing from a channel switched off while the run reads it: no rows, no daily counts, no cursor", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat] })
    let pages = 0
    const client = {
      ...ctx.client,
      messages: async (...args: Parameters<SyncContext["client"]["messages"]>) => {
        const page = await ctx.client.messages(...args)
        // An admin switches #general off while its first page is on its way
        if (args[0] === FAKE_CHANNELS.general && pages++ === 0) await memory.store.switchOff(FAKE_CHANNELS.general)
        return page
      },
    }
    const result = await syncMessages({ ...ctx, client } as SyncContext, { backfillDays: 60 })
    expect(result.problems).toEqual([])
    expect(pages).toBe(1)
    expect([...memory.messages.values()].some((m) => m.channelId === FAKE_CHANNELS.general)).toBe(false)
    expect([...memory.daily.values()].some((s) => s.channelId === FAKE_CHANNELS.general)).toBe(false)
    expect(memory.channels.get(FAKE_CHANNELS.general)).toMatchObject({ synced: false, lastMessageId: null, lastSyncedAt: null })
    expect([...memory.messages.values()].some((m) => m.channelId === FAKE_CHANNELS.lscChat)).toBe(true)
  })

  it("switches off an opted-in channel Discord deleted, with what's stored from it, instead of failing every run", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat] })
    await syncMessages(ctx)
    const general = [...memory.messages.values()].filter((m) => m.channelId === FAKE_CHANNELS.general).length
    expect(general).toBeGreaterThan(0)
    await hook(fakes, "DELETE", `channels/${FAKE_CHANNELS.general}`)

    const result = await syncMessages(ctx)
    expect(result.problems).toEqual([])
    expect(result.gone).toEqual([{ id: FAKE_CHANNELS.general, name: "general", messages: general }])
    expect(memory.channels.has(FAKE_CHANNELS.general)).toBe(false)
    expect([...memory.messages.values()].some((m) => m.channelId === FAKE_CHANNELS.general)).toBe(false)
    expect([...memory.daily.values()].some((s) => s.channelId === FAKE_CHANNELS.general)).toBe(false)
    expect([...memory.messages.values()].some((m) => m.channelId === FAKE_CHANNELS.lscChat)).toBe(true)
    // Discord was asked once more before anything was deleted
    expect(fakes.requests.some((r) => r.method === "GET" && r.path === `/api/v10/channels/${FAKE_CHANNELS.general}`)).toBe(true)
    expect((await syncMessages(ctx)).gone).toEqual([])
  })

  it("reports a 404 as a problem, deleting nothing, when Discord says the channel is still there", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    const client = {
      ...ctx.client,
      messages: async () => {
        throw new DiscordApiError(404, 10003, "GET /channels/:id/messages", "Unknown Channel")
      },
    }
    const result = await syncMessages({ ...ctx, client } as SyncContext)
    expect(result.gone).toEqual([])
    expect(result.problems).toEqual([{ channel: "#general", error: expect.stringContaining("10003") }])
    expect(memory.channels.get(FAKE_CHANNELS.general)?.synced).toBe(true)
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

  it("leaves a channel the sync hasn't read yet to the sync, so its first read still reaches back the whole backfill", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    await refreshChannels(ctx)
    expect(await rescan(ctx)).toMatchObject({ channels: 0, added: 0 })
    expect(memory.channels.get(FAKE_CHANNELS.general)?.lastMessageId).toBeNull()
    await syncMessages(ctx, { backfillDays: 30 })
    const oldest = Math.min(...[...memory.messages.values()].map((m) => m.createdAt.getTime()))
    expect(oldest).toBeLessThan(Date.now() - 20 * DAY)
  })

  it("picks up threads archived in the window under their channel", async () => {
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups] })
    const owner = await threadOwner(ctx, FAKE_CHANNELS.spaThread)
    await syncMessages(ctx)
    await rescan(ctx)
    const spa = [...memory.channels.values()].find((c) => c.name === "Spa wet setup")
    expect(spa).toMatchObject({ parentId: FAKE_CHANNELS.setups, synced: false, ownerId: owner })
    expect(spa?.lastMessageId).toBeTruthy()
  })

  it("picks up an archived thread a purged member started without its title", async () => {
    const owner = await threadOwner(setup().ctx, FAKE_CHANNELS.spaThread)
    vi.unstubAllGlobals()
    const { memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups], purged: [owner] })
    await syncMessages(ctx)
    await rescan(ctx)
    expect(memory.channels.get(FAKE_CHANNELS.spaThread)).toMatchObject({ name: "a thread", ownerId: null, parentId: FAKE_CHANNELS.setups })
    expect(JSON.stringify([...memory.channels.values()])).not.toContain("Spa wet setup")
  })

  it("never writes back what a purge deleted while the re-scan was reading, in that channel or the next", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat] })
    const someone = await poster(ctx)
    for (let i = 0; i < 120; i++) await hook(fakes, "POST", "messages", { channelId: FAKE_CHANNELS.general, content: `lap ${i}`, authorId: someone })
    await hook(fakes, "POST", "messages", { channelId: FAKE_CHANNELS.lscChat, content: "see you at practice", authorId: someone })
    await syncMessages(ctx)
    expect([...memory.messages.values()].filter((m) => m.authorId === someone).length).toBeGreaterThan(120)

    // The re-scan reads the last 7 days again; the purge lands after its first page
    const client = { ...ctx.client, messages: purgeAfterPage(ctx, () => memory.purge(someone), 0) }
    const result = await rescan({ ...ctx, client } as SyncContext)
    expect(result).toMatchObject({ unfinished: 0, problems: [] })
    expect([...memory.messages.values()].some((m) => m.authorId === someone)).toBe(false)
    // Everyone else's are still there, and today's count (their 120 laps) is rebuilt without them
    expect([...memory.messages.values()].some((m) => m.channelId === FAKE_CHANNELS.lscChat)).toBe(true)
    const today = chicagoDay(new Date()).getTime()
    const stat = [...memory.daily.values()].find((s) => s.date.getTime() === today && s.channelId === FAKE_CHANNELS.general)
    const live = [...memory.messages.values()].filter((m) => m.channelId === FAKE_CHANNELS.general && !m.deletedAt && chicagoDay(m.createdAt).getTime() === today)
    expect(stat?.messages ?? 0).toBe(live.length)
  })

  it("drops a thread Discord deleted with its messages, and rebuilds its channel's days, without failing the run", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups] })
    await syncMessages(ctx)
    const monza = [...memory.messages.values()].filter((m) => m.channelId === FAKE_CHANNELS.monzaThread)
    expect(monza.length).toBe(8)
    const statTotal = () => [...memory.daily.values()].filter((s) => s.channelId === FAKE_CHANNELS.setups).reduce((n, s) => n + s.messages, 0)
    expect(statTotal()).toBe(8)
    // A member deletes their forum post
    await hook(fakes, "DELETE", `channels/${FAKE_CHANNELS.monzaThread}`)

    const result = await rescan(ctx)
    expect(result).toMatchObject({ problems: [], gone: [], threadsGone: 1 })
    expect(memory.channels.has(FAKE_CHANNELS.monzaThread)).toBe(false)
    expect([...memory.messages.values()].some((m) => m.channelId === FAKE_CHANNELS.monzaThread)).toBe(false)
    expect(memory.channels.get(FAKE_CHANNELS.setups)?.synced).toBe(true)
    // Spa (archived 3 days ago) is still there and counted; Monza's messages no longer are
    const spa = [...memory.messages.values()].filter((m) => m.channelId === FAKE_CHANNELS.spaThread && m.createdAt.getTime() >= Date.now() - 7 * DAY).length
    expect(statTotal()).toBe(spa)
    expect((await rescan(ctx)).threadsGone).toBe(0)
  })

  it("switches off a forum Discord deleted when listing its archived threads finds it gone", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.setups, FAKE_CHANNELS.lscChat] })
    await syncMessages(ctx)
    await hook(fakes, "DELETE", `channels/${FAKE_CHANNELS.setups}`)
    const result = await rescan(ctx)
    expect(result.problems).toEqual([])
    expect(result.gone.map((g) => g.name)).toEqual(["setups"])
    expect(memory.channels.has(FAKE_CHANNELS.setups)).toBe(false)
    expect(memory.channels.has(FAKE_CHANNELS.monzaThread)).toBe(false)
    expect([...memory.messages.values()].some((m) => m.channelId === FAKE_CHANNELS.monzaThread)).toBe(false)
  })

  it("lists archived threads only for channels that can have them (not voice or stage)", async () => {
    const { fakes, ctx } = setup({ synced: [FAKE_CHANNELS.general, FAKE_CHANNELS.voiceLounge] })
    await expect(ctx.client.archivedThreads(FAKE_CHANNELS.voiceLounge)).rejects.toMatchObject({ status: 400, code: 50024 })
    await syncMessages(ctx)
    const result = await rescan(ctx)
    expect(result.problems).toEqual([])
    const listed = fakes.requests.filter((r) => r.path.endsWith("/threads/archived/public")).map((r) => r.path)
    expect(listed.filter((p) => p.includes(FAKE_CHANNELS.voiceLounge))).toHaveLength(1)
    expect(listed.some((p) => p.includes(FAKE_CHANNELS.general))).toBe(true)
  })

  it("saves where a pass cut short got to, marks deletions only up to there, and carries on from there next time", async () => {
    const { fakes, memory, ctx } = setup({ synced: [FAKE_CHANNELS.general] })
    // More than one page of recent messages
    for (let i = 0; i < 120; i++) await hook(fakes, "POST", "messages", { channelId: FAKE_CHANNELS.general, content: `message ${i}` })
    await syncMessages(ctx)
    // The fake stamps each posted message a millisecond apart, a little ahead of the clock
    const window = (await ctx.store.liveMessageIds(FAKE_CHANNELS.general, new Date(Date.now() - 7 * DAY), new Date(Date.now() + DAY))).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
    expect(window.length).toBeGreaterThan(120)
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
    const { memory, ctx } = setup({ purged: [someone] })
    await syncMembers(ctx)
    expect(memory.members.has(someone)).toBe(false)
    expect(memory.members.size).toBe(39)
  })

  it("doesn't add back, or link, a member purged between reading the list and saving it", async () => {
    const someone = (await (async () => {
      const { ctx } = setup()
      return (await ctx.client.members({ limit: 5 })).find((m) => !m.user.bot)!.user.id
    })())!
    vi.unstubAllGlobals()
    const { memory, ctx } = setup({ linked: { [someone]: "user-1" } })
    await syncMembers(ctx)
    expect(memory.members.get(someone)?.userId).toBe("user-1")

    const client = {
      ...ctx.client,
      members: async (...args: Parameters<SyncContext["client"]["members"]>) => {
        const page = await ctx.client.members(...args)
        memory.purge(someone)
        return page
      },
    }
    const result = await syncMembers({ ...ctx, client } as SyncContext)
    expect(memory.members.has(someone)).toBe(false)
    expect([...memory.members.values()].some((m) => m.userId === "user-1")).toBe(false)
    expect(result).toMatchObject({ members: 40, joined: 0, left: 0, memberCount: 39 })
  })

  it("links members as their accounts are linked when it saves, not when the run started", async () => {
    const someone = (await (async () => {
      const { ctx } = setup()
      return (await ctx.client.members({ limit: 5 })).find((m) => !m.user.bot)!.user.id
    })())!
    vi.unstubAllGlobals()
    const { memory, ctx } = setup({ linked: { [someone]: "user-1" } })
    const client = {
      ...ctx.client,
      members: async (...args: Parameters<SyncContext["client"]["members"]>) => {
        const page = await ctx.client.members(...args)
        // The member unlinks while the list is on its way
        memory.linked.delete(someone)
        return page
      },
    }
    await syncMembers({ ...ctx, client } as SyncContext)
    expect(memory.members.get(someone)?.userId).toBeNull()
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
