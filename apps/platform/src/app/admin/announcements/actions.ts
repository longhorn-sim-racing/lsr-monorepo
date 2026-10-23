"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import type { User } from "@prisma/client"
import { prisma } from "@/server/db"
import { requireOfficer } from "@/server/auth/guards"
import { setPostingChannels } from "@/server/discord-post/channels"
import { discordPostingForPage, NOT_CONNECTED } from "@/server/discord-post/connection"
import { cancelScheduledPost, createOfficerPost, retryFailedPost } from "@/server/discord-post/officer-posts"
import { readRoles } from "@/server/discord-post/role-sync"
import { createRule, deleteRule, isRuleKind, setRuleEnabled, updateRule, type RuleConfig } from "@/server/discord-post/rules"
import type { ActionResult } from "@/lib/action-result"

/**
 * Community → Announcements' actions (design §12.1, §13). Officers see everything, post, cancel a
 * scheduled post, retry a failed one and pause a rule; only admins create, edit, switch on or delete
 * standing rules and pick the posting channels. Each checks its own access; the services audit.
 */

const SIGNED_OUT = "You're signed out or no longer an officer. Sign in again and retry."
const ADMINS_ONLY = "Only admins can set up, change or switch on standing rules, or pick the posting channels."

async function officer(): Promise<{ user: User; admin: boolean } | null> {
  let user: User
  try {
    user = await requireOfficer()
  } catch {
    return null
  }
  const admin = (await prisma.userRole.count({ where: { userId: user.id, role: { key: "admin" } } })) > 0
  return { user, admin }
}

function refresh() {
  revalidatePath("/admin/announcements")
  revalidatePath("/admin/discord")
}

/** A rule as the page's form sends it */
const ruleForm = z.object({
  kind: z.string(),
  channelId: z.string().nullable(),
  offsets: z.array(z.number().int()).max(3).optional(),
  series: z.string().trim().max(80).nullable().optional(),
  top: z.number().int().nullable().optional(),
  /** A role's id; its name is read from Discord when saving */
  pingRoleId: z.string().nullable().optional(),
  location: z.string().trim().max(100).nullable().optional(),
})

export type RuleFormInput = z.infer<typeof ruleForm>

/** The form's fields as a rule's config. A ping's role name comes from Discord (the form only knows ids) */
async function toRuleInput(raw: unknown): Promise<{ ok: true; input: { kind: string; channelId: string | null; config: RuleConfig } } | { ok: false; error: string }> {
  const parsed = ruleForm.safeParse(raw)
  if (!parsed.success || !isRuleKind(parsed.data.kind)) return { ok: false, error: "Check the rule's fields." }
  const form = parsed.data
  let ping: RuleConfig["ping"] = null
  if (form.pingRoleId) {
    const posting = await discordPostingForPage()
    if (!posting) return { ok: false, error: `${NOT_CONNECTED} A ping needs Discord connected.` }
    const live = await readRoles(posting.client, posting.writer).catch(() => null)
    const role = live?.roles.find((r) => r.id === form.pingRoleId)
    if (!role) return { ok: false, error: "Couldn't find that role in Discord. Reload the page and pick it again." }
    if (!role.mentionable && !live?.mentionEveryone) return { ok: false, error: `@${role.name} isn't pingable by the bot ("Allow anyone to @mention this role" is off).` }
    ping = { type: "role", roleId: role.id, name: role.name }
  }
  const config: RuleConfig = {
    ...(form.kind === "event_reminder" ? { offsets: form.offsets ?? [] } : {}),
    ...(form.kind === "standings_update" ? { top: form.top ?? 5 } : {}),
    ...(["event_reminder", "new_event", "results_posted", "event_mirror"].includes(form.kind) ? { series: form.series || null } : {}),
    ...(form.kind === "event_mirror" ? { location: form.location || null } : { ping }),
  }
  return { ok: true, input: { kind: form.kind, channelId: form.kind === "event_mirror" ? null : form.channelId, config } }
}

export async function createRuleAction(raw: unknown, enabled: boolean): Promise<ActionResult> {
  const me = await officer()
  if (!me) return { ok: false, error: SIGNED_OUT }
  if (!me.admin) return { ok: false, error: ADMINS_ONLY }
  const input = await toRuleInput(raw)
  if (!input.ok) return input
  const result = await createRule(input.input, { userId: me.user.id }, { enabled })
  if (!result.ok) return { ok: false, error: result.error }
  refresh()
  return { ok: true }
}

export async function updateRuleAction(id: string, raw: unknown): Promise<ActionResult> {
  const me = await officer()
  if (!me) return { ok: false, error: SIGNED_OUT }
  if (!me.admin) return { ok: false, error: ADMINS_ONLY }
  const input = await toRuleInput(raw)
  if (!input.ok) return input
  const result = await updateRule(id, input.input, { userId: me.user.id })
  if (!result.ok) return { ok: false, error: result.error }
  refresh()
  return { ok: true }
}

/** On: admins (it moves the rule's cutoff to now). Off: any officer, so anyone can stop a rule */
export async function setRuleEnabledAction(id: string, enabled: boolean): Promise<ActionResult> {
  const me = await officer()
  if (!me) return { ok: false, error: SIGNED_OUT }
  if (enabled && !me.admin) return { ok: false, error: ADMINS_ONLY }
  const result = await setRuleEnabled(id, enabled, { userId: me.user.id })
  if (!result.ok) return { ok: false, error: result.error }
  refresh()
  return { ok: true }
}

export async function deleteRuleAction(id: string): Promise<ActionResult> {
  const me = await officer()
  if (!me) return { ok: false, error: SIGNED_OUT }
  if (!me.admin) return { ok: false, error: ADMINS_ONLY }
  const result = await deleteRule(id, { userId: me.user.id })
  if (!result.ok) return { ok: false, error: result.error }
  refresh()
  return { ok: true }
}

export async function setPostingChannelsAction(ids: string[]): Promise<ActionResult> {
  const me = await officer()
  if (!me) return { ok: false, error: SIGNED_OUT }
  if (!me.admin) return { ok: false, error: ADMINS_ONLY }
  if (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== "string")) return { ok: false, error: "Pick channels from the list." }
  const result = await setPostingChannels(ids, { userId: me.user.id })
  if (!result.ok) return result
  refresh()
  return { ok: true }
}

/** An officer's own post, now or at a Central time */
export async function createPostAction(raw: unknown): Promise<ActionResult<{ summary: string; url: string | null }>> {
  const me = await officer()
  if (!me) return { ok: false, error: SIGNED_OUT }
  const posting = await discordPostingForPage()
  if (!posting) return { ok: false, error: NOT_CONNECTED }
  const result = await createOfficerPost(raw, { userId: me.user.id, displayName: me.user.displayName }, posting)
  refresh()
  if (!result.ok) return result
  return { ok: true, data: { summary: result.summary, url: result.url } }
}

export async function cancelPostAction(id: string): Promise<ActionResult> {
  const me = await officer()
  if (!me) return { ok: false, error: SIGNED_OUT }
  const result = await cancelScheduledPost(id, { userId: me.user.id, displayName: me.user.displayName })
  if (!result.ok) return result
  refresh()
  return { ok: true }
}

export async function retryPostAction(id: string): Promise<ActionResult<{ summary: string; url: string | null }>> {
  const me = await officer()
  if (!me) return { ok: false, error: SIGNED_OUT }
  const result = await retryFailedPost(id, { userId: me.user.id, displayName: me.user.displayName }, await discordPostingForPage())
  refresh()
  if (!result.ok) return result
  return { ok: true, data: { summary: result.summary, url: result.url } }
}
