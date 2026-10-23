import { beforeEach, describe, expect, it, vi } from "vitest"

const connector = vi.hoisted(() => ({ client: vi.fn() }))
const sync = vi.hoisted(() => ({ syncMessages: vi.fn(), rescan: vi.fn(), syncMembers: vi.fn(), DEFAULT_BACKFILL_DAYS: 90 }))
const state = vi.hoisted(() => ({ recordConnectorSync: vi.fn(), recordConnectorError: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const db = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  discordChannel: { findMany: vi.fn(), deleteMany: vi.fn() },
  discordMessage: { deleteMany: vi.fn() },
  discordMember: { deleteMany: vi.fn() },
}))

vi.mock("@/server/connectors/discord/connector", () => ({ discordConnector: connector, DISCORD_CONNECTOR: "discord" }))
vi.mock("@/server/connectors/discord/sync", () => sync)
vi.mock("@/server/connectors/discord/store", () => ({ prismaDiscordStore: { kind: "prisma" } }))
vi.mock("@/server/connectors/state", () => state)
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/db", () => ({ prisma: db }))

import type { JobContext } from "../types"
import { discordMembersJob, discordPruneJob, discordRescanJob, discordSyncJob, JOBS } from "./discord-read"

function context(config: unknown = null) {
  const lines: string[] = []
  const ctx: JobContext = {
    signal: new AbortController().signal,
    deadline: Date.now() + 110_000,
    startedAt: Date.now(),
    log: (line) => lines.push(line),
    config,
    job: { id: "job-1", key: "discord.sync" },
  }
  return { ctx, lines }
}

const messageResult = { channels: 2, threads: 1, added: 41, unfinished: 0, days: 3, problems: [], gone: [], threadsGone: 0 }
const rescanResult = { channels: 3, added: 1, updated: 2, deleted: 4, polls: 1, unfinished: 0, days: 8, problems: [], gone: [], threadsGone: 0 }

beforeEach(() => {
  connector.client.mockResolvedValue({ guildId: "g" })
})

describe("the discord-read jobs", () => {
  it("are the sync, the re-scan, members and the prune", () => {
    expect(JOBS.map((j) => j.kind)).toEqual(["discord.sync", "discord.rescan", "discord.members", "discord.prune"])
  })

  it("skip while Discord is off or not set up, without touching the connector's status", async () => {
    connector.client.mockResolvedValue(null)
    for (const job of [discordSyncJob, discordRescanJob, discordMembersJob]) expect(await job.run(context().ctx)).toEqual({ summary: expect.stringContaining("isn't connected"), status: "skipped" })
    expect(sync.syncMessages).not.toHaveBeenCalled()
    expect(state.recordConnectorSync).not.toHaveBeenCalled()
  })

  it("syncs with the run's signal and deadline, the database store and the backfill from its config, and stamps the connector", async () => {
    sync.syncMessages.mockResolvedValue(messageResult)
    const { ctx } = context({ backfillDays: 30 })
    expect(await discordSyncJob.run(ctx)).toEqual({ summary: "Synced 2 channels and 1 thread: 41 new messages", counts: { channels: 2, threads: 1, messages: 41, days: 3 } })
    expect(sync.syncMessages).toHaveBeenCalledWith(expect.objectContaining({ client: { guildId: "g" }, store: { kind: "prisma" }, signal: ctx.signal, deadline: ctx.deadline }), { backfillDays: 30 })
    expect(state.recordConnectorSync).toHaveBeenCalledWith("discord")
    expect(state.recordConnectorError).not.toHaveBeenCalled()
  })

  it("ignores a config it can't read, and says when channels didn't finish", async () => {
    sync.syncMessages.mockResolvedValue({ ...messageResult, unfinished: 2 })
    const { ctx, lines } = context({ backfillDays: 9000 })
    await discordSyncJob.run(ctx)
    expect(sync.syncMessages).toHaveBeenCalledWith(expect.anything(), { backfillDays: undefined })
    expect(lines).toEqual(["2 channels didn't finish; the next run picks up where this one stopped."])
  })

  it("keeps what worked but fails the run, naming the channels it couldn't read", async () => {
    sync.syncMessages.mockResolvedValue({ ...messageResult, problems: [{ channel: "#officers", error: "Discord answered 403 (code 50001 Missing Access) on GET /channels/:id/messages" }] })
    await expect(discordSyncJob.run(context().ctx)).rejects.toThrow("Synced 2 channels and 1 thread: 41 new messages. Couldn't read #officers (Discord answered 403")
    expect(state.recordConnectorSync).toHaveBeenCalledWith("discord")
    expect(state.recordConnectorError).toHaveBeenCalledTimes(1)
  })

  it("records a failure as the connector's last error and lets it throw", async () => {
    const failure = new Error("Discord answered 401 on GET /guilds/:id/channels")
    sync.rescan.mockRejectedValue(failure)
    await expect(discordRescanJob.run(context().ctx)).rejects.toBe(failure)
    expect(state.recordConnectorError).toHaveBeenCalledWith("discord", failure)
    expect(state.recordConnectorSync).not.toHaveBeenCalled()
  })

  it("records an opted-in channel Discord deleted (switched off by the sync) in the audit log and the summary, without failing", async () => {
    sync.syncMessages.mockResolvedValue({ ...messageResult, gone: [{ id: "1100000000000000010", name: "old-events", messages: 12 }], threadsGone: 2 })
    const { ctx, lines } = context()
    expect((await discordSyncJob.run(ctx)).summary).toBe("Synced 2 channels and 1 thread: 41 new messages; #old-events deleted in Discord (switched off), 2 threads deleted in Discord")
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: null,
      actionType: "DISABLE",
      entityType: "DISCORD_CHANNEL",
      entityId: "1100000000000000010",
      summary: "#old-events no longer exists in Discord: switched it off and deleted 12 stored message records",
      before: { synced: true },
      after: { synced: false },
      metadata: { deleted: 12, deletedInDiscord: true },
    })
    expect(lines).toEqual(["#old-events no longer exists in Discord: switched it off and deleted 12 stored message records", "2 threads deleted in Discord, dropped with their messages."])
    expect(state.recordConnectorError).not.toHaveBeenCalled()

    sync.rescan.mockResolvedValue({ ...rescanResult, threadsGone: 1 })
    expect((await discordRescanJob.run(context().ctx)).summary).toBe("Read 3 channels again: 4 deleted, 2 updated, 1 added, 1 older poll refreshed; 1 thread deleted in Discord")
  })

  it("sums up a re-scan and a member sync", async () => {
    sync.rescan.mockResolvedValue(rescanResult)
    expect((await discordRescanJob.run(context().ctx)).summary).toBe("Read 3 channels again: 4 deleted, 2 updated, 1 added, 1 older poll refreshed")
    sync.rescan.mockResolvedValue({ ...rescanResult, channels: 1, added: 0, updated: 0, deleted: 0, polls: 0 })
    expect((await discordRescanJob.run(context().ctx)).summary).toBe("Read 1 channel again: no changes")

    sync.syncMembers.mockResolvedValue({ members: 40, joined: 1, left: 0, complete: false, memberCount: 40, joinedToday: 1, leftToday: 0 })
    const { ctx, lines } = context()
    expect(await discordMembersJob.run(ctx)).toEqual({ summary: "40 members; today 1 joined, 0 left", counts: { members: 40, new: 1, left: 0 } })
    expect(lines[0]).toMatch(/didn't finish/)
  })

  it("prunes metadata older than a year even while Discord is off, keeping the daily totals", async () => {
    connector.client.mockResolvedValue(null)
    db.$executeRaw.mockResolvedValue(0)
    db.discordChannel.findMany.mockResolvedValue([])
    db.discordMessage.deleteMany.mockResolvedValue({ count: 120 })
    db.discordMember.deleteMany.mockResolvedValue({ count: 2 })
    const before = Date.now()
    expect(await discordPruneJob.run(context().ctx)).toEqual({ summary: "Deleted 120 messages and 2 former members older than 365 days", counts: { messages: 120, members: 2, threads: 0, leftover: 0 } })
    const cutoff = db.discordMessage.deleteMany.mock.calls[0][0].where.createdAt.lt as Date
    expect(Math.abs(cutoff.getTime() - (before - 365 * 86_400_000))).toBeLessThan(5_000)
    expect(db.discordMember.deleteMany).toHaveBeenCalledWith({ where: { leftAt: { lt: cutoff } } })
    expect(db.discordChannel.deleteMany).not.toHaveBeenCalled()
  })

  it("prunes threads not read for a year, and whatever is left from channels that aren't opted in", async () => {
    // Threads in channels that aren't opted in, then message records, then daily totals
    db.$executeRaw.mockResolvedValueOnce(2).mockResolvedValueOnce(30).mockResolvedValueOnce(4)
    const old = new Date(Date.now() - 400 * 86_400_000)
    db.discordChannel.findMany.mockResolvedValue([
      { id: "1100000000000000077", lastSyncedAt: old },
      // Never read, made (by its id) in 2023: older than a year
      { id: "1142880731136000001", lastSyncedAt: null },
      // Never read, made just now
      { id: (BigInt(Date.now() - 1_420_070_400_000) << BigInt(22)).toString(), lastSyncedAt: null },
    ])
    db.discordChannel.deleteMany.mockResolvedValue({ count: 2 })
    db.discordMessage.deleteMany.mockResolvedValue({ count: 0 })
    db.discordMember.deleteMany.mockResolvedValue({ count: 0 })
    expect(await discordPruneJob.run(context().ctx)).toEqual({
      summary: "Nothing older than 365 days; 2 threads not read for 365 days; 36 leftover records from channels that aren't opted in",
      counts: { messages: 0, members: 0, threads: 4, leftover: 34 },
    })
    const where = db.discordChannel.deleteMany.mock.calls[0][0].where
    expect(where.id.in).toEqual(["1100000000000000077", "1142880731136000001"])
    // Checked again as it deletes, so a thread read meanwhile stays
    expect(where.OR).toEqual([{ lastSyncedAt: { lt: expect.any(Date) } }, { lastSyncedAt: null }])
    const statements = db.$executeRaw.mock.calls.map((call) => (call[0] as { sql: string }).sql)
    expect(statements[0]).toMatch(/DELETE FROM "DiscordChannel" t[\s\S]*"parentId" IS NOT NULL[\s\S]*p\.synced/)
    expect(statements[1]).toMatch(/DELETE FROM "DiscordMessage" m[\s\S]*NOT EXISTS[\s\S]*o\.synced/)
    expect(statements[2]).toMatch(/DELETE FROM "DiscordDailyStat" s[\s\S]*c\.synced/)
  })
})
