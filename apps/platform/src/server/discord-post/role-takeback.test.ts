import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  rules: [] as { id: string; roleId: string; condition: string; enabled: boolean }[],
  users: [] as { id: string; discordUserId: string | null }[],
  members: new Map<string, { id: string; roles: string[] }>(),
  settings: new Map<string, string>(),
  audits: [] as Record<string, unknown>[],
  locks: [] as string[],
  posting: null as unknown,
}))
vi.mock("@/server/db", () => {
  const prisma = {
    $executeRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => (state.locks.push(`${sql.join("?")} ${values.join(",")}`), 0),
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    discordRoleRule: {
      // In roleId order, as the code asks (Member's role comes before LSC Driver's)
      findMany: async ({ where }: { where?: { enabled?: boolean } } = {}) => state.rules.filter((r) => where?.enabled === undefined || r.enabled === where.enabled).sort((a, b) => a.roleId.localeCompare(b.roleId)),
      count: async ({ where }: { where?: { enabled?: boolean } } = {}) => state.rules.filter((r) => where?.enabled === undefined || r.enabled === where.enabled).length,
    },
    user: { findMany: async ({ where }: { where: { discordUserId: { in: string[] } } }) => state.users.filter((u) => u.discordUserId && where.discordUserId.in.includes(u.discordUserId)) },
    discordMember: {
      updateMany: async ({ where, data }: { where: { id: string }; data: { roles: string[] } }) => {
        const m = state.members.get(where.id)
        if (m) m.roles = data.roles
        return { count: m ? 1 : 0 }
      },
    },
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (state.settings.has(where.key) ? { key: where.key, value: state.settings.get(where.key)! } : null),
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => void state.settings.set(where.key, update.value),
      deleteMany: async ({ where }: { where: { key: string } }) => ({ count: Number(state.settings.delete(where.key)) }),
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.audits.push(data)
        return data
      },
    },
  }
  return { prisma }
})
vi.mock("./connection", () => ({ NOT_CONNECTED: "Discord isn't connected.", discordPostingForPage: async () => state.posting }))

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { discordClient } from "@/server/connectors/discord/client"
import { FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { purgedHash } from "@/server/connectors/discord/metadata"
import { DiscordRateLimiter } from "@/server/connectors/discord/rate-limit"
import { discordWriter } from "@/server/connectors/discord/write"
import { queueRoleTakeBack, runQueuedTakeBacks, takeBackAfterPurge, takeBackAfterUnlink, TAKEBACK_SETTING, waitingTakeBacks } from "./role-takeback"

const R = FAKE_DISCORD.roles
const NOT_IN_SERVER = "1999999999999999999"

let fakes: MountedFakes
let posting: { client: ReturnType<typeof discordClient>; writer: ReturnType<typeof discordWriter> }
let writer: ReturnType<typeof discordWriter>
let humans: string[]

const queue = () => (JSON.parse(state.settings.get(TAKEBACK_SETTING) ?? '{"accounts":[]}') as { accounts: string[] }).accounts
const roles = async (id: string) => (await writer.member(id)).roles
const roleWrites = () => fakes.requests.filter((r) => (r.method === "PUT" || r.method === "DELETE") && r.path.includes("/roles/"))
const moveRole = (roleId: string, position: number) => fetch(`${fakes.origin}/discord/_fake/roles/${roleId}`, { method: "PATCH", body: JSON.stringify({ position }) })
const failNext = (body: Record<string, unknown>) => fetch(`${fakes.origin}/discord/_fake/fail`, { method: "POST", body: JSON.stringify({ method: "DELETE", times: 1, ...body }) })

beforeEach(async () => {
  fakes = mountFakes([discordFake])
  const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() })
  writer = discordWriter(client.rest, client.guildId)
  posting = { client, writer }
  humans = (await client.members({ limit: 1000 })).filter((m) => !m.user.bot).map((m) => m.user.id)
  Object.assign(state, {
    // LSC Driver's rule is on; Member's is switched off (its role is still role sync's)
    rules: [
      { id: "rr-lsc", roleId: R.lscDriver, condition: "lsc_driver", enabled: true },
      { id: "rr-member", roleId: R.member, condition: "linked", enabled: false },
    ],
    users: [],
    members: new Map(),
    settings: new Map(),
    audits: [],
    locks: [],
    posting,
  })
  // humans[0] holds both roles (and Officer, which no rule names); the member sync stored them
  for (const role of [R.lscDriver, R.member]) await writer.addRole(humans[0], role, "test")
  state.members.set(humans[0], { id: humans[0], roles: (await roles(humans[0])).slice().sort() })
  fakes.requests.length = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("queueing an unlink", () => {
  it("queues the account under the queue's lock while any role sync rule exists (on or off), never a purged account, and counts what waits", async () => {
    expect(await queueRoleTakeBack(humans[0])).toBe(true)
    expect(await queueRoleTakeBack(humans[0])).toBe(true)
    expect(queue()).toEqual([humans[0]])
    expect(state.locks[0]).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\)\) lsr:discord_role_takeback/)
    expect(await waitingTakeBacks()).toBe(1)

    const key = Buffer.alloc(32, 7).toString("base64url")
    state.settings.set("discord_purged", JSON.stringify({ key, authors: [purgedHash(key, humans[1])] }))
    expect(await queueRoleTakeBack(humans[1])).toBe(false)
    expect(await queueRoleTakeBack("not-a-snowflake")).toBe(false)
    // Every rule switched off: their roles are still taken back
    state.rules = state.rules.map((r) => ({ ...r, enabled: false }))
    expect(await queueRoleTakeBack(humans[2])).toBe(true)
    state.rules = []
    expect(await queueRoleTakeBack(humans[5])).toBe(false)
    expect(queue()).toEqual([humans[0], humans[2]])
  })
})

describe("after an unlink (from the profile, or when the account is deleted)", () => {
  it("takes back every rule's role the account holds (a rule switched off too), nothing else, audited with no Discord id, and clears the queue", async () => {
    await queueRoleTakeBack(humans[0])
    await takeBackAfterUnlink(humans[0], "u0")
    expect(await roles(humans[0])).not.toContain(R.lscDriver)
    expect(await roles(humans[0])).not.toContain(R.member)
    // No rule names Officer: role sync never gave it
    expect(await roles(humans[0])).toContain(R.officer)
    expect(state.members.get(humans[0])!.roles).toEqual((await roles(humans[0])).slice().sort())
    expect(state.audits).toEqual([
      expect.objectContaining({ actorUserId: null, actionType: "ROLE_REMOVE", entityType: "DISCORD_ROLE", entityId: R.member, targetUserId: "u0", summary: "Role sync took back the Discord role @Member: their Discord account was unlinked from the site" }),
      expect.objectContaining({ actorUserId: null, actionType: "ROLE_REMOVE", entityType: "DISCORD_ROLE", entityId: R.lscDriver, targetUserId: "u0", summary: "Role sync took back the Discord role @LSC Driver: their Discord account was unlinked from the site" }),
    ])
    expect(JSON.stringify(state.audits)).not.toContain(humans[0])
    expect(state.settings.has(TAKEBACK_SETTING)).toBe(false)
  })

  it("is done at once for an account that isn't in the server or holds none of the roles", async () => {
    for (const role of [R.lscDriver, R.member]) await writer.removeRole(humans[3], role, "test")
    fakes.requests.length = 0
    for (const id of [NOT_IN_SERVER, humans[3]]) {
      await queueRoleTakeBack(id)
      await takeBackAfterUnlink(id, "u9")
    }
    expect(queue()).toEqual([])
    expect(roleWrites()).toEqual([])
    expect(state.audits).toEqual([])
  })

  it("leaves the account queued when Discord is off or fails, and never fails the unlink; the next run takes the rest back", async () => {
    await queueRoleTakeBack(humans[0])
    state.posting = null
    await expect(takeBackAfterUnlink(humans[0], "u0")).resolves.toBeUndefined()
    expect(queue()).toEqual([humans[0]])

    // Discord fails on Member's role: LSC Driver's is taken anyway
    state.posting = posting
    await failNext({ path: `/roles/${R.member}`, status: 500, code: 0, message: "Internal" })
    await expect(takeBackAfterUnlink(humans[0], "u0")).resolves.toBeUndefined()
    expect(queue()).toEqual([humans[0]])
    expect(await roles(humans[0])).toContain(R.member)
    expect(await roles(humans[0])).not.toContain(R.lscDriver)

    // The fake's failures are used up: the role sync run's first step takes the rest back
    fakes.requests.length = 0
    const lines: string[] = []
    const run = await runQueuedTakeBacks(posting, { maxChanges: 25, log: (line) => lines.push(line) })
    expect(run).toEqual({ accounts: 1, removed: 1, waiting: 0 })
    expect(await roles(humans[0])).not.toContain(R.member)
    expect(queue()).toEqual([])
    expect(lines.join("\n")).toMatch(/Took back @Member from an account that was unlinked/)
    expect(state.audits.at(-1)).toMatchObject({ targetUserId: null, summary: expect.stringMatching(/the account was unlinked from the site/) })
  })

  it("never lets a role above the bot's own stop the others, and keeps the account queued until it can be taken", async () => {
    state.rules = state.rules.map((r) => ({ ...r, enabled: true }))
    // An admin moved Member above the bot's role: role sync refuses that rule now, and Discord won't let the bot take the role
    await moveRole(R.member, 100)
    fakes.requests.length = 0
    await queueRoleTakeBack(humans[0])
    await takeBackAfterUnlink(humans[0], "u0")
    expect(await roles(humans[0])).not.toContain(R.lscDriver)
    expect(await roles(humans[0])).toContain(R.member)
    // Skipped without asking Discord
    expect(roleWrites().map((r) => r.path)).toEqual([expect.stringContaining(`/roles/${R.lscDriver}`)])
    expect(queue()).toEqual([humans[0]])

    const lines: string[] = []
    for (let i = 0; i < 2; i++) expect(await runQueuedTakeBacks(posting, { maxChanges: 25, log: (line) => lines.push(line) })).toEqual({ accounts: 0, removed: 0, waiting: 1 })
    expect(lines.at(-1)).toMatch(/^Couldn't take back @Member from an account that was unlinked \(@Member sits at or above the bot's own role.*\); it stays queued/)
    expect(queue()).toEqual([humans[0]])

    // Once the role is below the bot's again, the next run takes it
    await moveRole(R.member, 1)
    expect(await runQueuedTakeBacks(posting, { maxChanges: 25, log: () => {} })).toEqual({ accounts: 1, removed: 1, waiting: 0 })
    expect(await roles(humans[0])).not.toContain(R.member)
    expect(queue()).toEqual([])
  })

  it("takes the other roles when Discord refuses one, and says which it couldn't", async () => {
    await failNext({ path: `/roles/${R.member}`, status: 403, code: 50013, message: "Missing Permissions" })
    await queueRoleTakeBack(humans[0])
    const lines: string[] = []
    expect(await runQueuedTakeBacks(posting, { maxChanges: 25, log: (line) => lines.push(line) })).toEqual({ accounts: 0, removed: 1, waiting: 1 })
    expect(await roles(humans[0])).not.toContain(R.lscDriver)
    expect(lines).toEqual(["Took back @LSC Driver from an account that was unlinked.", expect.stringMatching(/^Couldn't take back @Member from an account that was unlinked \(Discord refused @Member \(Missing Permissions/)])
    expect(queue()).toEqual([humans[0]])
  })

  it("works through the queue while every rule is switched off: a rule paused when someone unlinked never leaves its role with them", async () => {
    state.rules = state.rules.map((r) => ({ ...r, enabled: false }))
    state.posting = null
    expect(await queueRoleTakeBack(humans[0])).toBe(true)
    await takeBackAfterUnlink(humans[0], "u0")
    expect(queue()).toEqual([humans[0]])
    // Later the rule is switched back on, or not: the next run takes both roles either way
    expect(await runQueuedTakeBacks(posting, { maxChanges: 25, log: () => {} })).toEqual({ accounts: 1, removed: 2, waiting: 0 })
    state.rules = state.rules.map((r) => ({ ...r, enabled: true }))
    expect(await roles(humans[0])).not.toContain(R.lscDriver)
    expect(await roles(humans[0])).not.toContain(R.member)
    expect(queue()).toEqual([])
  })

  it("leaves an account linked again to role sync, and drops one purged since, without touching either", async () => {
    await queueRoleTakeBack(humans[0])
    await queueRoleTakeBack(humans[4])
    state.users = [{ id: "u0", discordUserId: humans[0] }]
    const key = Buffer.alloc(32, 7).toString("base64url")
    state.settings.set("discord_purged", JSON.stringify({ key, authors: [purgedHash(key, humans[4])] }))
    expect(await runQueuedTakeBacks(posting, { maxChanges: 25, log: () => {} })).toEqual({ accounts: 0, removed: 0, waiting: 0 })
    expect(queue()).toEqual([])
    expect(roleWrites()).toEqual([])
  })

  it("stops at the run's cap and leaves the rest queued", async () => {
    state.rules = state.rules.filter((r) => r.roleId === R.lscDriver)
    await writer.addRole(humans[1], R.lscDriver, "test")
    await queueRoleTakeBack(humans[0])
    await queueRoleTakeBack(humans[1])
    expect(await runQueuedTakeBacks(posting, { maxChanges: 1, log: () => {} })).toEqual({ accounts: 1, removed: 1, waiting: 1 })
    expect(queue()).toEqual([humans[1]])
  })
})

describe("after a purge", () => {
  it("takes back the roles of an account that was linked, and says which", async () => {
    expect(await takeBackAfterPurge(humans[0], { wasLinked: true, targetUserId: "u0" })).toEqual({ taken: ["@Member", "@LSC Driver"], left: [], error: null })
    expect(await roles(humans[0])).not.toContain(R.lscDriver)
    expect(state.audits.map((a) => a.summary)).toEqual(["Role sync took back the Discord role @Member: their Discord data was deleted on request", "Role sync took back the Discord role @LSC Driver: their Discord data was deleted on request"])
    expect(state.audits.every((a) => a.actionType === "ROLE_REMOVE" && a.targetUserId === "u0")).toBe(true)
    expect(JSON.stringify(state.audits)).not.toContain(humans[0])
  })

  it("takes every role it can, and names the one it couldn't for the admin", async () => {
    await moveRole(R.member, 100)
    expect(await takeBackAfterPurge(humans[0], { wasLinked: true, targetUserId: "u0" })).toEqual({ taken: ["@LSC Driver"], left: ["@Member"], error: expect.stringMatching(/^@Member sits at or above the bot's own role/) })
    expect(await roles(humans[0])).not.toContain(R.lscDriver)
  })

  it("takes an account out of the queue and tries it now, and never keeps the id when that fails: the admin is told", async () => {
    await queueRoleTakeBack(humans[0])
    state.posting = null
    expect(await takeBackAfterPurge(humans[0], { wasLinked: false, targetUserId: null })).toEqual({ taken: [], left: [], error: "Discord isn't connected." })
    expect(state.settings.has(TAKEBACK_SETTING)).toBe(false)
    expect(await roles(humans[0])).toContain(R.lscDriver)
  })

  it("leaves alone an account that was never linked (its roles were given in Discord)", async () => {
    expect(await takeBackAfterPurge(humans[0], { wasLinked: false, targetUserId: null })).toBeNull()
    expect(fakes.requests).toEqual([])
    expect(await roles(humans[0])).toContain(R.lscDriver)
  })

  it("does nothing when there's no role sync rule", async () => {
    state.rules = []
    expect(await takeBackAfterPurge(humans[0], { wasLinked: true, targetUserId: "u0" })).toBeNull()
    expect(fakes.requests).toEqual([])
  })
})
