import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  rules: [] as { id: string; roleId: string; condition: string; enabled: boolean; createdById: string | null }[],
  users: [] as { id: string; displayName: string; discordUserId: string | null; roles: { role: { key: string } }[] }[],
  members: new Map<string, { id: string; roles: string[]; leftAt: Date | null }>(),
  purged: null as string | null,
  audits: [] as Record<string, unknown>[],
  season: { ok: true, open: true, season: { id: "s3" } } as unknown,
  entrants: [] as { status: string; user: { id: string } }[],
}))
vi.mock("@/server/db", () => ({
  prisma: {
    discordRoleRule: {
      findMany: async ({ where }: { where?: { enabled?: boolean } } = {}) => state.rules.filter((r) => where?.enabled === undefined || r.enabled === where.enabled),
      count: async ({ where }: { where: { roleId: string } }) => state.rules.filter((r) => r.roleId === where.roleId).length,
      create: async ({ data }: { data: Omit<(typeof state.rules)[number], "id"> }) => {
        const rule = { id: `rr-${state.rules.length + 1}`, ...data, createdById: data.createdById ?? null }
        state.rules.push(rule)
        return rule
      },
    },
    user: { findMany: async () => state.users.filter((u) => u.discordUserId) },
    discordMember: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => [...state.members.values()].filter((m) => where.id.in.includes(m.id) && !m.leftAt),
      updateMany: async ({ where, data }: { where: { id: string }; data: { roles: string[] } }) => {
        const m = state.members.get(where.id)
        if (m) m.roles = data.roles
        return { count: m ? 1 : 0 }
      },
    },
    systemSetting: { findUnique: async () => (state.purged ? { value: state.purged } : null) },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.audits.push(data)
        return data
      },
    },
  },
}))
vi.mock("@/server/jack/tools/seasons", () => ({ DEFAULT_LEAGUE: "lone-star-cup", resolveLeagueSeason: async () => state.season }))
vi.mock("@/server/services/league-entry.service", () => ({ listSeasonEntrants: async () => ({ entrants: state.entrants }) }))

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { discordClient } from "@/server/connectors/discord/client"
import { FAKE_CHANNELS, FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { purgedHash } from "@/server/connectors/discord/metadata"
import { DiscordRateLimiter } from "@/server/connectors/discord/rate-limit"
import { discordWriter } from "@/server/connectors/discord/write"
import { createRoleRule, MAX_ROLE_CHANGES_PER_RUN, qualifying, readRoles, runRoleSync, type LinkedMember } from "./role-sync"

const R = FAKE_DISCORD.roles

afterEach(() => {
  vi.unstubAllGlobals()
})

let fakes: MountedFakes
let humans: string[]
let posting: { client: ReturnType<typeof discordClient>; writer: ReturnType<typeof discordWriter> }

beforeEach(async () => {
  fakes = mountFakes([discordFake])
  const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() })
  posting = { client, writer: discordWriter(client.rest, client.guildId) }
  humans = (await client.members({ limit: 1000 })).filter((m) => !m.user.bot).map((m) => m.user.id)
  // Five linked site members; the member sync has seen the first four in the server, with the roles Discord has
  state.users = humans.slice(0, 5).map((discordUserId, i) => ({ id: `u${i}`, displayName: `Member ${i}`, discordUserId, roles: i < 2 ? [{ role: { key: "lsc_driver" } }] : i === 2 ? [{ role: { key: "officer" } }] : [] }))
  state.members = new Map()
  for (const id of humans.slice(0, 4)) state.members.set(id, { id, roles: (await posting.writer.member(id)).roles.slice().sort(), leftAt: null })
  Object.assign(state, { rules: [], purged: null, audits: [], season: { ok: true, open: true, season: { id: "s3" } }, entrants: [] })
})

const memberRoles = async (i: number) => (await posting.writer.member(humans[i])).roles
const run = () => runRoleSync(posting, { now: new Date(), log: () => {} })

describe("role sync", () => {
  it("gives the role to linked members who qualify and takes it from those who don't, auditing each change", async () => {
    state.rules = [{ id: "rr-1", roleId: R.member, condition: "lsc_driver", enabled: true, createdById: null }]
    const before = await Promise.all([0, 1, 2, 3].map(memberRoles))
    const result = await run()
    // Members 0 and 1 have the badge; 2 and 3 don't. 4 isn't in the server (never touched)
    for (const i of [0, 1]) expect(await memberRoles(i)).toContain(R.member)
    for (const i of [2, 3]) expect(await memberRoles(i)).not.toContain(R.member)
    const expectedAdds = [0, 1].filter((i) => !before[i].includes(R.member)).length
    const expectedRemoves = [2, 3].filter((i) => before[i].includes(R.member)).length
    expect(result).toMatchObject({ rules: 1, added: expectedAdds, removed: expectedRemoves, refused: 0 })
    expect(state.audits).toHaveLength(expectedAdds + expectedRemoves)
    expect(state.audits[0]).toMatchObject({ actorUserId: null, entityType: "DISCORD_ROLE", entityId: R.member, metadata: { ruleId: "rr-1", condition: "lsc_driver", roleName: "Member" } })
    expect(JSON.stringify(state.audits)).not.toContain(humans[0])
    // The stored roles follow, and a second run has nothing to do
    expect((await run())).toMatchObject({ added: 0, removed: 0 })
  })

  it("never touches anyone on the purged list", async () => {
    const key = Buffer.from("k".repeat(32)).toString("base64url")
    state.purged = JSON.stringify({ key, authors: [purgedHash(key, humans[0])] })
    state.rules = [{ id: "rr-1", roleId: R.lscDriver, condition: "linked", enabled: true, createdById: null }]
    const before = await memberRoles(0)
    await run()
    expect(await memberRoles(0)).toEqual(before)
    expect(await memberRoles(1)).toContain(R.lscDriver)
    expect(state.audits.some((a) => a.targetUserId === "u0")).toBe(false)
  })

  it("refuses roles with moderation permissions or above the bot's, live every run", async () => {
    state.rules = [
      { id: "rr-officer", roleId: R.officer, condition: "officer", enabled: true, createdById: null },
      { id: "rr-alumni", roleId: R.alumni, condition: "linked", enabled: true, createdById: null },
      { id: "rr-bot", roleId: R.bot, condition: "linked", enabled: true, createdById: null },
    ]
    const result = await run()
    expect(result).toMatchObject({ rules: 0, refused: 3, added: 0, removed: 0 })
    expect(fakes.requests.some((r) => r.method === "PUT" || r.method === "DELETE")).toBe(false)
  })

  it("refuses a plain role that gets moderation permissions in a channel through an overwrite", async () => {
    await fetch(`${fakes.origin}/discord/_fake/overwrites/${FAKE_CHANNELS.lscChat}`, { method: "PUT", body: JSON.stringify([{ id: R.lscDriver, type: 0, allow: String(BigInt(1) << BigInt(13)), deny: "0" }]) })
    state.rules = [{ id: "rr-1", roleId: R.lscDriver, condition: "lsc_driver", enabled: true, createdById: null }]
    const lines: string[] = []
    const result = await runRoleSync(posting, { now: new Date(), log: (line) => lines.push(line) })
    expect(result).toMatchObject({ rules: 0, refused: 1, added: 0 })
    expect(lines.join("\n")).toMatch(/Manage Messages in #lsc-chat/)
    expect(fakes.requests.some((r) => r.method === "PUT" && r.path.includes("/members/"))).toBe(false)
  })

  it("changes nothing when it can't tell who qualifies (no open LSC season)", async () => {
    state.rules = [{ id: "rr-1", roleId: R.lscDriver, condition: "lsc_entered", enabled: true, createdById: null }]
    state.season = { ok: true, open: false, season: { id: "s2" } }
    expect(await run()).toMatchObject({ skipped: 1, added: 0, removed: 0 })
    expect(fakes.requests.some((r) => r.method === "PUT" || r.method === "DELETE")).toBe(false)
  })

  it("stops at the per-run cap; the next run carries on", async () => {
    state.users = humans.slice(0, MAX_ROLE_CHANGES_PER_RUN + 3).map((discordUserId, i) => ({ id: `u${i}`, displayName: `Member ${i}`, discordUserId, roles: [] }))
    state.members = new Map()
    for (const id of humans.slice(0, MAX_ROLE_CHANGES_PER_RUN + 3)) state.members.set(id, { id, roles: (await posting.writer.member(id)).roles.filter((r) => r !== R.alumni), leftAt: null })
    // Nobody may keep Member when the rule is "officers" and nobody is one: everyone holding it loses it
    for (const m of state.members.values()) if (!m.roles.includes(R.member)) m.roles.push(R.member)
    state.rules = [{ id: "rr-1", roleId: R.member, condition: "officer", enabled: true, createdById: null }]
    const first = await run()
    expect(first.removed).toBe(MAX_ROLE_CHANGES_PER_RUN)
    expect(first.waiting).toBe(3)
  })
})

describe("conditions", () => {
  const members: LinkedMember[] = [
    { userId: "a", displayName: "A", discordUserId: "1", siteRoles: ["officer"] },
    { userId: "b", displayName: "B", discordUserId: "2", siteRoles: ["admin", "lsc_driver"] },
    { userId: "c", displayName: "C", discordUserId: "3", siteRoles: ["collegiate_driver"] },
  ]

  it("read the site's roles and the open season's entries", async () => {
    expect([...((await qualifying("linked", members)) ?? [])]).toEqual(["a", "b", "c"])
    expect([...((await qualifying("officer", members)) ?? [])]).toEqual(["a", "b"])
    expect([...((await qualifying("lsc_driver", members)) ?? [])]).toEqual(["b"])
    expect([...((await qualifying("collegiate_driver", members)) ?? [])]).toEqual(["c"])
    state.entrants = [{ status: "paid", user: { id: "c" } }, { status: "manual", user: { id: "a" } }, { status: "ended", user: { id: "b" } }, { status: "none", user: { id: "x" } }]
    expect([...((await qualifying("lsc_entered", members)) ?? [])].sort()).toEqual(["a", "c"])
  })
})

describe("adding a rule", () => {
  it("refuses an unsafe role or a second rule for a role, and audits a good one", async () => {
    const live = { ...(await readRoles(posting.client, posting.writer)), guildId: FAKE_DISCORD.guildId }
    expect(await createRoleRule({ roleId: R.officer, condition: "officer", enabled: true }, { userId: "admin-1" }, live)).toMatchObject({ ok: false, error: expect.stringMatching(/moderation permissions/) })
    expect(await createRoleRule({ roleId: R.alumni, condition: "linked", enabled: true }, { userId: "admin-1" }, live)).toMatchObject({ ok: false, error: expect.stringMatching(/above the bot's own role/) })
    expect(await createRoleRule({ roleId: R.lscDriver, condition: "nonsense", enabled: true }, { userId: "admin-1" }, live)).toMatchObject({ ok: false })
    expect(await createRoleRule({ roleId: R.lscDriver, condition: "lsc_entered", enabled: false }, { userId: "admin-1" }, live)).toMatchObject({ ok: true })
    expect(await createRoleRule({ roleId: R.lscDriver, condition: "linked", enabled: false }, { userId: "admin-1" }, live)).toMatchObject({ ok: false, error: expect.stringMatching(/already has a rule/) })
    expect(state.audits).toEqual([expect.objectContaining({ actorUserId: "admin-1", actionType: "CREATE", entityType: "DISCORD_ROLE_RULE" })])
  })
})
