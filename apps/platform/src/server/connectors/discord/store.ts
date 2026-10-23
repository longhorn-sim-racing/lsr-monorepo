import { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { purgedList, readStoredPoll, withoutPurgedOwner, type MessageRow, type PurgedList, type StoredPoll } from "./metadata"

/**
 * Where the Discord sync keeps what it reads (design §3.3): DiscordChannel, DiscordMessage, DiscordMember,
 * DiscordDailyStat and DiscordGuildDaily. The sync talks to this interface rather than Prisma, so its
 * tests run against an in-memory copy (memory-store.ts) and the HTTP fake; scripts/check-discord-read.ts
 * runs it against the database.
 *
 * Every write of someone's data (channels with thread owners, message pages, the member list) re-reads
 * the purged list inside its transaction, under the purge lock (purgedForWrite), so a purge that lands
 * while a run is going is never undone by that run.
 */

export type StoredChannel = {
  id: string
  name: string
  type: number
  parentId: string | null
  parentName: string | null
  /** A thread's starter (Discord user id); null for channels, and for a thread whose starter was purged */
  ownerId: string | null
  synced: boolean
  lastMessageId: string | null
  lastSyncedAt: Date | null
  rescanFrom: Date | null
}

export type ChannelInput = Pick<StoredChannel, "id" | "name" | "type" | "parentId" | "parentName" | "ownerId">

export type StoredMessage = { id: string; contentLength: number; poll: StoredPoll | null; editedAt: Date | null; attachments: number; deletedAt: Date | null }

export type MemberInput = { id: string; username: string; displayName: string | null; joinedAt: Date | null; roles: string[] }

export type DailyCount = { channelId: string; messages: number; activeAuthors: number }

/** One page read from a channel or thread, as savePage writes it */
export type PageWrite = {
  /** Rows not stored yet (ids already stored are skipped) */
  insert?: MessageRow[]
  /** Rows seen again with changes: their metadata, lastSeenAt, and not deleted (anything seen exists) */
  update?: MessageRow[]
  /** Rows seen again unchanged: lastSeenAt stamped with `at` */
  touch?: string[]
  at?: Date
  /** Where the channel's sync got to */
  cursor?: Partial<Pick<StoredChannel, "lastMessageId" | "lastSyncedAt" | "rescanFrom">>
}

export type DiscordStore = {
  channels(): Promise<StoredChannel[]>
  /**
   * Adds new channels (not synced) and updates the names, parents and owners of known ones; never
   * changes `synced`. A thread a purged member started is saved as "a thread", with no owner
   */
  saveChannels(channels: ChannelInput[]): Promise<void>
  /**
   * Writes a page read from a channel or thread, only while it's opted in (a thread: while its channel
   * is), in step with switching it off. Rows of purged members are left out, against the list as it is
   * at the write. Returns how many rows it added, or null, writing nothing, once it isn't opted in or a
   * thread's row is gone
   */
  savePage(channelId: string, page: PageWrite): Promise<{ added: number } | null>
  /** The stored rows among these ids */
  messagesByIds(ids: string[]): Promise<Map<string, StoredMessage>>
  /** Ids of a channel's rows created in [from, to], not marked deleted */
  liveMessageIds(channelId: string, from: Date, to: Date): Promise<string[]>
  markDeleted(ids: string[], at: Date): Promise<number>
  /** Polls not yet finalized, in messages created before `before`: their counts can still change */
  openPolls(before: Date, limit: number): Promise<{ id: string; channelId: string; poll: StoredPoll }[]>
  /** Per top-level channel (threads count toward theirs): messages and distinct authors created in [start, end), deleted ones left out */
  dailyCounts(start: Date, end: Date): Promise<DailyCount[]>
  /** Replaces one day's DiscordDailyStat rows. A channel that isn't opted in (any more) gets none */
  writeDailyStats(day: Date, counts: DailyCount[]): Promise<void>
  /**
   * Switches a channel off and deletes what's stored from it: its messages, its threads (rows and
   * messages) and its daily counts, and resets its cursor. `gone` (Discord deleted the channel) removes
   * its row too. Returns how many message rows went
   */
  switchOff(channelId: string, options?: { gone?: boolean }): Promise<number>
  /** Deletes a thread Discord deleted, and its messages. Returns the span its messages were made in (for the stats), or null when it had none */
  dropThread(threadId: string): Promise<{ from: Date; to: Date } | null>
  /** Members who haven't left */
  currentMemberIds(): Promise<string[]>
  /**
   * Adds new members and updates known ones, linked to the site member who has the account linked now.
   * Purged members are left out, against the list as it is at the write
   */
  saveMembers(members: MemberInput[], now: Date): Promise<{ joined: number }>
  markLeft(ids: string[], at: Date): Promise<number>
  /** DiscordGuildDaily for a day: members now, and joins and leaves that day */
  writeGuildDay(day: Date, dayStart: Date, dayEnd: Date): Promise<{ memberCount: number; joinedCount: number; leftCount: number }>
  /** Discord user id → site user id, for linked accounts */
  linkedAccounts(): Promise<Map<string, string>>
  /** Members whose Discord data was purged (never collected again) */
  purgedAuthors(): Promise<PurgedList>
}

/** Rows per statement, so a big page never makes one huge query */
const CHUNK = 500

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const pollJson = (poll: StoredPoll | null) => (poll ? (poll as unknown as Prisma.InputJsonValue) : Prisma.DbNull)

/**
 * The SystemSetting key that holds the purged list (`{ "key": <random>, "authors": [<keyed hash>, …] }`).
 * Not a credential, but its key must stay out of view: revoked from Jack like every SystemSetting, and
 * shown on no page
 */
export const PURGED_SETTING = "discord_purged"

export type PurgedSetting = { key: string | null; authors: string[] }

export function readPurged(value: string | null | undefined): PurgedSetting {
  try {
    const parsed = JSON.parse(value ?? "{}") as { key?: unknown; authors?: unknown }
    return {
      key: typeof parsed.key === "string" && parsed.key ? parsed.key : null,
      authors: Array.isArray(parsed.authors) ? parsed.authors.filter((a): a is string => typeof a === "string") : [],
    }
  } catch {
    return { key: null, authors: [] }
  }
}

/** The do-not-collect list from the setting's value */
export function purgedFrom(value: string | null | undefined): PurgedList {
  const { key, authors } = readPurged(value)
  return purgedList(key, authors)
}

/** The advisory lock between a purge (exclusive) and the sync's writes (shared), keyed by hashtext() of this */
export const PURGE_LOCK = "lsr:discord_purged"

/**
 * Takes the purge lock for the rest of a purge's transaction: it waits for every sync write in progress,
 * and every write after it waits for the purge and then reads the list with the account on it. An
 * advisory lock rather than a row lock on the setting, which doesn't exist before the first purge
 */
export async function lockPurgedListTx(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PURGE_LOCK}))`
}

/**
 * The purged list as it is now, read inside a sync write's transaction under the purge lock (shared), so
 * a purge that commits while a run is going is seen by the run's next write. Taken before any row lock,
 * as the purge takes it, so the two never wait on each other in a circle
 */
async function purgedForWrite(tx: Prisma.TransactionClient): Promise<PurgedList> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${PURGE_LOCK}))`
  return purgedFrom((await tx.systemSetting.findUnique({ where: { key: PURGED_SETTING } }))?.value)
}

/** A page's or a switch-off's transaction: room for a page of updates, or for deleting a busy channel's rows, against the hosted database */
const WRITE_TIMEOUT_MS = 30_000

export const prismaDiscordStore: DiscordStore = {
  async channels() {
    return prisma.discordChannel.findMany({ orderBy: { id: "asc" } })
  },

  async saveChannels(channels) {
    if (!channels.length) return
    await prisma.$transaction(
      async (tx) => {
        const purged = await purgedForWrite(tx)
        const rows = channels.map((c) => withoutPurgedOwner(c, purged))
        const known = new Map(
          (await tx.discordChannel.findMany({ where: { id: { in: rows.map((c) => c.id) } }, select: { id: true, name: true, type: true, parentId: true, parentName: true, ownerId: true } })).map((c) => [c.id, c]),
        )
        const fresh = rows.filter((c) => !known.has(c.id))
        if (fresh.length) await tx.discordChannel.createMany({ data: fresh.map((c) => ({ ...c, synced: false })), skipDuplicates: true })
        for (const channel of rows) {
          const was = known.get(channel.id)
          if (!was || (was.name === channel.name && was.type === channel.type && was.parentId === channel.parentId && was.parentName === channel.parentName && was.ownerId === channel.ownerId)) continue
          await tx.discordChannel.updateMany({ where: { id: channel.id }, data: { name: channel.name, type: channel.type, parentId: channel.parentId, parentName: channel.parentName, ownerId: channel.ownerId } })
        }
      },
      { timeout: WRITE_TIMEOUT_MS },
    )
  },

  async savePage(channelId, page) {
    return prisma.$transaction(
      async (tx) => {
        const purged = await purgedForWrite(tx)
        // The opted-in channel's row (a thread's channel), locked: switching it off updates that row first, so it waits for this page, or this page sees it off
        const [owner] = await tx.$queryRaw<{ synced: boolean }[]>(Prisma.sql`
          SELECT o.synced FROM "DiscordChannel" c JOIN "DiscordChannel" o ON o.id = coalesce(c."parentId", c.id)
          WHERE c.id = ${channelId}
          FOR SHARE OF o`)
        if (!owner?.synced) return null
        const kept = (row: MessageRow) => !purged.has(row.authorId)
        let added = 0
        for (const part of chunks((page.insert ?? []).filter(kept))) added += (await tx.discordMessage.createMany({ data: part.map((row) => ({ ...row, poll: pollJson(row.poll) })), skipDuplicates: true })).count
        for (const row of (page.update ?? []).filter(kept)) {
          await tx.discordMessage.updateMany({
            where: { id: row.id },
            data: { editedAt: row.editedAt, contentLength: row.contentLength, attachments: row.attachments, isReply: row.isReply, poll: pollJson(row.poll), lastSeenAt: row.lastSeenAt, deletedAt: null },
          })
        }
        if (page.at) for (const part of chunks(page.touch ?? [])) await tx.discordMessage.updateMany({ where: { id: { in: part } }, data: { lastSeenAt: page.at } })
        if (page.cursor) await tx.discordChannel.updateMany({ where: { id: channelId }, data: page.cursor })
        return { added }
      },
      { timeout: WRITE_TIMEOUT_MS },
    )
  },

  async messagesByIds(ids) {
    const found = new Map<string, StoredMessage>()
    for (const part of chunks(ids)) {
      const rows = await prisma.discordMessage.findMany({ where: { id: { in: part } }, select: { id: true, contentLength: true, poll: true, editedAt: true, attachments: true, deletedAt: true } })
      for (const row of rows) found.set(row.id, { ...row, poll: readStoredPoll(row.poll) })
    }
    return found
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
    await prisma.$transaction(async (tx) => {
      // Only channels still opted in, their rows locked as a page's are, so one switched off meanwhile gets no counts back
      const ids = counts.map((c) => c.channelId)
      const synced = new Set(
        ids.length ? (await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "DiscordChannel" WHERE id IN (${Prisma.join(ids)}) AND synced FOR SHARE`)).map((row) => row.id) : [],
      )
      await tx.discordDailyStat.deleteMany({ where: { date: day } })
      await tx.discordDailyStat.createMany({ data: counts.filter((c) => synced.has(c.channelId)).map((c) => ({ date: day, channelId: c.channelId, messages: c.messages, activeAuthors: c.activeAuthors })) })
    })
  },

  async switchOff(channelId, options = {}) {
    return prisma.$transaction(
      async (tx) => {
        // The channel's row first: a page being written holds it, so this waits for that page, and every page after sees the channel off
        await tx.discordChannel.update({ where: { id: channelId }, data: { synced: false, lastMessageId: null, lastSyncedAt: null, rescanFrom: null } })
        const threads = (await tx.discordChannel.findMany({ where: { parentId: channelId }, select: { id: true } })).map((t) => t.id)
        const { count } = await tx.discordMessage.deleteMany({ where: { channelId: { in: [channelId, ...threads] } } })
        await tx.discordChannel.deleteMany({ where: { parentId: channelId } })
        await tx.discordDailyStat.deleteMany({ where: { channelId } })
        if (options.gone) await tx.discordChannel.delete({ where: { id: channelId } })
        return count
      },
      { timeout: WRITE_TIMEOUT_MS },
    )
  },

  async dropThread(threadId) {
    return prisma.$transaction(async (tx) => {
      const span = await tx.discordMessage.aggregate({ where: { channelId: threadId }, _min: { createdAt: true }, _max: { createdAt: true } })
      await tx.discordMessage.deleteMany({ where: { channelId: threadId } })
      await tx.discordChannel.deleteMany({ where: { id: threadId, parentId: { not: null } } })
      return span._min.createdAt && span._max.createdAt ? { from: span._min.createdAt, to: span._max.createdAt } : null
    })
  },

  async currentMemberIds() {
    return (await prisma.discordMember.findMany({ where: { leftAt: null }, select: { id: true } })).map((m) => m.id)
  },

  async saveMembers(members, now) {
    return prisma.$transaction(
      async (tx) => {
        const purged = await purgedForWrite(tx)
        const list = members.filter((m) => !purged.has(m.id))
        // Read here, not when the run started: a purge or an unlink since then is already in them
        const known = new Map(
          (await tx.discordMember.findMany({ select: { id: true, username: true, displayName: true, joinedAt: true, roles: true, userId: true, leftAt: true } })).map((m) => [m.id, m]),
        )
        const linked = new Map((await tx.user.findMany({ where: { discordUserId: { not: null } }, select: { id: true, discordUserId: true } })).map((u) => [u.discordUserId!, u.id]))
        const fresh = list.filter((m) => !known.has(m.id))
        for (const part of chunks(fresh)) {
          await tx.discordMember.createMany({ data: part.map((m) => ({ ...m, userId: linked.get(m.id) ?? null, firstSeenAt: now, lastSeenAt: now })), skipDuplicates: true })
        }
        for (const member of list) {
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
            await tx.discordMember.updateMany({
              where: { id: member.id },
              data: { username: member.username, displayName: member.displayName, joinedAt: member.joinedAt, roles: member.roles, userId, leftAt: null },
            })
          }
        }
        for (const part of chunks(list.map((m) => m.id))) await tx.discordMember.updateMany({ where: { id: { in: part } }, data: { lastSeenAt: now } })
        return { joined: fresh.length }
      },
      { timeout: WRITE_TIMEOUT_MS },
    )
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
    return purgedFrom(row?.value)
  },
}
