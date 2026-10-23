import { getSiteUrl } from "@/lib/site-url"
import { clipText, stripLinks, stripMentions, tidy } from "@/lib/discord/text"
import { prisma } from "@/server/db"
import { DiscordApiError } from "@/server/connectors/discord/client"
import { DISCORD_WRITE_ERROR, type DiscordWriter, type ScheduledEventInput } from "@/server/connectors/discord/write"
import { EVENT_SELECT, eventProblem, postableEvents, type EventRow } from "./events"
import { readRuleConfig } from "./rules"
import { eventUrl } from "./templates"

/**
 * The event mirror (design §12.1, rule kind event_mirror): each upcoming public event becomes an
 * external scheduled event in the club server's Events list, kept up to date, with how many members
 * marked themselves interested read back (DiscordEventMirror.interestedCount, shown on Community →
 * Discord). One job (`discord.event-mirror`, every 15 minutes) while an event mirror rule is on:
 * - creates a Discord event for each public event starting in the next MIRROR_HORIZON_MS, and edits it
 *   when the event changes (its title, summary, times or venue; never its meeting link);
 * - deletes the Discord event of one that was cancelled, postponed, unpublished or deleted before it
 *   started (past ones are left: Discord completes them on its own);
 * - leaves alone a Discord event an admin deleted by hand (it isn't made again);
 * - at most MAX_MIRROR_WRITES_PER_RUN writes a run.
 */

export const MIRROR_HORIZON_MS = 60 * 24 * 60 * 60_000
export const MAX_MIRROR_WRITES_PER_RUN = 10
const REASON = "LSR website: event mirror"
const HOUR_MS = 60 * 60_000

/** Plain text for a field Discord doesn't format: no mentions or links, one line */
const plain = (text: string | null | undefined) => tidy(stripLinks(stripMentions(text ?? "")).replace(/\s+/g, " "))

/** The Discord event for one of ours: what's public about it, never its meeting link */
export function scheduledEventFor(event: Pick<EventRow, "slug" | "title" | "summary" | "startsAtUtc" | "endsAtUtc" | "venue">, { siteUrl, location }: { siteUrl: string; location?: string | null }): ScheduledEventInput {
  const url = eventUrl(siteUrl, event.slug)
  const summary = plain(event.summary)
  const end = event.endsAtUtc > event.startsAtUtc ? event.endsAtUtc : new Date(event.startsAtUtc.getTime() + HOUR_MS)
  const place = event.venue ? plain([event.venue.name, event.venue.room].filter(Boolean).join(", ")) : ""
  return {
    name: clipText(plain(event.title) || "Club event", 100),
    description: clipText(summary ? `${clipText(summary, 800)}\n\nDetails and registration: ${url}` : `Details and registration: ${url}`, 1000),
    scheduled_start_time: event.startsAtUtc.toISOString(),
    scheduled_end_time: end.toISOString(),
    entity_metadata: { location: clipText(place || plain(location) || "See the event page on longhornsimracing.org", 100) },
    channel_id: null,
    privacy_level: 2,
    entity_type: 3,
  }
}

export type MirrorRun = { status: "ok" | "no-rule"; created: number; updated: number; removed: number; counted: number; gone: number }

const unknownEvent = (error: unknown) => error instanceof DiscordApiError && error.code === DISCORD_WRITE_ERROR.unknownEvent

export async function runEventMirror(writer: DiscordWriter, ctx: { now: Date; log: (line: string) => void; signal?: AbortSignal; siteUrl?: string }): Promise<MirrorRun> {
  const run: MirrorRun = { status: "ok", created: 0, updated: 0, removed: 0, counted: 0, gone: 0 }
  const rule = await prisma.discordRule.findFirst({ where: { kind: "event_mirror", enabled: true }, orderBy: { createdAt: "asc" } })
  const config = rule ? readRuleConfig(rule.kind, rule.config) : null
  if (!rule || !config) return { ...run, status: "no-rule" }
  const siteUrl = ctx.siteUrl ?? getSiteUrl()
  const { now } = ctx
  let writes = 0
  const room = () => writes < MAX_MIRROR_WRITES_PER_RUN && !ctx.signal?.aborted

  const events = await prisma.event.findMany({
    where: postableEvents(now, config.series, { startsAtUtc: { gt: now, lte: new Date(now.getTime() + MIRROR_HORIZON_MS) }, AND: [{ startsAtUtc: { gt: rule.cutoffAt } }] }),
    select: EVENT_SELECT,
    orderBy: { startsAtUtc: "asc" },
    take: 50,
  })
  const mirrors = await prisma.discordEventMirror.findMany()
  const byEvent = new Map(mirrors.map((m) => [m.eventId, m]))
  const wanted = new Set<string>()

  for (const event of events) {
    if (eventProblem(event, now, config.series)) continue
    wanted.add(event.id)
    if (!room()) continue
    const input = scheduledEventFor(event, { siteUrl, location: config.location })
    const mirror = byEvent.get(event.id)
    if (!mirror) {
      const created = await writer.createScheduledEvent(input, REASON, ctx.signal)
      writes++
      await prisma.discordEventMirror.create({ data: { eventId: event.id, discordEventId: created.id, eventStartsAt: event.startsAtUtc, lastSyncedAt: now, interestedCount: created.user_count ?? 0 } })
      run.created++
      continue
    }
    if (event.updatedAt <= mirror.lastSyncedAt && event.startsAtUtc.getTime() === mirror.eventStartsAt.getTime()) continue
    try {
      await writer.updateScheduledEvent(mirror.discordEventId, input, REASON, ctx.signal)
      run.updated++
    } catch (error) {
      if (!unknownEvent(error)) throw error
      // An admin deleted it in Discord: left that way
      run.gone++
      ctx.log(`“${event.title}” was deleted in Discord; not made again.`)
    }
    writes++
    await prisma.discordEventMirror.update({ where: { eventId: event.id }, data: { eventStartsAt: event.startsAtUtc, lastSyncedAt: now } })
  }

  // Upcoming mirrors of events that aren't wanted anymore: off the Events list
  for (const mirror of mirrors) {
    if (wanted.has(mirror.eventId) || mirror.eventStartsAt <= now || !room()) continue
    const event = await prisma.event.findUnique({ where: { id: mirror.eventId }, select: EVENT_SELECT })
    // Still on, just outside the window (moved far ahead) or not reached this run: leave it for a later run
    if (event && !eventProblem(event, now, config.series) && event.startsAtUtc > now && (event.startsAtUtc.getTime() > now.getTime() + MIRROR_HORIZON_MS || events.length >= 50)) continue
    try {
      await writer.deleteScheduledEvent(mirror.discordEventId, REASON, ctx.signal)
    } catch (error) {
      if (!unknownEvent(error)) throw error
    }
    writes++
    await prisma.discordEventMirror.delete({ where: { eventId: mirror.eventId } })
    run.removed++
    ctx.log(`Took “${event?.title ?? "a deleted event"}” off Discord's Events list (${event ? (eventProblem(event, now, config.series) ?? "moved out of the mirror's range") : "deleted on the site"}).`)
  }

  // Interested counts, for the events Discord still lists (finished ones keep their last count)
  const listed = await writer.scheduledEvents(ctx.signal)
  for (const event of listed) {
    if (typeof event.user_count !== "number") continue
    const { count } = await prisma.discordEventMirror.updateMany({ where: { discordEventId: event.id, OR: [{ interestedCount: null }, { interestedCount: { not: event.user_count } }] }, data: { interestedCount: event.user_count } })
    run.counted += count
  }
  return run
}
