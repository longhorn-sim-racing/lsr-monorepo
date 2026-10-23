import type { DiscordPost, DiscordRule, Prisma } from "@prisma/client"
import { isEventPublic } from "@/lib/events"
import { getSiteUrl } from "@/lib/site-url"
import { TWITCH_URL } from "@/lib/socials"
import { prisma } from "@/server/db"
import { currentLiveStream, streamsWentLiveSince } from "@/server/connectors/twitch/streams"
import { postingChannelIds } from "./channels"
import { EVENT_SELECT, eventProblem, forPost, postableEvents } from "./events"
import { cancelPosts, queueDiscordPost, readBody } from "./outbox"
import { readRuleConfig, RULE_INFO, isRuleKind, type RuleConfig, type RuleKind } from "./rules"
import { eventReminderBody, newEventBody, resultsBody, standingsBody, twitchLiveBody } from "./templates"
import { when } from "./time"

/**
 * The standing rules that post (design §12.1): event_reminder, new_event, results_posted,
 * standings_update and twitch_live, run by one dispatcher job (`discord.rules`, every 5 minutes; the
 * event mirror is its own job). Each run, for each switched-on rule:
 * - it finds what's new since the rule's `cutoffAt` (and within a short look-back, so a rule that was off
 *   or a scheduler that stopped never floods the channel), public events only (`isEventPublic`, never a
 *   meeting link), and queues one post per thing, keyed so it's never posted twice (`dedupeKey`);
 * - at most MAX_NEW_PER_RUN new posts per rule per run (reminders, scheduled ahead, MAX_REMINDERS_PER_RUN);
 * - reminders are keyed by the event's start time, so a moved event gets new reminders, and its pending
 *   ones are cancelled; so are reminders of an event that was cancelled, postponed or unpublished.
 * The posts job checks each post again right before sending it (rulePostProblem).
 */

/** Reminders are queued at most this far ahead of their time */
export const REMINDER_HORIZON_MS = 8 * 24 * 60 * 60_000
/** A reminder whose time passed less than this long ago still goes (the job runs every 5 minutes) */
export const REMINDER_GRACE_MS = 15 * 60_000
/** New posts one rule may queue per run (new events, results, standings, Twitch) */
export const MAX_NEW_PER_RUN = 3
/** Reminders one rule may schedule per run */
export const MAX_REMINDERS_PER_RUN = 20
/** How far back a rule looks for what's new, at most (still never before its cutoff) */
export const LOOK_BACK_MS = 3 * 24 * 60 * 60_000
/** A stream that starts this soon after the previous one ended is a reconnect, not a new broadcast */
export const TWITCH_RECONNECT_MS = 15 * 60_000
/** A stream's title can be "" for a few seconds after it goes live; wait this long for it */
export const TWITCH_TITLE_WAIT_MS = 2 * 60_000

/** The Lone Star Cup: the one league whose standings the site shows (/lone-star-cup) */
const LSC_LEAGUE = "lone-star-cup"

/** The dedupe keys of rule posts. A reminder's carries the event's start time, so a moved event gets new ones */
export const ruleKey = {
  reminder: (ruleId: string, eventId: string, startsAt: Date, offsetMinutes: number) => `event_reminder:${ruleId}:${eventId}:${startsAt.toISOString()}:${offsetMinutes}`,
  newEvent: (ruleId: string, eventId: string) => `new_event:${ruleId}:${eventId}`,
  results: (ruleId: string, eventId: string) => `results_posted:${ruleId}:${eventId}`,
  standings: (ruleId: string, seasonId: string, auditId: string) => `standings_update:${ruleId}:${seasonId}:${auditId}`,
  twitch: (ruleId: string, streamId: string) => `twitch_live:${ruleId}:${streamId}`,
}

/** What a rule post's key says it's about */
export function parseRuleKey(key: string | null): { kind: "event_reminder"; ruleId: string; eventId: string; startsAt: string; offset: number } | { kind: "new_event" | "results_posted"; ruleId: string; eventId: string } | { kind: "standings_update"; ruleId: string; seasonId: string } | { kind: "twitch_live"; ruleId: string; streamId: string } | null {
  if (!key) return null
  const reminder = key.match(/^event_reminder:([^:]+):([^:]+):(.+):(\d+)$/)
  if (reminder) return { kind: "event_reminder", ruleId: reminder[1], eventId: reminder[2], startsAt: reminder[3], offset: Number(reminder[4]) }
  const simple = key.match(/^(new_event|results_posted|twitch_live|standings_update):([^:]+):([^:]+)/)
  if (!simple) return null
  if (simple[1] === "twitch_live") return { kind: "twitch_live", ruleId: simple[2], streamId: simple[3] }
  if (simple[1] === "standings_update") return { kind: "standings_update", ruleId: simple[2], seasonId: simple[3] }
  return { kind: simple[1] as "new_event" | "results_posted", ruleId: simple[2], eventId: simple[3] }
}

/** JSON with its keys sorted, so a stored message (Postgres reorders jsonb keys) compares equal to a fresh one */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export type RuleRunContext = { now: Date; log: (line: string) => void; siteUrl?: string }
export type RuleRunCounts = { queued: number; refreshed: number; cancelled: number }

const since = (rule: Pick<DiscordRule, "cutoffAt">, now: Date) => new Date(Math.max(rule.cutoffAt.getTime(), now.getTime() - LOOK_BACK_MS))

async function existing(key: string): Promise<DiscordPost | null> {
  return prisma.discordPost.findUnique({ where: { dedupeKey: key } })
}

/** Why a scheduled reminder shouldn't go anymore (its event moved, was cancelled or unpublished, or the rule changed), or null */
async function reminderProblem(post: Pick<DiscordPost, "dedupeKey">, config: RuleConfig, now: Date): Promise<string | null> {
  const key = parseRuleKey(post.dedupeKey)
  if (key?.kind !== "event_reminder") return "It isn't a reminder this rule makes."
  if (!(config.offsets ?? []).includes(key.offset)) return "The rule no longer sends this reminder."
  const event = await prisma.event.findUnique({ where: { id: key.eventId }, select: EVENT_SELECT })
  if (!event) return "Its event was deleted."
  const problem = eventProblem(event, now, config.series)
  if (problem) return `“${event.title}” ${problem}.`
  if (event.startsAtUtc.toISOString() !== key.startsAt) return `“${event.title}” moved to ${when(event.startsAtUtc)}; it gets new reminders.`
  if (event.startsAtUtc <= now) return `“${event.title}” already started.`
  return null
}

async function runReminders(rule: DiscordRule, config: RuleConfig, ctx: RuleRunContext): Promise<RuleRunCounts> {
  const counts: RuleRunCounts = { queued: 0, refreshed: 0, cancelled: 0 }
  const siteUrl = ctx.siteUrl ?? getSiteUrl()
  const offsets = config.offsets ?? []

  // Pending reminders first: cancel the ones that shouldn't go anymore
  const pending = await prisma.discordPost.findMany({ where: { ruleId: rule.id, status: "SCHEDULED" }, select: { id: true, dedupeKey: true } })
  for (const post of pending) {
    const problem = await reminderProblem(post, config, ctx.now)
    if (problem) counts.cancelled += await cancelPosts({ id: post.id }, problem, { release: true })
  }

  const latest = new Date(ctx.now.getTime() + REMINDER_HORIZON_MS + Math.max(0, ...offsets) * 60_000)
  const events = await prisma.event.findMany({ where: postableEvents(ctx.now, config.series, { startsAtUtc: { gt: ctx.now, lte: latest } }), select: EVENT_SELECT, orderBy: { startsAtUtc: "asc" }, take: 100 })
  for (const event of events) {
    if (eventProblem(event, ctx.now, config.series)) continue
    for (const offset of offsets) {
      const at = new Date(event.startsAtUtc.getTime() - offset * 60_000)
      if (at <= rule.cutoffAt || at.getTime() < ctx.now.getTime() - REMINDER_GRACE_MS || at.getTime() > ctx.now.getTime() + REMINDER_HORIZON_MS) continue
      const key = ruleKey.reminder(rule.id, event.id, event.startsAtUtc, offset)
      const body = eventReminderBody(forPost(event), { siteUrl, ping: config.ping, now: ctx.now })
      const found = await existing(key)
      if (!found) {
        if (counts.queued >= MAX_REMINDERS_PER_RUN) continue
        const { created } = await queueDiscordPost({ source: "rule", ruleId: rule.id, channelId: rule.channelId!, body, scheduledFor: at, dedupeKey: key })
        if (created) counts.queued++
      } else if (found.status === "SCHEDULED" && stableJson(found.content) !== stableJson(body)) {
        // The event's title, venue or registration changed: the reminder says what's true now
        const { count } = await prisma.discordPost.updateMany({ where: { id: found.id, status: "SCHEDULED" }, data: { content: body as unknown as Prisma.InputJsonValue } })
        counts.refreshed += count
      }
    }
  }
  return counts
}

async function runNewEvents(rule: DiscordRule, config: RuleConfig, ctx: RuleRunContext): Promise<RuleRunCounts> {
  const counts: RuleRunCounts = { queued: 0, refreshed: 0, cancelled: 0 }
  const from = since(rule, ctx.now)
  const events = await prisma.event.findMany({
    where: postableEvents(ctx.now, config.series, { startsAtUtc: { gt: ctx.now }, OR: [{ publishedAt: { gt: from } }, { publishedAt: null, createdAt: { gt: from } }] }),
    select: EVENT_SELECT,
    orderBy: [{ publishedAt: "asc" }, { startsAtUtc: "asc" }],
    take: 20,
  })
  for (const event of events) {
    if (counts.queued >= MAX_NEW_PER_RUN) break
    if (eventProblem(event, ctx.now, config.series)) continue
    const key = ruleKey.newEvent(rule.id, event.id)
    if (await existing(key)) continue
    const { created } = await queueDiscordPost({ source: "rule", ruleId: rule.id, channelId: rule.channelId!, body: newEventBody(forPost(event), { siteUrl: ctx.siteUrl ?? getSiteUrl(), ping: config.ping, now: ctx.now }), dedupeKey: key, scheduledFor: ctx.now })
    if (created) counts.queued++
  }
  return counts
}

async function runResults(rule: DiscordRule, config: RuleConfig, ctx: RuleRunContext): Promise<RuleRunCounts> {
  const counts: RuleRunCounts = { queued: 0, refreshed: 0, cancelled: 0 }
  // Uploads ingested since the cutoff, newest first: one post per event, once it has race results
  const ingests = await prisma.auditLog.findMany({ where: { actionType: "INGEST", entityType: "RESULT_UPLOAD", createdAt: { gt: since(rule, ctx.now) } }, orderBy: { createdAt: "desc" }, take: 50, select: { metadata: true } })
  const eventIds = [...new Set(ingests.map((a) => (a.metadata as { eventId?: unknown } | null)?.eventId).filter((id): id is string => typeof id === "string"))]
  for (const eventId of eventIds) {
    if (counts.queued >= MAX_NEW_PER_RUN) break
    const key = ruleKey.results(rule.id, eventId)
    if (await existing(key)) continue
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: EVENT_SELECT })
    if (!event || !isEventPublic(event, ctx.now) || (config.series && event.series?.slug !== config.series)) continue
    const race = await prisma.raceSession.findFirst({
      where: { eventId, sessionType: "RACE", results: { some: {} } },
      orderBy: { startedAt: "desc" },
      select: { trackName: true, results: { orderBy: { position: "asc" }, take: 3, select: { participant: { select: { displayName: true, user: { select: { displayName: true } } } } } } },
    })
    if (!race) continue
    const podium = race.results.map((r) => r.participant.user?.displayName ?? r.participant.displayName)
    const body = resultsBody({ event, trackName: race.trackName, podium }, { siteUrl: ctx.siteUrl ?? getSiteUrl(), ping: config.ping })
    const { created } = await queueDiscordPost({ source: "rule", ruleId: rule.id, channelId: rule.channelId!, body, dedupeKey: key, scheduledFor: ctx.now })
    if (created) counts.queued++
  }
  return counts
}

async function runStandings(rule: DiscordRule, config: RuleConfig, ctx: RuleRunContext): Promise<RuleRunCounts> {
  const counts: RuleRunCounts = { queued: 0, refreshed: 0, cancelled: 0 }
  const league = await prisma.league.findUnique({ where: { slug: LSC_LEAGUE }, select: { id: true, visibility: true } })
  if (!league || league.visibility !== "public") return counts
  // The standings tool reads recomputes the same way (src/server/jack/tools/standings.ts)
  const recomputes = await prisma.auditLog.findMany({
    where: { entityType: "SEASON", actionType: "UPDATE", summary: { startsWith: "Recomputed standings" }, createdAt: { gt: since(rule, ctx.now) } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, entityId: true },
  })
  const latest = new Map<string, string>()
  for (const r of recomputes) if (!latest.has(r.entityId)) latest.set(r.entityId, r.id)
  for (const [seasonId, auditId] of latest) {
    if (counts.queued >= MAX_NEW_PER_RUN) break
    const key = ruleKey.standings(rule.id, seasonId, auditId)
    if (await existing(key)) continue
    const season = await prisma.season.findUnique({ where: { id: seasonId }, select: { id: true, name: true, leagueId: true, visibility: true } })
    if (!season || season.leagueId !== league.id || season.visibility !== "public") continue
    const entries = await prisma.entry.findMany({
      where: { seasonId, user: { isNot: null }, totalPoints: { gt: 0 } },
      orderBy: [{ rank: "asc" }, { totalPoints: "desc" }],
      take: config.top ?? 5,
      select: { totalPoints: true, user: { select: { displayName: true } } },
    })
    if (!entries.length) continue
    const body = standingsBody({ seasonName: season.name, rows: entries.map((e) => ({ name: e.user?.displayName ?? "Unknown", points: e.totalPoints })), url: `${ctx.siteUrl ?? getSiteUrl()}/lone-star-cup` }, { ping: config.ping })
    // A recompute that changed nothing at the top isn't news
    const previous = await prisma.discordPost.findFirst({ where: { ruleId: rule.id, dedupeKey: { startsWith: `standings_update:${rule.id}:${seasonId}:` }, status: { in: ["SCHEDULED", "SENDING", "SENT"] } }, orderBy: { createdAt: "desc" }, select: { content: true } })
    if (previous && readBody(previous.content)?.content === body.content) continue
    const { created } = await queueDiscordPost({ source: "rule", ruleId: rule.id, channelId: rule.channelId!, body, dedupeKey: key, scheduledFor: ctx.now })
    if (created) counts.queued++
  }
  return counts
}

async function runTwitch(rule: DiscordRule, config: RuleConfig, ctx: RuleRunContext): Promise<RuleRunCounts> {
  const counts: RuleRunCounts = { queued: 0, refreshed: 0, cancelled: 0 }
  const live = await currentLiveStream(ctx.now)
  if (!live) return counts
  // Recent streams only: rows the daily snapshot adds from old VODs are already ended
  const streams = await streamsWentLiveSince(since(rule, ctx.now), 10)
  const stream = streams.find((s) => s.id === live.id && s.endedAt === null)
  if (!stream) return counts
  if (!stream.title && ctx.now.getTime() - stream.startedAt.getTime() < TWITCH_TITLE_WAIT_MS) return counts
  const key = ruleKey.twitch(rule.id, stream.id)
  if (await existing(key)) return counts
  // A reconnect (an encoder drop gets a new stream id) is the same broadcast: no second post
  const previous = await prisma.twitchStream.findFirst({ where: { startedAt: { lt: stream.startedAt } }, orderBy: { startedAt: "desc" }, select: { endedAt: true } })
  if (previous && (!previous.endedAt || previous.endedAt.getTime() > stream.startedAt.getTime() - TWITCH_RECONNECT_MS)) {
    ctx.log("Twitch: a reconnect of the stream before it, not posted.")
    return counts
  }
  const { created } = await queueDiscordPost({ source: "rule", ruleId: rule.id, channelId: rule.channelId!, body: twitchLiveBody({ title: stream.title, gameName: stream.gameName, channelUrl: TWITCH_URL }, { ping: config.ping }), dedupeKey: key, scheduledFor: ctx.now })
  if (created) counts.queued++
  return counts
}

const RUNNERS: Partial<Record<RuleKind, (rule: DiscordRule, config: RuleConfig, ctx: RuleRunContext) => Promise<RuleRunCounts>>> = {
  event_reminder: runReminders,
  new_event: runNewEvents,
  results_posted: runResults,
  standings_update: runStandings,
  twitch_live: runTwitch,
}

export type RulesRun = RuleRunCounts & { rules: number; skipped: number; errors: string[] }

/** One run over every switched-on posting rule. A rule that fails is reported; the others still run */
export async function runDiscordRules(ctx: RuleRunContext & { signal?: AbortSignal }): Promise<RulesRun> {
  const run: RulesRun = { rules: 0, queued: 0, refreshed: 0, cancelled: 0, skipped: 0, errors: [] }
  const rules = await prisma.discordRule.findMany({ where: { enabled: true, kind: { not: "event_mirror" } }, orderBy: { createdAt: "asc" } })
  const allowed = new Set(await postingChannelIds())
  for (const rule of rules) {
    if (ctx.signal?.aborted) break
    const config = readRuleConfig(rule.kind, rule.config)
    const runner = isRuleKind(rule.kind) ? RUNNERS[rule.kind] : undefined
    const label = isRuleKind(rule.kind) ? RULE_INFO[rule.kind].label : rule.kind
    if (!config || !runner) {
      run.skipped++
      ctx.log(`${label}: its settings can't be read; skipped.`)
      continue
    }
    if (!rule.channelId || !allowed.has(rule.channelId)) {
      run.skipped++
      ctx.log(`${label}: its channel isn't a posting channel anymore; skipped.`)
      continue
    }
    run.rules++
    try {
      const counts = await runner(rule, config, ctx)
      run.queued += counts.queued
      run.refreshed += counts.refreshed
      run.cancelled += counts.cancelled
    } catch (error) {
      run.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return run
}

/**
 * Right before a rule's post is sent: why it shouldn't go anymore (its rule was switched off, deleted or
 * moved to another channel; its event moved, was cancelled, unpublished or started; the stream ended),
 * or null to send it
 */
export async function rulePostProblem(post: DiscordPost, now: Date): Promise<string | null> {
  if (!post.ruleId) return null
  const rule = await prisma.discordRule.findUnique({ where: { id: post.ruleId } })
  if (!rule) return "Its rule was deleted."
  if (!rule.enabled) return "Its rule is switched off."
  if (rule.channelId !== post.channelId) return "Its rule posts in another channel now."
  const config = readRuleConfig(rule.kind, rule.config)
  if (!config) return "Its rule's settings can't be read."
  const key = parseRuleKey(post.dedupeKey)
  if (!key) return null
  if (key.kind === "event_reminder") return reminderProblem(post, config, now)
  if (key.kind === "new_event" || key.kind === "results_posted") {
    const event = await prisma.event.findUnique({ where: { id: key.eventId }, select: EVENT_SELECT })
    if (!event) return "Its event was deleted."
    // Results go out for any public event; a new-event post only for one that's still on and ahead
    if (key.kind === "results_posted") return isEventPublic(event, now) ? null : `“${event.title}” isn't public on the site anymore.`
    const problem = eventProblem(event, now, config.series)
    if (problem) return `“${event.title}” ${problem}.`
    if (event.startsAtUtc <= now) return `“${event.title}” already started.`
    return null
  }
  if (key.kind === "twitch_live") {
    const live = await currentLiveStream(now)
    return live?.id === key.streamId ? null : "The stream already ended."
  }
  return null
}
