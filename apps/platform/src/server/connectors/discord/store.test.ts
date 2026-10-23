import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

// The database store's purge rules, against a mocked Prisma (sync.test.ts covers the same rules in the
// in-memory store; scripts/check-discord-read.ts runs them against Postgres). Outside a transaction the
// client has nothing but $transaction, so every read and write here has to happen inside one
const db = vi.hoisted(() => ({ $transaction: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { purgedHash, type MessageRow } from "./metadata"
import { prismaDiscordStore, type ChannelInput, type MemberInput } from "./store"

const KEY = Buffer.alloc(32, 7).toString("base64url")
const PURGED = "300000000000000001"
const MEMBER = "300000000000000002"
const OTHER = "300000000000000003"
const AT = new Date("2026-10-23T15:00:00.000Z")

type Tx = ReturnType<typeof transaction>

/** A transaction client whose calls are logged in order, holding a purged list with PURGED on it */
function transaction(known: { channels?: unknown[]; members?: unknown[]; links?: unknown[] } = {}) {
  const log: string[] = []
  const step = (name: string, result: (arg: unknown) => unknown = () => ({ count: 0 })) =>
    vi.fn(async (...args: unknown[]) => {
      log.push(name)
      return result(args[0])
    })
  const count = (arg: unknown) => ({ count: (arg as { data: unknown[] }).data.length })
  return {
    log,
    $executeRaw: step("$executeRaw", () => 1),
    $queryRaw: step("$queryRaw", () => [{ synced: true }]),
    systemSetting: { findUnique: step("systemSetting.findUnique", () => ({ key: "discord_purged", value: JSON.stringify({ key: KEY, authors: [purgedHash(KEY, PURGED)] }) })) },
    discordChannel: { findMany: step("discordChannel.findMany", () => known.channels ?? []), createMany: step("discordChannel.createMany", count), updateMany: step("discordChannel.updateMany") },
    discordMessage: { createMany: step("discordMessage.createMany", count), updateMany: step("discordMessage.updateMany") },
    discordMember: { findMany: step("discordMember.findMany", () => known.members ?? []), createMany: step("discordMember.createMany", count), updateMany: step("discordMember.updateMany") },
    user: { findMany: step("user.findMany", () => known.links ?? []) },
  }
}

let tx: Tx

function useTransaction(next: Tx) {
  tx = next
  db.$transaction.mockImplementation(async (fn: (client: Tx) => unknown) => fn(tx))
}

beforeEach(() => useTransaction(transaction()))

/** The first argument of each call */
const argsOf = <T>(fn: Mock) => fn.mock.calls.map(([arg]) => arg as T)

/** Every write's arguments, to check a purged member's id or words never reach one */
const writes = () => JSON.stringify([tx.discordChannel.createMany, tx.discordChannel.updateMany, tx.discordMessage.createMany, tx.discordMessage.updateMany, tx.discordMember.createMany, tx.discordMember.updateMany].map((fn) => fn.mock.calls))

/** Each method's first statement is the shared purge lock, then the list is read again, before anything else */
function expectLockedRead() {
  expect(db.$transaction).toHaveBeenCalledTimes(1)
  expect(tx.log.slice(0, 2)).toEqual(["$executeRaw", "systemSetting.findUnique"])
  expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
  const [strings, ...values] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
  expect(strings.join("?")).toBe("SELECT pg_advisory_xact_lock_shared(hashtext(?))")
  expect(values).toEqual(["lsr:discord_purged"])
}

function message(id: string, authorId: string): MessageRow {
  return { id, channelId: "c-1", authorId, createdAt: new Date("2026-10-22T12:00:00.000Z"), editedAt: null, contentLength: 40, attachments: 0, isReply: false, poll: null, lastSeenAt: AT }
}

describe("prismaDiscordStore.savePage", () => {
  it("takes the purge lock first, then leaves rows by a purged member out of the inserts and the updates", async () => {
    const result = await prismaDiscordStore.savePage("c-1", {
      insert: [message("m-1", MEMBER), message("m-2", PURGED)],
      update: [message("m-3", PURGED), message("m-4", MEMBER)],
      touch: ["m-5"],
      at: AT,
      cursor: { lastMessageId: "m-4", lastSyncedAt: AT },
    })
    expect(result).toEqual({ added: 1 })
    expectLockedRead()
    // The lock comes before the channel row's FOR SHARE, as the purge takes it before any row
    expect(tx.log[2]).toBe("$queryRaw")
    expect(argsOf<{ data: MessageRow[] }>(tx.discordMessage.createMany).flatMap((a) => a.data.map((row) => row.id))).toEqual(["m-1"])
    expect(argsOf<{ where: unknown }>(tx.discordMessage.updateMany).map((a) => a.where)).toEqual([{ id: "m-4" }, { id: { in: ["m-5"] } }])
    expect(writes()).not.toContain(PURGED)
  })

  it("writes nothing once the channel isn't opted in", async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ synced: false }])
    expect(await prismaDiscordStore.savePage("c-1", { insert: [message("m-1", MEMBER)], cursor: { lastSyncedAt: AT } })).toBeNull()
    expect(writes()).toBe("[[],[],[],[],[],[]]")
  })
})

describe("prismaDiscordStore.saveChannels", () => {
  const thread = (id: string, name: string, ownerId: string | null): ChannelInput => ({ id, name, type: 11, parentId: "c-1", parentName: null, ownerId })

  it("saves a thread a purged member started as 'a thread' with no owner, when it's new and when it's updated", async () => {
    useTransaction(transaction({ channels: [thread("t-2", "Their old title", PURGED), thread("t-3", "Same title", MEMBER)] }))
    await prismaDiscordStore.saveChannels([
      thread("t-1", "Their forum post", PURGED),
      thread("t-2", "Their new title", PURGED),
      thread("t-3", "Same title", MEMBER),
      thread("t-4", "A member's post", OTHER),
    ])
    expectLockedRead()
    expect(argsOf<{ data: unknown[] }>(tx.discordChannel.createMany).flatMap((a) => a.data)).toEqual([
      { ...thread("t-1", "a thread", null), synced: false },
      { ...thread("t-4", "A member's post", OTHER), synced: false },
    ])
    // t-3 is unchanged, so only t-2 is written
    expect(argsOf(tx.discordChannel.updateMany)).toEqual([{ where: { id: "t-2" }, data: { name: "a thread", type: 11, parentId: "c-1", parentName: null, ownerId: null } }])
    expect(writes()).not.toContain(PURGED)
    expect(writes()).not.toContain("Their")
  })
})

describe("prismaDiscordStore.saveMembers", () => {
  const member = (id: string, username: string): MemberInput => ({ id, username, displayName: null, joinedAt: null, roles: [] })

  it("skips purged members and links members to the accounts linked at the write, read inside the transaction", async () => {
    useTransaction(
      transaction({
        members: [{ ...member(OTHER, "other"), userId: null, leftAt: null }],
        links: [
          { id: "user-1", discordUserId: MEMBER },
          { id: "user-2", discordUserId: OTHER },
        ],
      }),
    )
    expect(await prismaDiscordStore.saveMembers([member(PURGED, "purged"), member(MEMBER, "member"), member(OTHER, "other")], AT)).toEqual({ joined: 1 })
    expectLockedRead()
    expect(tx.log).toContain("user.findMany")
    expect(argsOf<{ data: unknown[] }>(tx.discordMember.createMany).flatMap((a) => a.data)).toEqual([{ ...member(MEMBER, "member"), userId: "user-1", firstSeenAt: AT, lastSeenAt: AT }])
    expect(argsOf(tx.discordMember.updateMany)).toEqual([
      { where: { id: OTHER }, data: { username: "other", displayName: null, joinedAt: null, roles: [], userId: "user-2", leftAt: null } },
      { where: { id: { in: [MEMBER, OTHER] } }, data: { lastSeenAt: AT } },
    ])
    expect(writes()).not.toContain(PURGED)
  })
})
