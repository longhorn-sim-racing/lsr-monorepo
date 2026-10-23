import type { Prisma } from "@prisma/client"
import { DIGEST_JOB_KEY, DIGEST_SETTINGS_PATH } from "@/lib/jack/recurring"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { formatUsd } from "@/lib/jack/spend"
import { getSiteUrl } from "@/lib/site-url"
import { createAuditLog } from "@/server/audit/log"
import { discordConnector } from "@/server/connectors/discord/connector"
import type { DiscordClient } from "@/server/connectors/discord/client"
import { postRecorded, teamsWebhookConnector } from "@/server/connectors/teams-webhook/connector"
import { TeamsWebhookError, type TeamsWebhookClient } from "@/server/connectors/teams-webhook/client"
import { prisma } from "@/server/db"
import { broadcastRoomEvent, type RoomBroadcaster } from "@/server/jack/broadcast"
import { centralDate, startOfCentralDay } from "@/server/jack/tools/time"
import type { JobContext, JobResult } from "@/server/scheduler/types"
import { userNames, officerIdSet } from "@/server/services/officers"
import { answerScheduledNote, defaultRunRoom, RETRY_AFTER_MS, RETRY_WINDOW_MS, retryJobAt, type RunRoom } from "../answer"
import { underWay, withAutomationCap, type AutomationBudget, type AutomationGate } from "../cap"
import { announceAutomationNote, insertAutomationNote } from "../notes"
import { attentionCount, runDigestChecks, type DigestReport } from "../run-checks"
import { readDigestConfig, type DigestConfig } from "./config"
import { sendDigestToDiscord } from "./discord"
import { discordDigestMessage, roomDigestText, teamsDigestCard } from "./render"

/**
 * The weekly digest's run (design §11.2), handed off to /api/admin/jack/run: the checks once, then the
 * room, Discord and Teams as its settings say, each at most once a day (a second run that day, a retry or
 * Run now, fills in only what's missing; a retry after midnight still counts as its first try's day), then
 * Jack's summary in the room last, since it takes longest.
 *
 * - The room gets the full list as a note. With the summary on (and its owner still an officer, and
 *   automations under their cap, counting the runs under way), the note is a scheduled one that Jack
 *   answers with a short summary, as the officer who set the digest up; when the room is busy the job
 *   looks again in a few minutes. That cap check and the note go together under the cap's lock (cap.ts).
 * - Discord and Teams get counts and links only, never items (render.ts), and only while their connector
 *   is on. Discord's copy goes through Discord posting (discord.ts), to a posting channel only. A Teams
 *   post's outcome is recorded on its connector (it posts nothing else); a Discord post's failure stays on
 *   its DiscordPost row, since one channel refusing doesn't mean Discord is down.
 * - Neither is sent again blind: a Discord send that wasn't confirmed waits for an officer on
 *   Announcements, and a Teams post that got no answer isn't tried again that day (below).
 * One destination failing doesn't stop the others; the run fails at the end, saying which.
 */

export type DigestRunDeps = {
  broadcast: RoomBroadcaster
  runRoom: RunRoom
  /** Checks the cap and posts the summary's note under its lock */
  withCap: AutomationGate
  checks: (now: Date, signal?: AbortSignal) => Promise<DigestReport>
  discord: () => Promise<DiscordClient | null>
  teams: () => Promise<TeamsWebhookClient | null>
  siteUrl: () => string
  now: () => Date
}

export const defaultDigestRunDeps: DigestRunDeps = {
  broadcast: broadcastRoomEvent,
  runRoom: defaultRunRoom,
  withCap: withAutomationCap,
  checks: (now, signal) => runDigestChecks({ now, signal }),
  discord: () => discordConnector.client(),
  teams: () => teamsWebhookConnector.client(),
  siteUrl: getSiteUrl,
  now: () => new Date(),
}

/**
 * AuditLog entity for the digest's posts outside the console (entityId "<where>:<day>"). A Teams post is
 * DIGEST_SENDING first, written before the post (the day's claim), then DIGEST_POSTED, or DIGEST_REFUSED
 * when Teams answered and didn't take it. The newest of those says what a later run that day may do
 */
export const DIGEST_ENTITY = "DIGEST"
export const DIGEST_POSTED = "DIGEST_POSTED"
export const DIGEST_SENDING = "DIGEST_SENDING"
export const DIGEST_REFUSED = "DIGEST_REFUSED"

export const TEAMS_UNCONFIRMED = "an earlier try today got no answer from Teams, so it isn't posted again today (it may be in the channel already)"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Whether the digest's owner can still have Jack answer for them, and their name */
async function digestOwner(config: DigestConfig): Promise<{ id: string; name: string; officer: boolean } | null> {
  if (!config.configuredById) return null
  const [names, officers] = await Promise.all([userNames([config.configuredById]), officerIdSet([config.configuredById])])
  const user = names.get(config.configuredById)
  return user ? { id: user.id, name: user.displayName, officer: officers.has(user.id) } : null
}

/** Why there's no summary today, as a line for the note, or null when Jack writes one */
function noSummaryLine(config: DigestConfig, owner: Awaited<ReturnType<typeof digestOwner>>, budget: AutomationBudget | null, total: number): string | null {
  if (!config.summary || !total) return null
  if (!owner?.officer) return "(No summary from Jack: whoever set the digest up isn't an officer any more. An officer can save its settings again to take it over.)"
  if (budget?.stopped === "automation_cap") return `(No summary from Jack: automations have used this month's ${formatUsd(budget.capUsd, { wholeIfRound: true })}${underWay(budget)}.)`
  if (budget?.stopped === "monthly_budget") return "(No summary from Jack: his monthly budget is used up.)"
  return null
}

type RoomPart = { line: string; note: { id: string; roomId: string; createdAt: Date } | null }

async function postToRoom(config: DigestConfig, report: DigestReport, day: string, deps: DigestRunDeps): Promise<RoomPart> {
  const roomId = config.roomId!
  const room = await prisma.jackRoom.findUnique({ where: { id: roomId }, select: { archivedAt: true } })
  if (!room) return { line: `Room: it's gone, pick another → ${DIGEST_SETTINGS_PATH}`, note: null }
  if (room.archivedAt) return { line: "Room: it's archived, so nothing was posted there", note: null }

  // Once a day: a second run gets the first one's summary answered, if it's still waiting
  const [today] = await prisma.jackMessage.findMany({
    where: { roomId, jobKey: DIGEST_JOB_KEY, createdAt: { gte: startOfCentralDay(day) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { id: true, roomId: true, createdAt: true, scheduled: true, answeredById: true },
  })
  if (today) return { line: "Room: already posted today", note: today.scheduled && !today.answeredById ? today : null }

  const total = attentionCount(report)
  const owner = await digestOwner(config)
  const write = async (budget: AutomationBudget | null, db?: Prisma.TransactionClient) => {
    const why = noSummaryLine(config, owner, budget, total)
    const askSummary = config.summary && total > 0 && !why
    const text = roomDigestText(report, { setUpBy: owner?.name ?? "a former officer", askSummary })
    const note = await insertAutomationNote({ roomId, jobKey: DIGEST_JOB_KEY, content: why ? `${text}\n\n${why}` : text, scheduled: askSummary, authorUserId: owner?.id ?? null }, db)
    return { note, askSummary }
  }
  // Asking for Jack's summary starts automation spend, so that note goes in under the cap's lock
  const { note, askSummary } = config.summary && total && owner?.officer ? await deps.withCap(report.at, write) : await write(null)
  await announceAutomationNote(note, deps.broadcast)
  return { line: `Room: posted${askSummary ? ", Jack's summary asked for" : ""}`, note: askSummary ? note : null }
}

/** What the digest's Teams copy did today so far: the newest of its entries (DIGEST_SENDING, _POSTED or _REFUSED), or null for nothing yet */
async function teamsToday(day: string): Promise<string | null> {
  const last = await prisma.auditLog.findFirst({
    where: { entityType: DIGEST_ENTITY, entityId: `teams:${day}`, actionType: { in: [DIGEST_SENDING, DIGEST_POSTED, DIGEST_REFUSED] } },
    orderBy: { createdAt: "desc" },
    select: { actionType: true },
  })
  return last?.actionType ?? null
}

/** Teams answered and didn't take it (a redirect or a 4xx): nothing was posted. No answer, or a 5xx, may have posted it */
function teamsRefused(error: unknown): error is TeamsWebhookError {
  return error instanceof TeamsWebhookError && error.status !== null && error.status < 500
}

/**
 * Posts the digest's card to Teams once a day. The day's claim (DIGEST_SENDING) is written first, straight
 * to the table (createAuditLog hides its own errors): without it nothing is posted. A post Teams refused
 * is recorded as refused, so a later run that day tries again; one that got no answer may be in the
 * channel, so the claim stands and no run posts it again that day
 */
async function postToTeams(client: TeamsWebhookClient, report: DigestReport, day: string, deps: DigestRunDeps, signal: AbortSignal | undefined): Promise<string> {
  const today = await teamsToday(day)
  if (today === DIGEST_POSTED) return "Teams: already posted today"
  if (today === DIGEST_SENDING) throw new Error(TEAMS_UNCONFIRMED)
  const total = attentionCount(report)
  const entry = { actorUserId: null, entityType: DIGEST_ENTITY, entityId: `teams:${day}`, metadata: { host: client.host, attention: total } }
  await prisma.auditLog.create({ data: { ...entry, actionType: DIGEST_SENDING, summary: "Posting the weekly digest to Teams" } })
  try {
    await postRecorded(client, teamsDigestCard(report, deps.siteUrl()), signal)
  } catch (error) {
    if (teamsRefused(error)) {
      await createAuditLog({ ...entry, actionType: DIGEST_REFUSED, summary: `Teams refused the weekly digest (${error.status}); nothing was posted` })
      throw error
    }
    throw new Error(`${message(error)}. It may have posted anyway, so it isn't tried again today: look in the Teams channel`)
  }
  await createAuditLog({ ...entry, actionType: DIGEST_POSTED, summary: "Posted the weekly digest to Teams" })
  return "Teams: posted"
}

/** The run log's line for the digest's Discord copy */
function discordLine(sent: Awaited<ReturnType<typeof sendDigestToDiscord>>): string {
  switch (sent.status) {
    case "sent":
      return "Discord: posted"
    case "already_sent":
      return "Discord: already posted today"
    case "cancelled":
      return `Discord: today's post was cancelled (${sent.reason})`
    case "waiting":
      return `Discord: ${sent.reason}`
  }
}

/**
 * The digest's summary note from an earlier try that's still waiting (within RETRY_WINDOW_MS), in any
 * room. A retry belongs to that try's day, so one that runs past midnight doesn't post the digest again
 */
async function waitingSummaryNote(now: Date): Promise<{ createdAt: Date } | null> {
  return prisma.jackMessage.findFirst({
    where: { jobKey: DIGEST_JOB_KEY, scheduled: true, answeredById: null, createdAt: { gte: new Date(now.getTime() - RETRY_WINDOW_MS) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true },
  })
}

export async function runWeeklyDigest(ctx: Pick<JobContext, "config" | "job" | "startedAt" | "log" | "signal">, deps: DigestRunDeps = defaultDigestRunDeps): Promise<JobResult> {
  const config = readDigestConfig(ctx.config)
  if (!config.roomId && !config.discordChannelId && !config.teams) return { status: "skipped", summary: `Not set up yet: an officer picks a room on Jack → Recurring questions (${DIGEST_SETTINGS_PATH}).` }

  const now = deps.now()
  const waiting = await waitingSummaryNote(now)
  const day = centralDate(waiting?.createdAt ?? now)
  const report = await deps.checks(now, ctx.signal)
  const total = attentionCount(report)
  const done: string[] = []
  const failed: string[] = []
  let summaryNote: RoomPart["note"] = null

  if (config.roomId) {
    try {
      const part = await postToRoom(config, report, day, deps)
      done.push(part.line)
      summaryNote = part.note
    } catch (error) {
      failed.push(`room: ${message(error)}`)
    }
  }

  if (config.discordChannelId) {
    try {
      const client = await deps.discord()
      if (!client) done.push("Discord: not connected, skipped")
      else {
        const sent = await sendDigestToDiscord(
          { channelId: config.discordChannelId, body: discordDigestMessage(report, deps.siteUrl()), dedupeKey: `digest:${day}`, createdById: config.configuredById },
          client,
          { now, signal: ctx.signal },
        )
        done.push(discordLine(sent))
        if (sent.status === "sent") {
          await createAuditLog({ actorUserId: null, actionType: DIGEST_POSTED, entityType: DIGEST_ENTITY, entityId: `discord:${day}`, summary: "Posted the weekly digest to Discord", metadata: { channelId: config.discordChannelId, postId: sent.postId, attention: total } })
        }
      }
    } catch (error) {
      failed.push(`Discord: ${message(error)}`)
    }
  }

  if (config.teams) {
    try {
      const client = await deps.teams()
      done.push(client ? await postToTeams(client, report, day, deps, ctx.signal) : "Teams: not connected, skipped")
    } catch (error) {
      failed.push(`Teams: ${message(error)}`)
    }
  }

  // Jack's summary last: it's a whole reply
  if (summaryNote) {
    try {
      const outcome = await answerScheduledNote(summaryNote, ctx.startedAt, deps.runRoom)
      if (outcome.answer) done.push(`Jack's summary: ${outcome.answer.status === "streaming" ? "being written" : "written"} → ${roomMessageUrl(summaryNote.roomId, outcome.answer.id)}`)
      else if (now.getTime() - summaryNote.createdAt.getTime() < RETRY_WINDOW_MS && (await retryJobAt(ctx.job.id, new Date(deps.now().getTime() + RETRY_AFTER_MS)))) {
        done.push(`Jack's summary: ${outcome.busy ? "the room is busy" : "not answered yet"}, looking again in ${RETRY_AFTER_MS / 60_000} minutes`)
      } else done.push("Jack's summary: still waiting in the room (Continue there answers it)")
    } catch (error) {
      failed.push(`Jack's summary: ${message(error)}`)
    }
  }

  const summary = `${total ? `${total} ${total === 1 ? "thing needs" : "things need"} attention` : "Nothing needs attention"} · ${done.join(" · ")}`
  if (failed.length) {
    ctx.log(summary)
    throw new Error(`The digest didn't reach everywhere: ${failed.join("; ")}`)
  }
  return { summary, counts: { attention: total } }
}
