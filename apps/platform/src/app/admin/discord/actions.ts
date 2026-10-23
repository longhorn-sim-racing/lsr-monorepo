"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/server/db"
import { requireOfficer } from "@/server/auth/guards"
import { createAuditLog } from "@/server/audit/log"
import { isSnowflake } from "@/server/connectors/discord/snowflake"
import { prismaDiscordStore } from "@/server/connectors/discord/store"
import { SYNCABLE_CHANNEL_TYPES } from "@/server/connectors/discord/types"
import { takeBackAfterPurge, type PurgeRoles } from "@/server/discord-post/role-takeback"
import { purgeDiscordData, type PurgeResult } from "@/server/services/discord-link.service"
import type { ActionResult } from "@/lib/action-result"

const ADMINS_ONLY = "Only admins can change which Discord channels sync or delete someone's Discord data."

/** Officers can see the Discord page; only admins change what it syncs or purge data (design §12.1) */
async function requireAdminAction(): Promise<{ userId: string } | null> {
  const officer = await requireOfficer()
  const admin = await prisma.userRole.count({ where: { userId: officer.id, role: { key: "admin" } } })
  return admin > 0 ? { userId: officer.id } : null
}

const switchSchema = z.object({ channelId: z.string().refine(isSnowflake), synced: z.boolean() })

/**
 * Opts a channel in to the sync (and Jack's live search) or out of it. Out also deletes what's stored
 * from it: its messages' metadata, its threads (their titles and messages) and its daily counts, and
 * resets its cursor, so the club holds nothing from a channel it doesn't sync (a sync running at that
 * moment waits for this or stops writing; see prismaDiscordStore.switchOff); opting back in reads it
 * again from the backfill window. Audited when it changes.
 */
export async function setDiscordChannelSyncedAction(channelId: string, synced: boolean): Promise<ActionResult<{ changed: boolean; deleted: number }>> {
  const admin = await requireAdminAction()
  if (!admin) return { ok: false, error: ADMINS_ONLY }
  const parsed = switchSchema.safeParse({ channelId, synced })
  if (!parsed.success) return { ok: false, error: "There's no channel like that. Reload the page." }

  const channel = await prisma.discordChannel.findUnique({ where: { id: parsed.data.channelId }, select: { id: true, name: true, type: true, parentId: true, synced: true } })
  if (!channel || channel.parentId || !SYNCABLE_CHANNEL_TYPES.includes(channel.type)) return { ok: false, error: "There's no channel like that to sync. Reload the page." }
  if (channel.synced === parsed.data.synced) return { ok: true, data: { changed: false, deleted: 0 } }

  let deleted = 0
  if (parsed.data.synced) await prisma.discordChannel.update({ where: { id: channel.id }, data: { synced: true } })
  else deleted = await prismaDiscordStore.switchOff(channel.id)
  await createAuditLog({
    actorUserId: admin.userId,
    actionType: parsed.data.synced ? "ENABLE" : "DISABLE",
    entityType: "DISCORD_CHANNEL",
    entityId: channel.id,
    summary: parsed.data.synced
      ? `Opted #${channel.name} in to the Discord sync`
      : `Opted #${channel.name} out of the Discord sync and deleted ${deleted} stored message ${deleted === 1 ? "record" : "records"}`,
    before: { synced: channel.synced },
    after: { synced: parsed.data.synced },
    metadata: { deleted },
  })
  revalidatePath("/admin/discord")
  return { ok: true, data: { changed: true, deleted } }
}

/**
 * Deletes everything held about one Discord account, on request: by its Discord user id, its username
 * as the member list has it, or (from Members) a site member's linked account. See purgeDiscordData.
 * Role sync never sees a purged account again, so the roles it gave are taken back right after (see
 * takeBackAfterPurge); when that fails the admin is told to remove them in Discord
 */
export async function purgeDiscordMemberAction(input: { discordUserId?: string; username?: string; userId?: string }): Promise<ActionResult<PurgeResult & { roles: PurgeRoles }>> {
  const admin = await requireAdminAction()
  if (!admin) return { ok: false, error: ADMINS_ONLY }

  let discordUserId: string | null = null
  if (input.userId) {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { discordUserId: true } })
    discordUserId = user?.discordUserId ?? null
    if (!discordUserId) return { ok: false, error: "That member has no Discord account linked. Use their Discord username on Community → Discord instead." }
  } else if (input.discordUserId?.trim()) {
    discordUserId = input.discordUserId.trim()
    if (!isSnowflake(discordUserId)) return { ok: false, error: "A Discord user ID is 17 to 20 digits (Discord: User Settings → Advanced → Developer Mode, then right-click the person → Copy User ID)." }
  } else if (input.username?.trim()) {
    const name = input.username.trim().replace(/^@/, "")
    const matches = await prisma.discordMember.findMany({ where: { username: { equals: name, mode: "insensitive" } }, select: { id: true }, take: 2 })
    if (!matches.length) return { ok: false, error: `Nobody called @${name} is in the synced member list. Try their Discord user ID.` }
    if (matches.length > 1) return { ok: false, error: `More than one member is called @${name}. Use their Discord user ID.` }
    discordUserId = matches[0].id
  } else {
    return { ok: false, error: "Enter a Discord user ID or username." }
  }

  const result = await purgeDiscordData(discordUserId, admin)
  const roles = await takeBackAfterPurge(discordUserId, { wasLinked: Boolean(result.unlinkedUserId), targetUserId: result.unlinkedUserId })
  revalidatePath("/admin/discord")
  if (result.unlinkedUserId) revalidatePath(`/admin/users/${result.unlinkedUserId}/edit`)
  return { ok: true, data: { ...result, roles } }
}
