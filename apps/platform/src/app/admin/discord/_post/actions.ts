"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/server/db"
import { requireOfficer } from "@/server/auth/guards"
import { discordPostingForPage, NOT_CONNECTED } from "@/server/discord-post/connection"
import { createRoleRule, deleteRoleRule, readRoles, setRoleRuleEnabled } from "@/server/discord-post/role-sync"
import { roleSyncRefusal } from "@/server/connectors/discord/write"
import type { ActionResult } from "@/lib/action-result"

/**
 * Role sync rules on Community → Discord (design §12.1). Officers see them; only admins add, switch or
 * delete one. Adding and switching on check the role against Discord's live roles (plain roles below the
 * bot's own only). The service audits each change.
 */

const ADMINS_ONLY = "Only admins can change role sync."

async function requireAdmin(): Promise<{ userId: string } | null> {
  const officer = await requireOfficer()
  const admin = await prisma.userRole.count({ where: { userId: officer.id, role: { key: "admin" } } })
  return admin > 0 ? { userId: officer.id } : null
}

async function liveRoles() {
  const posting = await discordPostingForPage()
  if (!posting) return null
  const live = await readRoles(posting.client, posting.writer).catch(() => null)
  return live ? { ...live, guildId: posting.writer.guildId } : null
}

export async function createRoleRuleAction(input: { roleId: string; condition: string; enabled: boolean }): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!admin) return { ok: false, error: ADMINS_ONLY }
  const live = await liveRoles()
  if (!live) return { ok: false, error: `${NOT_CONNECTED} Role sync reads the server's roles from Discord.` }
  const result = await createRoleRule({ roleId: String(input.roleId), condition: String(input.condition), enabled: Boolean(input.enabled) }, admin, live)
  if (!result.ok) return result
  revalidatePath("/admin/discord")
  return { ok: true }
}

export async function setRoleRuleEnabledAction(id: string, enabled: boolean): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!admin) return { ok: false, error: ADMINS_ONLY }
  const rule = await prisma.discordRoleRule.findUnique({ where: { id }, select: { roleId: true } })
  if (!rule) return { ok: false, error: "That rule no longer exists. Reload the page." }
  const live = await liveRoles()
  const role = live?.roles.find((r) => r.id === rule.roleId)
  if (enabled) {
    if (!live) return { ok: false, error: `${NOT_CONNECTED} Role sync reads the server's roles from Discord.` }
    const refusal = roleSyncRefusal(role, { guildId: live.guildId, botTop: live.botTop })
    if (refusal) return { ok: false, error: refusal }
  }
  const result = await setRoleRuleEnabled(id, enabled, admin, role?.name)
  if (!result.ok) return result
  revalidatePath("/admin/discord")
  return { ok: true }
}

export async function deleteRoleRuleAction(id: string): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!admin) return { ok: false, error: ADMINS_ONLY }
  const rule = await prisma.discordRoleRule.findUnique({ where: { id }, select: { roleId: true } })
  const live = rule ? await liveRoles() : null
  const result = await deleteRoleRule(id, admin, live?.roles.find((r) => r.id === rule?.roleId)?.name)
  if (!result.ok) return result
  revalidatePath("/admin/discord")
  return { ok: true }
}
