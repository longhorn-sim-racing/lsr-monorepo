import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DiscordRule } from "@prisma/client"
import { fakePostTable } from "@/server/discord-post/fake-posts"

const state = vi.hoisted(() => ({ rules: [] as unknown[], officerTexts: [] as string[], audits: [] as Record<string, unknown>[] }))
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
    const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() })
    return { client, writer: discordWriter(client.rest, client.guildId) }
  }
  return { NOT_CONNECTED: "Discord isn't connected.", discordPosting: async () => posting(), discordPostingForPage: async () => posting() }
})

import { mountFakes } from "@/server/connectors/fakes/testing"
import { FAKE_CHANNELS, FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { discordRuleKind, discordRuleSchema, type DiscordRuleProposal } from "./rule"

const CHANNEL = FAKE_CHANNELS.announcements
const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const applyCtx = (before: unknown): ProposalApplyContext => ({ officer: { userId: "admin-1", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: { via: "jack", proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" } })
const proposal = (p: Partial<DiscordRuleProposal>) => discordRuleSchema.parse({ type: "event_reminder", channel: "announcements", offsets: [1440, 60], ...p }) as DiscordRuleProposal
const rules = () => state.rules as DiscordRule[]

beforeEach(() => {
  mountFakes([discordFake])
  Object.assign(state, { rules: [], officerTexts: ["Set up reminders a day and an hour before events in announcements"], audits: [] })
  db.prisma = {
    discordPost: fakePostTable(),
    jackMessage: { findMany: async () => state.officerTexts.map((content) => ({ content })) },
    systemSetting: { findUnique: async () => ({ value: JSON.stringify({ channels: [CHANNEL] }) }) },
    discordChannel: { findMany: async () => [{ id: CHANNEL, name: "announcements", type: 5 }] },
    eventSeries: { findUnique: async () => null },
    discordRule: {
      count: async ({ where }: { where: { kind: string } }) => rules().filter((r) => r.kind === where.kind).length,
      findUnique: async ({ where }: { where: { id: string } }) => rules().find((r) => r.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rules().find((r) => r.id === where.id)!,
      create: async ({ data }: { data: Partial<DiscordRule> }) => {
        const rule = { id: `rule-${rules().length + 1}`, createdAt: new Date(), updatedAt: new Date("2026-10-23T12:00:00Z"), ...data } as DiscordRule
        rules().push(rule)
        return rule
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<DiscordRule> }) => Object.assign(rules().find((r) => r.id === where.id)!, data),
      updateMany: async ({ where, data }: { where: { id: string; updatedAt?: Date }; data: Partial<DiscordRule> }) => {
        const rule = rules().find((r) => r.id === where.id && (!where.updatedAt || r.updatedAt.getTime() === where.updatedAt.getTime()))
        if (rule) Object.assign(rule, data, { updatedAt: new Date(rule.updatedAt.getTime() + 1000) })
        return { count: rule ? 1 : 0 }
      },
    },
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("discord.rule", () => {
  it("is an admin kind on propose_discord", () => {
    expect(discordRuleKind).toMatchObject({ kind: "discord.rule", tool: "propose_discord", permission: "admin" })
    expect(discordRuleKind.destructive).toBeUndefined()
  })

  it("describes a new rule on the server, switched on when applied unless it says otherwise", async () => {
    const prepared = await discordRuleKind.prepare(proposal({}), ctx)
    expect(prepared.view.title).toBe("Set up a Discord rule: Event reminders in #announcements, 1 day and 1 hour before, no ping")
    expect(prepared.view.summary).toMatch(/^Applying it creates the rule and switches it on\. .*Only an admin can apply it\.$/)
    expect(prepared.targetId).toBe(`new:event_reminder:${CHANNEL}`)
    expect(prepared.before).toMatchObject({ ruleId: null, kind: "event_reminder", channelId: CHANNEL, enabled: true, config: { offsets: [1440, 60] } })
    const off = await discordRuleKind.prepare(proposal({ enabled: false }), ctx)
    expect(off.view.diff.find((d) => d.field === "enabled")?.after).toBe("Off (an admin switches it on)")
  })

  it("needs a posting channel, an officer's ask for a ping, and never pings @everyone", async () => {
    await expect(discordRuleKind.prepare(proposal({ channel: "general" }), ctx)).rejects.toThrow(/#general isn't a posting channel/)
    await expect(discordRuleKind.prepare(proposal({ channel: undefined }), ctx)).rejects.toThrow(/Give the channel/)
    await expect(discordRuleKind.prepare(proposal({ ping: "LSC Driver" }), ctx)).rejects.toThrow(/No officer asked for a ping/)
    await expect(discordRuleKind.prepare(proposal({ ping: "everyone" }), ctx)).rejects.toThrow(/can't ping @everyone/)
    state.officerTexts = ["Remind people before races and tag LSC Driver"]
    const prepared = await discordRuleKind.prepare(proposal({ ping: "LSC Driver" }), ctx)
    expect(prepared.before).toMatchObject({ config: { ping: { type: "role", roleId: FAKE_DISCORD.roles.lscDriver, name: "LSC Driver" } } })
    await expect(discordRuleKind.prepare(proposal({ type: "event_mirror", channel: undefined, ping: "LSC Driver" }), ctx)).rejects.toThrow(/doesn't post, so it can't ping/)
  })

  it("creates the rule on apply, as the applying admin, linked back to the proposal", async () => {
    const prepared = await discordRuleKind.prepare(proposal({}), ctx)
    const result = await discordRuleKind.apply(proposal({}), applyCtx(prepared.before))
    expect(result.summary).toBe("Set up the Discord rule “Event reminders in #announcements, 1 day and 1 hour before, no ping”, switched on.")
    expect(rules()).toEqual([expect.objectContaining({ kind: "event_reminder", channelId: CHANNEL, enabled: true, createdById: "admin-1" })])
    expect(state.audits[0]).toMatchObject({ actorUserId: "admin-1", entityType: "DISCORD_RULE", metadata: expect.objectContaining({ via: "jack", proposalId: "prop-1" }) })
  })

  it("changes an existing rule only if nobody changed it since, and keeps its kind", async () => {
    await discordRuleKind.apply(proposal({}), applyCtx((await discordRuleKind.prepare(proposal({}), ctx)).before))
    const id = rules()[0].id
    await expect(discordRuleKind.prepare(proposal({ ruleId: id, type: "new_event" }), ctx)).rejects.toThrow(/its type can't change/)
    const edit = await discordRuleKind.prepare(proposal({ ruleId: id, offsets: [60], enabled: false }), ctx)
    expect(edit.targetId).toBe(id)
    expect(edit.view.diff.map((d) => [d.field, d.before, d.after])).toEqual([
      ["rule", "Event reminders in #announcements, 1 day and 1 hour before, no ping", "Event reminders in #announcements, 1 hour before, no ping"],
      ["enabled", "On", "Off"],
    ])
    expect(await discordRuleKind.checkStale(proposal({ ruleId: id }), edit.before)).toBeNull()
    // Someone edits the rule first
    rules()[0].updatedAt = new Date("2026-10-23T13:00:00Z")
    expect(await discordRuleKind.checkStale(proposal({ ruleId: id }), edit.before)).toBe("Someone changed the rule since this was proposed.")
    await expect(discordRuleKind.apply(proposal({ ruleId: id }), applyCtx(edit.before))).rejects.toBeInstanceOf(StaleProposalError)
  })

  it("applies an edit and its switch together", async () => {
    await discordRuleKind.apply(proposal({}), applyCtx((await discordRuleKind.prepare(proposal({}), ctx)).before))
    const id = rules()[0].id
    const edit = await discordRuleKind.prepare(proposal({ ruleId: id, offsets: [60], enabled: false }), ctx)
    const result = await discordRuleKind.apply(proposal({ ruleId: id }), applyCtx(edit.before))
    expect(result.summary).toMatch(/^Changed the Discord rule .* and switched it off\.$/)
    expect(rules()[0]).toMatchObject({ enabled: false, config: { offsets: [60] } })
  })
})
