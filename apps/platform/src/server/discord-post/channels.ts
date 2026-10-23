import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { CHANNEL_TYPE } from "@/server/connectors/discord/types"

/**
 * Where the bot may post (design §12.1: "channel must be an allowed posting channel"). Admins pick the
 * channels on Community → Announcements; every post, proposal and standing rule is checked against the
 * list, at propose time and again right before sending. The list is SystemSetting `discord_posting`
 * (not a credential; revoked from Jack's SQL role like every setting), `{ "channels": [<id>, …] }`.
 * Channel names come from the Discord sync's channel list (DiscordChannel).
 */

export const POSTING_SETTING = "discord_posting"

/** Text and announcement channels: where a message or a poll can go (not forums, voice or threads) */
export const POSTABLE_CHANNEL_TYPES: readonly number[] = [CHANNEL_TYPE.text, CHANNEL_TYPE.announcement]

export type PostingChannel = { id: string; name: string; type: number }

function readSetting(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "{}") as { channels?: unknown }
    return Array.isArray(parsed.channels) ? [...new Set(parsed.channels.filter((id): id is string => typeof id === "string" && /^\d{17,20}$/.test(id)))] : []
  } catch {
    return []
  }
}

/** The ids an admin allowed, as saved */
export async function postingChannelIds(): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({ where: { key: POSTING_SETTING } })
  return readSetting(row?.value)
}

/** The allowed channels that still exist in the synced channel list, by name */
export async function postingChannels(): Promise<PostingChannel[]> {
  const ids = await postingChannelIds()
  if (!ids.length) return []
  const rows = await prisma.discordChannel.findMany({ where: { id: { in: ids }, parentId: null }, select: { id: true, name: true, type: true } })
  return rows.filter((c) => POSTABLE_CHANNEL_TYPES.includes(c.type)).sort((a, b) => a.name.localeCompare(b.name))
}

/** Every channel an admin could allow: the server's text and announcement channels, by name */
export async function postableChannels(): Promise<PostingChannel[]> {
  const rows = await prisma.discordChannel.findMany({ where: { parentId: null, type: { in: [...POSTABLE_CHANNEL_TYPES] } }, select: { id: true, name: true, type: true } })
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** A channel as Jack or an officer names it: its id, "announcements" or "#announcements", among `channels` */
export function findPostingChannel(name: string, channels: readonly PostingChannel[]): PostingChannel | null {
  const wanted = name.trim().replace(/^<#(\d+)>$/, "$1").replace(/^#/, "").toLowerCase()
  return channels.find((c) => c.id === wanted) ?? channels.find((c) => c.name.toLowerCase() === wanted) ?? null
}

/** "#announcements, #general" or a note that none are set */
export function channelList(channels: readonly PostingChannel[]): string {
  return channels.length ? channels.map((c) => `#${c.name}`).join(", ") : "none yet (an admin picks them on Community → Announcements)"
}

/**
 * Saves the allowed channels (admins; the caller checks the role). Only the server's text and
 * announcement channels are taken. Audited when the list changes
 */
export async function setPostingChannels(ids: readonly string[], actor: { userId: string }): Promise<{ ok: true; channels: PostingChannel[]; changed: boolean } | { ok: false; error: string }> {
  const wanted = [...new Set(ids)]
  const rows = wanted.length ? await prisma.discordChannel.findMany({ where: { id: { in: wanted }, parentId: null }, select: { id: true, name: true, type: true } }) : []
  const usable = rows.filter((c) => POSTABLE_CHANNEL_TYPES.includes(c.type))
  if (usable.length !== wanted.length) return { ok: false, error: "Only the server's text and announcement channels can be posting channels. Reload the page." }
  const before = await postingChannelIds()
  const after = usable.map((c) => c.id).sort()
  if (before.slice().sort().join(",") === after.join(",")) return { ok: true, channels: usable, changed: false }
  const value = JSON.stringify({ channels: after })
  await prisma.systemSetting.upsert({ where: { key: POSTING_SETTING }, update: { value }, create: { key: POSTING_SETTING, value } })
  const names = (list: string[]) => list.map((id) => `#${rows.find((c) => c.id === id)?.name ?? id}`)
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "UPDATE",
    entityType: "DISCORD_POSTING",
    entityId: POSTING_SETTING,
    summary: after.length ? `Set the Discord posting channels to ${names(after).join(", ")}` : "Cleared the Discord posting channels (nothing can be posted)",
    before: { channels: before },
    after: { channels: after },
  })
  return { ok: true, channels: usable.sort((a, b) => a.name.localeCompare(b.name)), changed: true }
}
