import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakePostTable, postRow, type FakePostTable } from "./fake-posts"

const db = vi.hoisted(() => ({ prisma: { discordPost: null as unknown as FakePostTable } }))
vi.mock("@/server/db", () => db)

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { DiscordApiError, discordClient } from "@/server/connectors/discord/client"
import { FAKE_CHANNELS, FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { DiscordRateLimiter } from "@/server/connectors/discord/rate-limit"
import { discordWriter } from "@/server/connectors/discord/write"
import { cancelPosts, claimPost, deliverClaimed, LATE_LIMIT_MS, postNonce, queueDiscordPost, sendDuePosts, sendPostNow, STUCK_AFTER_MS } from "./outbox"

const CHANNEL = FAKE_CHANNELS.announcements
const body = (content = "GM 2 is Monday at 6") => ({ content, allowed_mentions: { parse: [] as [] } })
const noPause = async () => {}

let table: FakePostTable
beforeEach(() => {
  table = fakePostTable()
  db.prisma.discordPost = table
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  const fakes = mountFakes([discordFake])
  const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter(), maxWaitMs: 200 })
  return { fakes, writer: discordWriter(client.rest, client.guildId) }
}
const hook = (fakes: MountedFakes, path: string, payload: unknown) => fetch(`${fakes.origin}/discord/_fake/${path}`, { method: "POST", body: JSON.stringify(payload) })
const posts = (fakes: MountedFakes) => fakes.requests.filter((r) => r.method === "POST" && r.path.endsWith(`/channels/${CHANNEL}/messages`))
async function botMessages(fakes: MountedFakes, content: string) {
  const res = await fetch(`${fakes.origin}/discord/api/v10/channels/${CHANNEL}/messages?limit=100`, { headers: { authorization: `Bot ${FAKE_DISCORD.botToken}` } })
  return ((await res.json()) as { content: string; author: { bot?: boolean } }[]).filter((m) => m.author.bot && m.content === content)
}

/** A post queued and claimed, ready to send */
async function claimed(content?: string) {
  const { post } = await queueDiscordPost({ source: "proposal", channelId: CHANNEL, body: body(content), scheduledFor: new Date(Date.now() - 1000) })
  expect(await claimPost(post.id, new Date())).toBe(true)
  return (await table.findUnique({ where: { id: post.id } }))!
}

describe("queueing", () => {
  it("gives each post its own nonce, and a dedupe key one post", async () => {
    const first = await queueDiscordPost({ source: "rule", channelId: CHANNEL, body: body(), dedupeKey: "new_event:r1:e1" })
    expect(first.created).toBe(true)
    expect(first.post.nonce).toBe(postNonce(first.post.id))
    expect(first.post.nonce!.length).toBeLessThanOrEqual(25)
    const again = await queueDiscordPost({ source: "rule", channelId: CHANNEL, body: body("different"), dedupeKey: "new_event:r1:e1" })
    expect(again).toMatchObject({ created: false, post: { id: first.post.id } })
    expect(table.rows).toHaveLength(1)
  })

  it("refuses a message Discord would refuse", async () => {
    await expect(queueDiscordPost({ source: "admin", channelId: CHANNEL, body: body("x".repeat(2001)) })).rejects.toThrow(/2001 characters/)
  })
})

describe("the SENDING claim", () => {
  it("lets exactly one of several callers claim a due post", async () => {
    const { post } = await queueDiscordPost({ source: "rule", channelId: CHANNEL, body: body(), scheduledFor: new Date(Date.now() - 1000) })
    const results = await Promise.all(Array.from({ length: 5 }, () => claimPost(post.id, new Date())))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(table.rows[0]).toMatchObject({ status: "SENDING" })
  })

  it("never claims a post that isn't due, or isn't scheduled", async () => {
    const { post } = await queueDiscordPost({ source: "rule", channelId: CHANNEL, body: body(), scheduledFor: new Date(Date.now() + 60_000) })
    expect(await claimPost(post.id, new Date())).toBe(false)
    await table.updateMany({ where: { id: post.id }, data: { status: "CANCELLED", scheduledFor: new Date(0) } })
    expect(await claimPost(post.id, new Date())).toBe(false)
  })
})

describe("sending", () => {
  it("posts once, with its nonce, enforce_nonce and no pings", async () => {
    const { fakes, writer } = setup()
    const post = await claimed()
    const outcome = await deliverClaimed(post, writer, { pause: noPause })
    expect(outcome).toEqual({ status: "SENT", messageId: expect.any(String) })
    expect(table.rows[0]).toMatchObject({ status: "SENT", discordMessageId: (outcome as { messageId: string }).messageId, error: null })
    const sent = JSON.parse(posts(fakes)[0].body)
    expect(sent).toMatchObject({ nonce: post.nonce, enforce_nonce: true, allowed_mentions: { parse: [] } })
  })

  it("retries a send whose answer never came with the same nonce, so Discord returns the first message", async () => {
    const { fakes, writer } = setup()
    await hook(fakes, "drop", { path: "/messages", when: "after", times: 1 })
    const post = await claimed()
    const outcome = await deliverClaimed(post, writer, { pause: noPause })
    expect(outcome.status).toBe("SENT")
    expect(posts(fakes)).toHaveLength(2)
    expect(new Set(posts(fakes).map((r) => JSON.parse(r.body).nonce))).toEqual(new Set([post.nonce]))
    expect(await botMessages(fakes, "GM 2 is Monday at 6")).toHaveLength(1)
  })

  it("checks the channel when no try is confirmed: found means sent", async () => {
    const { fakes, writer } = setup()
    await hook(fakes, "drop", { path: "/messages", when: "after", times: 3 })
    const post = await claimed("Posted, but nobody heard back")
    const outcome = await deliverClaimed(post, writer, { pause: noPause })
    expect(outcome.status).toBe("SENT")
    expect(await botMessages(fakes, "Posted, but nobody heard back")).toHaveLength(1)
  })

  it("checks the channel when no try is confirmed: not found means failed, for an officer, never re-sent blind", async () => {
    const { fakes, writer } = setup()
    await hook(fakes, "drop", { path: "/messages", when: "before", times: 3 })
    const post = await claimed("Never arrived")
    const outcome = await deliverClaimed(post, writer, { pause: noPause })
    expect(outcome).toMatchObject({ status: "FAILED", error: expect.stringMatching(/isn't in the channel/) })
    expect(posts(fakes)).toHaveLength(3)
    expect(table.rows[0].status).toBe("FAILED")
  })

  it("treats a 2xx whose answer couldn't be read as unconfirmed, not refused: it's found in the channel and marked sent", async () => {
    const { fakes, writer } = setup()
    // Discord posted it but the answer wasn't JSON (the REST client throws DiscordApiError with the 2xx status)
    const garbled = {
      ...writer,
      async createMessage(...args: Parameters<typeof writer.createMessage>): ReturnType<typeof writer.createMessage> {
        await writer.createMessage(...args)
        throw new DiscordApiError(200, null, "POST /channels/:id/messages", "the answer wasn't JSON")
      },
    }
    const post = await claimed("Posted, answer garbled")
    const outcome = await deliverClaimed(post, garbled, { pause: noPause })
    expect(outcome.status).toBe("SENT")
    expect(table.rows[0].status).toBe("SENT")
    expect(await botMessages(fakes, "Posted, answer garbled")).toHaveLength(1)
  })

  it("fails at once, without retrying, when Discord refuses it", async () => {
    const { fakes, writer } = setup()
    await hook(fakes, "fail", { path: "/messages", method: "POST", status: 403, code: 50013, message: "Missing Permissions" })
    const post = await claimed()
    const outcome = await deliverClaimed(post, writer, { pause: noPause })
    expect(outcome).toMatchObject({ status: "FAILED", error: expect.stringMatching(/isn't allowed to post/) })
    expect(posts(fakes)).toHaveLength(1)
  })

  it("puts a post back for the next run when Discord rate-limits past what the client waits (it wasn't taken)", async () => {
    const { fakes, writer } = setup()
    await hook(fakes, "rate-limit", { times: 1, retryAfter: 30, path: "/messages" })
    const post = await claimed()
    const outcome = await deliverClaimed(post, writer, { pause: noPause })
    expect(outcome).toMatchObject({ status: "SCHEDULED", error: expect.stringMatching(/rate-limited/) })
    expect(table.rows[0]).toMatchObject({ status: "SCHEDULED", claimedAt: null })
  })

  it("leaves a send cut off by the run's deadline SENDING, for a later run to check the channel", async () => {
    const { writer } = setup()
    const post = await claimed()
    const stop = new AbortController()
    stop.abort()
    const outcome = await deliverClaimed(post, writer, { pause: noPause, signal: stop.signal })
    expect(outcome).toMatchObject({ status: "SKIPPED" })
    expect(table.rows[0].status).toBe("SENDING")
  })

  it("sendPostNow claims first: a post someone already sent isn't sent again", async () => {
    const { fakes, writer } = setup()
    const { post } = await queueDiscordPost({ source: "proposal", channelId: CHANNEL, body: body() })
    expect((await sendPostNow(post.id, writer)).status).toBe("SENT")
    const again = await sendPostNow(post.id, writer)
    expect(again.status).toBe("SENT")
    expect(posts(fakes)).toHaveLength(1)
  })
})

describe("cancelling", () => {
  it("frees the dedupe key only when asked (a moved event's reminder can come back; an officer's cancel can't)", async () => {
    const a = await queueDiscordPost({ source: "rule", channelId: CHANNEL, body: body(), dedupeKey: "k-a" })
    const b = await queueDiscordPost({ source: "rule", channelId: CHANNEL, body: body(), dedupeKey: "k-b" })
    expect(await cancelPosts({ id: a.post.id }, "moved", { release: true })).toBe(1)
    expect(await cancelPosts({ id: b.post.id }, "Cancelled by Gray.", { release: false })).toBe(1)
    expect(table.rows.map((r) => [r.status, r.dedupeKey, r.error])).toEqual([
      ["CANCELLED", null, "moved"],
      ["CANCELLED", "k-b", "Cancelled by Gray."],
    ])
    // Only scheduled posts are cancelled
    expect(await cancelPosts({ id: a.post.id }, "again", { release: true })).toBe(0)
  })
})

describe("the posts job", () => {
  it("cancels late posts, confirms stuck ones, checks each due post and sends the rest", async () => {
    const { fakes, writer } = setup()
    const now = new Date()
    // Already in the channel, but the run that sent it stopped before recording it
    const stuckBody = body("Stuck but sent")
    await discordWriter(discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() }).rest, FAKE_DISCORD.guildId).createMessage(CHANNEL, stuckBody, "stuck-nonce")
    table.rows.push(postRow({ id: "stuck", channelId: CHANNEL, content: stuckBody, status: "SENDING", claimedAt: new Date(now.getTime() - STUCK_AFTER_MS - 60_000) }))
    table.rows.push(postRow({ id: "late", channelId: CHANNEL, content: body("late"), dedupeKey: "late-key", scheduledFor: new Date(now.getTime() - LATE_LIMIT_MS - 60_000) }))
    table.rows.push(postRow({ id: "unwanted", channelId: CHANNEL, content: body("unwanted"), dedupeKey: "unwanted-key", scheduledFor: new Date(now.getTime() - 60_000) }))
    table.rows.push(postRow({ id: "due", channelId: CHANNEL, content: body("due now"), nonce: "due-nonce", scheduledFor: new Date(now.getTime() - 30_000) }))
    table.rows.push(postRow({ id: "later", channelId: CHANNEL, content: body("later"), scheduledFor: new Date(now.getTime() + 3_600_000) }))
    const log: string[] = []

    const run = await sendDuePosts(writer, { now, deadline: Date.now() + 60_000, log: (line) => log.push(line), check: async (post) => (post.id === "unwanted" ? "Its rule is switched off." : null), pause: noPause })

    expect(run).toMatchObject({ sent: 1, confirmed: 1, cancelled: 2, failed: 0 })
    const byId = Object.fromEntries(table.rows.map((r) => [r.id, r]))
    expect(byId.stuck.status).toBe("SENT")
    expect(byId.late).toMatchObject({ status: "CANCELLED", dedupeKey: "late-key" })
    expect(byId.unwanted).toMatchObject({ status: "CANCELLED", dedupeKey: null, error: "Its rule is switched off." })
    expect(byId.due.status).toBe("SENT")
    expect(byId.later.status).toBe("SCHEDULED")
    expect(posts(fakes).map((r) => JSON.parse(r.body).content)).toEqual(["Stuck but sent", "due now"])
  })

  it("stops the run when Discord refuses the bot's token: one post fails, the rest wait", async () => {
    const fakes = mountFakes([discordFake])
    const writer = discordWriter(discordClient({ token: "not-the-token", guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() }).rest, FAKE_DISCORD.guildId)
    const now = new Date()
    for (let i = 0; i < 3; i++) table.rows.push(postRow({ id: `p${i}`, channelId: CHANNEL, content: body(`post ${i}`), scheduledFor: new Date(now.getTime() - (10 - i) * 1000) }))
    await expect(sendDuePosts(writer, { now, deadline: Date.now() + 60_000, log: () => {}, check: async () => null, pause: noPause })).rejects.toThrow(/refused the bot's token.*the other due posts wait/)
    expect(table.rows.map((r) => r.status)).toEqual(["FAILED", "SCHEDULED", "SCHEDULED"])
    expect(posts(fakes)).toHaveLength(1)
  })

  it("sends the text the post holds when it's claimed, not the copy read at the start of the run", async () => {
    const { fakes, writer } = setup()
    const now = new Date()
    table.rows.push(postRow({ id: "reminder", channelId: CHANNEL, content: body("GM 2 is in room 1.100"), nonce: "n-reminder", scheduledFor: new Date(now.getTime() - 30_000) }))
    // A rules run refreshes the reminder (the venue changed) after this run read it, before it claims it
    const check = async (post: { id: string }) => {
      await table.updateMany({ where: { id: post.id, status: "SCHEDULED" }, data: { content: body("GM 2 is in room 2.200") } })
      return null
    }
    expect((await sendDuePosts(writer, { now, deadline: Date.now() + 60_000, log: () => {}, check, pause: noPause })).sent).toBe(1)
    expect(posts(fakes).map((r) => JSON.parse(r.body).content)).toEqual(["GM 2 is in room 2.200"])
    expect(table.rows[0]).toMatchObject({ status: "SENT", content: body("GM 2 is in room 2.200") })
  })

  it("sends at most 10 a run, oldest first", async () => {
    const { fakes, writer } = setup()
    const now = new Date()
    for (let i = 0; i < 12; i++) table.rows.push(postRow({ id: `p${i}`, channelId: CHANNEL, content: body(`post ${i}`), nonce: `n${i}`, scheduledFor: new Date(now.getTime() - (20 - i) * 1000) }))
    const run = await sendDuePosts(writer, { now, deadline: Date.now() + 60_000, log: () => {}, check: async () => null, pause: noPause })
    expect(run.sent).toBe(10)
    expect(posts(fakes).map((r) => JSON.parse(r.body).content)).toEqual(Array.from({ length: 10 }, (_, i) => `post ${i}`))
  })
})
