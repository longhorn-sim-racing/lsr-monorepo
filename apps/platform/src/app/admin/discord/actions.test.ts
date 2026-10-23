import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => {
  const db = {
    $transaction: vi.fn(),
    userRole: { count: vi.fn() },
    user: { findUnique: vi.fn() },
    discordChannel: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    discordMessage: { deleteMany: vi.fn() },
    discordDailyStat: { deleteMany: vi.fn() },
    discordMember: { findMany: vi.fn() },
  }
  return db
})
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
const service = vi.hoisted(() => ({ purgeDiscordData: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/audit/log", () => audit)
vi.mock("next/cache", () => cache)
vi.mock("@/server/services/discord-link.service", () => service)

import { purgeDiscordMemberAction, setDiscordChannelSyncedAction } from "./actions"

const GENERAL = "1100000000000000010"
const THREAD = "1100000000000000099"
const DISCORD_ID = "1234567890123456789"

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "admin-1" })
  db.userRole.count.mockResolvedValue(1)
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db))
  db.discordChannel.findUnique.mockResolvedValue({ id: GENERAL, name: "general", type: 0, parentId: null, synced: false })
  db.discordChannel.findMany.mockResolvedValue([{ id: THREAD }])
  db.discordMessage.deleteMany.mockResolvedValue({ count: 240 })
  service.purgeDiscordData.mockResolvedValue({ messages: 12, member: true, unlinkedUserId: null })
})

describe("setDiscordChannelSyncedAction", () => {
  it("is admin-only: an officer gets a message and nothing changes", async () => {
    db.userRole.count.mockResolvedValue(0)
    expect(await setDiscordChannelSyncedAction(GENERAL, true)).toEqual({ ok: false, error: expect.stringMatching(/Only admins/) })
    expect(db.discordChannel.update).not.toHaveBeenCalled()
  })

  it("throws for someone who isn't an officer", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("Requires one of the following roles: admin, officer"))
    await expect(setDiscordChannelSyncedAction(GENERAL, true)).rejects.toThrow(/roles/)
  })

  it("opts a channel in, audited", async () => {
    expect(await setDiscordChannelSyncedAction(GENERAL, true)).toEqual({ ok: true, data: { changed: true, deleted: 0 } })
    expect(db.discordChannel.update).toHaveBeenCalledWith({ where: { id: GENERAL }, data: { synced: true } })
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "admin-1", actionType: "ENABLE", entityType: "DISCORD_CHANNEL", entityId: GENERAL, summary: "Opted #general in to the Discord sync" }))
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/discord")
  })

  it("opts a channel out by deleting what's stored from it and its threads, and resetting their cursors", async () => {
    db.discordChannel.findUnique.mockResolvedValue({ id: GENERAL, name: "general", type: 0, parentId: null, synced: true })
    expect(await setDiscordChannelSyncedAction(GENERAL, false)).toEqual({ ok: true, data: { changed: true, deleted: 240 } })
    expect(db.discordMessage.deleteMany).toHaveBeenCalledWith({ where: { channelId: { in: [GENERAL, THREAD] } } })
    expect(db.discordDailyStat.deleteMany).toHaveBeenCalledWith({ where: { channelId: GENERAL } })
    expect(db.discordChannel.updateMany).toHaveBeenCalledWith({ where: { id: { in: [GENERAL, THREAD] } }, data: { lastMessageId: null, lastSyncedAt: null, rescanFrom: null } })
    expect(db.discordChannel.update).toHaveBeenCalledWith({ where: { id: GENERAL }, data: { synced: false } })
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "DISABLE", summary: "Opted #general out of the Discord sync and deleted 240 stored message records", metadata: { deleted: 240 } }))
  })

  it("does nothing when it's already that way, and refuses threads, categories and made-up ids", async () => {
    db.discordChannel.findUnique.mockResolvedValue({ id: GENERAL, name: "general", type: 0, parentId: null, synced: true })
    expect(await setDiscordChannelSyncedAction(GENERAL, true)).toEqual({ ok: true, data: { changed: false, deleted: 0 } })
    expect(audit.createAuditLog).not.toHaveBeenCalled()

    db.discordChannel.findUnique.mockResolvedValue({ id: THREAD, name: "a thread", type: 11, parentId: GENERAL, synced: false })
    expect(await setDiscordChannelSyncedAction(THREAD, true)).toMatchObject({ ok: false })
    db.discordChannel.findUnique.mockResolvedValue({ id: GENERAL, name: "Club", type: 4, parentId: null, synced: false })
    expect(await setDiscordChannelSyncedAction(GENERAL, true)).toMatchObject({ ok: false })
    expect(await setDiscordChannelSyncedAction("../etc", true)).toMatchObject({ ok: false })
    expect(db.discordChannel.update).not.toHaveBeenCalled()
  })
})

describe("purgeDiscordMemberAction", () => {
  it("is admin-only", async () => {
    db.userRole.count.mockResolvedValue(0)
    expect(await purgeDiscordMemberAction({ discordUserId: DISCORD_ID })).toEqual({ ok: false, error: expect.stringMatching(/Only admins/) })
    expect(service.purgeDiscordData).not.toHaveBeenCalled()
  })

  it("purges by Discord id, as the admin", async () => {
    expect(await purgeDiscordMemberAction({ discordUserId: ` ${DISCORD_ID} ` })).toEqual({ ok: true, data: { messages: 12, member: true, unlinkedUserId: null } })
    expect(service.purgeDiscordData).toHaveBeenCalledWith(DISCORD_ID, { userId: "admin-1" })
  })

  it("finds the account by a unique username, or by a member's link", async () => {
    db.discordMember.findMany.mockResolvedValue([{ id: DISCORD_ID }])
    await purgeDiscordMemberAction({ username: "@Avery.Reyes" })
    expect(db.discordMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { username: { equals: "Avery.Reyes", mode: "insensitive" } } }))
    expect(service.purgeDiscordData).toHaveBeenLastCalledWith(DISCORD_ID, { userId: "admin-1" })

    db.user.findUnique.mockResolvedValue({ discordUserId: DISCORD_ID })
    service.purgeDiscordData.mockResolvedValue({ messages: 3, member: false, unlinkedUserId: "user-9" })
    await purgeDiscordMemberAction({ userId: "user-9" })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/users/user-9/edit")
  })

  it("says what's wrong instead of guessing", async () => {
    expect(await purgeDiscordMemberAction({ discordUserId: "123" })).toEqual({ ok: false, error: expect.stringMatching(/17 to 20 digits/) })
    db.discordMember.findMany.mockResolvedValue([])
    expect(await purgeDiscordMemberAction({ username: "nobody" })).toEqual({ ok: false, error: expect.stringMatching(/Nobody called @nobody/) })
    db.discordMember.findMany.mockResolvedValue([{ id: "1" }, { id: "2" }])
    expect(await purgeDiscordMemberAction({ username: "twin" })).toEqual({ ok: false, error: expect.stringMatching(/More than one/) })
    db.user.findUnique.mockResolvedValue({ discordUserId: null })
    expect(await purgeDiscordMemberAction({ userId: "user-1" })).toEqual({ ok: false, error: expect.stringMatching(/no Discord account linked/) })
    expect(await purgeDiscordMemberAction({})).toEqual({ ok: false, error: "Enter a Discord user ID or username." })
    expect(service.purgeDiscordData).not.toHaveBeenCalled()
  })
})
