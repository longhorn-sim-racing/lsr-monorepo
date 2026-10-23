import { fromZonedTime } from "date-fns-tz"
import { chicagoDay, DEFAULT_TIMEZONE } from "@/lib/dates"
import { DISCORD_ERROR, DiscordApiError, DiscordRateLimitError, type DiscordClient } from "./client"
import { keepMessage, messageRow, type MessageRow, type PurgedList } from "./metadata"
import { compareSnowflakes, snowflakeAt, snowflakeTime } from "./snowflake"
import type { ChannelInput, DiscordStore, MemberInput, StoredChannel, StoredMessage } from "./store"
import { CHANNEL_TYPE, MESSAGE_CHANNEL_TYPES, SYNCABLE_CHANNEL_TYPES, SYNCED_THREAD_TYPES, THREAD_PARENT_TYPES, type DiscordMessage } from "./types"

/**
 * The Discord sync (design §12.1, research §3 and §6), REST only: metadata of the channels admins opted
 * in (and the public threads in them), never message text, and nothing at all from other channels.
 * - `syncMessages` (every 10 minutes): new messages since each channel's cursor, a page of 100 at a time,
 *   saving the cursor with every page so a run cut short picks up where it stopped. A channel's first
 *   run reaches back `backfillDays`. A page is written only while its channel is still opted in.
 * - `rescan` (hourly): Discord has no feed of edits and deletions without the gateway, so the trailing
 *   7 days are read again; rows missing from a complete pass are marked deleted, edits and poll counts
 *   updated. Polls older than that are refreshed one by one until they're finalized.
 * - `syncMembers` (hourly): the member list, diffed against the last one for joins and leaves.
 * A thread Discord deleted is dropped with its messages; a channel Discord deleted is switched off.
 * Daily stats (DiscordDailyStat, DiscordGuildDaily) are rebuilt for every Central day a run touched.
 */

const DAY_MS = 86_400_000
/** No new page starts this close to the deadline, so the run can save what it has and rebuild its stats */
const STOP_MARGIN_MS = 12_000
const PAGE = 100
const MEMBER_PAGE = 1000
/** How far back a channel's first sync reads, unless the job's config says otherwise */
export const DEFAULT_BACKFILL_DAYS = 90
/** How far back the re-scan reads for edits and deletions */
export const RESCAN_DAYS = 7
/** Polls refreshed one by one per re-scan */
const OPEN_POLLS_PER_RUN = 25

export type SyncContext = {
  client: DiscordClient
  store: DiscordStore
  signal?: AbortSignal
  /** Epoch ms the run must be done by */
  deadline?: number
  now?: () => Date
  log?: (line: string) => void
}

/** A channel the run couldn't read, and why (shown in the run's summary and the connector's last error) */
export type ChannelProblem = { channel: string; error: string }

/** An opted-in channel Discord deleted: the run switched it off, deleting the records stored from it */
export type GoneChannel = { id: string; name: string; messages: number }

/** What a run gathers besides its counts */
type RunState = { touched: Map<number, Date>; problems: ChannelProblem[]; gone: GoneChannel[]; threadsGone: number; unfinished: number }

const newRun = (): RunState => ({ touched: new Map(), problems: [], gone: [], threadsGone: 0, unfinished: 0 })

const clock = (ctx: SyncContext) => (ctx.now ? ctx.now() : new Date())

function stopping(ctx: SyncContext): boolean {
  return Boolean(ctx.signal?.aborted) || (ctx.deadline !== undefined && Date.now() > ctx.deadline - STOP_MARGIN_MS)
}

/** A 401 stops the whole run (the token is bad); anything else is that channel's problem */
function fatal(error: unknown): boolean {
  return error instanceof DiscordApiError && error.status === 401
}

/** The run was stopped (its deadline) or Discord asked us to wait longer than the client waits: not a fault, the next run resumes from the saved cursor */
function interrupted(error: unknown, ctx: SyncContext): boolean {
  return Boolean(ctx.signal?.aborted) || error instanceof DiscordRateLimitError
}

/** Discord says there's no such channel (404 10003): deleted, a thread included */
function unknownChannel(error: unknown): boolean {
  return error instanceof DiscordApiError && error.status === 404 && error.code === DISCORD_ERROR.unknownChannel
}

const byId = (a: { id: string }, b: { id: string }) => compareSnowflakes(a.id, b.id)

/** A Central calendar day (as chicagoDay stores it) as the instants it runs between */
export function chicagoDayBounds(day: Date): { start: Date; end: Date } {
  const ymd = (date: Date) => date.toISOString().slice(0, 10)
  return { start: fromZonedTime(`${ymd(day)}T00:00:00`, DEFAULT_TIMEZONE), end: fromZonedTime(`${ymd(new Date(day.getTime() + DAY_MS))}T00:00:00`, DEFAULT_TIMEZONE) }
}

/** Every Central day from `from` to `to`, as chicagoDay values */
export function daysBetween(from: Date, to: Date): Date[] {
  const days: Date[] = []
  for (let day = chicagoDay(from); day.getTime() <= chicagoDay(to).getTime(); day = new Date(day.getTime() + DAY_MS)) days.push(day)
  return days
}

/** Rebuilds DiscordDailyStat for these days from the stored messages (threads count toward their channel) */
export async function rebuildDailyStats(store: DiscordStore, days: Iterable<Date>): Promise<number> {
  const unique = [...new Map([...days].map((day) => [day.getTime(), day])).values()].sort((a, b) => a.getTime() - b.getTime())
  for (const day of unique) {
    const { start, end } = chicagoDayBounds(day)
    await store.writeDailyStats(day, await store.dailyCounts(start, end))
  }
  return unique.length
}

/** The channels opted in, by id */
function syncedTop(channels: StoredChannel[]): Map<string, StoredChannel> {
  return new Map(channels.filter((c) => !c.parentId && c.synced).map((c) => [c.id, c]))
}

/**
 * Reads the server's channels into DiscordChannel (new ones arrive switched off), and the active public
 * threads of the channels that are opted in, with the channel as their parent. Thread titles are written
 * by members, so none are kept from channels that aren't synced. A channel missing from the list stays
 * (since 2026-11-16 Discord leaves out channels the bot can't see, which isn't deletion)
 */
export async function refreshChannels(ctx: SyncContext): Promise<{ channels: StoredChannel[]; activeThreads: Set<string> }> {
  const [listed, active, stored] = await Promise.all([ctx.client.channels(ctx.signal), ctx.client.activeThreads(ctx.signal), ctx.store.channels()])
  const categories = new Map(listed.filter((c) => c.type === CHANNEL_TYPE.category).map((c) => [c.id, c.name ?? ""]))
  const top = listed.filter((c) => SYNCABLE_CHANNEL_TYPES.includes(c.type))
  const names = new Map(top.map((c) => [c.id, c.name ?? c.id]))
  const opted = syncedTop(stored)
  const threads = active.threads.filter((t) => SYNCED_THREAD_TYPES.includes(t.type) && t.parent_id && names.has(t.parent_id) && opted.has(t.parent_id))
  const inputs: ChannelInput[] = [
    ...top.map((c) => ({ id: c.id, name: c.name ?? c.id, type: c.type, parentId: null, parentName: (c.parent_id && categories.get(c.parent_id)) || null })),
    ...threads.map((t) => ({ id: t.id, name: t.name ?? t.id, type: t.type, parentId: t.parent_id!, parentName: names.get(t.parent_id!) ?? null })),
  ]
  await ctx.store.saveChannels(inputs)
  return { channels: await ctx.store.channels(), activeThreads: new Set(threads.map((t) => t.id)) }
}

const oldestFirst = (a: StoredChannel, b: StoredChannel) => (a.lastSyncedAt?.getTime() ?? 0) - (b.lastSyncedAt?.getTime() ?? 0)

/**
 * Reads a channel's new messages after its cursor (or from `backfillFrom` the first time), saving the
 * cursor with each page. Stops, keeping nothing more, once the channel is switched off
 */
async function readNew(ctx: SyncContext, target: StoredChannel, backfillFrom: Date, purged: PurgedList, touched: Map<number, Date>): Promise<{ added: number; done: boolean }> {
  let cursor = target.lastMessageId ?? snowflakeAt(backfillFrom)
  let added = 0
  for (;;) {
    if (stopping(ctx)) return { added, done: false }
    const page = (await ctx.client.messages(target.id, { after: cursor, limit: PAGE }, ctx.signal)).sort(byId)
    const now = clock(ctx)
    const rows = page.filter((m) => keepMessage(m, purged)).map((m) => messageRow(m, now))
    if (page.length) cursor = page[page.length - 1].id
    const saved = await ctx.store.savePage(target.id, { insert: rows, cursor: { lastMessageId: cursor, lastSyncedAt: now } })
    if (!saved) return { added, done: true }
    added += saved.added
    for (const row of rows) touched.set(chicagoDay(row.createdAt).getTime(), chicagoDay(row.createdAt))
    if (page.length < PAGE) return { added, done: true }
  }
}

/**
 * After a channel or thread failed: a rejected token stops the run (thrown); a stop or a long rate limit
 * leaves it for the next run; a thread or channel Discord deleted is dropped (dropDeleted); anything
 * else is a problem the run reports
 */
async function failed(ctx: SyncContext, target: StoredChannel, channels: StoredChannel[], error: unknown, run: RunState): Promise<void> {
  if (fatal(error)) throw error
  if (interrupted(error, ctx)) {
    run.unfinished++
    return
  }
  let reason = error
  if (unknownChannel(error)) {
    try {
      if (await dropDeleted(ctx, target, run)) return
    } catch (check) {
      if (fatal(check)) throw check
      if (interrupted(check, ctx)) {
        run.unfinished++
        return
      }
      reason = check
    }
  }
  run.problems.push({ channel: label(target, channels), error: reason instanceof Error ? reason.message : String(reason) })
}

/**
 * A thread or channel Discord answered 404 10003 for. A thread (a member deleting their forum post, say)
 * is dropped with its messages, and its days' stats rebuilt. A channel is checked once more with
 * GET /channels/:id (research §6) and, once Discord confirms it's gone, switched off with everything
 * stored from it. False when Discord says the channel is still there
 */
async function dropDeleted(ctx: SyncContext, target: StoredChannel, run: RunState): Promise<boolean> {
  if (target.parentId) {
    const span = await ctx.store.dropThread(target.id)
    if (span) for (const day of daysBetween(span.from, span.to)) run.touched.set(day.getTime(), day)
    run.threadsGone++
    return true
  }
  try {
    await ctx.client.channel(target.id, ctx.signal)
    return false
  } catch (error) {
    if (!unknownChannel(error)) throw error
  }
  run.gone.push({ id: target.id, name: target.name, messages: await ctx.store.switchOff(target.id, { gone: true }) })
  return true
}

/** Whether a channel (or a thread's channel) was found deleted earlier in this run */
const goneEarlier = (run: RunState, target: StoredChannel) => run.gone.some((g) => g.id === (target.parentId ?? target.id))

export type MessageSyncResult = {
  channels: number
  threads: number
  added: number
  unfinished: number
  days: number
  problems: ChannelProblem[]
  /** Opted-in channels Discord deleted, switched off */
  gone: GoneChannel[]
  /** Threads Discord deleted, dropped with their messages */
  threadsGone: number
}

/** New messages in every opted-in channel and its active threads, oldest-synced first */
export async function syncMessages(ctx: SyncContext, options: { backfillDays?: number } = {}): Promise<MessageSyncResult> {
  const now = clock(ctx)
  const backfillFrom = new Date(now.getTime() - (options.backfillDays ?? DEFAULT_BACKFILL_DAYS) * DAY_MS)
  const [{ channels, activeThreads }, purged] = await Promise.all([refreshChannels(ctx), ctx.store.purgedAuthors()])
  const synced = syncedTop(channels)
  const targets = [
    ...[...synced.values()].filter((c) => MESSAGE_CHANNEL_TYPES.includes(c.type)),
    ...channels.filter((c) => c.parentId && synced.has(c.parentId) && activeThreads.has(c.id)),
  ].sort(oldestFirst)

  const run = newRun()
  let added = 0
  for (const target of targets) {
    if (goneEarlier(run, target)) continue
    if (stopping(ctx)) {
      run.unfinished++
      continue
    }
    try {
      const result = await readNew(ctx, target, backfillFrom, purged, run.touched)
      added += result.added
      if (!result.done) run.unfinished++
    } catch (error) {
      await failed(ctx, target, channels, error, run)
    }
  }
  const days = await rebuildDailyStats(ctx.store, run.touched.values())
  return {
    channels: targets.filter((t) => !t.parentId).length,
    threads: targets.filter((t) => t.parentId).length,
    added,
    unfinished: run.unfinished,
    days,
    problems: run.problems,
    gone: run.gone,
    threadsGone: run.threadsGone,
  }
}

/** "#general", or "#setups › Monza setup help" for a thread */
export function label(channel: StoredChannel, all: StoredChannel[]): string {
  if (!channel.parentId) return `#${channel.name}`
  const parent = all.find((c) => c.id === channel.parentId)
  return `#${parent?.name ?? channel.parentName ?? "?"} › ${channel.name}`
}

const changed = (was: StoredMessage, row: MessageRow) =>
  Boolean(was.deletedAt) ||
  was.editedAt?.getTime() !== row.editedAt?.getTime() ||
  was.contentLength !== row.contentLength ||
  was.attachments !== row.attachments ||
  JSON.stringify(was.poll) !== JSON.stringify(row.poll)

/** Writes a page read again: new rows added, changed ones updated (and undeleted), the rest stamped as seen. Null once the channel is switched off */
async function saveSeen(ctx: SyncContext, channelId: string, page: DiscordMessage[], purged: PurgedList, now: Date): Promise<{ added: number; updated: number } | null> {
  const kept = page.filter((m) => keepMessage(m, purged))
  const stored = await ctx.store.messagesByIds(kept.map((m) => m.id))
  const fresh: MessageRow[] = []
  const updates: MessageRow[] = []
  const same: string[] = []
  for (const message of kept) {
    const was = stored.get(message.id)
    const row = messageRow(message, now, was)
    if (!was) fresh.push(row)
    else if (changed(was, row)) updates.push(row)
    else same.push(message.id)
  }
  const saved = await ctx.store.savePage(channelId, { insert: fresh, update: updates, touch: same, at: now })
  return saved && { added: saved.added, updated: updates.length }
}

/**
 * Reads a channel's last days again: what's missing from the pass was deleted. A pass cut short marks
 * deletions only up to the last message it read and saves where it got to (`rescanFrom`) for the next run
 */
async function rescanChannel(ctx: SyncContext, target: StoredChannel, windowStart: Date, purged: PurgedList): Promise<{ added: number; updated: number; deleted: number; done: boolean }> {
  const from = target.rescanFrom && target.rescanFrom > windowStart ? target.rescanFrom : windowStart
  const startedAt = clock(ctx)
  // A millisecond earlier, so a message made in `from`'s own millisecond is read too (after= leaves out the cursor)
  let cursor = snowflakeAt(new Date(from.getTime() - 1))
  let reached = from
  const seen = new Set<string>()
  let added = 0
  let updated = 0
  let done = false
  for (;;) {
    if (stopping(ctx)) break
    const page = (await ctx.client.messages(target.id, { after: cursor, limit: PAGE }, ctx.signal)).sort(byId)
    for (const message of page) seen.add(message.id)
    const saved = await saveSeen(ctx, target.id, page, purged, clock(ctx))
    // Switched off while this run read it: what was stored from it went with the switch
    if (!saved) return { added, updated, deleted: 0, done: true }
    added += saved.added
    updated += saved.updated
    if (page.length) {
      cursor = page[page.length - 1].id
      reached = snowflakeTime(cursor)
    }
    if (page.length < PAGE) {
      done = true
      break
    }
  }
  const upTo = done ? startedAt : reached
  // Cut short, only ids up to the last one read: a message made in that same millisecond may not have been read yet
  const gone = (await ctx.store.liveMessageIds(target.id, from, upTo)).filter((id) => !seen.has(id) && (done || compareSnowflakes(id, cursor) <= 0))
  const deleted = await ctx.store.markDeleted(gone, clock(ctx))
  await ctx.store.savePage(target.id, { cursor: { rescanFrom: done ? null : reached } })
  return { added, updated, deleted, done }
}

export type RescanResult = {
  channels: number
  added: number
  updated: number
  deleted: number
  polls: number
  unfinished: number
  days: number
  problems: ChannelProblem[]
  gone: GoneChannel[]
  threadsGone: number
}

/** Edits, deletions and poll counts in the last RESCAN_DAYS of every opted-in channel and its recent threads, plus older polls still open */
export async function rescan(ctx: SyncContext): Promise<RescanResult> {
  const now = clock(ctx)
  const windowStart = new Date(now.getTime() - RESCAN_DAYS * DAY_MS)
  const purged = await ctx.store.purgedAuthors()
  const run = newRun()
  let channels = await ctx.store.channels()

  // Threads archived in the window: their last messages may have come after the last sync saw them active.
  // Only channels that can have threads (Discord refuses the call for voice and stage channels)
  const archived: ChannelInput[] = []
  for (const parent of syncedTop(channels).values()) {
    if (!THREAD_PARENT_TYPES.includes(parent.type)) continue
    if (stopping(ctx)) break
    try {
      const { threads } = await ctx.client.archivedThreads(parent.id, { limit: 50 }, ctx.signal)
      for (const thread of threads) {
        const at = thread.thread_metadata?.archive_timestamp
        if (at && new Date(at) >= windowStart && SYNCED_THREAD_TYPES.includes(thread.type)) archived.push({ id: thread.id, name: thread.name ?? thread.id, type: thread.type, parentId: parent.id, parentName: parent.name })
      }
    } catch (error) {
      await failed(ctx, parent, channels, error, run)
    }
  }
  if (archived.length) await ctx.store.saveChannels(archived)
  // Read again: archived threads added, channels found deleted gone
  channels = await ctx.store.channels()
  const synced = syncedTop(channels)
  const recentlyArchived = new Set(archived.map((t) => t.id))
  const targets = [
    // A channel the sync hasn't read yet is left to it: its first read reaches back further than this window
    ...[...synced.values()].filter((c) => MESSAGE_CHANNEL_TYPES.includes(c.type) && c.lastMessageId),
    ...channels.filter((c) => c.parentId && synced.has(c.parentId) && (recentlyArchived.has(c.id) || (c.lastSyncedAt && c.lastSyncedAt >= windowStart))),
  ]

  let added = 0
  let updated = 0
  let deleted = 0
  for (const target of targets) {
    if (goneEarlier(run, target)) continue
    if (stopping(ctx)) {
      run.unfinished++
      continue
    }
    try {
      // A thread never read before gets its first read; then its window is read again like any channel
      if (!target.lastMessageId) {
        const first = await readNew(ctx, target, windowStart, purged, run.touched)
        added += first.added
        if (!first.done) {
          run.unfinished++
          continue
        }
      }
      const result = await rescanChannel(ctx, target, windowStart, purged)
      added += result.added
      updated += result.updated
      deleted += result.deleted
      if (!result.done) run.unfinished++
    } catch (error) {
      await failed(ctx, target, channels, error, run)
    }
  }

  const polls = await refreshOpenPolls(ctx, windowStart, channels, synced, purged)
  const days = await rebuildDailyStats(ctx.store, [...daysBetween(windowStart, now), ...run.touched.values()])
  return { channels: targets.length, added, updated, deleted, polls, unfinished: run.unfinished, days, problems: run.problems, gone: run.gone, threadsGone: run.threadsGone }
}

/** Polls older than the re-scan window that aren't finalized yet: each read again until Discord finalizes it */
async function refreshOpenPolls(ctx: SyncContext, before: Date, channels: StoredChannel[], synced: Map<string, StoredChannel>, purged: PurgedList): Promise<number> {
  const open = await ctx.store.openPolls(before, OPEN_POLLS_PER_RUN)
  let refreshed = 0
  for (const { id, channelId } of open) {
    if (stopping(ctx)) break
    const channel = channels.find((c) => c.id === channelId)
    if (!channel || !synced.has(channel.parentId ?? channel.id)) continue
    try {
      const message = await ctx.client.message(channelId, id, ctx.signal)
      const saved = await saveSeen(ctx, channelId, [message], purged, clock(ctx))
      refreshed += saved?.updated ?? 0
    } catch (error) {
      if (fatal(error)) throw error
      // The message, or the thread it was in, was deleted
      const deletedThere = error instanceof DiscordApiError && error.status === 404 && (error.code === DISCORD_ERROR.unknownMessage || error.code === DISCORD_ERROR.unknownChannel)
      if (deletedThere) await ctx.store.markDeleted([id], clock(ctx))
      else if (interrupted(error, ctx)) break
    }
  }
  return refreshed
}

export type MemberSyncResult = { members: number; joined: number; left: number; complete: boolean; memberCount: number; joinedToday: number; leftToday: number }

export class DiscordMembersIntentError extends Error {
  constructor() {
    super("Discord refused the member list (403 Missing Access): switch on the Server Members intent (Developer Portal → Bot → Privileged Gateway Intents), and check the bot is still in the server")
    this.name = "DiscordMembersIntentError"
  }
}

/**
 * The member list (needs the Server Members intent), a page of 1,000 at a time. New members are added,
 * names, roles and links updated; anyone missing from a complete list has left. Bots and purged members
 * are left out. Then today's DiscordGuildDaily row
 */
export async function syncMembers(ctx: SyncContext): Promise<MemberSyncResult> {
  const now = clock(ctx)
  const [purged, linked] = await Promise.all([ctx.store.purgedAuthors(), ctx.store.linkedAccounts()])
  const seen: MemberInput[] = []
  let after = "0"
  let complete = false
  for (;;) {
    if (stopping(ctx)) break
    let page
    try {
      page = await ctx.client.members({ after, limit: MEMBER_PAGE }, ctx.signal)
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 403) throw new DiscordMembersIntentError()
      // An incomplete list marks nobody as left; the next run reads it all again
      if (interrupted(error, ctx)) break
      throw error
    }
    for (const member of page) {
      if (member.user.bot || purged.has(member.user.id)) continue
      seen.push({
        id: member.user.id,
        username: member.user.username,
        displayName: member.nick || member.user.global_name || null,
        joinedAt: member.joined_at ? new Date(member.joined_at) : null,
        roles: [...member.roles].sort(),
      })
    }
    if (page.length) after = page[page.length - 1].user.id
    if (page.length < MEMBER_PAGE) {
      complete = true
      break
    }
  }
  const { joined } = await ctx.store.saveMembers(seen, now, linked)
  let left = 0
  if (complete) {
    const here = new Set(seen.map((m) => m.id))
    left = await ctx.store.markLeft((await ctx.store.currentMemberIds()).filter((id) => !here.has(id)), now)
  }
  const day = chicagoDay(now)
  const { start, end } = chicagoDayBounds(day)
  const today = await ctx.store.writeGuildDay(day, start, end)
  return { members: seen.length, joined, left, complete, memberCount: today.memberCount, joinedToday: today.joinedCount, leftToday: today.leftCount }
}
