import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ userRole: { count: vi.fn() } }))
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
const rules = vi.hoisted(() => ({ createRule: vi.fn(), updateRule: vi.fn(), setRuleEnabled: vi.fn(), deleteRule: vi.fn(), isRuleKind: (k: unknown) => typeof k === "string" && ["event_reminder", "new_event", "results_posted", "standings_update", "twitch_live", "event_mirror"].includes(k) }))
const channels = vi.hoisted(() => ({ setPostingChannels: vi.fn() }))
const posts = vi.hoisted(() => ({ createOfficerPost: vi.fn(), cancelScheduledPost: vi.fn(), retryFailedPost: vi.fn() }))
const connection = vi.hoisted(() => ({ discordPosting: vi.fn(), discordPostingForPage: vi.fn(), NOT_CONNECTED: "Discord isn't connected." }))
const roleSync = vi.hoisted(() => ({ readRoles: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("next/cache", () => cache)
vi.mock("@/server/discord-post/rules", () => rules)
vi.mock("@/server/discord-post/channels", () => channels)
vi.mock("@/server/discord-post/officer-posts", () => posts)
vi.mock("@/server/discord-post/connection", () => connection)
vi.mock("@/server/discord-post/role-sync", () => roleSync)

import { cancelPostAction, createPostAction, createRuleAction, deleteRuleAction, retryPostAction, setPostingChannelsAction, setRuleEnabledAction, updateRuleAction } from "./actions"

const CHANNEL = "1100000000000000001"
const ROLE = "1100000000000000011"
const form = { kind: "event_reminder", channelId: CHANNEL, offsets: [1440, 60], series: null, pingRoleId: null }

beforeEach(() => {
  vi.clearAllMocks()
  guards.requireOfficer.mockResolvedValue({ id: "admin-1", displayName: "Gray" })
  db.userRole.count.mockResolvedValue(1)
  rules.createRule.mockResolvedValue({ ok: true, rule: { id: "r1" } })
  rules.updateRule.mockResolvedValue({ ok: true, rule: { id: "r1" } })
  rules.setRuleEnabled.mockResolvedValue({ ok: true, rule: { id: "r1" } })
  rules.deleteRule.mockResolvedValue({ ok: true, rule: { id: "r1" } })
  channels.setPostingChannels.mockResolvedValue({ ok: true, channels: [], changed: true })
  connection.discordPosting.mockResolvedValue({ client: {}, writer: { guildId: "g" } })
  connection.discordPostingForPage.mockResolvedValue({ client: {}, writer: { guildId: "g" } })
  roleSync.readRoles.mockResolvedValue({ roles: [{ id: ROLE, name: "LSC Driver", position: 2, permissions: "0", managed: false, mentionable: true }], botTop: 3, botRoleIds: [], mentionEveryone: false })
  posts.createOfficerPost.mockResolvedValue({ ok: true, status: "SENT", url: "https://discord.com/channels/g/c/m", summary: "Posted in #announcements." })
  posts.cancelScheduledPost.mockResolvedValue({ ok: true })
  posts.retryFailedPost.mockResolvedValue({ ok: true, status: "SENT", url: null, summary: "Posted." })
})

describe("standing rules", () => {
  it("are set up, changed, switched on and deleted by admins only", async () => {
    db.userRole.count.mockResolvedValue(0)
    for (const result of [await createRuleAction(form, true), await updateRuleAction("r1", form), await setRuleEnabledAction("r1", true), await deleteRuleAction("r1")]) {
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/Only admins/) })
    }
    expect(rules.createRule).not.toHaveBeenCalled()
    expect(rules.setRuleEnabled).not.toHaveBeenCalled()
  })

  it("can be paused by any officer", async () => {
    db.userRole.count.mockResolvedValue(0)
    expect(await setRuleEnabledAction("r1", false)).toEqual({ ok: true })
    expect(rules.setRuleEnabled).toHaveBeenCalledWith("r1", false, { userId: "admin-1" })
  })

  it("turn the form into a rule: a reminder's offsets, and a ping's name read from Discord", async () => {
    expect(await createRuleAction({ ...form, pingRoleId: ROLE }, true)).toEqual({ ok: true })
    expect(rules.createRule).toHaveBeenCalledWith({ kind: "event_reminder", channelId: CHANNEL, config: { offsets: [1440, 60], series: null, ping: { type: "role", roleId: ROLE, name: "LSC Driver" } } }, { userId: "admin-1" }, { enabled: true })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/announcements")
    // A role Discord doesn't have, or one the bot can't ping
    expect(await createRuleAction({ ...form, pingRoleId: "1100000000000000999" }, true)).toMatchObject({ ok: false })
    roleSync.readRoles.mockResolvedValue({ roles: [{ id: ROLE, name: "LSC Driver", position: 2, permissions: "0", managed: false, mentionable: false }], botTop: 3, botRoleIds: [], mentionEveryone: false })
    expect(await createRuleAction({ ...form, pingRoleId: ROLE }, true)).toMatchObject({ ok: false, error: expect.stringMatching(/isn't pingable/) })
    // The event mirror has no channel and no ping
    await createRuleAction({ kind: "event_mirror", channelId: CHANNEL, location: "Online", series: null }, false)
    expect(rules.createRule).toHaveBeenLastCalledWith({ kind: "event_mirror", channelId: null, config: { series: null, location: "Online" } }, { userId: "admin-1" }, { enabled: false })
    expect(await createRuleAction({ kind: "spam", channelId: CHANNEL }, true)).toMatchObject({ ok: false })
  })

  it("pass a service's refusal on", async () => {
    rules.updateRule.mockResolvedValue({ ok: false, error: "Someone changed the rule since." })
    expect(await updateRuleAction("r1", form)).toEqual({ ok: false, error: "Someone changed the rule since." })
  })
})

describe("posting channels", () => {
  it("are picked by admins only", async () => {
    expect(await setPostingChannelsAction([CHANNEL])).toEqual({ ok: true })
    expect(channels.setPostingChannels).toHaveBeenCalledWith([CHANNEL], { userId: "admin-1" })
    db.userRole.count.mockResolvedValue(0)
    expect(await setPostingChannelsAction([CHANNEL])).toMatchObject({ ok: false, error: expect.stringMatching(/Only admins/) })
  })
})

describe("posts", () => {
  it("any officer posts, cancels and retries", async () => {
    db.userRole.count.mockResolvedValue(0)
    expect(await createPostAction({ channelId: CHANNEL, text: "Hi" })).toEqual({ ok: true, data: { summary: "Posted in #announcements.", url: "https://discord.com/channels/g/c/m" } })
    expect(posts.createOfficerPost).toHaveBeenCalledWith({ channelId: CHANNEL, text: "Hi" }, { userId: "admin-1", displayName: "Gray" }, expect.anything())
    expect(await cancelPostAction("p1")).toEqual({ ok: true })
    expect(await retryPostAction("p1")).toEqual({ ok: true, data: { summary: "Posted.", url: null } })
  })

  it("won't post while Discord is off", async () => {
    connection.discordPostingForPage.mockResolvedValue(null)
    expect(await createPostAction({ channelId: CHANNEL, text: "Hi" })).toEqual({ ok: false, error: "Discord isn't connected." })
    expect(posts.createOfficerPost).not.toHaveBeenCalled()
  })

  it("tell someone signed out to sign in again", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("no"))
    expect(await createPostAction({ channelId: CHANNEL, text: "Hi" })).toMatchObject({ ok: false, error: expect.stringMatching(/signed out/) })
    expect(await cancelPostAction("p1")).toMatchObject({ ok: false })
  })
})
