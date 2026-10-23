import { beforeEach, describe, expect, it, vi } from "vitest"

const connector = vi.hoisted(() => ({ client: vi.fn() }))
const sync = vi.hoisted(() => ({ syncMessages: vi.fn(), rescan: vi.fn(), syncMembers: vi.fn(), DEFAULT_BACKFILL_DAYS: 90 }))
const state = vi.hoisted(() => ({ recordConnectorSync: vi.fn(), recordConnectorError: vi.fn() }))
const db = vi.hoisted(() => ({ discordMessage: { deleteMany: vi.fn() }, discordMember: { deleteMany: vi.fn() } }))

vi.mock("@/server/connectors/discord/connector", () => ({ discordConnector: connector, DISCORD_CONNECTOR: "discord" }))
vi.mock("@/server/connectors/discord/sync", () => sync)
vi.mock("@/server/connectors/discord/store", () => ({ prismaDiscordStore: { kind: "prisma" } }))
vi.mock("@/server/connectors/state", () => state)
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

const messageResult = { channels: 2, threads: 1, added: 41, unfinished: 0, days: 3, problems: [] }

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

  it("sums up a re-scan and a member sync", async () => {
    sync.rescan.mockResolvedValue({ channels: 3, added: 1, updated: 2, deleted: 4, polls: 1, unfinished: 0, days: 8, problems: [] })
    expect((await discordRescanJob.run(context().ctx)).summary).toBe("Read 3 channels again: 4 deleted, 2 updated, 1 added, 1 older poll refreshed")
    sync.rescan.mockResolvedValue({ channels: 1, added: 0, updated: 0, deleted: 0, polls: 0, unfinished: 0, days: 8, problems: [] })
    expect((await discordRescanJob.run(context().ctx)).summary).toBe("Read 1 channel again: no changes")

    sync.syncMembers.mockResolvedValue({ members: 40, joined: 1, left: 0, complete: false, memberCount: 40, joinedToday: 1, leftToday: 0 })
    const { ctx, lines } = context()
    expect(await discordMembersJob.run(ctx)).toEqual({ summary: "40 members; today 1 joined, 0 left", counts: { members: 40, new: 1, left: 0 } })
    expect(lines[0]).toMatch(/didn't finish/)
  })

  it("prunes metadata older than a year even while Discord is off, keeping the daily totals", async () => {
    connector.client.mockResolvedValue(null)
    db.discordMessage.deleteMany.mockResolvedValue({ count: 120 })
    db.discordMember.deleteMany.mockResolvedValue({ count: 2 })
    const before = Date.now()
    expect(await discordPruneJob.run(context().ctx)).toEqual({ summary: "Deleted 120 messages and 2 former members older than 365 days", counts: { messages: 120, members: 2 } })
    const cutoff = db.discordMessage.deleteMany.mock.calls[0][0].where.createdAt.lt as Date
    expect(Math.abs(cutoff.getTime() - (before - 365 * 86_400_000))).toBeLessThan(5_000)
    expect(db.discordMember.deleteMany).toHaveBeenCalledWith({ where: { leftAt: { lt: cutoff } } })
  })
})
