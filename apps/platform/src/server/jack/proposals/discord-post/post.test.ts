import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakePostTable, type FakePostTable } from "@/server/discord-post/fake-posts"

const state = vi.hoisted(() => ({
  officerTexts: [] as string[],
  posting: [] as string[],
  connected: true,
  audits: [] as Record<string, unknown>[],
}))
const db = vi.hoisted(() => ({ prisma: {} as Record<string, unknown> }))
vi.mock("@/server/db", () => db)
vi.mock("@/server/audit/log", () => ({ createAuditLog: async (entry: Record<string, unknown>) => void state.audits.push(entry) }))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/server/discord-post/connection", async () => {
  const { discordClient } = await import("@/server/connectors/discord/client")
  const { discordWriter } = await import("@/server/connectors/discord/write")
  const { DiscordRateLimiter } = await import("@/server/connectors/discord/rate-limit")
  const { FAKE_DISCORD } = await import("@/server/connectors/discord/fake/data")
  const posting = () => {
    if (!state.connected) return null
    const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() })
    return { client, writer: discordWriter(client.rest, client.guildId) }
  }
  return { NOT_CONNECTED: "Discord isn't connected.", discordPosting: async () => posting(), discordPostingForPage: async () => posting() }
})

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { FAKE_CHANNELS, FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { discordPostKind, discordPostSchema, type DiscordPostProposal } from "./post"

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const applyCtx = (before: unknown): ProposalApplyContext => ({
  officer: { userId: "u2", displayName: "Gray" },
  proposalId: "prop-1",
  roomId: "room-1",
  idempotencyKey: "proposal:prop-1",
  before,
  auditMetadata: { via: "jack", proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" },
})
const proposal = (p: Partial<DiscordPostProposal>) => discordPostSchema.parse({ channel: "announcements", text: "GM 2 is Monday at 6 in the lounge.", ...p }) as DiscordPostProposal

let posts: FakePostTable
let fakes: MountedFakes
const channels = [
  { id: FAKE_CHANNELS.announcements, name: "announcements", type: 5, parentId: null },
  { id: FAKE_CHANNELS.general, name: "general", type: 0, parentId: null },
]

beforeEach(() => {
  fakes = mountFakes([discordFake])
  vi.stubEnv("DISCORD_GUILD_ID", FAKE_DISCORD.guildId)
  posts = fakePostTable()
  Object.assign(state, { officerTexts: ["Can you announce GM 2 in announcements?"], posting: [FAKE_CHANNELS.announcements], connected: true, audits: [] })
  db.prisma = {
    discordPost: posts,
    jackMessage: { findMany: async () => state.officerTexts.map((content) => ({ content })) },
    systemSetting: { findUnique: async () => ({ value: JSON.stringify({ channels: state.posting }) }) },
    discordChannel: { findMany: async ({ where }: { where: { id?: { in: string[] } } }) => channels.filter((c) => !where.id || where.id.in.includes(c.id)) },
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const botPosts = () => fakes.requests.filter((r) => r.method === "POST" && /\/channels\/\d+\/messages$/.test(r.path))

describe("discord.post", () => {
  it("is a destructive officer kind on propose_discord", () => {
    expect(discordPostKind).toMatchObject({ kind: "discord.post", tool: "propose_discord", permission: "officer", destructive: true })
    expect(discordPostSchema.safeParse({ channel: "announcements" }).success).toBe(false)
  })

  it("only posts in a posting channel, and says which they are", async () => {
    await expect(discordPostKind.prepare(proposal({ channel: "#general" }), ctx)).rejects.toThrow(/#general isn't a posting channel\. Posting channels: #announcements/)
    state.connected = false
    await expect(discordPostKind.prepare(proposal({}), ctx)).rejects.toThrow(/Discord isn't connected/)
  })

  it("takes out mentions and outside links no officer's message has, keeps the officer's and the site's, and shows the exact message", async () => {
    state.officerTexts = ["Post about GM 2, sign-ups at https://forms.example/gm2"]
    const prepared = await discordPostKind.prepare(
      proposal({ text: "@everyone GM 2 is Monday! Sign up: https://forms.example/gm2 Details: https://www.longhornsimracing.org/events/gm-2 Win [prizes](https://claim.example/x) <@&123456789012345678>" }),
      ctx,
    )
    const before = prepared.before as { body: { content: string; allowed_mentions: unknown }; channelId: string }
    expect(before.channelId).toBe(FAKE_CHANNELS.announcements)
    expect(before.body.content).toBe("everyone GM 2 is Monday! Sign up: https://forms.example/gm2 Details: https://www.longhornsimracing.org/events/gm-2 Win prizes")
    expect(before.body.allowed_mentions).toEqual({ parse: [] })
    expect(prepared.view.summary).toMatch(/pings nobody/)
    expect(prepared.view.summary).toMatch(/Taken out because no officer's message in this room has them: 1 link \(claim\.example\) and 2 mentions/)
    expect(prepared.view.title).toBe("Post in #announcements")
    expect(prepared.targetId).toBe(`channel:${FAKE_CHANNELS.announcements}`)
    // The card lists the officer's outside link with its host
    expect(prepared.view.links).toEqual([{ title: "A link in the post", url: "https://forms.example/gm2" }, { title: "Announcements", url: "/admin/announcements" }])
    expect(prepared.view.preview?.blocks[0]).toMatchObject({ t: "p" })
  })

  it("pings only when an officer asked, only what the bot may ping", async () => {
    await expect(discordPostKind.prepare(proposal({ ping: "LSC Driver" }), ctx)).rejects.toThrow(/No officer asked for a ping of @LSC Driver/)
    state.officerTexts = ["Announce GM 2 and ping the LSC drivers"]
    const prepared = await discordPostKind.prepare(proposal({ ping: "LSC Driver" }), ctx)
    const body = (prepared.before as { body: { content: string; allowed_mentions: unknown } }).body
    expect(body.content).toBe(`<@&${FAKE_DISCORD.roles.lscDriver}> GM 2 is Monday at 6 in the lounge.`)
    expect(body.allowed_mentions).toEqual({ parse: [], roles: [FAKE_DISCORD.roles.lscDriver] })
    expect(prepared.view.title).toBe("Post in #announcements, pinging @LSC Driver")
    // The bot has no Mention @everyone, and Member isn't pingable
    state.officerTexts = ["ping @everyone about GM 2", "and ping Member too"]
    await expect(discordPostKind.prepare(proposal({ ping: "everyone" }), ctx)).rejects.toThrow(/can't ping @everyone/)
    await expect(discordPostKind.prepare(proposal({ ping: "Member" }), ctx)).rejects.toThrow(/can't be pinged by the bot/)
    await expect(discordPostKind.prepare(proposal({ ping: "Nobody" }), ctx)).rejects.toThrow(/no role called @Nobody/)
  })

  it("schedules for a Central time in the future only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-23T17:00:00Z"))
    try {
      await expect(discordPostKind.prepare(proposal({ sendAt: "2026-10-23T10:00" }), ctx)).rejects.toThrow(/has passed/)
      const prepared = await discordPostKind.prepare(proposal({ sendAt: "2026-10-26T18:00" }), ctx)
      expect(prepared.view.summary).toMatch(/at Mon Oct 26, 6:00 PM CT./)
      expect((prepared.before as { sendAt: string }).sendAt).toBe("2026-10-26T23:00:00.000Z")
    } finally {
      vi.useRealTimers()
    }
  })

  it("posts exactly what the card showed, once, with the proposal's key; applying again posts nothing", async () => {
    const prepared = await discordPostKind.prepare(proposal({}), ctx)
    const result = await discordPostKind.apply(proposal({ text: "something else entirely" }), applyCtx(prepared.before))
    expect(result.summary).toBe("Posted in #announcements.")
    expect(result.links?.[1]).toMatchObject({ title: "The post in Discord", url: expect.stringMatching(new RegExp(`^https://discord\\.com/channels/${FAKE_DISCORD.guildId}/${FAKE_CHANNELS.announcements}/\\d+$`)) })
    expect(posts.rows).toEqual([expect.objectContaining({ source: "proposal", proposalId: "prop-1", dedupeKey: "proposal:prop-1", createdById: "u1", approvedById: "u2", status: "SENT" })])
    expect(JSON.parse(botPosts()[0].body).content).toBe("GM 2 is Monday at 6 in the lounge.")
    expect(state.audits[0]).toMatchObject({ actorUserId: "u2", entityType: "DISCORD_POST", metadata: expect.objectContaining({ via: "jack", proposalId: "prop-1" }) })

    const again = await discordPostKind.apply(proposal({}), applyCtx(prepared.before))
    expect(again.summary).toMatch(/Already posted/)
    expect(botPosts()).toHaveLength(1)
  })

  it("schedules a timed post for the posts job instead of sending it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-23T17:00:00Z"))
    try {
      const prepared = await discordPostKind.prepare(proposal({ sendAt: "2026-10-26T18:00" }), ctx)
      const result = await discordPostKind.apply(proposal({}), applyCtx(prepared.before))
      expect(result.summary).toMatch(/^Scheduled for Mon Oct 26/)
      expect(posts.rows[0]).toMatchObject({ status: "SCHEDULED", scheduledFor: new Date("2026-10-26T23:00:00Z") })
      expect(botPosts()).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails when Discord refuses it, goes stale when the channel stops being a posting channel", async () => {
    const prepared = await discordPostKind.prepare(proposal({}), ctx)
    await fetch(`${fakes.origin}/discord/_fake/fail`, { method: "POST", body: JSON.stringify({ path: "/messages", method: "POST", status: 403, code: 50013, message: "Missing Permissions" }) })
    await expect(discordPostKind.apply(proposal({}), { ...applyCtx(prepared.before), proposalId: "prop-2", idempotencyKey: "proposal:prop-2" })).rejects.toThrow(/Couldn't post it: The bot isn't allowed to post/)
    expect(await discordPostKind.checkStale(proposal({}), prepared.before)).toBeNull()
    state.posting = []
    expect(await discordPostKind.checkStale(proposal({}), prepared.before)).toBe("#announcements isn't a posting channel anymore.")
    await expect(discordPostKind.apply(proposal({}), applyCtx({ broken: true }))).rejects.toBeInstanceOf(StaleProposalError)
  })

  it("refuses a post that would be empty once the outside bits are out", async () => {
    state.officerTexts = ["post something"]
    await expect(discordPostKind.prepare(proposal({ text: "https://claim.example/x" }), ctx)).rejects.toBeInstanceOf(ProposalInputError)
  })
})
