import { z } from "zod"
import { prisma } from "@/server/db"
import { channelList, findPostingChannel, postingChannelIds, postingChannels } from "@/server/discord-post/channels"
import { officerAskedPing, resolvePing } from "@/server/discord-post/compose"
import { discordPostingForPage, NOT_CONNECTED } from "@/server/discord-post/connection"
import { readRoles } from "@/server/discord-post/role-sync"
import { createRule, describeRule, RULE_INFO, RULE_KINDS, setRuleEnabled, updateRule, validateRule, type RuleConfig } from "@/server/discord-post/rules"
import { pingLabel } from "@/server/discord-post/templates"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalDiffRow, ProposalKind } from "../types"
import { ANNOUNCEMENTS_PAGE, officerTexts, refreshAnnouncements } from "./shared"

/**
 * discord.rule (design §4.3, §12.1): create or edit a standing Discord rule. Rules post fixed templates
 * over the site's own data (nothing Jack writes is ever sent by a rule), only about public events, and
 * only about what happens after they're switched on. Only an admin can apply one (design: standing
 * rules need an admin to create and enable them); the change is audited through the rules service.
 */

export const discordRuleSchema = z.object({
  ruleId: z.string().trim().min(1).max(64).optional().describe('An existing rule\'s id to change it (run_sql: SELECT id, kind, "channelId", config, enabled FROM "DiscordRule"); leave out to create one'),
  type: z.enum(RULE_KINDS).describe("event_reminder: before each public event; new_event: when an event is published; results_posted: a race's top three; standings_update: the LSC top drivers after a recompute; twitch_live: the club stream going live; event_mirror: events copied to Discord's Events list"),
  channel: z.string().trim().min(1).max(100).optional().describe("The posting channel by name or id (every type but event_mirror)"),
  offsets: z.array(z.number().int().min(15).max(10_080)).min(1).max(3).optional().describe("event_reminder: minutes before the start, e.g. [1440, 60] for a day and an hour before"),
  series: z.string().trim().min(1).max(80).optional().describe("Only this event series' events (its slug)"),
  top: z.number().int().min(3).max(10).optional().describe("standings_update: how many drivers to list (default 5)"),
  ping: z.string().trim().min(1).max(100).optional().describe("A role to ping by name; only when an officer asked for it here. Rules never ping @everyone"),
  location: z.string().trim().min(1).max(100).optional().describe("event_mirror: the location Discord shows for an event with no venue"),
  enabled: z.boolean().optional().describe("Switch it on when applied (the default), or leave it off"),
})

export type DiscordRuleProposal = z.infer<typeof discordRuleSchema>

const savedRule = z.object({
  ruleId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  kind: z.string(),
  channelId: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
})
type SavedRule = z.infer<typeof savedRule>

export const discordRuleKind: ProposalKind<DiscordRuleProposal> = {
  kind: "discord.rule",
  tool: "propose_discord",
  description:
    "discord.rule: create or change a standing Discord automation (types above). It posts a fixed template from the site's data, only about public events and only about what happens after it's switched on; you can't write its text. Check the existing rules first with run_sql on \"DiscordRule\" and change one instead of adding a twin.",
  schema: discordRuleSchema,
  targetType: "DISCORD_RULE",
  permission: "admin",

  async prepare(p, ctx) {
    const current = p.ruleId ? await prisma.discordRule.findUnique({ where: { id: p.ruleId } }) : null
    if (p.ruleId && !current) throw new ProposalInputError(`There's no Discord rule with id ${p.ruleId}. Find it with run_sql: SELECT id, kind, "channelId" FROM "DiscordRule".`)
    if (current && current.kind !== p.type) throw new ProposalInputError(`That rule is a ${current.kind} rule; its type can't change. Propose a new rule instead.`)
    if (!current && p.type === "event_mirror" && (await prisma.discordRule.count({ where: { kind: "event_mirror" } }))) throw new ProposalInputError("There's already an event mirror rule. Change that one (its ruleId).")

    const posts = RULE_INFO[p.type].posts
    const channels = await postingChannels()
    const channel = posts ? (p.channel ? findPostingChannel(p.channel, channels) : null) : null
    if (posts && !channel) throw new ProposalInputError(`${p.channel ? `#${p.channel.replace(/^#/, "")} isn't a posting channel` : "Give the channel"}. Posting channels: ${channelList(channels)}.`)

    let ping: RuleConfig["ping"] = null
    if (p.ping) {
      if (!posts) throw new ProposalInputError("An event mirror doesn't post, so it can't ping.")
      const posting = await discordPostingForPage()
      if (!posting) throw new ProposalInputError(NOT_CONNECTED)
      const live = await readRoles(posting.client, posting.writer, ctx.signal).catch(() => {
        throw new ProposalInputError("Couldn't read the server's roles from Discord just now. Try again in a minute, or leave the ping out.")
      })
      const resolved = resolvePing(p.ping, { roles: live.roles, mentionEveryone: false })
      if (!resolved.ok) throw new ProposalInputError(resolved.error)
      if (resolved.ping?.type !== "role") throw new ProposalInputError("A standing rule can ping a role, never @everyone or @here.")
      if (!officerAskedPing(resolved.ping, await officerTexts(ctx.roomId))) throw new ProposalInputError(`No officer asked for a ping of ${pingLabel(resolved.ping)} in this room. Leave ping out, or ask the officer first.`)
      ping = resolved.ping
    }

    const config: RuleConfig = { offsets: p.offsets, series: p.series ?? null, top: p.top, ping, location: p.location ?? null }
    const valid = await validateRule({ kind: p.type, channelId: channel?.id ?? null, config: Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) })
    if (!valid.ok) throw new ProposalInputError(valid.error)
    const enabled = p.enabled ?? true

    const names = { channels: new Map(channels.map((c) => [c.id, c.name])) }
    const after = describeRule({ kind: valid.rule.kind, channelId: valid.rule.channelId, config: valid.rule.config }, names)
    const diff: ProposalDiffRow[] = current
      ? [
          { field: "rule", label: "Rule", before: describeRule(current, names), after, format: "text" },
          ...(current.enabled !== enabled ? [{ field: "enabled", label: "State", before: current.enabled ? "On" : "Off", after: enabled ? "On" : "Off", format: "value" as const }] : []),
        ]
      : [
          { field: "rule", label: "Rule", before: null, after, format: "text" },
          { field: "enabled", label: "State", before: null, after: enabled ? "On when applied" : "Off (an admin switches it on)", format: "value" },
        ]
    const what = RULE_INFO[valid.rule.kind]
    const summary = [
      current ? `Applying it changes this rule's settings${current.enabled !== enabled ? ` and switches it ${enabled ? "on" : "off"}` : ""}.` : `Applying it creates the rule${enabled ? " and switches it on" : ", switched off"}.`,
      `${what.description} It posts a fixed template from the site's data, only about public events, and only about what happens from the moment it's switched on.`,
      "Only an admin can apply it.",
    ].join(" ")

    return {
      before: { ruleId: current?.id ?? null, updatedAt: current?.updatedAt.toISOString() ?? null, kind: valid.rule.kind, channelId: valid.rule.channelId, config: valid.rule.config as Record<string, unknown>, enabled } satisfies SavedRule,
      targetId: current?.id ?? `new:${valid.rule.kind}:${valid.rule.channelId ?? "none"}`,
      view: { title: current ? `Change the Discord rule “${describeRule(current, names)}”` : `Set up a Discord rule: ${after}`, summary, diff, links: [{ title: "Announcements", url: ANNOUNCEMENTS_PAGE }] },
    }
  },

  async checkStale(p, before) {
    const saved = savedRule.safeParse(before)
    if (!saved.success) return "The proposal's copy of the rule is missing. Ask Jack to propose it again."
    if (saved.data.ruleId) {
      const rule = await prisma.discordRule.findUnique({ where: { id: saved.data.ruleId }, select: { updatedAt: true } })
      if (!rule) return "The rule was deleted."
      if (rule.updatedAt.toISOString() !== saved.data.updatedAt) return "Someone changed the rule since this was proposed."
    } else if (saved.data.kind === "event_mirror" && (await prisma.discordRule.count({ where: { kind: "event_mirror" } }))) {
      return "Someone set up an event mirror since this was proposed."
    }
    if (saved.data.channelId && !(await postingChannelIds()).includes(saved.data.channelId)) return "Its channel isn't a posting channel anymore."
    return null
  },

  async apply(p, ctx) {
    const saved = savedRule.safeParse(ctx.before)
    if (!saved.success) throw new StaleProposalError("The proposal's copy of the rule is missing. Ask Jack to propose it again.")
    const input = { kind: saved.data.kind, channelId: saved.data.channelId, config: saved.data.config }
    const actor = { userId: ctx.officer.userId }
    const links = [{ title: "Announcements", url: ANNOUNCEMENTS_PAGE }]
    const names = { channels: new Map((await postingChannels()).map((c) => [c.id, c.name])) }

    if (!saved.data.ruleId) {
      const created = await createRule(input, actor, { enabled: saved.data.enabled, auditMetadata: ctx.auditMetadata })
      if (!created.ok) throw new Error(created.error)
      refreshAnnouncements()
      return { summary: `Set up the Discord rule “${describeRule(created.rule, names)}”${saved.data.enabled ? ", switched on" : ", switched off"}.`, links, created: [{ type: "DISCORD_RULE", id: created.rule.id }] }
    }

    const updated = await updateRule(saved.data.ruleId, input, actor, { expectedUpdatedAt: saved.data.updatedAt ? new Date(saved.data.updatedAt) : undefined, auditMetadata: ctx.auditMetadata })
    if (!updated.ok) {
      if (updated.reason) throw new StaleProposalError(updated.reason === "not_found" ? "The rule was deleted." : "Someone changed the rule since this was proposed.")
      throw new Error(updated.error)
    }
    const switching = updated.rule.enabled !== saved.data.enabled
    if (switching) {
      const switched = await setRuleEnabled(updated.rule.id, saved.data.enabled, actor, { auditMetadata: ctx.auditMetadata })
      if (!switched.ok) throw new Error(`Saved the settings, but couldn't switch it ${saved.data.enabled ? "on" : "off"}: ${switched.error}`)
    }
    refreshAnnouncements()
    return { summary: `Changed the Discord rule “${describeRule(updated.rule, names)}”${switching ? ` and switched it ${saved.data.enabled ? "on" : "off"}` : ""}.`, links }
  },
}
