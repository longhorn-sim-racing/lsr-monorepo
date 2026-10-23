import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DiscordRule } from "@prisma/client"
import { fakePostTable, postRow, type FakePostTable } from "./fake-posts"

const state = vi.hoisted(() => ({ rules: [] as unknown[], posting: ["1100000000000000001"], series: ["lsc"], audits: [] as Record<string, unknown>[] }))
const db = vi.hoisted(() => ({ prisma: {} as Record<string, unknown> }))
vi.mock("@/server/db", () => db)
vi.mock("@/server/audit/log", () => ({ createAuditLog: async (entry: Record<string, unknown>) => void state.audits.push(entry) }))

import { createRule, deleteRule, describeRule, readRuleConfig, setRuleEnabled, updateRule, validateRule } from "./rules"

const CHANNEL = "1100000000000000001"
const rules = () => state.rules as DiscordRule[]
let posts: FakePostTable

beforeEach(() => {
  posts = fakePostTable()
  Object.assign(state, { rules: [], posting: [CHANNEL], series: ["lsc"], audits: [] })
  db.prisma = {
    discordPost: posts,
    systemSetting: { findUnique: async () => ({ value: JSON.stringify({ channels: state.posting }) }) },
    discordChannel: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => [{ id: CHANNEL, name: "announcements", type: 5 }].filter((c) => where.id.in.includes(c.id)) },
    eventSeries: { findUnique: async ({ where }: { where: { slug: string } }) => (state.series.includes(where.slug) ? { id: `series-${where.slug}` } : null) },
    discordRule: {
      count: async ({ where }: { where: { kind: string } }) => rules().filter((r) => r.kind === where.kind).length,
      findUnique: async ({ where }: { where: { id: string } }) => rules().find((r) => r.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rules().find((r) => r.id === where.id)!,
      create: async ({ data }: { data: Partial<DiscordRule> }) => {
        const rule = { id: `rule-${rules().length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data } as DiscordRule
        rules().push(rule)
        return rule
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<DiscordRule> }) => Object.assign(rules().find((r) => r.id === where.id)!, data, { updatedAt: new Date() }),
      updateMany: async ({ where, data }: { where: { id: string; updatedAt?: Date }; data: Partial<DiscordRule> }) => {
        const rule = rules().find((r) => r.id === where.id && (!where.updatedAt || r.updatedAt.getTime() === where.updatedAt.getTime()))
        if (rule) Object.assign(rule, data, { updatedAt: new Date(rule.updatedAt.getTime() + 1) })
        return { count: rule ? 1 : 0 }
      },
      delete: async ({ where }: { where: { id: string } }) => {
        state.rules = rules().filter((r) => r.id !== where.id)
      },
    },
  }
})

const admin = { userId: "admin-1" }

describe("validating a rule", () => {
  it("checks the kind, the config, the posting channel and the series", async () => {
    expect(await validateRule({ kind: "spam", channelId: CHANNEL, config: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/no rule kind "spam"/) })
    expect(await validateRule({ kind: "event_reminder", channelId: CHANNEL, config: { offsets: [] } })).toMatchObject({ ok: false, error: expect.stringMatching(/^offsets:/) })
    expect(await validateRule({ kind: "event_reminder", channelId: CHANNEL, config: { offsets: [5] } })).toMatchObject({ ok: false })
    expect(await validateRule({ kind: "new_event", channelId: "1100000000000000999", config: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/Pick a posting channel: #announcements/) })
    expect(await validateRule({ kind: "new_event", channelId: CHANNEL, config: { series: "gm" } })).toMatchObject({ ok: false, error: expect.stringMatching(/no event series "gm"/) })
    // Rules ping a role at most, never @everyone
    expect(await validateRule({ kind: "new_event", channelId: CHANNEL, config: { ping: { type: "everyone" } } })).toMatchObject({ ok: false })
    const ok = await validateRule({ kind: "event_reminder", channelId: CHANNEL, config: { offsets: [60, 1440, 60], series: "lsc" } })
    expect(ok).toMatchObject({ ok: true, rule: { kind: "event_reminder", channelId: CHANNEL, config: { offsets: [1440, 60], series: "lsc" } } })
    // The event mirror has no channel
    expect(await validateRule({ kind: "event_mirror", channelId: CHANNEL, config: {} })).toMatchObject({ ok: true, rule: { channelId: null } })
  })

  it("describes a rule in a line", () => {
    expect(describeRule({ kind: "event_reminder", channelId: CHANNEL, config: { offsets: [1440, 60], ping: { type: "role", roleId: "223456789012345678", name: "LSC Driver" } } }, { channels: new Map([[CHANNEL, "announcements"]]) })).toBe(
      "Event reminders in #announcements, 1 day and 1 hour before, pinging @LSC Driver",
    )
    expect(describeRule({ kind: "standings_update", channelId: CHANNEL, config: {} })).toBe(`Standings updates in #${CHANNEL}, top 5, no ping`)
    expect(describeRule({ kind: "event_reminder", channelId: CHANNEL, config: { offsets: "soon" } })).toMatch(/can't be read/)
    expect(readRuleConfig("twitch_live", { ping: null })).toEqual({ ping: null })
  })
})

describe("the rules service", () => {
  it("creates a rule acting from now, audited, with one event mirror at most", async () => {
    const created = await createRule({ kind: "new_event", channelId: CHANNEL, config: {} }, admin, { enabled: true, now: new Date("2026-10-23T17:00:00Z") })
    expect(created).toMatchObject({ ok: true, rule: { kind: "new_event", enabled: true, cutoffAt: new Date("2026-10-23T17:00:00Z"), createdById: "admin-1" } })
    expect(state.audits[0]).toMatchObject({ actorUserId: "admin-1", actionType: "CREATE", entityType: "DISCORD_RULE", summary: "Created the Discord rule “New events in #announcements, no ping”, switched on" })
    await createRule({ kind: "event_mirror", channelId: null, config: {} }, admin, { enabled: false })
    expect(await createRule({ kind: "event_mirror", channelId: null, config: {} }, admin, { enabled: false })).toMatchObject({ ok: false, error: expect.stringMatching(/already an event mirror/) })
  })

  it("switching on moves the cutoff to now; pausing cancels the scheduled posts (their keys freed, so switching on again brings them back)", async () => {
    const { rule } = (await createRule({ kind: "event_reminder", channelId: CHANNEL, config: { offsets: [60] } }, admin, { enabled: true, now: new Date("2026-10-01T00:00:00Z") })) as { rule: DiscordRule }
    posts.rows.push(postRow({ ruleId: rule.id, dedupeKey: "event_reminder:k" }), postRow({ ruleId: rule.id, status: "SENT" }))
    expect(await setRuleEnabled(rule.id, false, { userId: "officer-1" })).toMatchObject({ ok: true, changed: true })
    expect(posts.rows.map((p) => [p.status, p.dedupeKey])).toEqual([["CANCELLED", null], ["SENT", null]])
    expect(await setRuleEnabled(rule.id, true, admin, { now: new Date("2026-10-23T17:00:00Z") })).toMatchObject({ ok: true, rule: { enabled: true, cutoffAt: new Date("2026-10-23T17:00:00Z") } })
    expect(state.audits.map((a) => a.actionType)).toEqual(["CREATE", "DISABLE", "ENABLE"])
    // Not again when it's already on
    expect(await setRuleEnabled(rule.id, true, admin)).toMatchObject({ ok: true, changed: false })
  })

  it("won't switch on a rule whose channel isn't a posting channel anymore", async () => {
    const { rule } = (await createRule({ kind: "new_event", channelId: CHANNEL, config: {} }, admin, { enabled: false })) as { rule: DiscordRule }
    state.posting = []
    expect(await setRuleEnabled(rule.id, true, admin)).toMatchObject({ ok: false, error: expect.stringMatching(/isn't a posting channel/) })
  })

  it("edits only an unchanged rule (for proposals), keeps its kind, and cancels its scheduled posts", async () => {
    const { rule } = (await createRule({ kind: "event_reminder", channelId: CHANNEL, config: { offsets: [60] } }, admin, { enabled: true })) as { rule: DiscordRule }
    posts.rows.push(postRow({ ruleId: rule.id, dedupeKey: "old" }))
    const seen = rule.updatedAt
    expect(await updateRule(rule.id, { kind: "new_event", channelId: CHANNEL, config: {} }, admin)).toMatchObject({ ok: false, error: expect.stringMatching(/kind can't change/) })
    expect(await updateRule(rule.id, { kind: "event_reminder", channelId: CHANNEL, config: { offsets: [1440] } }, admin, { expectedUpdatedAt: seen })).toMatchObject({ ok: true, rule: { config: { offsets: [1440] } } })
    expect(posts.rows[0]).toMatchObject({ status: "CANCELLED", dedupeKey: null })
    expect(await updateRule(rule.id, { kind: "event_reminder", channelId: CHANNEL, config: { offsets: [60] } }, admin, { expectedUpdatedAt: seen })).toMatchObject({ ok: false, reason: "changed" })
  })

  it("deletes a rule, keeping what it posted and the keys of what it cancelled", async () => {
    const { rule } = (await createRule({ kind: "new_event", channelId: CHANNEL, config: {} }, admin, { enabled: true })) as { rule: DiscordRule }
    posts.rows.push(postRow({ ruleId: rule.id, dedupeKey: "new_event:x" }))
    expect(await deleteRule(rule.id, admin)).toMatchObject({ ok: true })
    expect(rules()).toEqual([])
    expect(posts.rows[0]).toMatchObject({ status: "CANCELLED", dedupeKey: "new_event:x" })
    expect(state.audits.at(-1)).toMatchObject({ actionType: "DELETE", entityType: "DISCORD_RULE" })
  })
})
