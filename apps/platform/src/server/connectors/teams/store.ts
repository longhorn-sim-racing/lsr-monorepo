import { prisma } from "@/server/db"

/**
 * Writes for the Teams sync, the change notifications and the subscription job (design §3.3:
 * TeamsChannel, TeamsMessage, GraphSubscription). The sync code talks to these interfaces, so tests run
 * against the in-memory ones in `testing.ts`. The search index follows TeamsMessage by trigger.
 */

export type TeamsMessageRow = {
  id: string
  channelId: string
  replyToId: string | null
  authorAadId: string | null
  authorName: string
  /** Plain text; "" once deleted */
  content: string
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
}

export type TeamsChannelRow = { id: string; teamId: string; name: string; synced: boolean; deltaLink: string | null }

export type TeamsStore = {
  channel(id: string): Promise<TeamsChannelRow | null>
  /** Saves a configured channel as synced (its delta link kept) */
  saveChannel(channel: { id: string; teamId: string; name: string }, at: Date): Promise<void>
  setDeltaLink(channelId: string, deltaLink: string | null, at: Date): Promise<void>
  /** Saves a message; a deleted one keeps only who wrote it and when */
  saveMessage(row: TeamsMessageRow): Promise<void>
  /** A message deleted in Teams: its text goes. True when it was there with text */
  purgeMessage(id: string, at: Date): Promise<boolean>
  /** Channels no longer configured: no longer synced, and every message of theirs deleted. Returns the counts */
  dropOtherChannels(keep: string[]): Promise<{ channels: number; messages: number }>
}

export function prismaTeamsStore(): TeamsStore {
  return {
    channel: (id) => prisma.teamsChannel.findUnique({ where: { id }, select: { id: true, teamId: true, name: true, synced: true, deltaLink: true } }),
    async saveChannel({ id, teamId, name }) {
      await prisma.teamsChannel.upsert({ where: { id }, create: { id, teamId, name, synced: true }, update: { teamId, name, synced: true } })
    },
    async setDeltaLink(channelId, deltaLink, at) {
      await prisma.teamsChannel.update({ where: { id: channelId }, data: { deltaLink, lastSyncedAt: at } })
    },
    async saveMessage(row) {
      const data = row.deletedAt ? { ...row, content: "" } : row
      await prisma.teamsMessage.upsert({ where: { id: row.id }, create: data, update: data })
    },
    async purgeMessage(id, at) {
      const { count } = await prisma.teamsMessage.updateMany({ where: { id, deletedAt: null }, data: { content: "", deletedAt: at } })
      return count > 0
    },
    async dropOtherChannels(keep) {
      // An empty list is a setup mistake, never "drop everything"
      if (!keep.length) return { channels: 0, messages: 0 }
      const others = await prisma.teamsChannel.findMany({ where: { id: { notIn: keep } }, select: { id: true } })
      if (!others.length) return { channels: 0, messages: 0 }
      const ids = others.map((channel) => channel.id)
      return prisma.$transaction(async (tx) => {
        const { count: messages } = await tx.teamsMessage.deleteMany({ where: { channelId: { in: ids } } })
        const { count: channels } = await tx.teamsChannel.updateMany({ where: { id: { in: ids }, synced: true }, data: { synced: false, deltaLink: null } })
        return { channels, messages }
      })
    },
  }
}

export type GraphSubscriptionRow = { id: string; resource: string; expiresAt: Date; clientStateHash: string }

export type SubscriptionStore = {
  list(): Promise<GraphSubscriptionRow[]>
  find(id: string): Promise<GraphSubscriptionRow | null>
  save(row: GraphSubscriptionRow): Promise<void>
  remove(id: string): Promise<void>
}

export function prismaSubscriptionStore(): SubscriptionStore {
  const select = { id: true, resource: true, expiresAt: true, clientStateHash: true } as const
  return {
    list: () => prisma.graphSubscription.findMany({ select, orderBy: { expiresAt: "asc" } }),
    find: (id) => prisma.graphSubscription.findUnique({ where: { id }, select }),
    async save(row) {
      await prisma.graphSubscription.upsert({ where: { id: row.id }, create: row, update: { resource: row.resource, expiresAt: row.expiresAt, clientStateHash: row.clientStateHash } })
    },
    async remove(id) {
      await prisma.graphSubscription.deleteMany({ where: { id } })
    },
  }
}
