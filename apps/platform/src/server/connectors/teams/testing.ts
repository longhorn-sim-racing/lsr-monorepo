import type { GraphSubscriptionRow, SubscriptionStore, TeamsChannelRow, TeamsMessageRow, TeamsStore } from "./store"

/** Test helpers: the Teams stores kept in memory, with the rows they hold. Not used by the app */

export function memoryTeamsStore(): TeamsStore & { channels: Map<string, TeamsChannelRow & { lastSyncedAt?: Date }>; messages: Map<string, TeamsMessageRow> } {
  const channels = new Map<string, TeamsChannelRow & { lastSyncedAt?: Date }>()
  const messages = new Map<string, TeamsMessageRow>()
  return {
    channels,
    messages,
    async channel(id) {
      const row = channels.get(id)
      return row ? { id: row.id, teamId: row.teamId, name: row.name, synced: row.synced, deltaLink: row.deltaLink } : null
    },
    async saveChannel({ id, teamId, name }) {
      const existing = channels.get(id)
      channels.set(id, { id, teamId, name, synced: true, deltaLink: existing?.deltaLink ?? null, lastSyncedAt: existing?.lastSyncedAt })
    },
    async setDeltaLink(channelId, deltaLink, at) {
      const row = channels.get(channelId)
      if (!row) throw new Error(`No channel ${channelId}`)
      channels.set(channelId, { ...row, deltaLink, lastSyncedAt: at })
    },
    async saveMessage(row) {
      messages.set(row.id, row.deletedAt ? { ...row, content: "" } : row)
    },
    async purgeMessage(id, at) {
      const row = messages.get(id)
      if (!row || row.deletedAt) return false
      messages.set(id, { ...row, content: "", deletedAt: at })
      return true
    },
    async dropOtherChannels(keep) {
      if (!keep.length) return { channels: 0, messages: 0 }
      let dropped = 0
      let gone = 0
      for (const [id, row] of channels) {
        if (keep.includes(id)) continue
        if (row.synced) dropped++
        channels.set(id, { ...row, synced: false, deltaLink: null })
        for (const [messageId, message] of messages) {
          if (message.channelId !== id) continue
          messages.delete(messageId)
          gone++
        }
      }
      return { channels: dropped, messages: gone }
    },
  }
}

export function memorySubscriptionStore(): SubscriptionStore & { rows: Map<string, GraphSubscriptionRow> } {
  const rows = new Map<string, GraphSubscriptionRow>()
  return {
    rows,
    list: async () => [...rows.values()].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime()),
    find: async (id) => rows.get(id) ?? null,
    async save(row) {
      rows.set(row.id, row)
    },
    async remove(id) {
      rows.delete(id)
    },
  }
}
