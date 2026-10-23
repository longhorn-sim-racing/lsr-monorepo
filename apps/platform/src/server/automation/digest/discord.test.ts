import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakePostTable, postRow, type FakePostTable } from "@/server/discord-post/fake-posts"

const db = vi.hoisted(() => ({ prisma: { discordPost: null as unknown as FakePostTable } }))
vi.mock("@/server/db", () => db)
const channels = vi.hoisted(() => ({ postingChannelIds: vi.fn() }))
vi.mock("@/server/discord-post/channels", () => channels)

import { discordClient } from "@/server/connectors/discord/client"
import { FAKE_CHANNELS, FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { DiscordRateLimiter } from "@/server/connectors/discord/rate-limit"
import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { postNonce, UNCONFIRMED_SEND } from "@/server/discord-post/outbox"
import { EARLIER_SEND_UNCONFIRMED, NOT_A_POSTING_CHANNEL, sendDigestToDiscord } from "./discord"

/**
 * The digest's Discord copy goes through the real outbox (an in-memory DiscordPost table) to the Discord
 * HTTP fake, so these check what reaches Discord, not just which functions were called
 */

const CHANNEL = FAKE_CHANNELS.announcements
const OTHER = FAKE_CHANNELS.general
const KEY = "digest:2026-10-26"
const input = (overrides: Partial<Parameters<typeof sendDigestToDiscord>[0]> = {}) => ({
  channelId: CHANNEL,
  body: { content: "Weekly digest: 3 things need attention <https://www.longhornsimracing.org/admin>", allowed_mentions: { parse: ["everyone" as const] } },
  dedupeKey: KEY,
  createdById: "officer-gray",
  ...overrides,
})

let table: FakePostTable
let fakes: MountedFakes

beforeEach(() => {
  table = fakePostTable()
  db.prisma.discordPost = table
  channels.postingChannelIds.mockResolvedValue([CHANNEL, OTHER])
  fakes = mountFakes([discordFake])
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fresh client each time, as each run builds its own (its rate limiter starts empty) */
const client = () => discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter(), maxWaitMs: 200 })
const sends = (channel = CHANNEL) => fakes.requests.filter((r) => r.method === "POST" && r.path.endsWith(`/channels/${channel}/messages`))
const hook = (path: string, payload: unknown) => fetch(`${fakes.origin}/discord/_fake/${path}`, { method: "POST", body: JSON.stringify(payload) })
/** The day's post, already in the outbox from an earlier run */
const earlier = (fields: Parameters<typeof postRow>[0]) => table.rows.push(postRow({ id: "post-0", source: "digest", channelId: CHANNEL, dedupeKey: KEY, nonce: postNonce("post-0"), content: { content: "Earlier text", allowed_mentions: { parse: [] } }, ...fields }))

describe("the digest's Discord copy", () => {
  it("goes out once a day as a digest post that pings nobody, through Discord posting", async () => {
    const sent = await sendDigestToDiscord(input(), client())
    expect(sent).toMatchObject({ status: "sent", postId: table.rows[0].id })
    expect(table.rows[0]).toMatchObject({ source: "digest", channelId: CHANNEL, dedupeKey: KEY, status: "SENT", createdById: "officer-gray", approvedById: "officer-gray" })
    const [request] = sends()
    expect(JSON.parse(request.body)).toMatchObject({ content: input().body.content, allowed_mentions: { parse: [] }, nonce: table.rows[0].nonce, enforce_nonce: true })

    expect(await sendDigestToDiscord(input(), client())).toMatchObject({ status: "already_sent", postId: table.rows[0].id })
    expect(sends()).toHaveLength(1)
  })

  it("posts only to a posting channel: one taken off the list, or a cleared list, stops it before anything is queued", async () => {
    channels.postingChannelIds.mockResolvedValue([OTHER])
    await expect(sendDigestToDiscord(input(), client())).rejects.toThrow(NOT_A_POSTING_CHANNEL)
    channels.postingChannelIds.mockResolvedValue([])
    await expect(sendDigestToDiscord(input(), client())).rejects.toThrow(NOT_A_POSTING_CHANNEL)
    expect(table.rows).toHaveLength(0)
    expect(fakes.requests.filter((r) => r.method === "POST")).toHaveLength(0)

    // An earlier try's post isn't sent either once its channel left the list
    earlier({ status: "SCHEDULED", error: "Discord rate-limited the bot (30 s); it goes out on the next run." })
    await expect(sendDigestToDiscord(input(), client())).rejects.toThrow(NOT_A_POSTING_CHANNEL)
    expect(table.rows[0].status).toBe("SCHEDULED")
    expect(sends()).toHaveLength(0)
  })

  it("never sends again a post whose send Discord didn't confirm: it may be in the channel, so an officer looks first", async () => {
    for (const error of [
      `${UNCONFIRMED_SEND} (the connection dropped), and the message isn't in the channel. Check the channel, then retry it from Announcements.`,
      `${UNCONFIRMED_SEND} (the connection dropped), and the channel couldn't be read to check (Discord answered 500). Check the channel before retrying it from Announcements.`,
    ]) {
      table.rows.length = 0
      earlier({ status: "FAILED", error })
      await expect(sendDigestToDiscord(input({ body: { content: "Newer text", allowed_mentions: { parse: [] } } }), client())).rejects.toThrow(EARLIER_SEND_UNCONFIRMED)
      expect(table.rows[0]).toMatchObject({ status: "FAILED", error, content: { content: "Earlier text" } })
    }
    expect(sends()).toHaveLength(0)
  })

  it("sends again, with this run's text and channel, a post Discord refused (nothing was posted)", async () => {
    await hook("fail", { path: "/messages", method: "POST", status: 403, code: 50013, message: "Missing Permissions", times: 1 })
    await expect(sendDigestToDiscord(input(), client())).rejects.toThrow(/isn't allowed to post/)
    expect(table.rows[0].status).toBe("FAILED")

    const again = await sendDigestToDiscord(input({ channelId: OTHER, body: { content: "Newer text", allowed_mentions: { parse: [] } } }), client())
    expect(again).toMatchObject({ status: "sent", postId: table.rows[0].id })
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]).toMatchObject({ status: "SENT", channelId: OTHER, error: null })
    expect(sends(OTHER).map((r) => JSON.parse(r.body).content)).toEqual(["Newer text"])
  })

  it("leaves a post Discord rate-limited to the posts job, and the next run sends it with its own text", async () => {
    await hook("rate-limit", { times: 1, retryAfter: 30, path: "/messages" })
    expect(await sendDigestToDiscord(input(), client())).toMatchObject({ status: "waiting", reason: expect.stringMatching(/rate-limited/) })
    expect(table.rows[0]).toMatchObject({ status: "SCHEDULED", claimedAt: null })

    expect(await sendDigestToDiscord(input({ body: { content: "Newer text", allowed_mentions: { parse: [] } } }), client())).toMatchObject({ status: "sent" })
    expect(sends().map((r) => JSON.parse(r.body).content).filter((text) => text === "Newer text")).toHaveLength(1)
  })

  it("says so when today's post was cancelled on Announcements, or another run is still sending it, and sends nothing", async () => {
    earlier({ status: "CANCELLED", error: "Cancelled by Dylan." })
    expect(await sendDigestToDiscord(input(), client())).toEqual({ status: "cancelled", postId: "post-0", reason: "Cancelled by Dylan" })
    table.rows.length = 0
    earlier({ status: "SENDING", claimedAt: new Date() })
    expect(await sendDigestToDiscord(input(), client())).toMatchObject({ status: "waiting", reason: expect.stringMatching(/still sending/) })
    expect(sends()).toHaveLength(0)
  })

  it("throws a failed send to the job (the post keeps the error)", async () => {
    await hook("fail", { path: "/messages", method: "POST", status: 403, code: 50001, message: "Missing Access", times: 1 })
    await expect(sendDigestToDiscord(input(), client())).rejects.toThrow(/can't see/)
    expect(table.rows[0]).toMatchObject({ status: "FAILED", error: expect.stringMatching(/Missing Access/) })
  })
})
