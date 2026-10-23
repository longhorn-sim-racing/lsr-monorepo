import { DIGEST_JOB_KEY, DIGEST_SETTINGS_PATH } from "@/lib/jack/recurring"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { formatUsd } from "@/lib/jack/spend"
import { getSiteUrl } from "@/lib/site-url"
import { createAuditLog } from "@/server/audit/log"
import { discordConnector } from "@/server/connectors/discord/connector"
import type { DiscordClient } from "@/server/connectors/discord/client"
import { postRecorded, teamsWebhookConnector } from "@/server/connectors/teams-webhook/connector"
import type { TeamsWebhookClient } from "@/server/connectors/teams-webhook/client"
import { prisma } from "@/server/db"
import { broadcastRoomEvent, type RoomBroadcaster } from "@/server/jack/broadcast"
import { centralDate, startOfCentralDay } from "@/server/jack/tools/time"
import type { JobContext, JobResult } from "@/server/scheduler/types"
import { userNames, officerIdSet } from "@/server/services/officers"
import { answerScheduledNote, defaultRunRoom, RETRY_AFTER_MS, RETRY_WINDOW_MS, retryJobAt, type RunRoom } from "../answer"
import { automationBudget, type AutomationBudget } from "../cap"
import { postAutomationNote } from "../notes"
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
 *   automations under their cap), the note is a scheduled one that Jack answers with a short summary, as
 *   the officer who set the digest up; when the room is busy the job looks again in a few minutes.
 * - Discord and Teams get counts and links only, never items (render.ts), and only while their connector
 *   is on. A Teams post's outcome is recorded on its connector (it posts nothing else); a Discord post's
 *   failure stays on its DiscordPost row, since one channel refusing doesn't mean Discord is down.
 * One destination failing doesn't stop the others; the run fails at the end, saying which.
 */

export type DigestRunDeps = {
  broadcast: RoomBroadcaster
  runRoom: RunRoom
  budget: (now: Date) => Promise<AutomationBudget>
  checks: (now: Date, signal?: AbortSignal) => Promise<DigestReport>
  discord: () => Promise<DiscordClient | null>
  teams: () => Promise<TeamsWebhookClient | null>
  siteUrl: () => string
  now: () => Date
}

export const defaultDigestRunDeps: DigestRunDeps = {
  broadcast: broadcastRoomEvent,
  runRoom: defaultRunRoom,
  budget: (now) => automationBudget(now),
  checks: (now, signal) => runDigestChecks({ now, signal }),
  discord: () => discordConnector.client(),
  teams: () => teamsWebhookConnector.client(),
  siteUrl: getSiteUrl,
  now: () => new Date(),
}

/** AuditLog entity for the digest's posts outside the console (entityId "<where>:<day>") */
export const DIGEST_ENTITY = "DIGEST"
export const DIGEST_POSTED = "DIGEST_POSTED"

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
  if (budget?.stopped === "automation_cap") return `(No summary from Jack: automations have used this month's ${formatUsd(budget.capUsd, { wholeIfRound: true })}.)`
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
  const budget = config.summary && total && owner?.officer ? await deps.budget(report.at) : null
  const why = noSummaryLine(config, owner, budget, total)
  const askSummary = config.summary && total > 0 && !why
  const text = roomDigestText(report, { setUpBy: owner?.name ?? "a former officer", askSummary })
  const note = await postAutomationNote(
    { roomId, jobKey: DIGEST_JOB_KEY, content: why ? `${text}\n\n${why}` : text, scheduled: askSummary, authorUserId: owner?.id ?? null },
    deps.broadcast,
  )
  return { line: `Room: posted${askSummary ? ", Jack's summary asked for" : ""}`, note: askSummary ? note : null }
}

/** Whether the day's post to Teams went out already (its audit entry) */
async function postedToTeams(day: string): Promise<boolean> {
  return (await prisma.auditLog.count({ where: { entityType: DIGEST_ENTITY, entityId: `teams:${day}`, actionType: DIGEST_POSTED } })) > 0
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
        done.push(sent.status === "sent" ? "Discord: posted" : sent.status === "already_sent" ? "Discord: already posted today" : "Discord: another run is posting it")
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
      if (!client) done.push("Teams: not connected, skipped")
      else if (await postedToTeams(day)) done.push("Teams: already posted today")
      else {
        await postRecorded(client, teamsDigestCard(report, deps.siteUrl()), ctx.signal)
        await createAuditLog({ actorUserId: null, actionType: DIGEST_POSTED, entityType: DIGEST_ENTITY, entityId: `teams:${day}`, summary: "Posted the weekly digest to Teams", metadata: { host: client.host, attention: total } })
        done.push("Teams: posted")
      }
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
