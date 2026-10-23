import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { DiscordApiError, discordClient } from "./client"
import { FAKE_CHANNELS, FAKE_DISCORD, fakeRoles } from "./fake/data"
import { discordFake } from "./fake/handlers"
import { DiscordRateLimiter } from "./rate-limit"
import { botRoleCheck, botRoleProblem, botStanding, discordWriter, messageProblems, moderationPermissions, roleSyncRefusal, type DiscordRole } from "./write"

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  const fakes = mountFakes([discordFake])
  const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() })
  return { fakes, client, writer: discordWriter(client.rest, client.guildId) }
}

const hook = (fakes: MountedFakes, method: string, path: string, body?: unknown) => fetch(`${fakes.origin}/discord/_fake/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })
const writes = async (fakes: MountedFakes) => ((await (await hook(fakes, "GET", "writes")).json()) as { writes: { method: string; path: string; body: Record<string, unknown> }[]; events: { id: string; user_count: number; status: number }[] })

const role = (over: Partial<DiscordRole>): DiscordRole => ({ id: "300000000000000001", name: "Role", position: 1, permissions: "0", managed: false, mentionable: false, ...over })

describe("message limits", () => {
  it("name every problem Discord would refuse", () => {
    expect(messageProblems({ allowed_mentions: { parse: [] } })).toEqual(["The message is empty."])
    expect(messageProblems({ content: "x".repeat(2001), allowed_mentions: { parse: [] } })[0]).toMatch(/2001 characters/)
    expect(messageProblems({ content: "ok", embeds: Array.from({ length: 11 }, () => ({ title: "t" })), allowed_mentions: { parse: [] } })[0]).toMatch(/11 embeds/)
    expect(messageProblems({ embeds: [{ description: "x".repeat(4000) }, { description: "x".repeat(2500) }], allowed_mentions: { parse: [] } })).toEqual([expect.stringMatching(/6500 characters/)])
    const poll = (answers: string[], duration = 24, question = "Night?") => ({ poll: { question: { text: question }, answers: answers.map((text) => ({ poll_media: { text } })), duration, allow_multiselect: false }, allowed_mentions: { parse: [] as [] } })
    expect(messageProblems(poll(["Mon", "Wed"]))).toEqual([])
    expect(messageProblems(poll(Array.from({ length: 11 }, (_, i) => `a${i}`)))).toHaveLength(1)
    expect(messageProblems(poll(["x".repeat(56)]))).toHaveLength(1)
    expect(messageProblems(poll(["a"], 769))).toHaveLength(1)
    expect(messageProblems(poll(["a"], 24, "q".repeat(301)))).toHaveLength(1)
  })
})

describe("posting against the fake", () => {
  it("posts with enforce_nonce: the same nonce again returns the first message instead of posting twice", async () => {
    const { fakes, writer } = setup()
    const body = { content: "GM 2 is Monday", allowed_mentions: { parse: [] as [] } }
    const first = await writer.createMessage(FAKE_CHANNELS.announcements, body, "nonce-abc")
    const again = await writer.createMessage(FAKE_CHANNELS.announcements, body, "nonce-abc")
    expect(again.id).toBe(first.id)
    const sent = (await writes(fakes)).writes.filter((w) => w.path.endsWith("/messages"))
    expect(sent).toHaveLength(2)
    expect(sent[0].body).toMatchObject({ nonce: "nonce-abc", enforce_nonce: true, allowed_mentions: { parse: [] } })
    // It's in the channel's history now, as the bot's
    const recent = await writer.messagesAfter(FAKE_CHANNELS.announcements, "0")
    expect(recent.filter((m) => m.content === "GM 2 is Monday")).toHaveLength(1)
    expect(recent[0].author.bot).toBe(true)
  })

  it("posts again with the same nonce once Discord's window has passed", async () => {
    const { fakes, writer } = setup()
    const body = { content: "Hi", allowed_mentions: { parse: [] as [] } }
    const first = await writer.createMessage(FAKE_CHANNELS.general, body, "nonce-late")
    await hook(fakes, "POST", "clock", { advanceMs: 4 * 60_000 })
    const second = await writer.createMessage(FAKE_CHANNELS.general, body, "nonce-late")
    expect(second.id).not.toBe(first.id)
  })

  it("gets Discord's refusals as errors: too long, a channel it can't see, a forum", async () => {
    const { writer } = setup()
    const long = writer.createMessage(FAKE_CHANNELS.general, { content: "x".repeat(2001), allowed_mentions: { parse: [] } }, "n1")
    await expect(long).rejects.toMatchObject({ status: 400, code: 50035 })
    await expect(writer.createMessage(FAKE_CHANNELS.officers, { content: "hi", allowed_mentions: { parse: [] } }, "n2")).rejects.toMatchObject({ status: 403, code: 50001 })
    await expect(writer.createMessage(FAKE_CHANNELS.setups, { content: "hi", allowed_mentions: { parse: [] } }, "n3")).rejects.toBeInstanceOf(DiscordApiError)
  })

  it("posts a poll and ends it early", async () => {
    const { writer } = setup()
    const sent = await writer.createMessage(FAKE_CHANNELS.lscChat, { poll: { question: { text: "Next track?" }, answers: [{ poll_media: { text: "Monza" } }, { poll_media: { text: "Spa" } }], duration: 48, allow_multiselect: false }, allowed_mentions: { parse: [] } }, "n-poll")
    expect(sent.poll?.question.text).toBe("Next track?")
    const ended = await writer.expirePoll(FAKE_CHANNELS.lscChat, sent.id)
    expect(ended.poll?.results?.is_finalized).toBe(true)
  })
})

describe("role safety", () => {
  const guildId = FAKE_DISCORD.guildId

  it("names a role's moderation permissions (Administrator stands for them all)", () => {
    expect(moderationPermissions(role({ permissions: "0" }))).toEqual([])
    expect(moderationPermissions(role({ permissions: String(BigInt(1) << BigInt(40)) }))).toEqual(["Timeout Members"])
    expect(moderationPermissions(role({ permissions: "8" }))).toEqual(["Administrator"])
    expect(moderationPermissions(role({ permissions: "not a number" }))).toEqual(["Administrator"])
  })

  it("refuses @everyone, managed roles, moderation roles and roles at or above the bot's; allows a plain role below it", () => {
    expect(roleSyncRefusal(undefined, { guildId, botTop: 3 })).toMatch(/no longer exists/)
    expect(roleSyncRefusal(role({ id: guildId, name: "@everyone", position: 0 }), { guildId, botTop: 3 })).toMatch(/@everyone/)
    expect(roleSyncRefusal(role({ managed: true }), { guildId, botTop: 3 })).toMatch(/integration or a bot/)
    expect(roleSyncRefusal(role({ name: "Mods", permissions: String(BigInt(1) << BigInt(13)) }), { guildId, botTop: 3 })).toMatch(/moderation permissions \(Manage Messages\)/)
    expect(roleSyncRefusal(role({ position: 3 }), { guildId, botTop: 3 })).toMatch(/at or above the bot's own role/)
    expect(roleSyncRefusal(role({ position: 2 }), { guildId, botTop: 3 })).toBeNull()
  })

  it("checks the bot's place for the smoke test: below the admin roles, without Administrator", () => {
    const roles = fakeRoles()
    const bot = [FAKE_DISCORD.roles.bot]
    expect(botRoleProblem(roles, bot)).toBeNull()
    expect(botStanding(roles, bot)).toMatchObject({ top: 3, administrator: false, mentionEveryone: false })
    // Moved above the Officer and Admin roles: the admin roles are below it
    const raised = roles.map((r) => (r.id === FAKE_DISCORD.roles.bot ? { ...r, position: 9 } : r))
    expect(botRoleProblem(raised, bot)).toMatch(/sits above @Admin/)
    // Given Administrator
    const admin = roles.map((r) => (r.id === FAKE_DISCORD.roles.bot ? { ...r, permissions: "8" } : r))
    expect(botRoleProblem(admin, bot)).toMatch(/has Administrator/)
  })

  it("reads the bot's place live for the smoke test", async () => {
    const { fakes, client } = setup()
    expect(await botRoleCheck(client)).toBeNull()
    await hook(fakes, "PATCH", `roles/${FAKE_DISCORD.roles.bot}`, { position: 10 })
    expect(await botRoleCheck(client)).toMatch(/sits above/)
  })

  it("adds and removes a plain role below the bot's; Discord refuses one above it", async () => {
    const { fakes, writer } = setup()
    expect((await writer.member(FAKE_DISCORD.botUserId)).roles).toEqual([FAKE_DISCORD.roles.bot])
    await expect(writer.addRole("100000000000000001", FAKE_DISCORD.roles.lscDriver, "test")).rejects.toMatchObject({ code: 10007 })
    const [first] = await discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() }).members({ limit: 1 })
    const id = first.user.id
    await expect(writer.addRole(id, FAKE_DISCORD.roles.alumni, "test")).rejects.toMatchObject({ status: 403, code: 50013 })
    await expect(writer.addRole(id, FAKE_DISCORD.roles.bot, "test")).rejects.toMatchObject({ status: 403, code: 50013 })
    await writer.removeRole(id, FAKE_DISCORD.roles.member, "test")
    expect((await writer.member(id)).roles).not.toContain(FAKE_DISCORD.roles.member)
    await writer.addRole(id, FAKE_DISCORD.roles.member, "LSR website: role sync")
    expect((await writer.member(id)).roles).toContain(FAKE_DISCORD.roles.member)
    // Only the two that worked were written; the reason goes in Discord's audit log header
    const roleWrites = (await writes(fakes)).writes.filter((w) => w.path.includes("/roles/"))
    expect(roleWrites.map((w) => w.method)).toEqual(["DELETE", "PUT"])
    expect(fakes.requests.filter((r) => r.method === "PUT").at(-1)?.headers.get("x-audit-log-reason")).toBe(encodeURIComponent("LSR website: role sync"))
  })
})

describe("scheduled events against the fake", () => {
  const start = () => new Date(Date.now() + 3 * 86_400_000)
  const input = (at = start()) => ({ name: "GM 2", description: "Details: https://www.longhornsimracing.org/events/gm-2", scheduled_start_time: at.toISOString(), scheduled_end_time: new Date(at.getTime() + 7_200_000).toISOString(), entity_metadata: { location: "Alienware Lounge" }, channel_id: null, privacy_level: 2 as const, entity_type: 3 as const })

  it("creates an external event, edits it, reads interested counts and deletes it", async () => {
    const { fakes, writer } = setup()
    const created = await writer.createScheduledEvent(input(), "test")
    expect(created).toMatchObject({ name: "GM 2", status: 1, entity_type: 3, channel_id: null })
    await writer.updateScheduledEvent(created.id, { name: "GM 2 (moved)" }, "test")
    await hook(fakes, "POST", "interested", { eventId: created.id, count: 12 })
    const listed = await writer.scheduledEvents()
    expect(listed).toEqual([expect.objectContaining({ id: created.id, name: "GM 2 (moved)", user_count: 12 })])
    await writer.deleteScheduledEvent(created.id, "test")
    await expect(writer.deleteScheduledEvent(created.id, "test")).rejects.toMatchObject({ status: 404, code: 10070 })
  })

  it("refuses an external event without a location or an end, and one in the past", async () => {
    const { writer } = setup()
    await expect(writer.createScheduledEvent({ ...input(), entity_metadata: { location: "" } }, "t")).rejects.toMatchObject({ code: 50035 })
    await expect(writer.createScheduledEvent({ ...input(), scheduled_end_time: "" }, "t")).rejects.toMatchObject({ code: 50035 })
    await expect(writer.createScheduledEvent(input(new Date(Date.now() - 86_400_000)), "t")).rejects.toMatchObject({ code: 50035 })
  })

  it("starts and completes events by the fake's clock, and lists only open ones", async () => {
    const { fakes, writer } = setup()
    const created = await writer.createScheduledEvent(input(), "t")
    await hook(fakes, "POST", "clock", { advanceMs: 3 * 86_400_000 + 60_000 })
    expect((await writer.scheduledEvents())[0].status).toBe(2)
    await hook(fakes, "POST", "clock", { advanceMs: 3 * 3_600_000 })
    expect(await writer.scheduledEvents()).toEqual([])
    await expect(writer.updateScheduledEvent(created.id, { name: "late" }, "t")).rejects.toMatchObject({ code: 50035 })
  })
})
