import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  posting: null as unknown,
  allowed: ["1100000000000000001"],
  sendDuePosts: vi.fn(),
  runDiscordRules: vi.fn(),
  rulePostProblem: vi.fn(),
  runEventMirror: vi.fn(),
  runRoleSync: vi.fn(),
  recordConnectorError: vi.fn(),
}))
vi.mock("@/server/discord-post/connection", () => ({ discordPosting: async () => mocks.posting }))
vi.mock("@/server/discord-post/channels", () => ({ postingChannelIds: async () => mocks.allowed }))
vi.mock("@/server/discord-post/outbox", () => ({ sendDuePosts: mocks.sendDuePosts }))
vi.mock("@/server/discord-post/rule-runner", () => ({ runDiscordRules: mocks.runDiscordRules, rulePostProblem: mocks.rulePostProblem }))
vi.mock("@/server/discord-post/event-mirror", () => ({ runEventMirror: mocks.runEventMirror }))
vi.mock("@/server/discord-post/role-sync", () => ({ runRoleSync: mocks.runRoleSync }))
vi.mock("@/server/connectors/state", () => ({ recordConnectorError: mocks.recordConnectorError }))
vi.mock("@/server/connectors/discord/connector", () => ({ DISCORD_CONNECTOR: "discord" }))

import type { DiscordPost } from "@prisma/client"
import type { JobContext } from "../types"
import { discordEventMirrorJob, discordPostsJob, discordRoleSyncJob, discordRulesJob, JOBS } from "./discord-post"

const ctx = (): JobContext => ({ signal: new AbortController().signal, deadline: Date.now() + 60_000, startedAt: Date.now(), log: () => {}, config: null, job: { id: "job-1", key: "x" } })

beforeEach(() => {
  mocks.posting = { writer: {}, client: {} }
  mocks.allowed = ["1100000000000000001"]
  for (const fn of [mocks.sendDuePosts, mocks.runDiscordRules, mocks.rulePostProblem, mocks.runEventMirror, mocks.runRoleSync, mocks.recordConnectorError]) fn.mockReset()
})

describe("the discord-post jobs", () => {
  it("are the posts sender, the rules dispatcher, the event mirror and role sync", () => {
    expect(JOBS.map((j) => [j.kind, j.defaultSchedule])).toEqual([
      ["discord.posts", "*/2 * * * *"],
      ["discord.rules", "*/5 * * * *"],
      ["discord.event-mirror", "*/15 * * * *"],
      ["discord.role-sync", "27 * * * *"],
    ])
  })

  it("all skip while Discord is off or not set up", async () => {
    mocks.posting = null
    for (const job of JOBS) expect(await job.run(ctx())).toMatchObject({ status: "skipped" })
    expect(mocks.sendDuePosts).not.toHaveBeenCalled()
  })

  it("checks each due post's channel, and a rule's post against its rule, before sending", async () => {
    mocks.sendDuePosts.mockImplementation(async (_writer, opts: { check: (post: DiscordPost, now: Date) => Promise<string | null> }) => {
      expect(await opts.check({ channelId: "1100000000000000999", source: "proposal" } as DiscordPost, new Date())).toBe("Its channel isn't a posting channel anymore.")
      mocks.rulePostProblem.mockResolvedValue("Its rule is switched off.")
      expect(await opts.check({ channelId: "1100000000000000001", source: "rule" } as DiscordPost, new Date())).toBe("Its rule is switched off.")
      expect(await opts.check({ channelId: "1100000000000000001", source: "admin" } as DiscordPost, new Date())).toBeNull()
      return { sent: 2, failed: 1, cancelled: 0, deferred: 0, confirmed: 0, links: [] }
    })
    expect(await discordPostsJob.run(ctx())).toEqual({ summary: "Posts: sent 2, 1 failed", counts: { sent: 2, failed: 1, cancelled: 0, deferred: 0, confirmed: 0 } })
  })

  it("records a run that fails outright on the connector", async () => {
    mocks.sendDuePosts.mockRejectedValue(new Error("Discord answered 401"))
    await expect(discordPostsJob.run(ctx())).rejects.toThrow("Discord answered 401")
    expect(mocks.recordConnectorError).toHaveBeenCalledWith("discord", expect.any(Error))
  })

  it("fails the rules run when a rule failed, after the others ran", async () => {
    mocks.runDiscordRules.mockResolvedValue({ rules: 2, queued: 1, refreshed: 0, cancelled: 0, skipped: 0, errors: ["Event reminders: boom"] })
    await expect(discordRulesJob.run(ctx())).rejects.toThrow("Event reminders: boom (queued 1 post from the other rules)")
    mocks.runDiscordRules.mockResolvedValue({ rules: 2, queued: 3, refreshed: 1, cancelled: 2, skipped: 1, errors: [] })
    expect((await discordRulesJob.run(ctx())).summary).toBe("2 rules: queued 3 posts, 1 updated, 2 cancelled, 1 rule skipped")
    mocks.runDiscordRules.mockResolvedValue({ rules: 0, queued: 0, refreshed: 0, cancelled: 0, skipped: 0, errors: [] })
    expect((await discordRulesJob.run(ctx())).summary).toBe("No standing rules switched on")
  })

  it("says when there's no event mirror or role sync rule", async () => {
    mocks.runEventMirror.mockResolvedValue({ status: "no-rule", created: 0, updated: 0, removed: 0, counted: 0, gone: 0 })
    expect(await discordEventMirrorJob.run(ctx())).toMatchObject({ status: "skipped", summary: "No event mirror rule is switched on" })
    mocks.runEventMirror.mockResolvedValue({ status: "ok", created: 2, updated: 0, removed: 1, counted: 3, gone: 0 })
    expect((await discordEventMirrorJob.run(ctx())).summary).toBe("Discord events: 2 added, 1 removed, 3 interested counts updated")
    mocks.runRoleSync.mockResolvedValue({ rules: 0, added: 0, removed: 0, refused: 0, skipped: 0, waiting: 0 })
    expect((await discordRoleSyncJob.run(ctx())).summary).toBe("No role sync rules switched on")
    mocks.runRoleSync.mockResolvedValue({ rules: 1, added: 3, removed: 1, refused: 1, skipped: 0, waiting: 2 })
    expect((await discordRoleSyncJob.run(ctx())).summary).toBe("Role sync over 1 rule: 3 added, 1 removed, 2 waiting for the next run, 1 rule refused")
  })
})
