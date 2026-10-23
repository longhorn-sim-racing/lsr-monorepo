import { compareSnowflakes } from "./snowflake"
import type { MessageRow, PurgedList } from "./metadata"
import type { DailyCount, DiscordStore, MemberInput, StoredChannel } from "./store"

/**
 * An in-memory DiscordStore for the sync's tests (tests only; the app uses prismaDiscordStore). It keeps
 * the same rules the database does: new channels arrive switched off, inserts skip ids already stored,
 * a page is written only while its channel is opted in, daily counts leave deleted rows out and count
 * threads toward their channel, and only opted-in channels get daily stats.
 */

export type MemoryMessage = MessageRow & { deletedAt: Date | null }
export type MemoryMember = MemberInput & { userId: string | null; firstSeenAt: Date; lastSeenAt: Date; leftAt: Date | null }

/** `purged` are Discord user ids (the database keeps keyed hashes; the list answers the same way) */
export function memoryDiscordStore(seed: { channels?: Partial<StoredChannel>[]; linked?: Record<string, string>; purged?: string[] } = {}) {
  const channels = new Map<string, StoredChannel>()
  const messages = new Map<string, MemoryMessage>()
  const members = new Map<string, MemoryMember>()
  const daily = new Map<string, DailyCount & { date: Date }>()
  const guildDays = new Map<number, { memberCount: number; joinedCount: number; leftCount: number }>()
  const linked = new Map(Object.entries(seed.linked ?? {}))
  const purged = new Set(seed.purged ?? [])
  for (const c of seed.channels ?? []) {
    channels.set(c.id!, { name: c.id!, type: 0, parentId: null, parentName: null, synced: false, lastMessageId: null, lastSyncedAt: null, rescanFrom: null, ...c } as StoredChannel)
  }
  /** Whether a channel, or a thread's channel, is opted in */
  const optedIn = (id: string) => {
    const channel = channels.get(id)
    return Boolean(channel && channels.get(channel.parentId ?? channel.id)?.synced)
  }
  const deleteMessages = (channelIds: Set<string>) => {
    let count = 0
    for (const [id, m] of messages) {
      if (!channelIds.has(m.channelId)) continue
      messages.delete(id)
      count++
    }
    return count
  }

  const store: DiscordStore = {
    async channels() {
      return [...channels.values()].map((c) => ({ ...c })).sort((a, b) => compareSnowflakes(a.id, b.id))
    },
    async saveChannels(list) {
      for (const c of list) {
        const was = channels.get(c.id)
        channels.set(c.id, was ? { ...was, ...c } : { ...c, synced: false, lastMessageId: null, lastSyncedAt: null, rescanFrom: null })
      }
    },
    async savePage(channelId, page) {
      if (!optedIn(channelId)) return null
      let added = 0
      for (const row of page.insert ?? []) {
        if (messages.has(row.id)) continue
        messages.set(row.id, { ...row, deletedAt: null })
        added++
      }
      for (const row of page.update ?? []) {
        const was = messages.get(row.id)
        if (was) messages.set(row.id, { ...was, ...row, createdAt: was.createdAt, channelId: was.channelId, authorId: was.authorId, deletedAt: null })
      }
      for (const id of page.touch ?? []) {
        const was = messages.get(id)
        if (was && page.at) was.lastSeenAt = page.at
      }
      if (page.cursor) channels.set(channelId, { ...channels.get(channelId)!, ...page.cursor })
      return { added }
    },
    async messagesByIds(ids) {
      return new Map(ids.flatMap((id) => (messages.has(id) ? [[id, { ...messages.get(id)! }] as const] : [])))
    },
    async liveMessageIds(channelId, from, to) {
      return [...messages.values()].filter((m) => m.channelId === channelId && !m.deletedAt && m.createdAt >= from && m.createdAt <= to).map((m) => m.id)
    },
    async markDeleted(ids, at) {
      let count = 0
      for (const id of ids) {
        const was = messages.get(id)
        if (was && !was.deletedAt) {
          was.deletedAt = at
          count++
        }
      }
      return count
    },
    async openPolls(before, limit) {
      return [...messages.values()]
        .filter((m) => m.poll && !m.poll.finalized && !m.deletedAt && m.createdAt < before)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((m) => ({ id: m.id, channelId: m.channelId, poll: m.poll! }))
    },
    async dailyCounts(start, end) {
      const by = new Map<string, { messages: number; authors: Set<string> }>()
      for (const m of messages.values()) {
        if (m.deletedAt || m.createdAt < start || m.createdAt >= end) continue
        const channelId = channels.get(m.channelId)?.parentId ?? m.channelId
        const entry = by.get(channelId) ?? { messages: 0, authors: new Set<string>() }
        entry.messages++
        entry.authors.add(m.authorId)
        by.set(channelId, entry)
      }
      return [...by].map(([channelId, e]) => ({ channelId, messages: e.messages, activeAuthors: e.authors.size }))
    },
    async writeDailyStats(day, counts) {
      for (const key of [...daily.keys()]) if (key.startsWith(`${day.getTime()}|`)) daily.delete(key)
      for (const c of counts) if (channels.get(c.channelId)?.synced) daily.set(`${day.getTime()}|${c.channelId}`, { ...c, date: day })
    },
    async switchOff(channelId, options = {}) {
      const channel = channels.get(channelId)
      if (!channel) throw new Error(`No channel ${channelId}`)
      channels.set(channelId, { ...channel, synced: false, lastMessageId: null, lastSyncedAt: null, rescanFrom: null })
      const threads = [...channels.values()].filter((c) => c.parentId === channelId).map((c) => c.id)
      const count = deleteMessages(new Set([channelId, ...threads]))
      for (const id of threads) channels.delete(id)
      for (const [key, stat] of daily) if (stat.channelId === channelId) daily.delete(key)
      if (options.gone) channels.delete(channelId)
      return count
    },
    async dropThread(threadId) {
      const times = [...messages.values()].filter((m) => m.channelId === threadId).map((m) => m.createdAt.getTime())
      deleteMessages(new Set([threadId]))
      if (channels.get(threadId)?.parentId) channels.delete(threadId)
      return times.length ? { from: new Date(Math.min(...times)), to: new Date(Math.max(...times)) } : null
    },
    async currentMemberIds() {
      return [...members.values()].filter((m) => !m.leftAt).map((m) => m.id)
    },
    async saveMembers(list, now, links) {
      let joined = 0
      for (const m of list) {
        const was = members.get(m.id)
        if (!was) joined++
        members.set(m.id, { ...m, userId: links.get(m.id) ?? null, firstSeenAt: was?.firstSeenAt ?? now, lastSeenAt: now, leftAt: null })
      }
      return { joined }
    },
    async markLeft(ids, at) {
      let count = 0
      for (const id of ids) {
        const was = members.get(id)
        if (was && !was.leftAt) {
          was.leftAt = at
          count++
        }
      }
      return count
    },
    async writeGuildDay(day, dayStart, dayEnd) {
      const all = [...members.values()]
      const counts = {
        memberCount: all.filter((m) => !m.leftAt).length,
        joinedCount: all.filter((m) => m.joinedAt && m.joinedAt >= dayStart && m.joinedAt < dayEnd).length,
        leftCount: all.filter((m) => m.leftAt && m.leftAt >= dayStart && m.leftAt < dayEnd).length,
      }
      guildDays.set(day.getTime(), counts)
      return counts
    },
    async linkedAccounts() {
      return new Map(linked)
    },
    async purgedAuthors(): Promise<PurgedList> {
      const ids = new Set(purged)
      return { has: (discordUserId) => ids.has(discordUserId), size: ids.size }
    },
  }
  return { store, channels, messages, members, daily, guildDays, linked, purged }
}
