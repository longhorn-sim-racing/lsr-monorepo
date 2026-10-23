import { prisma } from "@/server/db"
import { PURGED_SETTING, readPurged } from "./store"

/**
 * Which Discord channels Jack may read live (design §12.1): the ones an admin opted in, and the threads
 * in them. Read from DiscordChannel on every call, so switching a channel off takes effect at once.
 */

export type DiscordScope = {
  /** Opted-in channels and their threads (what search is limited to); Discord takes up to 500 */
  ids: string[]
  has(channelId: string): boolean
  /** "#general", or "#setups › Monza setup help" for a thread */
  label(channelId: string): string
  /** Hashed ids of members whose data was purged on request: their messages are never shown */
  purged: Set<string>
}

export async function discordScope(): Promise<DiscordScope> {
  const [channels, purged] = await Promise.all([
    prisma.discordChannel.findMany({ select: { id: true, name: true, parentId: true, synced: true } }),
    prisma.systemSetting.findUnique({ where: { key: PURGED_SETTING } }),
  ])
  const byId = new Map(channels.map((c) => [c.id, c]))
  const opted = new Set(channels.filter((c) => !c.parentId && c.synced).map((c) => c.id))
  const ids = channels.filter((c) => (c.parentId ? opted.has(c.parentId) : opted.has(c.id))).map((c) => c.id)
  // Channels before threads, so the cap keeps every channel
  ids.sort((a, b) => Number(Boolean(byId.get(a)?.parentId)) - Number(Boolean(byId.get(b)?.parentId)))
  const allowed = new Set(ids.slice(0, 500))
  return {
    ids: [...allowed],
    has: (channelId) => allowed.has(channelId),
    label(channelId) {
      const channel = byId.get(channelId)
      if (!channel) return "a Discord channel"
      const parent = channel.parentId ? byId.get(channel.parentId) : undefined
      return parent ? `#${parent.name} › ${channel.name}` : `#${channel.name}`
    },
    purged: readPurged(purged?.value),
  }
}
