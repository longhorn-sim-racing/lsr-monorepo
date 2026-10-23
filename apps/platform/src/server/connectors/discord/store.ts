import { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { readStoredPoll, type MessageRow, type StoredPoll } from "./metadata"

/**
 * Where the Discord sync keeps what it reads (design §3.3): DiscordChannel, DiscordMessage, DiscordMember,
 * DiscordDailyStat and DiscordGuildDaily. The sync talks to this interface rather than Prisma, so its
 * tests run against an in-memory copy (memory-store.ts) and the HTTP fake; scripts/check-discord-read.ts
 * runs it against the database.
 */

export type StoredChannel = {
  id: string
  name: string
  type: number
  parentId: string | null
  parentName: string | null
  synced: boolean
  lastMessageId: string | null
  lastSyncedAt: Date | null
  rescanFrom: Date | null
}

export type ChannelInput = Pick<StoredChannel, "id" | "name" | "type" | "parentId" | "parentName">

export type StoredMessage = { id: string; contentLength: number; poll: StoredPoll | null; editedAt: Date | null; attachments: number; deletedAt: Date | null }

export type MemberInput = { id: string; username: string; displayName: string | null; joinedAt: Date | null; roles: string[] }

export type DailyCount = { channelId: string; messages: number; activeAuthors: number }

export type DiscordStore = {
  channels(): Promise<StoredChannel[]>
  /** Adds new channels (not synced) and updates the names and parents of known ones; never changes `synced` */
  saveChannels(channels: ChannelInput[]): Promise<void>
  /** A channel's sync position */
  saveCursor(id: string, cursor: Partial<Pick<StoredChannel, "lastMessageId" | "lastSyncedAt" | "rescanFrom">>): Promise<void>
  /** The stored rows among these ids */
  messagesByIds(ids: string[]): Promise<Map<string, StoredMessage>>
  /** Adds rows that aren't stored yet; returns how many it added */
  insertMessages(rows: MessageRow[]): Promise<number>
  /** Writes rows seen again with changes: their metadata, lastSeenAt, and not deleted (anything seen exists) */
  updateMessages(rows: MessageRow[]): Promise<void>
  /** Stamps lastSeenAt on rows seen again unchanged */
  touchMessages(ids: string[], at: Date): Promise<void>
  /** Ids of a channel's rows created in [from, to], not marked deleted */
  liveMessageIds(channelId: string, from: Date, to: Date): Promise<string[]>
  markDeleted(ids: string[], at: Date): Promise<number>
  /** Polls not yet finalized, in messages created before `before`: their counts can still change */
  openPolls(before: Date, limit: number): Promise<{ id: string; channelId: string; poll: StoredPoll }[]>
  /** Per top-level channel (threads count toward theirs): messages and distinct authors created in [start, end), deleted ones left out */
  dailyCounts(start: Date, end: Date): Promise<DailyCount[]>
  /** Replaces one day's DiscordDailyStat rows */
  writeDailyStats(day: Date, counts: DailyCount[]): Promise<void>
  /** Members who haven't left */
  currentMemberIds(): Promise<string[]>
  saveMembers(members: MemberInput[], now: Date, linked: ReadonlyMap<string, string>): Promise<{ joined: number }>
  markLeft(ids: string[], at: Date): Promise<number>
  /** DiscordGuildDaily for a day: members now, and joins and leaves that day */
  writeGuildDay(day: Date, dayStart: Date, dayEnd: Date): Promise<{ memberCount: number; joinedCount: number; leftCount: number }>
  /** Discord user id → site user id, for linked accounts */
  linkedAccounts(): Promise<Map<string, string>>
  /** The hashed ids of members whose Discord data was purged (never collected again) */
  purgedAuthors(): Promise<Set<string>>
}

/** Rows per statement, so a big page never makes one huge query */
const CHUNK = 500

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const pollJson = (poll: StoredPoll | null) => (poll ? (poll as unknown as Prisma.InputJsonValue) : Prisma.DbNull)

/** The SystemSetting key that holds the purged list (`{ "authors": [<hash>, …] }`). Not a credential; revoked from Jack like every SystemSetting */
export const PURGED_SETTING = "discord_purged"

export function readPurged(value: string | null | undefined): Set<string> {
  try {
    const parsed = JSON.parse(value ?? "{}") as { authors?: unknown }
    return new Set(Array.isArray(parsed.authors) ? parsed.authors.filter((a): a is string => typeof a === "string") : [])
  } catch {
    return new Set()
  }
}

export const prismaDiscordStore: DiscordStore = {
  async channels() {
    return prisma.discordChannel.findMany({ orderBy: { id: "asc" } })
  },

  async saveChannels(channels) {
    if (!channels.length) return
    const known = new Map((await prisma.discordChannel.findMany({ where: { id: { in: channels.map((c) => c.id) } }, select: { id: true, name: true, type: true, parentId: true, parentName: true } })).map((c) => [c.id, c]))
    const fresh = channels.filter((c) => !known.has(c.id))
    if (fresh.length) await prisma.discordChannel.createMany({ data: fresh.map((c) => ({ ...c, synced: false })), skipDuplicates: true })
    for (const channel of channels) {
      const was = known.get(channel.id)
      if (!was || (was.name === channel.name && was.type === channel.type && was.parentId === channel.parentId && was.parentName === channel.parentName)) continue
      await prisma.discordChannel.update({ where: { id: channel.id }, data: { name: channel.name, type: channel.type, parentId: channel.parentId, parentName: channel.parentName } })
    }
  },

  async saveCursor(id, cursor) {
    await prisma.discordChannel.update({ where: { id }, data: cursor })
  },

  async messagesByIds(ids) {
    const found = new Map<string, StoredMessage>()
    for (const part of chunks(ids)) {
      const rows = await prisma.discordMessage.findMany({ where: { id: { in: part } }, select: { id: true, contentLength: true, poll: true, editedAt: true, attachments: true, deletedAt: true } })
      for (const row of rows) found.set(row.id, { ...row, poll: readStoredPoll(row.poll) })
    }
    return found
  },

  async insertMessages(rows) {
    let added = 0
    for (const part of chunks(rows)) {
      const { count } = await prisma.discordMessage.createMany({ data: part.map((row) => ({ ...row, poll: pollJson(row.poll) })), skipDuplicates: true })
      added += count
    }
    return added
  },

  async updateMessages(rows) {
    for (const row of rows) {
      await prisma.discordMessage.update({
        where: { id: row.id },
        data: { editedAt: row.editedAt, contentLength: row.contentLength, attachments: row.attachments, isReply: row.isReply, poll: pollJson(row.poll), lastSeenAt: row.lastSeenAt, deletedAt: null },
      })
    }
  },

  async touchMessages(ids, at) {
    for (const part of chunks(ids)) await prisma.discordMessage.updateMany({ where: { id: { in: part } }, data: { lastSeenAt: at } })
  },

  async liveMessageIds(channelId, from, to) {
    const rows = await prisma.discordMessage.findMany({ where: { channelId, createdAt: { gte: from, lte: to }, deletedAt: null }, select: { id: true } })
    return rows.map((row) => row.id)
  },

  async markDeleted(ids, at) {
    let count = 0
    for (const part of chunks(ids)) count += (await prisma.discordMessage.updateMany({ where: { id: { in: part }, deletedAt: null }, data: { deletedAt: at } })).count
    return count
  },

  async openPolls(before, limit) {
    const rows = await prisma.$queryRaw<{ id: string; channelId: string; poll: unknown }[]>(Prisma.sql`
      SELECT id, "channelId", poll FROM "DiscordMessage"
      WHERE poll IS NOT NULL AND coalesce((poll->>'finalized')::boolean, false) = false AND "deletedAt" IS NULL AND "createdAt" < ${before}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}`)
    return rows.flatMap((row) => {
      const poll = readStoredPoll(row.poll)
      return poll ? [{ id: row.id, channelId: row.channelId, poll }] : []
    })
  },

  async dailyCounts(start, end) {
    return prisma.$queryRaw<DailyCount[]>(Prisma.sql`
      SELECT coalesce(c."parentId", m."channelId") AS "channelId", count(*)::int AS messages, count(DISTINCT m."authorId")::int AS "activeAuthors"
      FROM "DiscordMessage" m
      LEFT JOIN "DiscordChannel" c ON c.id = m."channelId"
      WHERE m."deletedAt" IS NULL AND m."createdAt" >= ${start} AND m."createdAt" < ${end}
      GROUP BY 1`)
  },

  async writeDailyStats(day, counts) {
    await prisma.$transaction([
      prisma.discordDailyStat.deleteMany({ where: { date: day } }),
      prisma.discordDailyStat.createMany({ data: counts.map((c) => ({ date: day, channelId: c.channelId, messages: c.messages, activeAuthors: c.activeAuthors })) }),
    ])
  },

  async currentMemberIds() {
    return (await prisma.discordMember.findMany({ where: { leftAt: null }, select: { id: true } })).map((m) => m.id)
  },

  async saveMembers(members, now, linked) {
    const known = new Map(
      (await prisma.discordMember.findMany({ select: { id: true, username: true, displayName: true, joinedAt: true, roles: true, userId: true, leftAt: true } })).map((m) => [m.id, m]),
    )
    const fresh = members.filter((m) => !known.has(m.id))
    for (const part of chunks(fresh)) {
      await prisma.discordMember.createMany({ data: part.map((m) => ({ ...m, userId: linked.get(m.id) ?? null, firstSeenAt: now, lastSeenAt: now })), skipDuplicates: true })
    }
    for (const member of members) {
      const was = known.get(member.id)
      if (!was) continue
      const userId = linked.get(member.id) ?? null
      const same =
        was.username === member.username &&
        was.displayName === member.displayName &&
        was.joinedAt?.getTime() === member.joinedAt?.getTime() &&
        was.roles.join(",") === member.roles.join(",") &&
        was.userId === userId &&
        was.leftAt === null
      if (!same) {
        await prisma.discordMember.update({
          where: { id: member.id },
          data: { username: member.username, displayName: member.displayName, joinedAt: member.joinedAt, roles: member.roles, userId, leftAt: null },
        })
      }
    }
    for (const part of chunks(members.map((m) => m.id))) await prisma.discordMember.updateMany({ where: { id: { in: part } }, data: { lastSeenAt: now } })
    return { joined: fresh.length }
  },

  async markLeft(ids, at) {
    let count = 0
    for (const part of chunks(ids)) count += (await prisma.discordMember.updateMany({ where: { id: { in: part }, leftAt: null }, data: { leftAt: at } })).count
    return count
  },

  async writeGuildDay(day, dayStart, dayEnd) {
    const [memberCount, joinedCount, leftCount] = await Promise.all([
      prisma.discordMember.count({ where: { leftAt: null } }),
      prisma.discordMember.count({ where: { joinedAt: { gte: dayStart, lt: dayEnd } } }),
      prisma.discordMember.count({ where: { leftAt: { gte: dayStart, lt: dayEnd } } }),
    ])
    await prisma.discordGuildDaily.upsert({ where: { date: day }, update: { memberCount, joinedCount, leftCount }, create: { date: day, memberCount, joinedCount, leftCount } })
    return { memberCount, joinedCount, leftCount }
  },

  async linkedAccounts() {
    const users = await prisma.user.findMany({ where: { discordUserId: { not: null } }, select: { id: true, discordUserId: true } })
    return new Map(users.map((u) => [u.discordUserId!, u.id]))
  },

  async purgedAuthors() {
    const row = await prisma.systemSetting.findUnique({ where: { key: PURGED_SETTING } })
    return readPurged(row?.value)
  },
}
