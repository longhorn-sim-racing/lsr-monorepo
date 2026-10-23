import { beforeEach, describe, expect, it, vi } from "vitest"
import { postRow } from "./fake-posts"

const db = vi.hoisted(() => ({
  discordChannel: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  discordRule: { findMany: vi.fn() },
  jackProposal: { findMany: vi.fn() },
  discordRoleRule: { findMany: vi.fn() },
  discordMember: { findMany: vi.fn(), count: vi.fn() },
  scheduledJob: { findUnique: vi.fn() },
  systemSetting: { findUnique: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { readableText, roleSyncView, toPostViews } from "./queries"

const CHANNEL = "1100000000000000001"
const ROLE = "1100000000000000011"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("DISCORD_GUILD_ID", "1100000000000000000")
  db.discordChannel.findMany.mockResolvedValue([{ id: CHANNEL, name: "announcements" }])
  db.user.findMany.mockResolvedValue([{ id: "u1", displayName: "Ana" }, { id: "u2", displayName: "Gray" }])
  db.discordRule.findMany.mockImplementation(async (args: { where?: unknown; select?: { config?: boolean; id?: boolean } }) =>
    args.select?.config ? [{ kind: "event_reminder", config: { offsets: [60], ping: { type: "role", roleId: ROLE, name: "LSC Driver" } } }] : [{ id: "r1", kind: "event_reminder" }],
  )
  db.jackProposal.findMany.mockResolvedValue([{ id: "prop-1", roomId: "room-1", messageId: "msg-1" }])
})

describe("the outbox as the page shows it", () => {
  it("shows Discord's markup as words", () => {
    const names = { channels: new Map([[CHANNEL, "announcements"]]), roles: new Map([[ROLE, "LSC Driver"]]) }
    expect(readableText(`<@&${ROLE}> see <#${CHANNEL}> at <t:1793055600:F> <@123456789012345678>`, names)).toBe("@LSC Driver see #announcements at Mon Oct 26, 6:00 PM CT @member")
  })

  it("says where each post came from, when, who it pings, and links the sent ones", async () => {
    const views = await toPostViews(
      [
        postRow({ id: "a", source: "rule", ruleId: "r1", channelId: CHANNEL, content: { content: `<@&${ROLE}> Reminder`, allowed_mentions: { parse: [], roles: [ROLE] } }, status: "SCHEDULED", scheduledFor: new Date("2026-10-26T23:00:00Z") }),
        postRow({ id: "b", source: "proposal", proposalId: "prop-1", approvedById: "u2", channelId: CHANNEL, status: "SENT", sentAt: new Date("2026-10-22T23:00:00Z"), discordMessageId: "1300000000000000555" }),
        postRow({ id: "c", source: "admin", createdById: "u1", channelId: CHANNEL, status: "FAILED", error: "The bot isn't allowed to post in #announcements" }),
        postRow({ id: "d", source: "rule", ruleId: "deleted", channelId: "1100000000000000999", status: "CANCELLED" }),
      ],
      new Date("2026-10-23T17:00:00Z"),
    )
    expect(views.map((v) => [v.from, v.channel, v.when, v.ping, v.url])).toEqual([
      ["Event reminders", "#announcements", "Sends Mon Oct 26, 6:00 PM CT", "@LSC Driver", null],
      ["Jack, applied by Gray", "#announcements", "Sent Thu Oct 22, 6:00 PM CT", null, "https://discord.com/channels/1100000000000000000/1100000000000000001/1300000000000000555"],
      ["Ana", "#announcements", "Failed, due Fri Oct 23, 7:00 AM CT", null, null],
      ["A deleted rule", "#1100000000000000999", "Cancelled, was due Fri Oct 23, 7:00 AM CT", null, null],
    ])
    expect(views[0].text).toBe("@LSC Driver Reminder")
    expect(views[1].fromHref).toBe("/admin/jack/room-1?m=msg-1")
    expect(views[2].error).toMatch(/isn't allowed/)
  })
})

describe("role sync on the Discord page", () => {
  it("counts the linked members who hold a rule's role, the members who hold it without being linked, and the accounts waiting to have it taken back", async () => {
    const linked = "1200000000000000001"
    db.discordRoleRule.findMany.mockResolvedValue([{ id: "rr-1", roleId: ROLE, condition: "linked", enabled: true }])
    db.user.findMany.mockResolvedValue([{ id: "u1", displayName: "Ana", discordUserId: linked, roles: [] }])
    db.scheduledJob.findUnique.mockResolvedValue(null)
    db.systemSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => (where.key === "discord_role_takeback" ? { value: JSON.stringify({ accounts: ["1200000000000000002", "1200000000000000003"] }) } : null))
    db.discordMember.findMany.mockResolvedValue([{ roles: [ROLE] }])
    db.discordMember.count.mockResolvedValue(4)
    const view = await roleSyncView(null)
    expect(view).toMatchObject({ linked: 1, waitingTakeBacks: 2, rules: [{ qualifying: 1, holders: 1, others: 4 }] })
    expect(db.discordMember.count).toHaveBeenCalledWith({ where: { id: { notIn: [linked] }, leftAt: null, roles: { has: ROLE } } })
  })
})
