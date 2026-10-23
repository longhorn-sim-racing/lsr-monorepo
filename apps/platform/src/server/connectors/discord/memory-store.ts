import { compareSnowflakes } from "./snowflake"
import type { MessageRow } from "./metadata"
import type { DailyCount, DiscordStore, MemberInput, StoredChannel } from "./store"

/**
 * An in-memory DiscordStore for the sync's tests (tests only; the app uses prismaDiscordStore). It keeps
 * the same rules the database does: new channels arrive switched off, inserts skip ids already stored,
 * daily counts leave deleted rows out and count threads toward their channel.
 */

export type MemoryMessage = MessageRow & { deletedAt: Date | null }
export type MemoryMember = MemberInput & { userId: string | null; firstSeenAt: Date; lastSeenAt: Date; leftAt: Date | null }

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
    async saveCursor(id, cursor) {
      const was = channels.get(id)
      if (!was) throw new Error(`No channel ${id}`)
      channels.set(id, { ...was, ...cursor })
    },
    async messagesByIds(ids) {
      return new Map(ids.flatMap((id) => (messages.has(id) ? [[id, { ...messages.get(id)! }] as const] : [])))
    },
    async insertMessages(rows) {
      let added = 0
      for (const row of rows) {
        if (messages.has(row.id)) continue
        messages.set(row.id, { ...row, deletedAt: null })
        added++
      }
      return added
    },
    async updateMessages(rows) {
      for (const row of rows) {
        const was = messages.get(row.id)
        if (was) messages.set(row.id, { ...was, ...row, createdAt: was.createdAt, channelId: was.channelId, authorId: was.authorId, deletedAt: null })
      }
    },
    async touchMessages(ids, at) {
      for (const id of ids) {
        const was = messages.get(id)
        if (was) was.lastSeenAt = at
      }
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
      for (const c of counts) daily.set(`${day.getTime()}|${c.channelId}`, { ...c, date: day })
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
    async purgedAuthors() {
      return new Set(purged)
    },
  }
  return { store, channels, messages, members, daily, guildDays, linked, purged }
}
