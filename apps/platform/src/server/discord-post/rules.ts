import type { DiscordRule } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { channelList, postingChannels, type PostingChannel } from "./channels"
import { cancelPosts } from "./outbox"
import { offsetLabel, pingLabel, type PingTarget } from "./templates"

/**
 * Standing Discord rules (design §12.1, §4.3 `discord.rule`): automations an admin sets up once. Each
 * posts a fixed template over the site's own data (templates.ts) when something new happens after the
 * rule's `cutoffAt`; nothing a model writes is ever sent by a rule. Officers see them on Community →
 * Announcements; only admins create, edit and switch them on (any officer can pause one). Every change
 * is audited (entityType DISCORD_RULE).
 */

export const RULE_KINDS = ["event_reminder", "new_event", "results_posted", "standings_update", "twitch_live", "event_mirror"] as const
export type RuleKind = (typeof RULE_KINDS)[number]

export const RULE_INFO: Record<RuleKind, { label: string; description: string; posts: boolean }> = {
  event_reminder: { label: "Event reminders", description: "Reminds the channel before each public event starts.", posts: true },
  new_event: { label: "New events", description: "Announces each upcoming event once it's public on the site.", posts: true },
  results_posted: { label: "Results posted", description: "Posts a race's top three once its results are uploaded.", posts: true },
  standings_update: { label: "Standings updates", description: "Posts the Lone Star Cup's top drivers when its standings are recomputed.", posts: true },
  twitch_live: { label: "Twitch live", description: "Says when the club's Twitch channel goes live.", posts: true },
  event_mirror: { label: "Event mirror", description: "Adds each upcoming public event to the server's Events list and keeps it up to date.", posts: false },
}

export const isRuleKind = (value: unknown): value is RuleKind => typeof value === "string" && (RULE_KINDS as readonly string[]).includes(value)

/** A rule may ping one role (admins approve it); never @everyone or @here */
const rolePing = z.object({ type: z.literal("role"), roleId: z.string().regex(/^\d{17,20}$/), name: z.string().trim().min(1).max(100) })
/** An event series' slug: only that series' events */
const series = z.string().trim().min(1).max(80).nullish()

/** Each kind's config (DiscordRule.config) */
export const RULE_CONFIG = {
  event_reminder: z.object({ offsets: z.array(z.number().int().min(15).max(7 * 1440)).min(1).max(3), series, ping: rolePing.nullish() }),
  new_event: z.object({ series, ping: rolePing.nullish() }),
  results_posted: z.object({ series, ping: rolePing.nullish() }),
  standings_update: z.object({ top: z.number().int().min(3).max(10).default(5), ping: rolePing.nullish() }),
  twitch_live: z.object({ ping: rolePing.nullish() }),
  event_mirror: z.object({ series, location: z.string().trim().min(1).max(100).nullish() }),
} satisfies Record<RuleKind, z.ZodType>

/** Every kind's fields in one shape (each kind uses some of them) */
export type RuleConfig = {
  offsets?: number[]
  series?: string | null
  ping?: Extract<PingTarget, { type: "role" }> | null
  top?: number
  location?: string | null
}

/** A rule as saved, with its config read back; null config when it's unreadable (the rule then does nothing) */
export function readRuleConfig(kind: string, config: unknown): RuleConfig | null {
  if (!isRuleKind(kind)) return null
  const parsed = RULE_CONFIG[kind].safeParse(config ?? {})
  return parsed.success ? (parsed.data as RuleConfig) : null
}

export type RuleInput = { kind: string; channelId: string | null; config: unknown }

export type ValidRule = { kind: RuleKind; channelId: string | null; config: RuleConfig; channel: PostingChannel | null }

/** The first problem zod found, in a sentence */
function issue(error: z.ZodError): string {
  const first = error.issues[0]
  return first ? `${first.path.join(".") || "config"}: ${first.message}` : "The rule's settings aren't valid."
}

/**
 * Checks a rule as an admin (or a proposal) gives it: a known kind, its config, a posting channel for the
 * kinds that post (event_mirror has none), and a series that exists. Reads only
 */
export async function validateRule(input: RuleInput): Promise<{ ok: true; rule: ValidRule } | { ok: false; error: string }> {
  if (!isRuleKind(input.kind)) return { ok: false, error: `There's no rule kind "${input.kind}". Kinds: ${RULE_KINDS.join(", ")}.` }
  const parsed = RULE_CONFIG[input.kind].safeParse(input.config ?? {})
  if (!parsed.success) return { ok: false, error: issue(parsed.error) }
  const config = parsed.data as RuleConfig
  if (config.offsets) config.offsets = [...new Set(config.offsets)].sort((a, b) => b - a)

  let channel: PostingChannel | null = null
  if (RULE_INFO[input.kind].posts) {
    const channels = await postingChannels()
    channel = channels.find((c) => c.id === input.channelId) ?? null
    if (!channel) return { ok: false, error: `Pick a posting channel: ${channelList(channels)}.` }
  }
  if (config.series) {
    const found = await prisma.eventSeries.findUnique({ where: { slug: config.series }, select: { id: true } })
    if (!found) return { ok: false, error: `There's no event series "${config.series}".` }
  }
  return { ok: true, rule: { kind: input.kind, channelId: channel?.id ?? null, config, channel } }
}

/** "Event reminders in #announcements, 1 day and 1 hour before, pinging @LSC Driver" */
export function describeRule(rule: { kind: string; channelId: string | null; config: unknown }, names: { channels?: Map<string, string>; series?: Map<string, string> } = {}): string {
  const config = readRuleConfig(rule.kind, rule.config)
  if (!isRuleKind(rule.kind) || !config) return "A rule whose settings can't be read (it does nothing). Edit or delete it."
  const channel = rule.channelId ? `#${names.channels?.get(rule.channelId) ?? rule.channelId}` : null
  const parts = [`${RULE_INFO[rule.kind].label}${channel ? ` in ${channel}` : ""}`]
  if (config.offsets?.length) parts.push(`${config.offsets.map(offsetLabel).join(" and ")} before`)
  if (config.series) parts.push(`${names.series?.get(config.series) ?? config.series} events only`)
  if (rule.kind === "standings_update") parts.push(`top ${config.top ?? 5}`)
  if (config.location) parts.push(`location “${config.location}” when an event has no venue`)
  const ping = pingLabel(config.ping)
  parts.push(ping ? `pinging ${ping}` : "no ping")
  return parts.join(", ")
}

export type RuleActor = { userId: string }
type RuleResult = { ok: true; rule: DiscordRule } | { ok: false; error: string; reason?: "not_found" | "changed" }
type AuditExtras = { auditMetadata?: Record<string, unknown> }

const snapshot = (rule: Pick<DiscordRule, "kind" | "channelId" | "config" | "enabled">) => ({ kind: rule.kind, channelId: rule.channelId, config: rule.config, enabled: rule.enabled })

async function audit(actor: RuleActor, actionType: string, rule: DiscordRule, summary: string, extra: { before?: unknown; after?: unknown; metadata?: Record<string, unknown> } = {}) {
  await createAuditLog({
    actorUserId: actor.userId,
    actionType,
    entityType: "DISCORD_RULE",
    entityId: rule.id,
    summary,
    before: extra.before,
    after: extra.after,
    metadata: { kind: rule.kind, ...extra.metadata },
  })
}

/**
 * Creates a rule (admins; the caller checks). It acts only on things after now (cutoffAt). There's one
 * event mirror at most
 */
export async function createRule(input: RuleInput, actor: RuleActor, { enabled, now = new Date(), auditMetadata }: { enabled: boolean; now?: Date } & AuditExtras): Promise<RuleResult> {
  const valid = await validateRule(input)
  if (!valid.ok) return valid
  if (valid.rule.kind === "event_mirror" && (await prisma.discordRule.count({ where: { kind: "event_mirror" } }))) return { ok: false, error: "There's already an event mirror rule. Edit that one." }
  const rule = await prisma.discordRule.create({
    data: { kind: valid.rule.kind, channelId: valid.rule.channelId, config: valid.rule.config, enabled, cutoffAt: now, createdById: actor.userId, updatedById: actor.userId },
  })
  const label = describeRule(rule, { channels: new Map(valid.rule.channel ? [[valid.rule.channel.id, valid.rule.channel.name]] : []) })
  await audit(actor, "CREATE", rule, `Created the Discord rule “${label}”${enabled ? ", switched on" : ", switched off"}`, { after: snapshot(rule), metadata: auditMetadata })
  return { ok: true, rule }
}

/**
 * Edits a rule's channel and settings (admins). Its scheduled posts are cancelled, and the next run makes
 * them again with the new settings. With `expectedUpdatedAt` (a proposal), it only saves when nobody
 * changed the rule since
 */
export async function updateRule(id: string, input: RuleInput, actor: RuleActor, { expectedUpdatedAt, auditMetadata }: { expectedUpdatedAt?: Date } & AuditExtras = {}): Promise<RuleResult> {
  const current = await prisma.discordRule.findUnique({ where: { id } })
  if (!current) return { ok: false, error: "That rule no longer exists.", reason: "not_found" }
  if (current.kind !== input.kind) return { ok: false, error: `A rule's kind can't change (it's ${current.kind}). Delete it and create a new one.` }
  const valid = await validateRule(input)
  if (!valid.ok) return valid
  const { count } = await prisma.discordRule.updateMany({
    where: { id, ...(expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}) },
    data: { channelId: valid.rule.channelId, config: valid.rule.config, updatedById: actor.userId },
  })
  if (!count) return { ok: false, error: "Someone changed the rule since.", reason: "changed" }
  const rule = await prisma.discordRule.findUniqueOrThrow({ where: { id } })
  await cancelPosts({ ruleId: id }, "The rule was edited; its next run schedules posts with the new settings.", { release: true })
  await audit(actor, "UPDATE", rule, `Edited the Discord rule “${describeRule(rule, { channels: new Map(valid.rule.channel ? [[valid.rule.channel.id, valid.rule.channel.name]] : []) })}”`, {
    before: snapshot(current),
    after: snapshot(rule),
    metadata: auditMetadata,
  })
  return { ok: true, rule }
}

/**
 * Switches a rule on or off. On (admins) moves its cutoff to now, so it never posts about what happened
 * while it was off. Off (any officer) cancels its scheduled posts
 */
export async function setRuleEnabled(id: string, enabled: boolean, actor: RuleActor, { now = new Date(), auditMetadata }: { now?: Date } & AuditExtras = {}): Promise<RuleResult & { changed?: boolean }> {
  const current = await prisma.discordRule.findUnique({ where: { id } })
  if (!current) return { ok: false, error: "That rule no longer exists.", reason: "not_found" }
  if (current.enabled === enabled) return { ok: true, rule: current, changed: false }
  if (enabled && isRuleKind(current.kind) && RULE_INFO[current.kind].posts) {
    const channels = await postingChannels()
    if (!channels.some((c) => c.id === current.channelId)) return { ok: false, error: "Its channel isn't a posting channel anymore. Edit the rule first." }
  }
  if (enabled && !readRuleConfig(current.kind, current.config)) return { ok: false, error: "Its settings can't be read. Edit the rule first." }
  const rule = await prisma.discordRule.update({ where: { id }, data: { enabled, updatedById: actor.userId, ...(enabled ? { cutoffAt: now } : {}) } })
  if (!enabled) await cancelPosts({ ruleId: id }, "The rule was switched off.", { release: true })
  await audit(actor, enabled ? "ENABLE" : "DISABLE", rule, `${enabled ? "Switched on" : "Paused"} the Discord rule “${describeRule(rule)}”`, { before: { enabled: current.enabled }, after: { enabled }, metadata: auditMetadata })
  return { ok: true, rule, changed: true }
}

/** Deletes a rule (admins) and cancels its scheduled posts; what it already posted stays, and so do the Discord events an event mirror made */
export async function deleteRule(id: string, actor: RuleActor): Promise<RuleResult> {
  const current = await prisma.discordRule.findUnique({ where: { id } })
  if (!current) return { ok: false, error: "That rule no longer exists.", reason: "not_found" }
  await cancelPosts({ ruleId: id }, "The rule was deleted.", { release: false })
  await prisma.discordRule.delete({ where: { id } })
  await audit(actor, "DELETE", current, `Deleted the Discord rule “${describeRule(current)}”`, { before: snapshot(current) })
  return { ok: true, rule: current }
}
