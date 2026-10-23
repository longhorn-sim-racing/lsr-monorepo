import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

const db = vi.hoisted(() => {
  const db = {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    connectorState: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    discordMember: { updateMany: vi.fn(), deleteMany: vi.fn() },
    discordMessage: { updateMany: vi.fn(), deleteMany: vi.fn(), aggregate: vi.fn() },
    discordChannel: { updateMany: vi.fn() },
    systemSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  }
  return db
})
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const stats = vi.hoisted(() => ({ rebuildDailyStats: vi.fn(), daysBetween: vi.fn(() => ["days"]) }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/connectors/discord/sync", () => stats)
const takeback = vi.hoisted(() => ({ queueRoleTakeBack: vi.fn(), takeBackAfterUnlink: vi.fn() }))
vi.mock("@/server/discord-post/role-takeback", () => takeback)

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { purgedHash, purgedList } from "@/server/connectors/discord/metadata"
import { purgedFrom } from "@/server/connectors/discord/store"
import { finishDiscordLink, linkDiscordAccount, openLinkCookie, purgeDiscordData, sealLinkCookie, startDiscordLink, unlinkDiscord } from "./discord-link.service"

const SECRET = FAKE_DISCORD.clientSecret
const DISCORD_ID = "1234567890123456789"
let fakes: MountedFakes

beforeEach(() => {
  fakes = mountFakes([discordFake])
  vi.stubEnv("DISCORD_BOT_TOKEN", FAKE_DISCORD.botToken)
  vi.stubEnv("DISCORD_GUILD_ID", FAKE_DISCORD.guildId)
  vi.stubEnv("DISCORD_CLIENT_ID", FAKE_DISCORD.clientId)
  vi.stubEnv("DISCORD_CLIENT_SECRET", SECRET)
  vi.stubEnv("DISCORD_OAUTH_REDIRECT_URI", "https://lsr.test/api/discord/oauth/callback")
  db.connectorState.findUnique.mockResolvedValue({ id: "discord", enabled: true })
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db))
  db.user.findUnique.mockResolvedValue(null)
  db.user.updateMany.mockResolvedValue({ count: 1 })
  db.discordMember.updateMany.mockResolvedValue({ count: 1 })
  db.discordMessage.updateMany.mockResolvedValue({ count: 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the link cookie", () => {
  const payload = { state: "s", verifier: "v", userId: "user-1", exp: Date.now() + 60_000 }

  it("opens what it sealed, and nothing else", () => {
    const sealed = sealLinkCookie(payload, SECRET)
    expect(openLinkCookie(sealed, SECRET)).toEqual({ v: 1, ...payload })
    // Private as well as signed: the verifier isn't readable in it
    expect(Buffer.from(sealed.split(".")[2], "base64url").toString()).not.toContain("user-1")
    expect(openLinkCookie(sealed, "another-secret")).toBeNull()
    const [iv, tag, body] = sealed.split(".")
    const flipped = Buffer.from(body, "base64url")
    flipped[0] ^= 1
    expect(openLinkCookie([iv, tag, flipped.toString("base64url")].join("."), SECRET)).toBeNull()
    expect(openLinkCookie("not.a.cookie", SECRET)).toBeNull()
    expect(openLinkCookie(undefined, SECRET)).toBeNull()
  })

  it("expires", () => {
    const sealed = sealLinkCookie({ ...payload, exp: 1_000 }, SECRET)
    expect(openLinkCookie(sealed, SECRET, 999)).not.toBeNull()
    expect(openLinkCookie(sealed, SECRET, 1_000)).toBeNull()
  })
})

/** Starts linking, follows the fake's authorize page, and returns what the callback would get */
async function approve(userId = "user-1") {
  const started = await startDiscordLink({ id: userId, discordUserId: null })
  if (!started.ok) throw new Error(started.outcome)
  const answer = await fetch(started.url, { redirect: "manual" })
  const back = new URL(answer.headers.get("location")!)
  return { started, back, input: { userId, cookie: started.cookie, code: back.searchParams.get("code"), state: back.searchParams.get("state"), iss: back.searchParams.get("iss"), error: back.searchParams.get("error") } }
}

describe("startDiscordLink", () => {
  it("sends the member to Discord for identify only, with PKCE S256 and a state bound to them", async () => {
    const started = await startDiscordLink({ id: "user-1", discordUserId: null })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const url = new URL(started.url)
    expect(url.origin + url.pathname).toBe(`${fakes.origin}/discord/oauth2/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: FAKE_DISCORD.clientId,
      scope: "identify",
      redirect_uri: "https://lsr.test/api/discord/oauth/callback",
      code_challenge_method: "S256",
      prompt: "none",
    })
    const sealed = openLinkCookie(started.cookie, SECRET)!
    expect(sealed).toMatchObject({ userId: "user-1", state: url.searchParams.get("state") })
    expect(url.searchParams.get("code_challenge")).not.toBe(sealed.verifier)
    expect(url.toString()).not.toContain(sealed.verifier)
  })

  it("asks for an unlink first when the member already has a link, and says so when linking isn't on", async () => {
    expect(await startDiscordLink({ id: "user-1", discordUserId: DISCORD_ID })).toEqual({ ok: false, outcome: "already" })
    db.connectorState.findUnique.mockResolvedValue({ id: "discord", enabled: false })
    expect(await startDiscordLink({ id: "user-1", discordUserId: null })).toEqual({ ok: false, outcome: "unavailable" })
    vi.stubEnv("DISCORD_CLIENT_SECRET", "")
    expect(await startDiscordLink({ id: "user-1", discordUserId: null })).toEqual({ ok: false, outcome: "unavailable" })
  })
})

describe("finishDiscordLink", () => {
  it("exchanges the code with the verifier, reads the account, revokes the token and saves only the id and username", async () => {
    const { input, back } = await approve()
    expect(back.searchParams.get("iss")).toBe("https://discord.com")
    expect(await finishDiscordLink(input)).toBe("linked")

    const token = fakes.requests.find((r) => r.path === "/api/v10/oauth2/token")!
    expect(token.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(token.headers.get("authorization")).toMatch(/^Basic /)
    const form = new URLSearchParams(token.body)
    expect(form.get("grant_type")).toBe("authorization_code")
    expect(form.get("code_verifier")).toBe(openLinkCookie(input.cookie, SECRET)!.verifier)
    expect(fakes.requests.some((r) => r.path === "/api/v10/oauth2/token/revoke")).toBe(true)
    // The fake holds no live token afterwards
    const state = await (await fetch(`${fakes.origin}/discord/_fake/oauth`, { method: "POST", body: "{}" })).json()
    expect(state.liveTokens).toBe(0)

    const saved = db.user.updateMany.mock.calls[0][0]
    expect(saved.where).toEqual({ id: "user-1", discordUserId: null })
    expect(Object.keys(saved.data).sort()).toEqual(["discordLinkedAt", "discordUserId", "discordUsername"])
    expect(saved.data.discordUserId).toMatch(/^\d{17,20}$/)
    expect(db.discordMember.updateMany).toHaveBeenCalledWith({ where: { id: saved.data.discordUserId }, data: { userId: "user-1" } })
  })

  it("refuses a state that doesn't match, a cookie from another member, a missing cookie and a wrong issuer", async () => {
    const { input } = await approve()
    expect(await finishDiscordLink({ ...input, state: "something-else" })).toBe("expired")
    expect(await finishDiscordLink({ ...input, userId: "user-2" })).toBe("expired")
    expect(await finishDiscordLink({ ...input, cookie: undefined })).toBe("expired")
    expect(await finishDiscordLink({ ...input, iss: "https://evil.example" })).toBe("failed")
    expect(db.user.updateMany).not.toHaveBeenCalled()
    expect(fakes.requests.some((r) => r.path === "/api/v10/oauth2/token")).toBe(false)
  })

  it("says the member cancelled when they denied it", async () => {
    await fetch(`${fakes.origin}/discord/_fake/oauth`, { method: "POST", body: JSON.stringify({ deny: true }) })
    const { input } = await approve()
    expect(input.error).toBe("access_denied")
    expect(await finishDiscordLink(input)).toBe("cancelled")
  })

  it("revokes the token even when the account is already another member's", async () => {
    const { input } = await approve()
    db.user.findUnique.mockResolvedValue({ id: "someone-else" })
    expect(await finishDiscordLink(input)).toBe("taken")
    expect(fakes.requests.some((r) => r.path === "/api/v10/oauth2/token/revoke")).toBe(true)
    expect(db.user.updateMany).not.toHaveBeenCalled()
  })

  it("fails without saving when the code was already used", async () => {
    const { input } = await approve()
    expect(await finishDiscordLink(input)).toBe("linked")
    db.user.updateMany.mockClear()
    expect(await finishDiscordLink(input)).toBe("failed")
    expect(db.user.updateMany).not.toHaveBeenCalled()
  })
})

describe("linkDiscordAccount", () => {
  it("says already for the member's own link, and taken when two finish at once", async () => {
    db.user.findUnique.mockResolvedValue({ id: "user-1" })
    expect(await linkDiscordAccount("user-1", { id: DISCORD_ID, username: "avery" })).toBe("already")
    db.user.findUnique.mockResolvedValue(null)
    db.user.updateMany.mockResolvedValue({ count: 0 })
    expect(await linkDiscordAccount("user-1", { id: DISCORD_ID, username: "avery" })).toBe("already")
    db.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" }))
    expect(await linkDiscordAccount("user-1", { id: DISCORD_ID, username: "avery" })).toBe("taken")
    expect(await linkDiscordAccount("user-1", { id: "not-a-snowflake", username: "x" })).toBe("failed")
  })
})

describe("unlinkDiscord", () => {
  it("clears the member's link and every row pointing at them", async () => {
    db.user.findUnique.mockResolvedValue({ discordUserId: DISCORD_ID })
    expect(await unlinkDiscord("user-1")).toBe(true)
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { discordUserId: null, discordUsername: null, discordLinkedAt: null } })
    expect(db.discordMember.updateMany).toHaveBeenCalledWith({ where: { userId: "user-1" }, data: { userId: null } })
    expect(db.discordMessage.updateMany).toHaveBeenCalledWith({ where: { userId: "user-1" }, data: { userId: null } })
    db.user.findUnique.mockResolvedValue({ discordUserId: null })
    db.user.update.mockClear()
    expect(await unlinkDiscord("user-1")).toBe(false)
    expect(db.user.update).not.toHaveBeenCalled()
  })

  it("takes back the roles role sync gave (from the profile, and before an account is deleted): queued with the unlink, tried before it returns", async () => {
    const order: string[] = []
    let inTransaction = false
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => {
      inTransaction = true
      try {
        return await fn(db)
      } finally {
        inTransaction = false
      }
    })
    db.user.findUnique.mockResolvedValue({ discordUserId: DISCORD_ID })
    takeback.queueRoleTakeBack.mockImplementation(async () => (order.push(`queue${inTransaction ? " (in)" : ""}`), true))
    takeback.takeBackAfterUnlink.mockImplementation(async () => void order.push(`take back${inTransaction ? " (in)" : ""}`))
    const done = unlinkDiscord("user-1").then(() => order.push("returned"))
    await done
    // Queued in the unlink's own transaction, so it can't be lost; deleteAccount awaits this before the account goes
    expect(order).toEqual(["queue (in)", "take back", "returned"])
    expect(takeback.queueRoleTakeBack).toHaveBeenCalledWith(DISCORD_ID, db)
    expect(takeback.takeBackAfterUnlink).toHaveBeenCalledWith(DISCORD_ID, "user-1")

    // No role sync rule on: nothing queued, nothing to try
    order.length = 0
    takeback.queueRoleTakeBack.mockResolvedValue(false)
    expect(await unlinkDiscord("user-1")).toBe(true)
    expect(order).toEqual([])
  })
})

describe("purgeDiscordData", () => {
  beforeEach(() => {
    db.discordMessage.aggregate.mockResolvedValue({ _min: { createdAt: new Date("2026-09-01") }, _max: { createdAt: new Date("2026-10-20") } })
    db.discordMessage.deleteMany.mockResolvedValue({ count: 57 })
    db.discordMember.deleteMany.mockResolvedValue({ count: 1 })
    db.discordChannel.updateMany.mockResolvedValue({ count: 2 })
    db.user.findUnique.mockResolvedValue({ id: "user-9" })
    db.systemSetting.findUnique.mockResolvedValue({ key: "discord_purged", value: JSON.stringify({ authors: ["earlier"] }) })
  })

  it("deletes the account's metadata, member row and link, lists it (keyed hash) so it's never collected again, and rebuilds the stats", async () => {
    expect(await purgeDiscordData(DISCORD_ID, { userId: "admin-1" })).toEqual({ messages: 57, member: true, threads: 2, unlinkedUserId: "user-9", reference: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(db.discordMessage.deleteMany).toHaveBeenCalledWith({ where: { authorId: DISCORD_ID } })
    expect(db.discordMember.deleteMany).toHaveBeenCalledWith({ where: { id: DISCORD_ID } })
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "user-9" }, data: { discordUserId: null, discordUsername: null, discordLinkedAt: null } })
    const value = JSON.parse(db.systemSetting.upsert.mock.calls[0][0].update.value) as { key: string; authors: string[] }
    // The list's key is made on the first purge: 32 random bytes
    expect(Buffer.from(value.key, "base64url")).toHaveLength(32)
    expect(value.authors).toEqual(["earlier", purgedHash(value.key, DISCORD_ID)])
    expect(purgedFrom(JSON.stringify(value)).has(DISCORD_ID)).toBe(true)
    expect(JSON.stringify(value)).not.toContain(DISCORD_ID)
    expect(stats.rebuildDailyStats).toHaveBeenCalledWith(expect.anything(), ["days"])
  })

  it("removes the titles of the threads they started, keeping the threads (others' replies still count) with no owner", async () => {
    await purgeDiscordData(DISCORD_ID, { userId: "admin-1" })
    expect(db.discordChannel.updateMany).toHaveBeenCalledWith({ where: { ownerId: DISCORD_ID }, data: { name: "a thread", ownerId: null } })
    const entry = audit.createAuditLog.mock.calls[0][0]
    expect(entry.summary).toContain("the titles of 2 threads they started")
    expect(entry.metadata).toMatchObject({ threads: 2 })
  })

  it("takes the purge lock before touching anything, and waits long enough for a sync write to finish", async () => {
    const order: string[] = []
    db.$executeRaw.mockImplementation(async (sql: TemplateStringsArray) => order.push(sql.join("?")))
    db.discordMessage.aggregate.mockImplementation(async () => (order.push("read"), { _min: { createdAt: null }, _max: { createdAt: null } }))
    db.discordMessage.deleteMany.mockImplementation(async () => (order.push("delete"), { count: 0 }))
    await purgeDiscordData(DISCORD_ID, { userId: "admin-1" })
    // Exclusive: the sync's writes take the same lock shared, and re-read the list under it
    expect(order[0]).toMatch(/^SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)$/)
    expect(db.$executeRaw.mock.calls[0][1]).toBe("lsr:discord_purged")
    expect(order.slice(1)).toEqual(["read", "delete"])
    expect(db.$transaction.mock.calls[0][1]).toMatchObject({ timeout: expect.any(Number) })
    expect(db.$transaction.mock.calls[0][1].timeout).toBeGreaterThanOrEqual(30_000)
  })

  it("keeps the list's key, so earlier purges still match", async () => {
    const key = Buffer.alloc(32, 3).toString("base64url")
    db.systemSetting.findUnique.mockResolvedValue({ key: "discord_purged", value: JSON.stringify({ key, authors: [purgedHash(key, "1234567890123456780")] }) })
    await purgeDiscordData(DISCORD_ID, { userId: "admin-1" })
    const list = purgedFrom(db.systemSetting.upsert.mock.calls[0][0].update.value)
    expect([list.has("1234567890123456780"), list.has(DISCORD_ID), list.has("1234567890123456781"), list.size]).toEqual([true, true, false, 2])
  })

  it("is audited under a random reference, never the Discord id or anything worked out from it", async () => {
    const { reference } = await purgeDiscordData(DISCORD_ID, { userId: "admin-1" })
    const entry = audit.createAuditLog.mock.calls[0][0]
    expect(entry).toMatchObject({ actorUserId: "admin-1", actionType: "PURGE", entityType: "DISCORD_MEMBER", entityId: reference, targetUserId: "user-9", metadata: { messages: 57, member: true, unlinked: true } })
    expect(JSON.stringify(entry)).not.toContain(DISCORD_ID)
    // The hash on the list isn't in the entry either
    const value = JSON.parse(db.systemSetting.upsert.mock.calls[0][0].update.value) as { key: string }
    expect(JSON.stringify(entry)).not.toContain(purgedHash(value.key, DISCORD_ID).slice(0, 16))
    // Unkeyed, anyone with a member's (public) Discord id could check it against the list: keyed, they can't
    expect(purgedList(Buffer.alloc(32, 9).toString("base64url"), [purgedHash(value.key, DISCORD_ID)]).has(DISCORD_ID)).toBe(false)
  })

  it("refuses something that isn't a Discord id", async () => {
    await expect(purgeDiscordData("@avery", { userId: "admin-1" })).rejects.toThrow(/isn't a Discord user id/)
    expect(db.discordMessage.deleteMany).not.toHaveBeenCalled()
  })
})
