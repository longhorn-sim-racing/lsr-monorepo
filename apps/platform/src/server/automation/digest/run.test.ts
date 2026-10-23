import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackRoom: { findUnique: vi.fn() }, jackMessage: { findMany: vi.fn(), findFirst: vi.fn() }, auditLog: { count: vi.fn() } }))
const officers = vi.hoisted(() => ({ userNames: vi.fn(), officerIdSet: vi.fn() }))
const notes = vi.hoisted(() => ({ postAutomationNote: vi.fn() }))
const answer = vi.hoisted(() => ({ answerScheduledNote: vi.fn(), retryJobAt: vi.fn(), defaultRunRoom: vi.fn(), RETRY_AFTER_MS: 180_000, RETRY_WINDOW_MS: 2_700_000 }))
const discord = vi.hoisted(() => ({ sendDigestToDiscord: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const state = vi.hoisted(() => ({ recordConnectorError: vi.fn(), recordConnectorSync: vi.fn(), connectorEnabled: vi.fn(), readConnectorState: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/officers", () => officers)
vi.mock("../notes", () => notes)
vi.mock("../answer", () => answer)
vi.mock("./discord", () => discord)
vi.mock("@/server/audit/log", () => audit)
vi.mock("../registry", () => ({ DIGEST_CHECKS: [] }))
vi.mock("../cap", () => ({ automationBudget: vi.fn() }))
vi.mock("@/server/jack/broadcast", () => ({ broadcastRoomEvent: vi.fn() }))
vi.mock("@/server/connectors/discord/connector", () => ({ discordConnector: { client: vi.fn() } }))
vi.mock("@/server/connectors/state", () => state)
vi.mock("@/server/connectors/teams-webhook/connector", async (importOriginal) => ({ ...(await importOriginal<object>()), teamsWebhookConnector: { client: vi.fn() } }))

import type { AutomationBudget } from "../cap"
import type { DigestReport } from "../run-checks"
import { runWeeklyDigest, type DigestRunDeps } from "./run"

const NOW = new Date("2026-10-26T14:00:00Z") // Mon, Oct 26, 9 AM Central
const SITE = "https://www.longhornsimracing.org"
const report = (count = 3): DigestReport => ({
  at: NOW,
  outcomes: [
    {
      check: { id: "action_items.overdue", label: "Overdue action items", href: "/admin/action-items?status=overdue", order: 20 },
      result: { count, severity: "warning", items: count ? [{ title: "Dylan: 3 overdue", href: "/admin/action-items?owner=dylan" }] : [] },
      error: null,
    },
  ],
})
const budget = (stopped: AutomationBudget["stopped"] = null): AutomationBudget => ({ month: "October", spentUsd: 1, capUsd: 10, totalUsd: 20, budgetUsd: 50, stopped })
const config = (overrides: Record<string, unknown> = {}) => ({ roomId: "room-1", summary: true, discordChannelId: null, teams: false, configuredById: "gray", configuredAt: "2026-10-20T15:00:00.000Z", ...overrides })
const ctx = (overrides: Record<string, unknown> = {}) => ({ config: config(overrides), job: { id: "job-d", key: "digest.weekly" }, startedAt: NOW.getTime(), log: vi.fn(), signal: new AbortController().signal })

let deps: DigestRunDeps
let teamsPost: ReturnType<typeof vi.fn>

beforeEach(() => {
  teamsPost = vi.fn(async () => ({ status: 202 }))
  deps = {
    broadcast: vi.fn(),
    runRoom: vi.fn(),
    budget: vi.fn(async () => budget()),
    checks: vi.fn(async () => report()),
    discord: vi.fn(async () => ({ rest: {} }) as never),
    teams: vi.fn(async () => ({ host: "prod-00.westus.logic.azure.com", post: teamsPost }) as never),
    siteUrl: () => SITE,
    now: () => NOW,
  }
  db.jackRoom.findUnique.mockResolvedValue({ archivedAt: null })
  db.jackMessage.findMany.mockResolvedValue([])
  db.jackMessage.findFirst.mockResolvedValue(null)
  state.recordConnectorError.mockResolvedValue("")
  state.recordConnectorSync.mockResolvedValue(undefined)
  db.auditLog.count.mockResolvedValue(0)
  officers.userNames.mockResolvedValue(new Map([["gray", { id: "gray", displayName: "Gray", handle: "gray" }]]))
  officers.officerIdSet.mockResolvedValue(new Set(["gray"]))
  notes.postAutomationNote.mockImplementation(async (note) => ({ id: "note-1", roomId: note.roomId, createdAt: NOW }))
  answer.answerScheduledNote.mockResolvedValue({ answer: { id: "reply-1", status: "done", costUsd: 0.08 } })
  answer.retryJobAt.mockResolvedValue(true)
  discord.sendDigestToDiscord.mockResolvedValue({ status: "sent", messageId: "m-1", postId: "post-1" })
})

describe("the weekly digest's run", () => {
  it("is skipped until an officer sets it up", async () => {
    expect(await runWeeklyDigest({ ...ctx(), config: null }, deps)).toMatchObject({ status: "skipped", summary: expect.stringMatching(/^Not set up yet/) })
    expect(deps.checks).not.toHaveBeenCalled()
  })

  it("posts the full list to the room as a note Jack answers with his summary, as the officer who set it up", async () => {
    const result = await runWeeklyDigest(ctx(), deps)
    const note = notes.postAutomationNote.mock.calls[0][0]
    expect(note).toMatchObject({ roomId: "room-1", jobKey: "digest.weekly", scheduled: true, authorUserId: "gray" })
    expect(note.content).toMatch(/^Weekly digest for Mon, Oct 26 \(set up by Gray\): 3 things need attention → \/admin\n/)
    expect(note.content).toContain("Dylan: 3 overdue")
    expect(note.content).toMatch(/Jack: sum this up for the officers/)
    expect(answer.answerScheduledNote).toHaveBeenCalledWith({ id: "note-1", roomId: "room-1", createdAt: NOW }, NOW.getTime(), deps.runRoom)
    expect(result).toEqual({ summary: "3 things need attention · Room: posted, Jack's summary asked for · Jack's summary: written → /admin/jack/room-1?m=reply-1", counts: { attention: 3 } })
    expect(deps.checks).toHaveBeenCalledWith(NOW, expect.any(AbortSignal))
  })

  it("asks for no summary when it's off, nothing needs attention, the owner left, or automations are capped, and says why", async () => {
    await runWeeklyDigest(ctx({ summary: false }), deps)
    expect(notes.postAutomationNote.mock.calls[0][0]).toMatchObject({ scheduled: false })

    deps.checks = vi.fn(async () => report(0))
    await runWeeklyDigest(ctx(), deps)
    expect(notes.postAutomationNote.mock.calls[1][0]).toMatchObject({ scheduled: false, content: expect.stringMatching(/nothing needs attention → \/admin$/) })

    deps.checks = vi.fn(async () => report())
    officers.officerIdSet.mockResolvedValue(new Set())
    await runWeeklyDigest(ctx(), deps)
    expect(notes.postAutomationNote.mock.calls[2][0]).toMatchObject({ scheduled: false, content: expect.stringMatching(/No summary from Jack: whoever set the digest up isn't an officer any more/) })

    officers.officerIdSet.mockResolvedValue(new Set(["gray"]))
    deps.budget = vi.fn(async () => budget("automation_cap"))
    await runWeeklyDigest(ctx(), deps)
    expect(notes.postAutomationNote.mock.calls[3][0]).toMatchObject({ scheduled: false, content: expect.stringMatching(/No summary from Jack: automations have used this month's \$10/) })
    expect(answer.answerScheduledNote).not.toHaveBeenCalled()
  })

  it("posts to the room once a day: a second run only gets the first one's summary answered", async () => {
    db.jackMessage.findMany.mockResolvedValue([{ id: "note-0", roomId: "room-1", createdAt: new Date(NOW.getTime() - 60_000), scheduled: true, answeredById: null }])
    const result = await runWeeklyDigest(ctx(), deps)
    expect(notes.postAutomationNote).not.toHaveBeenCalled()
    expect(db.jackMessage.findMany.mock.calls[0][0].where).toEqual({ roomId: "room-1", jobKey: "digest.weekly", createdAt: { gte: new Date("2026-10-26T05:00:00Z") } })
    expect(answer.answerScheduledNote.mock.calls[0][0]).toMatchObject({ id: "note-0" })
    expect(result.summary).toContain("Room: already posted today")
  })

  it("keeps a retry that runs past midnight on its first try's day, so nothing is posted twice", async () => {
    const after = new Date("2026-10-27T05:10:00Z") // Tue, Oct 27, 12:10 AM Central
    const asked = new Date("2026-10-27T04:50:00Z") // Mon, Oct 26, 11:50 PM Central
    deps.now = () => after
    db.jackMessage.findFirst.mockResolvedValue({ createdAt: asked })
    db.jackMessage.findMany.mockResolvedValue([{ id: "note-0", roomId: "room-1", createdAt: asked, scheduled: true, answeredById: null }])
    db.auditLog.count.mockResolvedValue(1)
    discord.sendDigestToDiscord.mockResolvedValue({ status: "already_sent", messageId: "m-1", postId: "post-1" })
    const result = await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020", teams: true }), deps)
    expect(db.jackMessage.findFirst.mock.calls[0][0].where).toEqual({ jobKey: "digest.weekly", scheduled: true, answeredById: null, createdAt: { gte: new Date(after.getTime() - 2_700_000) } })
    expect(db.jackMessage.findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: new Date("2026-10-26T05:00:00Z") })
    expect(notes.postAutomationNote).not.toHaveBeenCalled()
    expect(discord.sendDigestToDiscord.mock.calls[0][0].dedupeKey).toBe("digest:2026-10-26")
    expect(db.auditLog.count.mock.calls[0][0].where.entityId).toBe("teams:2026-10-26")
    expect(teamsPost).not.toHaveBeenCalled()
    expect(answer.answerScheduledNote.mock.calls[0][0]).toMatchObject({ id: "note-0" })
    expect(result.summary).toBe("3 things need attention · Room: already posted today · Discord: already posted today · Teams: already posted today · Jack's summary: written → /admin/jack/room-1?m=reply-1")
  })

  it("records each Teams post's outcome on its connector, so Connections shows a broken flow", async () => {
    await runWeeklyDigest(ctx({ teams: true }), deps)
    expect(state.recordConnectorSync).toHaveBeenCalledWith("teams-webhook")
    const refused = new Error("The Teams webhook answered 404 (WorkflowNotFound)")
    teamsPost.mockRejectedValue(refused)
    await expect(runWeeklyDigest(ctx({ teams: true }), deps)).rejects.toThrow("The digest didn't reach everywhere: Teams: The Teams webhook answered 404 (WorkflowNotFound)")
    expect(state.recordConnectorError).toHaveBeenCalledWith("teams-webhook", refused)
    // Only the first run's post was audited as posted
    expect(audit.createAuditLog.mock.calls.filter(([entry]) => entry.entityId === "teams:2026-10-26")).toHaveLength(1)
  })

  it("skips an archived or deleted room, and still posts outside", async () => {
    db.jackRoom.findUnique.mockResolvedValue({ archivedAt: NOW })
    const result = await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020", teams: true }), deps)
    expect(notes.postAutomationNote).not.toHaveBeenCalled()
    expect(result.summary).toBe("3 things need attention · Room: it's archived, so nothing was posted there · Discord: posted · Teams: posted")
  })

  it("gives Discord and Teams counts and console links only, once a day each, and audits each post", async () => {
    const result = await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020", teams: true }), deps)
    const sent = discord.sendDigestToDiscord.mock.calls[0][0]
    expect(sent).toMatchObject({ channelId: "1100000000000000020", dedupeKey: "digest:2026-10-26", createdById: "gray" })
    expect(sent.body.allowed_mentions).toEqual({ parse: [] })
    expect(sent.body.content).toContain("Overdue action items: 3 <https://www.longhornsimracing.org/admin/action-items?status=overdue>")
    const card = JSON.stringify(teamsPost.mock.calls[0][0])
    expect(card).toContain("Overdue action items")
    for (const copy of [sent.body.content, card]) expect(copy).not.toContain("Dylan")
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "DIGEST_POSTED", entityType: "DIGEST", entityId: "discord:2026-10-26" }))
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "DIGEST_POSTED", entityType: "DIGEST", entityId: "teams:2026-10-26" }))
    expect(result.summary).toContain("Discord: posted · Teams: posted")

    db.auditLog.count.mockResolvedValue(1)
    discord.sendDigestToDiscord.mockResolvedValue({ status: "already_sent", messageId: "m-1", postId: "post-1" })
    const again = await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020", teams: true }), deps)
    expect(teamsPost).toHaveBeenCalledTimes(1)
    expect(again.summary).toContain("Discord: already posted today · Teams: already posted today")
  })

  it("skips Discord and Teams while they aren't connected", async () => {
    deps.discord = vi.fn(async () => null)
    deps.teams = vi.fn(async () => null)
    const result = await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020", teams: true }), deps)
    expect(discord.sendDigestToDiscord).not.toHaveBeenCalled()
    expect(result.summary).toContain("Discord: not connected, skipped · Teams: not connected, skipped")
  })

  it("keeps going when one place fails, then fails the run saying which", async () => {
    discord.sendDigestToDiscord.mockRejectedValue(new Error("Discord answered 403 (code 50001 Missing Access) on POST /channels/:id/messages"))
    const run = ctx({ discordChannelId: "1100000000000000020", teams: true })
    await expect(runWeeklyDigest(run, deps)).rejects.toThrow("The digest didn't reach everywhere: Discord: Discord answered 403 (code 50001 Missing Access) on POST /channels/:id/messages")
    expect(teamsPost).toHaveBeenCalledTimes(1)
    expect(answer.answerScheduledNote).toHaveBeenCalledTimes(1)
    expect(run.log).toHaveBeenCalledWith(expect.stringContaining("Room: posted"))
  })

  it("looks again for Jack's summary when the room is busy", async () => {
    answer.answerScheduledNote.mockResolvedValue({ answer: null, busy: true })
    const result = await runWeeklyDigest(ctx(), deps)
    expect(answer.retryJobAt).toHaveBeenCalledWith("job-d", new Date(NOW.getTime() + 180_000))
    expect(result.summary).toContain("Jack's summary: the room is busy, looking again in 3 minutes")
  })
})
