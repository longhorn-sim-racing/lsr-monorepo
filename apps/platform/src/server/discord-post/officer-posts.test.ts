import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakePostTable, postRow, type FakePostTable } from "./fake-posts"

const state = vi.hoisted(() => ({ audits: [] as Record<string, unknown>[], posting: [] as string[] }))
const db = vi.hoisted(() => ({ prisma: {} as Record<string, unknown> }))
vi.mock("@/server/db", () => db)
vi.mock("@/server/audit/log", () => ({ createAuditLog: async (entry: Record<string, unknown>) => void state.audits.push(entry) }))

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { discordClient } from "@/server/connectors/discord/client"
import { FAKE_CHANNELS, FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { DiscordRateLimiter } from "@/server/connectors/discord/rate-limit"
import { discordWriter } from "@/server/connectors/discord/write"
import { cancelScheduledPost, createOfficerPost, retryFailedPost } from "./officer-posts"

const CHANNEL = FAKE_CHANNELS.announcements
const actor = { userId: "u1", displayName: "Ana" }
let posts: FakePostTable
let fakes: MountedFakes
let posting: { client: ReturnType<typeof discordClient>; writer: ReturnType<typeof discordWriter> }

beforeEach(() => {
  fakes = mountFakes([discordFake])
  const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() })
  posting = { client, writer: discordWriter(client.rest, client.guildId) }
  posts = fakePostTable()
  Object.assign(state, { audits: [], posting: [CHANNEL] })
  db.prisma = {
    discordPost: posts,
    systemSetting: { findUnique: async () => ({ value: JSON.stringify({ channels: state.posting }) }) },
    discordChannel: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => [{ id: CHANNEL, name: "announcements", type: 5 }].filter((c) => where.id.in.includes(c.id)) },
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const sent = () => fakes.requests.filter((r) => r.method === "POST" && r.path.endsWith("/messages")).map((r) => JSON.parse(r.body))

describe("an officer's own post", () => {
  it("goes as typed, now, and pings nobody unless a ping is picked", async () => {
    const result = await createOfficerPost({ channelId: CHANNEL, text: "Hey @everyone, GM at 6 https://forms.example/x" }, actor, posting)
    expect(result).toMatchObject({ ok: true, status: "SENT", summary: "Posted in #announcements." })
    expect(sent()[0]).toMatchObject({ content: "Hey @everyone, GM at 6 https://forms.example/x", allowed_mentions: { parse: [] } })
    expect(posts.rows[0]).toMatchObject({ source: "admin", createdById: "u1", approvedById: "u1", status: "SENT" })
    expect(state.audits[0]).toMatchObject({ actorUserId: "u1", actionType: "CREATE", entityType: "DISCORD_POST" })
  })

  it("pings a role the bot may ping", async () => {
    await createOfficerPost({ channelId: CHANNEL, text: "Practice tonight", ping: FAKE_DISCORD.roles.lscDriver }, actor, posting)
    expect(sent()[0]).toMatchObject({ content: `<@&${FAKE_DISCORD.roles.lscDriver}> Practice tonight`, allowed_mentions: { parse: [], roles: [FAKE_DISCORD.roles.lscDriver] } })
    expect(await createOfficerPost({ channelId: CHANNEL, text: "x", ping: "everyone" }, actor, posting)).toMatchObject({ ok: false, error: expect.stringMatching(/can't ping @everyone/) })
  })

  it("is scheduled for a Central time, and needs a posting channel", async () => {
    const at = new Date(Date.now() + 3 * 86_400_000)
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(at).replace(" ", "T")
    expect(await createOfficerPost({ channelId: CHANNEL, text: "Later", sendAt: local }, actor, posting)).toMatchObject({ ok: true, status: "SCHEDULED" })
    expect(sent()).toHaveLength(0)
    expect(await createOfficerPost({ channelId: FAKE_CHANNELS.general, text: "x" }, actor, posting)).toMatchObject({ ok: false, error: expect.stringMatching(/Pick a posting channel/) })
    expect(await createOfficerPost({ channelId: CHANNEL }, actor, posting)).toMatchObject({ ok: false })
  })
})

describe("what any officer can do to a post", () => {
  it("cancel a scheduled one (a rule won't make it again), or nothing once it's gone", async () => {
    posts.rows.push(postRow({ id: "p1", dedupeKey: "new_event:r:e", scheduledFor: new Date(Date.now() + 60_000) }))
    expect(await cancelScheduledPost("p1", actor)).toEqual({ ok: true })
    expect(posts.rows[0]).toMatchObject({ status: "CANCELLED", dedupeKey: "new_event:r:e", error: "Cancelled by Ana." })
    expect(await cancelScheduledPost("p1", actor)).toMatchObject({ ok: false })
  })

  it("send a failed one again with the same nonce, so a repeat within Discord's window is caught", async () => {
    const first = await posting.writer.createMessage(CHANNEL, { content: "Retry me", allowed_mentions: { parse: [] } }, "same-nonce")
    posts.rows.push(postRow({ id: "p2", channelId: CHANNEL, status: "FAILED", nonce: "same-nonce", content: { content: "Retry me", allowed_mentions: { parse: [] } }, error: "Discord didn't confirm" }))
    const result = await retryFailedPost("p2", actor, posting)
    expect(result).toMatchObject({ ok: true, status: "SENT" })
    expect(posts.rows[0]).toMatchObject({ status: "SENT", discordMessageId: first.id })
    expect(state.audits.at(-1)).toMatchObject({ actionType: "RETRY" })
  })
})
