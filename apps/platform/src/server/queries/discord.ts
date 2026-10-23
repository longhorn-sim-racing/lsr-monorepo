import { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { chicagoDay } from "@/lib/dates"
import { readStoredPoll, type StoredPoll } from "@/server/connectors/discord/metadata"
import { chicagoDayBounds } from "@/server/connectors/discord/sync"
import { CHANNEL_TYPE, THREAD_TYPES } from "@/server/connectors/discord/types"

/**
 * Discord activity as the club may look at it (design §12.1): aggregates only. Counts per channel and
 * day, how many members were active, members over time and poll results. Nothing here is broken down
 * by person: Discord's Developer Policy bans profiling individual users, so neither the admin page nor
 * Jack's tools ever list who posted what or how much.
 */

const DAY_MS = 86_400_000

/** The Central day `days - 1` days before today, through the end of today: the last `days` days, today included */
export function lastDays(days: number, now: Date): { firstDay: Date; lastDay: Date; from: Date; to: Date } {
  const lastDay = chicagoDay(now)
  const firstDay = new Date(lastDay.getTime() - (days - 1) * DAY_MS)
  return { firstDay, lastDay, from: chicagoDayBounds(firstDay).start, to: chicagoDayBounds(lastDay).end }
}

export type DiscordChannelRow = {
  id: string
  name: string
  type: number
  category: string | null
  synced: boolean
  /** Threads stored under it */
  threads: number
  lastSyncedAt: Date | null
  /** Messages in the last 30 days, threads included */
  messages30: number
}

/** Kinds of channel, for the page */
export const CHANNEL_KIND: Record<number, string> = {
  [CHANNEL_TYPE.text]: "Text",
  [CHANNEL_TYPE.voice]: "Voice",
  [CHANNEL_TYPE.announcement]: "Announcements",
  [CHANNEL_TYPE.stage]: "Stage",
  [CHANNEL_TYPE.forum]: "Forum",
  [CHANNEL_TYPE.media]: "Media",
}

/** The server's channels (not threads), grouped by category in name order, with the last 30 days' messages */
export async function discordChannels(now = new Date()): Promise<DiscordChannelRow[]> {
  const { firstDay } = lastDays(30, now)
  const [channels, stats] = await Promise.all([
    prisma.discordChannel.findMany({ select: { id: true, name: true, type: true, parentId: true, parentName: true, synced: true, lastSyncedAt: true } }),
    prisma.discordDailyStat.groupBy({ by: ["channelId"], where: { date: { gte: firstDay } }, _sum: { messages: true } }),
  ])
  const counts = new Map(stats.map((s) => [s.channelId, s._sum.messages ?? 0]))
  const threads = new Map<string, { count: number; last: Date | null }>()
  for (const c of channels) {
    if (!c.parentId) continue
    const entry = threads.get(c.parentId) ?? { count: 0, last: null }
    entry.count++
    if (c.lastSyncedAt && (!entry.last || c.lastSyncedAt > entry.last)) entry.last = c.lastSyncedAt
    threads.set(c.parentId, entry)
  }
  return channels
    .filter((c) => !c.parentId && !THREAD_TYPES.includes(c.type))
    .map((c) => {
      const t = threads.get(c.id)
      const lastSyncedAt = [c.lastSyncedAt, t?.last ?? null].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
      return { id: c.id, name: c.name, type: c.type, category: c.parentName, synced: c.synced, threads: t?.count ?? 0, lastSyncedAt, messages30: counts.get(c.id) ?? 0 }
    })
    .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name))
}

/** Distinct members who posted in [from, to), per top-level channel (threads count toward theirs) and in all */
async function activeMembers(from: Date, to: Date, channelId?: string): Promise<{ total: number; byChannel: Map<string, number> }> {
  const channelFilter = channelId ? Prisma.sql`AND coalesce(c."parentId", m."channelId") = ${channelId}` : Prisma.empty
  const [rows, [all]] = await Promise.all([
    prisma.$queryRaw<{ channelId: string; members: number }[]>(Prisma.sql`
      SELECT coalesce(c."parentId", m."channelId") AS "channelId", count(DISTINCT m."authorId")::int AS members
      FROM "DiscordMessage" m LEFT JOIN "DiscordChannel" c ON c.id = m."channelId"
      WHERE m."deletedAt" IS NULL AND m."createdAt" >= ${from} AND m."createdAt" < ${to} ${channelFilter}
      GROUP BY 1`),
    prisma.$queryRaw<{ members: number }[]>(Prisma.sql`
      SELECT count(DISTINCT m."authorId")::int AS members
      FROM "DiscordMessage" m LEFT JOIN "DiscordChannel" c ON c.id = m."channelId"
      WHERE m."deletedAt" IS NULL AND m."createdAt" >= ${from} AND m."createdAt" < ${to} ${channelFilter}`),
  ])
  return { total: all?.members ?? 0, byChannel: new Map(rows.map((r) => [r.channelId, r.members])) }
}

export type DiscordActivity = {
  firstDay: Date
  lastDay: Date
  messages: number
  activeMembers: number
  channels: { id: string; name: string; category: string | null; messages: number; activeMembers: number; busiestDay: Date | null; busiestDayMessages: number }[]
  /** Messages per Central day, every day of the period (0s included) */
  daily: { date: Date; messages: number; byChannel: Record<string, number> }[]
  /** DiscordGuildDaily in the period: one row per day the member sync ran */
  members: { date: Date; memberCount: number; joined: number | null; left: number | null }[]
  linkedMembers: number
}

/** Activity over the last `days` Central days (today included), for one channel or all of them */
export async function discordActivity(options: { days: number; channelId?: string; now?: Date }): Promise<DiscordActivity> {
  const now = options.now ?? new Date()
  const { firstDay, lastDay, from, to } = lastDays(options.days, now)
  const [stats, channels, active, guild, linkedMembers] = await Promise.all([
    prisma.discordDailyStat.findMany({ where: { date: { gte: firstDay, lte: lastDay }, ...(options.channelId ? { channelId: options.channelId } : {}) }, orderBy: { date: "asc" } }),
    prisma.discordChannel.findMany({ where: { parentId: null }, select: { id: true, name: true, parentName: true } }),
    activeMembers(from, to, options.channelId),
    prisma.discordGuildDaily.findMany({ where: { date: { gte: firstDay, lte: lastDay } }, orderBy: { date: "asc" } }),
    prisma.user.count({ where: { discordUserId: { not: null } } }),
  ])
  const names = new Map(channels.map((c) => [c.id, c]))
  const perChannel = new Map<string, { messages: number; busiest: { date: Date; messages: number } | null }>()
  const perDay = new Map<number, { messages: number; byChannel: Record<string, number> }>()
  for (const stat of stats) {
    const channel = perChannel.get(stat.channelId) ?? { messages: 0, busiest: null }
    channel.messages += stat.messages
    if (!channel.busiest || stat.messages > channel.busiest.messages) channel.busiest = { date: stat.date, messages: stat.messages }
    perChannel.set(stat.channelId, channel)
    const day = perDay.get(stat.date.getTime()) ?? { messages: 0, byChannel: {} }
    day.messages += stat.messages
    day.byChannel[stat.channelId] = (day.byChannel[stat.channelId] ?? 0) + stat.messages
    perDay.set(stat.date.getTime(), day)
  }
  const daily: DiscordActivity["daily"] = []
  for (let t = firstDay.getTime(); t <= lastDay.getTime(); t += DAY_MS) daily.push({ date: new Date(t), messages: perDay.get(t)?.messages ?? 0, byChannel: perDay.get(t)?.byChannel ?? {} })
  return {
    firstDay,
    lastDay,
    messages: stats.reduce((n, s) => n + s.messages, 0),
    activeMembers: active.total,
    channels: [...perChannel]
      .map(([id, c]) => ({
        id,
        name: names.get(id)?.name ?? "deleted channel",
        category: names.get(id)?.parentName ?? null,
        messages: c.messages,
        activeMembers: active.byChannel.get(id) ?? 0,
        busiestDay: c.busiest?.date ?? null,
        busiestDayMessages: c.busiest?.messages ?? 0,
      }))
      .sort((a, b) => b.messages - a.messages),
    daily,
    members: guild.map((g) => ({ date: g.date, memberCount: g.memberCount, joined: g.joinedCount, left: g.leftCount })),
    linkedMembers,
  }
}

/** Joins per month of the members in the server now (from their join dates; people who've since left aren't known) */
export async function discordJoinsByMonth(months: number, now = new Date()): Promise<{ month: string; joined: number }[]> {
  const from = new Date(now.getTime() - months * 31 * DAY_MS)
  const rows = await prisma.$queryRaw<{ month: string; joined: number }[]>(Prisma.sql`
    SELECT to_char(date_trunc('month', "joinedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago'), 'YYYY-MM') AS month, count(*)::int AS joined
    FROM "DiscordMember" WHERE "leftAt" IS NULL AND "joinedAt" >= ${from}
    GROUP BY 1 ORDER BY 1`)
  return rows
}

export type DiscordPollView = {
  id: string
  channelId: string
  channel: string
  postedAt: Date
  poll: StoredPoll
  /** open, closed (final counts), or closed but Discord hasn't finalized the counts yet */
  status: "open" | "final" | "closing"
  totalVotes: number | null
}

/** Polls posted in the last `days` days, newest first: their questions, answers and vote counts (never voters) */
export async function discordPolls(options: { days: number; status?: "open" | "closed" | "all"; search?: string; limit: number; now?: Date }): Promise<{ polls: DiscordPollView[]; matched: number }> {
  const now = options.now ?? new Date()
  const [rows, channels] = await Promise.all([
    prisma.discordMessage.findMany({
      where: { poll: { not: Prisma.DbNull }, deletedAt: null, createdAt: { gte: new Date(now.getTime() - options.days * DAY_MS) } },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { id: true, channelId: true, createdAt: true, poll: true },
    }),
    prisma.discordChannel.findMany({ select: { id: true, name: true, parentId: true } }),
  ])
  const byId = new Map(channels.map((c) => [c.id, c]))
  const label = (channelId: string) => {
    const channel = byId.get(channelId)
    const parent = channel?.parentId ? byId.get(channel.parentId) : undefined
    return channel ? (parent ? `#${parent.name} › ${channel.name}` : `#${channel.name}`) : "a Discord channel"
  }
  const words = (options.search ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const polls = rows.flatMap((row): DiscordPollView[] => {
    const poll = readStoredPoll(row.poll)
    if (!poll) return []
    const open = !poll.finalized && (!poll.expiresAt || new Date(poll.expiresAt) > now)
    const status = open ? "open" : poll.finalized ? "final" : "closing"
    if (options.status === "open" && !open) return []
    if (options.status === "closed" && open) return []
    const text = `${poll.question} ${poll.answers.map((a) => a.text).join(" ")}`.toLowerCase()
    if (words.some((w) => !text.includes(w))) return []
    const known = poll.answers.every((a) => a.votes !== null)
    return [{ id: row.id, channelId: row.channelId, channel: label(row.channelId), postedAt: row.createdAt, poll, status, totalVotes: known ? poll.answers.reduce((n, a) => n + (a.votes ?? 0), 0) : null }]
  })
  return { polls: polls.slice(0, options.limit), matched: polls.length }
}

export type DiscordWeek = {
  messages: number
  previousMessages: number
  activeMembers: number
  memberCount: number | null
  memberChange: number | null
  topChannels: { name: string; messages: number }[]
  synced: number
}

/** This week (the last 7 Central days) against the 7 before, for the Overview card */
export async function discordWeek(now = new Date()): Promise<DiscordWeek> {
  const week = lastDays(7, now)
  const previousFirst = new Date(week.firstDay.getTime() - 7 * DAY_MS)
  const previousLast = new Date(week.firstDay.getTime() - DAY_MS)
  const [thisWeek, lastWeek, active, members, channels, synced] = await Promise.all([
    prisma.discordDailyStat.groupBy({ by: ["channelId"], where: { date: { gte: week.firstDay, lte: week.lastDay } }, _sum: { messages: true } }),
    prisma.discordDailyStat.aggregate({ where: { date: { gte: previousFirst, lte: previousLast } }, _sum: { messages: true } }),
    activeMembers(week.from, week.to),
    prisma.discordGuildDaily.findMany({ where: { date: { gte: previousLast } }, orderBy: { date: "asc" } }),
    prisma.discordChannel.findMany({ where: { parentId: null }, select: { id: true, name: true } }),
    prisma.discordChannel.count({ where: { parentId: null, synced: true } }),
  ])
  const names = new Map(channels.map((c) => [c.id, c.name]))
  const latest = members.at(-1) ?? null
  const before = members[0] && members[0] !== latest ? members[0] : null
  return {
    messages: thisWeek.reduce((n, s) => n + (s._sum.messages ?? 0), 0),
    previousMessages: lastWeek._sum.messages ?? 0,
    activeMembers: active.total,
    memberCount: latest?.memberCount ?? null,
    memberChange: latest && before ? latest.memberCount - before.memberCount : null,
    topChannels: thisWeek
      .map((s) => ({ name: names.get(s.channelId) ?? "deleted channel", messages: s._sum.messages ?? 0 }))
      .filter((c) => c.messages > 0)
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 3),
    synced,
  }
}
