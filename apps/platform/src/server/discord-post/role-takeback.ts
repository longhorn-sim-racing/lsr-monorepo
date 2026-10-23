import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { DISCORD_ERROR, DiscordApiError } from "@/server/connectors/discord/client"
import { isSnowflake } from "@/server/connectors/discord/snowflake"
import { prismaDiscordStore, purgedFrom, PURGED_SETTING } from "@/server/connectors/discord/store"
import { botStanding, DISCORD_WRITE_ERROR, type DiscordRole } from "@/server/connectors/discord/write"
import { discordPostingForPage, NOT_CONNECTED, type DiscordPosting } from "./connection"

/**
 * Taking back the roles role sync gave (design §12.1) when an account leaves its reach: the member unlinks
 * it (on their profile, or by deleting their site account) or an admin deletes its Discord data. Role sync
 * only looks at linked members, so without this the roles would stay for good, and a role that opens a
 * private channel would keep it open.
 * - The roles of every role sync rule, switched on or off, that the account holds now (read live from
 *   Discord): role sync handed them out while the rule was on, and nothing reaches the account once a
 *   paused rule is switched back on. Members who never linked are never touched, so roles Discord's
 *   moderators hand out stay theirs.
 * - One role that can't be taken (it sits above the bot's own role, or Discord refuses) never stops the
 *   others; the account stays queued until every one is gone, so it's taken once an admin fixes the role.
 * - An unlink queues the account in its own transaction, then tries right away (a short budget); what's
 *   left goes first in the next role sync run. The queue is a SystemSetting holding Discord ids only.
 * - A purge is never queued (that would keep the id the purge deleted): it's tried right away, and the
 *   admin is told when it couldn't be done.
 * - Audited like role sync's own changes (ROLE_REMOVE, DISCORD_ROLE, the system as actor), with no Discord id.
 */

/** Accounts still waiting: `{ "accounts": [<Discord user id>, …] }`. Revoked from Jack like every SystemSetting; pages show only the count */
export const TAKEBACK_SETTING = "discord_role_takeback"

const LOCK = "lsr:discord_role_takeback"

const REASON = "LSR website: role sync (account unlinked)"

/** How long an unlink or a purge waits on Discord, so a slow Discord never holds up the member's page */
const NOW_BUDGET_MS = 8_000

/** Why it was taken back, for the audit entry (an account deletion unlinks first) */
const WHY = {
  unlinked: "their Discord account was unlinked from the site",
  queued: "the account was unlinked from the site (taken back by the next run)",
  purged: "their Discord data was deleted on request",
} as const

function readQueue(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "{}") as { accounts?: unknown }
    return Array.isArray(parsed.accounts) ? parsed.accounts.filter(isSnowflake) : []
  } catch {
    return []
  }
}

/** Changes the queue under its lock, so an unlink and a run changing it at once can't lose an account */
async function changeQueue(tx: Prisma.TransactionClient, change: (accounts: string[]) => string[]): Promise<{ before: string[]; after: string[] }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`
  const before = readQueue((await tx.systemSetting.findUnique({ where: { key: TAKEBACK_SETTING } }))?.value)
  const after = [...new Set(change(before))]
  if (after.length === before.length && after.every((id, i) => id === before[i])) return { before, after }
  if (!after.length) await tx.systemSetting.deleteMany({ where: { key: TAKEBACK_SETTING } })
  else {
    const value = JSON.stringify({ accounts: after })
    await tx.systemSetting.upsert({ where: { key: TAKEBACK_SETTING }, update: { value }, create: { key: TAKEBACK_SETTING, value } })
  }
  return { before, after }
}

const inTransaction = <T>(tx: Prisma.TransactionClient | undefined, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => (tx ? run(tx) : prisma.$transaction(run))

/**
 * Queues an account whose link is going (pass the unlink's transaction). Only while a role sync rule
 * exists (on or off), and never an account on the purged list. Whether it was queued
 */
export async function queueRoleTakeBack(discordUserId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
  if (!isSnowflake(discordUserId)) return false
  return inTransaction(tx, async (db) => {
    if (!(await db.discordRoleRule.count())) return false
    if (purgedFrom((await db.systemSetting.findUnique({ where: { key: PURGED_SETTING } }))?.value).has(discordUserId)) return false
    await changeQueue(db, (accounts) => [...accounts, discordUserId])
    return true
  })
}

/** How many unlinked accounts wait to have their roles taken back, for the role sync panel */
export async function waitingTakeBacks(): Promise<number> {
  return readQueue((await prisma.systemSetting.findUnique({ where: { key: TAKEBACK_SETTING } }))?.value).length
}

/** The server's roles and the bot's highest position (null when Discord didn't say: then every role is tried and Discord decides) */
type Standing = { roles: DiscordRole[]; botTop: number | null } | null

/** Reads the standing at most once, when an account first needs it, and shares it with the rest of the run */
function standingOnce({ client, writer }: DiscordPosting, signal?: AbortSignal): () => Promise<Standing> {
  const standing = async (): Promise<Standing> => {
    const roles = await writer.roles(signal).catch(() => null)
    if (!roles) return null
    try {
      const bot = await writer.member((await client.botUser(signal)).id, signal)
      return { roles, botTop: botStanding(roles, bot.roles).top }
    } catch {
      return { roles, botTop: null }
    }
  }
  let read: Promise<Standing> | undefined
  return () => (read ??= standing())
}

/**
 * `removed` and `left` name the roles ("@LSC Driver"): taken, and still held because they couldn't be.
 * `error` says why, one reason per role left (or why Discord couldn't be asked at all, with `left` empty)
 */
export type TakeBackResult = { status: "done"; removed: string[] } | { status: "failed"; removed: string[]; left: string[]; error: string }

/**
 * Takes every role sync rule's role (on or off) from one Discord account, as it holds them now. Done when
 * it holds none of them any more (or isn't in the server); failed when Discord couldn't be asked, or some
 * role couldn't be taken. A role at or above the bot's own is skipped without asking (Discord would refuse),
 * and a role Discord refuses never stops the ones after it
 */
export async function takeBackSyncedRoles(posting: DiscordPosting, discordUserId: string, ctx: { why: keyof typeof WHY; targetUserId: string | null; signal?: AbortSignal; standing?: () => Promise<Standing> }): Promise<TakeBackResult> {
  const { writer } = posting
  const removed: string[] = []
  try {
    const rules = await prisma.discordRoleRule.findMany({ orderBy: { roleId: "asc" }, select: { id: true, roleId: true, condition: true } })
    if (!rules.length) return { status: "done", removed }
    let held: string[]
    try {
      held = (await writer.member(discordUserId, ctx.signal)).roles
    } catch (error) {
      if (error instanceof DiscordApiError && error.code === DISCORD_ERROR.unknownMember) return { status: "done", removed }
      throw error
    }
    const take = rules.filter((rule) => held.includes(rule.roleId))
    if (!take.length) return { status: "done", removed }
    const standing = await (ctx.standing ?? standingOnce(posting, ctx.signal))()
    const left: { role: string; why: string }[] = []
    let holds = held
    for (const rule of take) {
      const known = standing?.roles.find((r) => r.id === rule.roleId)
      const role = known ? `@${known.name}` : "a role Discord didn't name"
      if (known && standing?.botTop != null && known.position >= standing.botTop) {
        left.push({ role, why: `${role} sits at or above the bot's own role, so Discord won't let the bot take it (move the bot's role above it in Server Settings → Roles)` })
        continue
      }
      try {
        await writer.removeRole(discordUserId, rule.roleId, REASON, ctx.signal)
      } catch (error) {
        // They left the server meanwhile (Discord took every role with them)
        if (error instanceof DiscordApiError && error.code === DISCORD_ERROR.unknownMember) return { status: "done", removed }
        // The role was deleted: nobody holds it
        if (error instanceof DiscordApiError && error.code === DISCORD_WRITE_ERROR.unknownRole) continue
        const refused = error instanceof DiscordApiError && error.code === DISCORD_ERROR.missingPermissions
        left.push({ role, why: refused ? `Discord refused ${role} (Missing Permissions: the bot needs Manage Roles, and the role must sit below the bot's own)` : `${role}: ${error instanceof Error ? error.message : String(error)}` })
        continue
      }
      holds = holds.filter((id) => id !== rule.roleId)
      removed.push(role)
      await createAuditLog({
        actorUserId: null,
        actionType: "ROLE_REMOVE",
        entityType: "DISCORD_ROLE",
        entityId: rule.roleId,
        targetUserId: ctx.targetUserId,
        summary: `Role sync took back the Discord role ${role}: ${WHY[ctx.why]}`,
        metadata: { ruleId: rule.id, condition: rule.condition, roleName: known?.name ?? null, reason: ctx.why },
      })
    }
    // The stored roles follow (a purged account has no row to update)
    if (removed.length) await prisma.discordMember.updateMany({ where: { id: discordUserId }, data: { roles: [...holds].sort() } })
    if (left.length) return { status: "failed", removed, left: left.map((l) => l.role), error: left.map((l) => l.why).join("; ") }
    return { status: "done", removed }
  } catch (error) {
    return { status: "failed", removed, left: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export type QueuedRun = { accounts: number; removed: number; waiting: number }

/**
 * Takes back the queued accounts' roles (or only `only`'s), at most `maxChanges` roles a run. An account
 * done leaves the queue; one still holding a role that couldn't be taken stays for the next run (its other
 * roles are taken anyway). One linked again is role sync's to look after, and one purged since is dropped
 * (the purge tried it)
 */
export async function runQueuedTakeBacks(posting: DiscordPosting, ctx: { only?: string; targetUserId?: string | null; maxChanges: number; signal?: AbortSignal; log: (line: string) => void }): Promise<QueuedRun> {
  const run: QueuedRun = { accounts: 0, removed: 0, waiting: 0 }
  const queued = readQueue((await prisma.systemSetting.findUnique({ where: { key: TAKEBACK_SETTING } }))?.value).filter((id) => !ctx.only || id === ctx.only)
  if (!queued.length) return run
  const [linked, purged] = await Promise.all([prisma.user.findMany({ where: { discordUserId: { in: queued } }, select: { discordUserId: true } }), prismaDiscordStore.purgedAuthors()])
  const relinked = new Set(linked.map((u) => u.discordUserId))
  const standing = standingOnce(posting, ctx.signal)
  const finished: string[] = []
  for (const id of queued) {
    if (relinked.has(id) || purged.has(id)) {
      finished.push(id)
      continue
    }
    if (run.removed >= ctx.maxChanges || ctx.signal?.aborted) {
      run.waiting++
      continue
    }
    const result = await takeBackSyncedRoles(posting, id, { why: ctx.only ? "unlinked" : "queued", targetUserId: ctx.targetUserId ?? null, signal: ctx.signal, standing })
    run.removed += result.removed.length
    if (result.removed.length) ctx.log(`Took back ${result.removed.join(", ")} from an account that was unlinked.`)
    if (result.status === "done") {
      finished.push(id)
      run.accounts++
    } else {
      run.waiting++
      ctx.log(`Couldn't take back ${result.left.length ? result.left.join(", ") : "the synced roles"} from an account that was unlinked (${result.error}); it stays queued and the next run tries again.`)
    }
  }
  if (finished.length) await prisma.$transaction((tx) => changeQueue(tx, (accounts) => accounts.filter((id) => !finished.includes(id))))
  return run
}

/** Right after an unlink: the account's take-back now, within a short budget; what's left waits in the queue for the next role sync run. Never throws */
export async function takeBackAfterUnlink(discordUserId: string, userId: string): Promise<void> {
  try {
    const posting = await discordPostingForPage()
    if (!posting) return
    await runQueuedTakeBacks(posting, { only: discordUserId, targetUserId: userId, maxChanges: Infinity, signal: AbortSignal.timeout(NOW_BUDGET_MS), log: () => {} })
  } catch (error) {
    console.error("[discord] Couldn't take back synced roles after an unlink:", error instanceof Error ? error.message : error)
  }
}

/** What the admin is told after a purge: the roles taken back, and those left with why (null: there was nothing to take back) */
export type PurgeRoles = { taken: string[]; left: string[]; error: string | null } | null

/**
 * Right after a purge: takes back the synced roles of an account that was linked or waiting in the queue,
 * and drops it from the queue either way (the purge deleted the id, so it's never kept). Never throws:
 * the purge is done, and when this fails the admin removes the roles in Discord
 */
export async function takeBackAfterPurge(discordUserId: string, { wasLinked, targetUserId }: { wasLinked: boolean; targetUserId: string | null }): Promise<PurgeRoles> {
  try {
    const { before } = await prisma.$transaction((tx) => changeQueue(tx, (accounts) => accounts.filter((id) => id !== discordUserId)))
    if (!wasLinked && !before.includes(discordUserId)) return null
    if (!(await prisma.discordRoleRule.count())) return null
    const posting = await discordPostingForPage()
    if (!posting) return { taken: [], left: [], error: NOT_CONNECTED }
    const result = await takeBackSyncedRoles(posting, discordUserId, { why: "purged", targetUserId, signal: AbortSignal.timeout(NOW_BUDGET_MS) })
    return result.status === "failed" ? { taken: result.removed, left: result.left, error: result.error } : { taken: result.removed, left: [], error: null }
  } catch (error) {
    return { taken: [], left: [], error: error instanceof Error ? error.message : String(error) }
  }
}
