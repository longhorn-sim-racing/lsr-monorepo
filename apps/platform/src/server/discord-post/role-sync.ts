import type { DiscordRoleRule } from "@prisma/client"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { DISCORD_ERROR, DiscordApiError, type DiscordClient } from "@/server/connectors/discord/client"
import { prismaDiscordStore } from "@/server/connectors/discord/store"
import { botStanding, roleSyncRefusal, type DiscordRole, type DiscordWriter, type RoleSafety } from "@/server/connectors/discord/write"
import { DEFAULT_LEAGUE, resolveLeagueSeason } from "@/server/jack/tools/seasons"
import { listSeasonEntrants } from "@/server/services/league-entry.service"

/**
 * Role sync (design §12.1): linked members (User.discordUserId) get a Discord role while they meet a
 * condition on the site, and lose it when they stop. Hourly (`discord.role-sync`), after the member sync.
 * - Plain roles only: never @everyone, a managed role, a role with any moderation permission (server-wide,
 *   or in a channel the bot can see through a permission overwrite), one with Create Events or Create
 *   Expressions that @everyone doesn't have, or one at or above the bot's own highest role
 *   (roleSyncRefusal; checked live every run, so a role someone gives Kick Members later is refused from
 *   then on).
 * - Only linked members, never anyone on the purged list, and only members the member sync has seen in
 *   the server (DiscordMember.roles is what they hold now).
 * - At most MAX_ROLE_CHANGES_PER_RUN changes a run; the rest wait for the next.
 * - Every change is audited (entityType DISCORD_ROLE, the member as target, the system as actor).
 * - One rule per role. Rules are managed on Community → Discord (admins).
 */

export const ROLE_CONDITIONS = {
  linked: { label: "Linked members", description: "Everyone who linked their Discord account on the site." },
  officer: { label: "Officers", description: "Members with the officer or admin role on the site." },
  lsc_driver: { label: "LSC Driver badge", description: "Members with the LSC Driver badge on the site." },
  collegiate_driver: { label: "Collegiate Series badge", description: "Members with the Collegiate Series badge on the site." },
  lsc_entered: { label: "Entered in the open LSC season", description: "Members entered in the Lone Star Cup's open season (paid, or added by an officer). Nothing changes while no season is open." },
} as const

export type RoleCondition = keyof typeof ROLE_CONDITIONS

export const isRoleCondition = (value: unknown): value is RoleCondition => typeof value === "string" && Object.hasOwn(ROLE_CONDITIONS, value)

export const MAX_ROLE_CHANGES_PER_RUN = 25

const REASON = "LSR website: role sync"

export type LinkedMember = { userId: string; displayName: string; discordUserId: string; siteRoles: string[] }

/** Members who linked Discord: not deleted accounts, never anyone whose Discord data was purged */
export async function linkedMembers(): Promise<LinkedMember[]> {
  const [users, purged] = await Promise.all([
    prisma.user.findMany({
      where: { discordUserId: { not: null }, status: { not: "deleted" } },
      select: { id: true, displayName: true, discordUserId: true, roles: { select: { role: { select: { key: true } } } } },
    }),
    prismaDiscordStore.purgedAuthors(),
  ])
  return users
    .filter((u): u is typeof u & { discordUserId: string } => Boolean(u.discordUserId) && !purged.has(u.discordUserId!))
    .map((u) => ({ userId: u.id, displayName: u.displayName, discordUserId: u.discordUserId, siteRoles: u.roles.map((r) => r.role.key) }))
}

/** Who meets a condition now, by user id; null when it can't be told (no open LSC season), so nothing changes */
export async function qualifying(condition: RoleCondition, members: LinkedMember[], now = new Date()): Promise<Set<string> | null> {
  const withRole = (...keys: string[]) => new Set(members.filter((m) => m.siteRoles.some((r) => keys.includes(r))).map((m) => m.userId))
  switch (condition) {
    case "linked":
      return new Set(members.map((m) => m.userId))
    case "officer":
      return withRole("officer", "admin")
    case "lsc_driver":
      return withRole("lsc_driver")
    case "collegiate_driver":
      return withRole("collegiate_driver")
    case "lsc_entered": {
      const season = await resolveLeagueSeason(DEFAULT_LEAGUE, undefined, now)
      if (!season.ok || !season.open) return null
      const roster = await listSeasonEntrants(season.season.id)
      if (!roster) return null
      return new Set(roster.entrants.filter((e) => e.status === "paid" || e.status === "manual").map((e) => e.user.id))
    }
  }
}

/** The bot's standing among the server's roles, read live: every role, and the bot's highest position */
export async function readRoles(client: DiscordClient, writer: DiscordWriter, signal?: AbortSignal): Promise<{ roles: DiscordRole[]; botTop: number; botRoleIds: string[]; mentionEveryone: boolean }> {
  const [roles, me] = await Promise.all([writer.roles(signal), client.botUser(signal)])
  const bot = await writer.member(me.id, signal)
  const standing = botStanding(roles, bot.roles)
  return { roles, botTop: standing.top, botRoleIds: bot.roles, mentionEveryone: standing.mentionEveryone }
}

/** Everything role sync checks a role against, read live: the roles, the bot's place, @everyone's permissions and the channels' overwrites */
export async function readRoleSafety(client: DiscordClient, writer: DiscordWriter, signal?: AbortSignal): Promise<RoleSafety & { roles: DiscordRole[] }> {
  const [live, channels] = await Promise.all([readRoles(client, writer, signal), writer.channelPermissions(signal)])
  const everyone = live.roles.find((r) => r.id === writer.guildId)
  return { roles: live.roles, botTop: live.botTop, guildId: writer.guildId, everyonePermissions: everyone?.permissions ?? null, channels }
}

export type RoleSyncRun = { rules: number; added: number; removed: number; refused: number; skipped: number; waiting: number }

/** One role sync run over the switched-on rules */
export async function runRoleSync({ client, writer }: { client: DiscordClient; writer: DiscordWriter }, ctx: { now: Date; log: (line: string) => void; signal?: AbortSignal }): Promise<RoleSyncRun> {
  const run: RoleSyncRun = { rules: 0, added: 0, removed: 0, refused: 0, skipped: 0, waiting: 0 }
  const rules = await prisma.discordRoleRule.findMany({ where: { enabled: true }, orderBy: { roleId: "asc" } })
  if (!rules.length) return run
  const live = await readRoleSafety(client, writer, ctx.signal)
  const { roles } = live
  const members = await linkedMembers()
  const inServer = await prisma.discordMember.findMany({ where: { id: { in: members.map((m) => m.discordUserId) }, leftAt: null }, select: { id: true, roles: true } })
  const current = new Map(inServer.map((m) => [m.id, [...m.roles]]))
  let changes = 0

  for (const rule of rules) {
    if (ctx.signal?.aborted) break
    const role = roles.find((r) => r.id === rule.roleId)
    const refusal = roleSyncRefusal(role, live)
    if (refusal || !role) {
      run.refused++
      ctx.log(`Refused a rule: ${refusal}`)
      continue
    }
    if (!isRoleCondition(rule.condition)) {
      run.skipped++
      ctx.log(`@${role.name}: unknown condition "${rule.condition}"; skipped.`)
      continue
    }
    const want = await qualifying(rule.condition, members, ctx.now)
    if (!want) {
      run.skipped++
      ctx.log(`@${role.name}: can't tell who meets “${ROLE_CONDITIONS[rule.condition].label}” right now (no open season); nothing changed.`)
      continue
    }
    run.rules++
    for (const member of members) {
      const holds = current.get(member.discordUserId)
      // Not in the server, or the member sync hasn't seen them yet
      if (!holds) continue
      const should = want.has(member.userId)
      if (should === holds.includes(role.id)) continue
      if (changes >= MAX_ROLE_CHANGES_PER_RUN || ctx.signal?.aborted) {
        run.waiting++
        continue
      }
      try {
        if (should) await writer.addRole(member.discordUserId, role.id, REASON, ctx.signal)
        else await writer.removeRole(member.discordUserId, role.id, REASON, ctx.signal)
      } catch (error) {
        if (error instanceof DiscordApiError && error.code === DISCORD_ERROR.unknownMember) {
          current.delete(member.discordUserId)
          continue
        }
        if (error instanceof DiscordApiError && error.code === DISCORD_ERROR.missingPermissions) {
          run.refused++
          ctx.log(`@${role.name}: Discord refused the change (Missing Permissions); the role must sit below the bot's own.`)
          break
        }
        throw error
      }
      changes++
      const next = should ? [...holds, role.id].sort() : holds.filter((r) => r !== role.id)
      current.set(member.discordUserId, next)
      await prisma.discordMember.updateMany({ where: { id: member.discordUserId }, data: { roles: next } })
      if (should) run.added++
      else run.removed++
      const condition = ROLE_CONDITIONS[rule.condition].label
      await createAuditLog({
        actorUserId: null,
        actionType: should ? "ROLE_ADD" : "ROLE_REMOVE",
        entityType: "DISCORD_ROLE",
        entityId: role.id,
        targetUserId: member.userId,
        summary: should ? `Role sync gave ${member.displayName} the Discord role @${role.name} (${condition})` : `Role sync took the Discord role @${role.name} from ${member.displayName} (no longer: ${condition})`,
        metadata: { ruleId: rule.id, condition: rule.condition, roleName: role.name },
      })
    }
  }
  return run
}

// ---------------------------------------------------------------------------
// The rules (admins, on Community → Discord)
// ---------------------------------------------------------------------------

type Actor = { userId: string }

async function audit(actor: Actor, actionType: string, rule: DiscordRoleRule, summary: string, extra: { before?: unknown; after?: unknown } = {}) {
  await createAuditLog({ actorUserId: actor.userId, actionType, entityType: "DISCORD_ROLE_RULE", entityId: rule.id, summary, before: extra.before, after: extra.after, metadata: { roleId: rule.roleId, condition: rule.condition } })
}

/** Adds a rule, refusing an unsafe role (checked against the live roles) and a role that already has one */
export async function createRoleRule(input: { roleId: string; condition: string; enabled: boolean }, actor: Actor, live: RoleSafety & { roles: DiscordRole[] }): Promise<{ ok: true; rule: DiscordRoleRule } | { ok: false; error: string }> {
  if (!isRoleCondition(input.condition)) return { ok: false, error: "Pick a condition from the list." }
  const role = live.roles.find((r) => r.id === input.roleId)
  const refusal = roleSyncRefusal(role, live)
  if (refusal || !role) return { ok: false, error: refusal ?? "Pick a role." }
  if (await prisma.discordRoleRule.count({ where: { roleId: role.id } })) return { ok: false, error: `@${role.name} already has a rule. Change or delete that one.` }
  const rule = await prisma.discordRoleRule.create({ data: { roleId: role.id, condition: input.condition, enabled: input.enabled, createdById: actor.userId } })
  await audit(actor, "CREATE", rule, `Added the role sync rule: @${role.name} for ${ROLE_CONDITIONS[input.condition].label}${input.enabled ? " (on)" : " (off)"}`, { after: { roleId: role.id, roleName: role.name, condition: input.condition, enabled: input.enabled } })
  return { ok: true, rule }
}

export async function setRoleRuleEnabled(id: string, enabled: boolean, actor: Actor, roleName?: string): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const rule = await prisma.discordRoleRule.findUnique({ where: { id } })
  if (!rule) return { ok: false, error: "That rule no longer exists. Reload the page." }
  if (rule.enabled === enabled) return { ok: true, changed: false }
  const updated = await prisma.discordRoleRule.update({ where: { id }, data: { enabled } })
  await audit(actor, enabled ? "ENABLE" : "DISABLE", updated, `${enabled ? "Switched on" : "Switched off"} role sync for @${roleName ?? rule.roleId}`, { before: { enabled: rule.enabled }, after: { enabled } })
  return { ok: true, changed: true }
}

/** Deletes a rule. Roles it already handed out stay; nobody loses one because the rule went */
export async function deleteRoleRule(id: string, actor: Actor, roleName?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const rule = await prisma.discordRoleRule.findUnique({ where: { id } })
  if (!rule) return { ok: false, error: "That rule no longer exists. Reload the page." }
  await prisma.discordRoleRule.delete({ where: { id } })
  await audit(actor, "DELETE", rule, `Deleted the role sync rule for @${roleName ?? rule.roleId}`, { before: { roleId: rule.roleId, condition: rule.condition, enabled: rule.enabled } })
  return { ok: true }
}
