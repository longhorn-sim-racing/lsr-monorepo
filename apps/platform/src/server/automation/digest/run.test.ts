import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackRoom: { findUnique: vi.fn() }, jackMessage: { findMany: vi.fn(), findFirst: vi.fn() }, auditLog: { findFirst: vi.fn(), create: vi.fn() } }))
const officers = vi.hoisted(() => ({ userNames: vi.fn(), officerIdSet: vi.fn() }))
const notes = vi.hoisted(() => ({ insertAutomationNote: vi.fn(), announceAutomationNote: vi.fn() }))
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
vi.mock("../cap", async (original) => ({ ...(await original<typeof import("../cap")>()), withAutomationCap: vi.fn() }))
vi.mock("@/server/jack/broadcast", () => ({ broadcastRoomEvent: vi.fn() }))
vi.mock("@/server/connectors/discord/connector", () => ({ discordConnector: { client: vi.fn() } }))
vi.mock("@/server/connectors/state", () => state)
vi.mock("@/server/connectors/teams-webhook/connector", async (importOriginal) => ({ ...(await importOriginal<object>()), teamsWebhookConnector: { client: vi.fn() } }))

import { TeamsWebhookError } from "@/server/connectors/teams-webhook/client"
import type { AutomationBudget, AutomationStart } from "../cap"
import type { DigestReport } from "../run-checks"
import { runWeeklyDigest, TEAMS_UNCONFIRMED, type DigestRunDeps } from "./run"

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
const budget = (stopped: AutomationBudget["stopped"] = null, more: Partial<AutomationBudget> = {}): AutomationBudget => ({ month: "October", spentUsd: 1, reservedUsd: 0, capUsd: 10, totalUsd: 20, budgetUsd: 50, stopped, ...more })
const config = (overrides: Record<string, unknown> = {}) => ({ roomId: "room-1", summary: true, discordChannelId: null, teams: false, configuredById: "gray", configuredAt: "2026-10-20T15:00:00.000Z", ...overrides })
const ctx = (overrides: Record<string, unknown> = {}) => ({ config: config(overrides), job: { id: "job-d", key: "digest.weekly" }, startedAt: NOW.getTime(), log: vi.fn(), signal: new AbortController().signal })
/** The transaction the cap's lock is held in */
const TX = { tx: "under the cap's lock" }
/** The cap's lock, as the run sees it: `start` with where automations stand, in the transaction */
const capAt = (state: AutomationBudget) => vi.fn(async (_now: Date, start: AutomationStart<unknown>) => start(state, TX as never)) as unknown as DigestRunDeps["withCap"]
const teamsEntries = (action?: string) => audit.createAuditLog.mock.calls.map(([entry]) => entry).filter((entry) => entry.entityId === "teams:2026-10-26" && (!action || entry.actionType === action))

let deps: DigestRunDeps
let teamsPost: ReturnType<typeof vi.fn>

beforeEach(() => {
  teamsPost = vi.fn(async () => ({ status: 202 }))
  deps = {
    broadcast: vi.fn(),
    runRoom: vi.fn(),
    withCap: capAt(budget()),
    checks: vi.fn(async () => report()),
    discord: vi.fn(async () => ({ rest: {} }) as never),
    teams: vi.fn(async () => ({ host: "prod-00.westus.logic.azure.com", post: teamsPost }) as never),
    siteUrl: () => SITE,
    now: () => NOW,
  }
  db.jackRoom.findUnique.mockResolvedValue({ archivedAt: null })
  db.jackMessage.findMany.mockResolvedValue([])
  db.jackMessage.findFirst.mockResolvedValue(null)
  db.auditLog.findFirst.mockResolvedValue(null)
  db.auditLog.create.mockResolvedValue({})
  state.recordConnectorError.mockResolvedValue("")
  state.recordConnectorSync.mockResolvedValue(undefined)
  officers.userNames.mockResolvedValue(new Map([["gray", { id: "gray", displayName: "Gray", handle: "gray" }]]))
  officers.officerIdSet.mockResolvedValue(new Set(["gray"]))
  notes.insertAutomationNote.mockImplementation(async (note) => ({ id: "note-1", roomId: note.roomId, createdAt: NOW }))
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
    const note = notes.insertAutomationNote.mock.calls[0][0]
    expect(note).toMatchObject({ roomId: "room-1", jobKey: "digest.weekly", scheduled: true, authorUserId: "gray" })
    expect(note.content).toMatch(/^Weekly digest for Mon, Oct 26 \(set up by Gray\): 3 things need attention → \/admin\n/)
    expect(note.content).toContain("Dylan: 3 overdue")
    expect(note.content).toMatch(/Jack: sum this up for the officers/)
    expect(notes.announceAutomationNote).toHaveBeenCalledWith({ id: "note-1", roomId: "room-1", createdAt: NOW }, deps.broadcast)
    expect(answer.answerScheduledNote).toHaveBeenCalledWith({ id: "note-1", roomId: "room-1", createdAt: NOW }, NOW.getTime(), deps.runRoom)
    expect(result).toEqual({ summary: "3 things need attention · Room: posted, Jack's summary asked for · Jack's summary: written → /admin/jack/room-1?m=reply-1", counts: { attention: 3 } })
    expect(deps.checks).toHaveBeenCalledWith(NOW, expect.any(AbortSignal))
  })

  it("checks the cap and asks for the summary under the cap's lock, and tells the room only once that's committed", async () => {
    const order: string[] = []
    deps.withCap = vi.fn(async (_now: Date, start: AutomationStart<unknown>) => {
      order.push("lock")
      const started = await start(budget(), TX as never)
      order.push("commit")
      return started
    }) as unknown as DigestRunDeps["withCap"]
    notes.insertAutomationNote.mockImplementation(async (note, tx) => {
      order.push(tx === TX ? "note in the transaction" : "note outside it")
      return { id: "note-1", roomId: note.roomId, createdAt: NOW }
    })
    notes.announceAutomationNote.mockImplementation(async () => {
      order.push("broadcast")
    })
    await runWeeklyDigest(ctx(), deps)
    expect(deps.withCap).toHaveBeenCalledWith(NOW, expect.any(Function))
    expect(order).toEqual(["lock", "note in the transaction", "commit", "broadcast"])
  })

  it("asks for no summary when it's off, nothing needs attention, the owner left, or automations are capped (counting runs under way), and says why", async () => {
    await runWeeklyDigest(ctx({ summary: false }), deps)
    expect(notes.insertAutomationNote.mock.calls[0][0]).toMatchObject({ scheduled: false })

    deps.checks = vi.fn(async () => report(0))
    await runWeeklyDigest(ctx(), deps)
    expect(notes.insertAutomationNote.mock.calls[1][0]).toMatchObject({ scheduled: false, content: expect.stringMatching(/nothing needs attention → \/admin$/) })

    deps.checks = vi.fn(async () => report())
    officers.officerIdSet.mockResolvedValue(new Set())
    await runWeeklyDigest(ctx(), deps)
    expect(notes.insertAutomationNote.mock.calls[2][0]).toMatchObject({ scheduled: false, content: expect.stringMatching(/No summary from Jack: whoever set the digest up isn't an officer any more/) })
    expect(deps.withCap).not.toHaveBeenCalled()

    officers.officerIdSet.mockResolvedValue(new Set(["gray"]))
    deps.withCap = capAt(budget("automation_cap", { spentUsd: 10.2 }))
    await runWeeklyDigest(ctx(), deps)
    expect(notes.insertAutomationNote.mock.calls[3][0]).toMatchObject({ scheduled: false, content: expect.stringMatching(/No summary from Jack: automations have used this month's \$10\.\)$/) })

    deps.withCap = capAt(budget("automation_cap", { spentUsd: 9.9, reservedUsd: 0.24 }))
    await runWeeklyDigest(ctx(), deps)
    expect(notes.insertAutomationNote.mock.calls[4][0].content).toMatch(/No summary from Jack: automations have used this month's \$10 \(counting the runs under way\)\.\)$/)
    expect(answer.answerScheduledNote).not.toHaveBeenCalled()
  })

  it("posts to the room once a day: a second run only gets the first one's summary answered", async () => {
    db.jackMessage.findMany.mockResolvedValue([{ id: "note-0", roomId: "room-1", createdAt: new Date(NOW.getTime() - 60_000), scheduled: true, answeredById: null }])
    const result = await runWeeklyDigest(ctx(), deps)
    expect(notes.insertAutomationNote).not.toHaveBeenCalled()
    expect(deps.withCap).not.toHaveBeenCalled()
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
    db.auditLog.findFirst.mockResolvedValue({ actionType: "DIGEST_POSTED" })
    discord.sendDigestToDiscord.mockResolvedValue({ status: "already_sent", messageId: "m-1", postId: "post-1" })
    const result = await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020", teams: true }), deps)
    expect(db.jackMessage.findFirst.mock.calls[0][0].where).toEqual({ jobKey: "digest.weekly", scheduled: true, answeredById: null, createdAt: { gte: new Date(after.getTime() - 2_700_000) } })
    expect(db.jackMessage.findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: new Date("2026-10-26T05:00:00Z") })
    expect(notes.insertAutomationNote).not.toHaveBeenCalled()
    expect(discord.sendDigestToDiscord.mock.calls[0][0].dedupeKey).toBe("digest:2026-10-26")
    expect(db.auditLog.findFirst.mock.calls[0][0].where).toEqual({ entityType: "DIGEST", entityId: "teams:2026-10-26", actionType: { in: ["DIGEST_SENDING", "DIGEST_POSTED", "DIGEST_REFUSED"] } })
    expect(teamsPost).not.toHaveBeenCalled()
    expect(answer.answerScheduledNote.mock.calls[0][0]).toMatchObject({ id: "note-0" })
    expect(result.summary).toBe("3 things need attention · Room: already posted today · Discord: already posted today · Teams: already posted today · Jack's summary: written → /admin/jack/room-1?m=reply-1")
  })

  it("claims the day's Teams post before posting it, then records that it went out", async () => {
    const order: string[] = []
    db.auditLog.create.mockImplementation(async ({ data }) => order.push(`claim ${data.actionType}`))
    teamsPost.mockImplementation(async () => {
      order.push("post")
      return { status: 202 }
    })
    audit.createAuditLog.mockImplementation(async (entry) => order.push(`record ${entry.actionType}`))
    const result = await runWeeklyDigest(ctx({ teams: true }), deps)
    expect(order).toEqual(["claim DIGEST_SENDING", "post", "record DIGEST_POSTED"])
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ actorUserId: null, entityType: "DIGEST", entityId: "teams:2026-10-26", summary: "Posting the weekly digest to Teams" })
    expect(state.recordConnectorSync).toHaveBeenCalledWith("teams-webhook")
    expect(result.summary).toContain("Teams: posted")
  })

  it("posts nothing to Teams when the day's claim can't be written", async () => {
    db.auditLog.create.mockRejectedValue(new Error("the database went away"))
    await expect(runWeeklyDigest(ctx({ teams: true }), deps)).rejects.toThrow("The digest didn't reach everywhere: Teams: the database went away")
    expect(teamsPost).not.toHaveBeenCalled()
  })

  it("never posts the Teams card again the same day after a try that got no answer: it may be in the channel", async () => {
    for (const noAnswer of [new TeamsWebhookError(null, "no answer in 15 s"), new TeamsWebhookError(502, "")]) {
      teamsPost.mockRejectedValueOnce(noAnswer)
      await expect(runWeeklyDigest(ctx({ teams: true }), deps)).rejects.toThrow(/It may have posted anyway, so it isn't tried again today: look in the Teams channel/)
    }
    expect(state.recordConnectorError).toHaveBeenCalledTimes(2)
    expect(teamsEntries()).toEqual([])

    // The next run that day (the summary's retry, or Run now) finds the claim standing and doesn't post
    db.auditLog.findFirst.mockResolvedValue({ actionType: "DIGEST_SENDING" })
    await expect(runWeeklyDigest(ctx({ teams: true }), deps)).rejects.toThrow(`Teams: ${TEAMS_UNCONFIRMED}`)
    expect(teamsPost).toHaveBeenCalledTimes(2)
    expect(db.auditLog.create).toHaveBeenCalledTimes(2)
  })

  it("records a post Teams refused (nothing was posted), so a later run that day tries again", async () => {
    const refused = new TeamsWebhookError(404, "WorkflowNotFound")
    teamsPost.mockRejectedValueOnce(refused)
    await expect(runWeeklyDigest(ctx({ teams: true }), deps)).rejects.toThrow("The digest didn't reach everywhere: Teams: The Teams webhook answered 404 (WorkflowNotFound)")
    expect(state.recordConnectorError).toHaveBeenCalledWith("teams-webhook", refused)
    expect(teamsEntries()).toEqual([expect.objectContaining({ actionType: "DIGEST_REFUSED", summary: "Teams refused the weekly digest (404); nothing was posted" })])

    db.auditLog.findFirst.mockResolvedValue({ actionType: "DIGEST_REFUSED" })
    const again = await runWeeklyDigest(ctx({ teams: true }), deps)
    expect(teamsPost).toHaveBeenCalledTimes(2)
    expect(again.summary).toContain("Teams: posted")
    expect(teamsEntries("DIGEST_POSTED")).toHaveLength(1)
  })

  it("skips an archived or deleted room, and still posts outside", async () => {
    db.jackRoom.findUnique.mockResolvedValue({ archivedAt: NOW })
    const result = await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020", teams: true }), deps)
    expect(notes.insertAutomationNote).not.toHaveBeenCalled()
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

    db.auditLog.findFirst.mockResolvedValue({ actionType: "DIGEST_POSTED" })
    discord.sendDigestToDiscord.mockResolvedValue({ status: "already_sent", messageId: "m-1", postId: "post-1" })
    const again = await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020", teams: true }), deps)
    expect(teamsPost).toHaveBeenCalledTimes(1)
    expect(again.summary).toContain("Discord: already posted today · Teams: already posted today")
  })

  it("says what happened to a Discord post it didn't send itself", async () => {
    discord.sendDigestToDiscord.mockResolvedValueOnce({ status: "waiting", postId: "post-1", reason: "rate-limited, so the Discord posts job sends it" })
    expect((await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020" }), deps)).summary).toContain("Discord: rate-limited, so the Discord posts job sends it")
    discord.sendDigestToDiscord.mockResolvedValueOnce({ status: "cancelled", postId: "post-1", reason: "Cancelled by Dylan" })
    expect((await runWeeklyDigest(ctx({ discordChannelId: "1100000000000000020" }), deps)).summary).toContain("Discord: today's post was cancelled (Cancelled by Dylan)")
    expect(audit.createAuditLog).not.toHaveBeenCalledWith(expect.objectContaining({ entityId: "discord:2026-10-26" }))
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
