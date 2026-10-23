import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { DISCORD_ERROR, DiscordApiError } from "@/server/connectors/discord/client"
import { isSnowflake } from "@/server/connectors/discord/snowflake"
import { prismaDiscordStore, purgedFrom, PURGED_SETTING } from "@/server/connectors/discord/store"
import { DISCORD_WRITE_ERROR, type DiscordWriter } from "@/server/connectors/discord/write"
import { discordPostingForPage, NOT_CONNECTED } from "./connection"

/**
 * Taking back the roles role sync gave (design §12.1) when an account leaves its reach: the member unlinks
 * it (on their profile, or by deleting their site account) or an admin deletes its Discord data. Role sync
 * only looks at linked members, so without this the roles would stay for good, and a role that opens a
 * private channel would keep it open.
 * - The roles of the switched-on rules that the account holds now (read live from Discord). Members who
 *   never linked are never touched, so roles Discord's moderators hand out stay theirs.
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
 * Queues an account whose link is going (pass the unlink's transaction). Only while a role sync rule is
 * on, and never an account on the purged list. Whether it was queued
 */
export async function queueRoleTakeBack(discordUserId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
  if (!isSnowflake(discordUserId)) return false
  return inTransaction(tx, async (db) => {
    if (!(await db.discordRoleRule.count({ where: { enabled: true } }))) return false
    if (purgedFrom((await db.systemSetting.findUnique({ where: { key: PURGED_SETTING } }))?.value).has(discordUserId)) return false
    await changeQueue(db, (accounts) => [...accounts, discordUserId])
    return true
  })
}

/** How many unlinked accounts wait to have their roles taken back, for the role sync panel */
export async function waitingTakeBacks(): Promise<number> {
  return readQueue((await prisma.systemSetting.findUnique({ where: { key: TAKEBACK_SETTING } }))?.value).length
}

export type TakeBackResult = { status: "done"; removed: string[] } | { status: "failed"; removed: string[]; error: string }

/**
 * Takes the switched-on rules' roles from one Discord account, as it holds them now. Done when it holds
 * none of them any more (or isn't in the server); failed when Discord couldn't be asked or refused, with
 * what it took before that. `removed` names the roles ("@LSC Driver")
 */
export async function takeBackSyncedRoles(writer: DiscordWriter, discordUserId: string, ctx: { why: keyof typeof WHY; targetUserId: string | null; signal?: AbortSignal }): Promise<TakeBackResult> {
  const removed: string[] = []
  try {
    const rules = await prisma.discordRoleRule.findMany({ where: { enabled: true }, orderBy: { roleId: "asc" }, select: { id: true, roleId: true, condition: true } })
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
    const names = new Map((await writer.roles(ctx.signal).catch(() => [])).map((role) => [role.id, role.name]))
    let left = held
    for (const rule of take) {
      try {
        await writer.removeRole(discordUserId, rule.roleId, REASON, ctx.signal)
      } catch (error) {
        // They left the server meanwhile (nothing to take), or the role was deleted
        if (error instanceof DiscordApiError && error.code === DISCORD_ERROR.unknownMember) break
        if (error instanceof DiscordApiError && error.code === DISCORD_WRITE_ERROR.unknownRole) continue
        throw error
      }
      left = left.filter((id) => id !== rule.roleId)
      const name = names.get(rule.roleId) ?? "a role Discord didn't name"
      removed.push(names.has(rule.roleId) ? `@${name}` : name)
      await createAuditLog({
        actorUserId: null,
        actionType: "ROLE_REMOVE",
        entityType: "DISCORD_ROLE",
        entityId: rule.roleId,
        targetUserId: ctx.targetUserId,
        summary: `Role sync took back the Discord role ${removed.at(-1)}: ${WHY[ctx.why]}`,
        metadata: { ruleId: rule.id, condition: rule.condition, roleName: names.get(rule.roleId) ?? null, reason: ctx.why },
      })
    }
    // The stored roles follow (a purged account has no row to update)
    await prisma.discordMember.updateMany({ where: { id: discordUserId }, data: { roles: [...left].sort() } })
    return { status: "done", removed }
  } catch (error) {
    return { status: "failed", removed, error: error instanceof Error ? error.message : String(error) }
  }
}

export type QueuedRun = { accounts: number; removed: number; waiting: number }

/**
 * Takes back the queued accounts' roles (or only `only`'s), at most `maxChanges` roles a run. An account
 * done leaves the queue; one that failed stays for the next run. One linked again is role sync's to look
 * after, and one purged since is dropped (the purge tried it)
 */
export async function runQueuedTakeBacks(writer: DiscordWriter, ctx: { only?: string; targetUserId?: string | null; maxChanges: number; signal?: AbortSignal; log: (line: string) => void }): Promise<QueuedRun> {
  const run: QueuedRun = { accounts: 0, removed: 0, waiting: 0 }
  const queued = readQueue((await prisma.systemSetting.findUnique({ where: { key: TAKEBACK_SETTING } }))?.value).filter((id) => !ctx.only || id === ctx.only)
  if (!queued.length) return run
  const [linked, purged] = await Promise.all([prisma.user.findMany({ where: { discordUserId: { in: queued } }, select: { discordUserId: true } }), prismaDiscordStore.purgedAuthors()])
  const relinked = new Set(linked.map((u) => u.discordUserId))
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
    const result = await takeBackSyncedRoles(writer, id, { why: ctx.only ? "unlinked" : "queued", targetUserId: ctx.targetUserId ?? null, signal: ctx.signal })
    run.removed += result.removed.length
    if (result.status === "done") {
      finished.push(id)
      run.accounts++
      if (result.removed.length) ctx.log(`Took back ${result.removed.join(", ")} from an account that was unlinked.`)
    } else {
      run.waiting++
      ctx.log(`Couldn't take back the synced roles of an account that was unlinked (${result.error}); it waits for the next run.`)
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
    await runQueuedTakeBacks(posting.writer, { only: discordUserId, targetUserId: userId, maxChanges: Infinity, signal: AbortSignal.timeout(NOW_BUDGET_MS), log: () => {} })
  } catch (error) {
    console.error("[discord] Couldn't take back synced roles after an unlink:", error instanceof Error ? error.message : error)
  }
}

/** What the admin is told after a purge: the roles taken back, or why they couldn't be (null: there was nothing to take back) */
export type PurgeRoles = { taken: string[]; error: string | null } | null

/**
 * Right after a purge: takes back the synced roles of an account that was linked or waiting in the queue,
 * and drops it from the queue either way (the purge deleted the id, so it's never kept). Never throws:
 * the purge is done, and when this fails the admin removes the roles in Discord
 */
export async function takeBackAfterPurge(discordUserId: string, { wasLinked, targetUserId }: { wasLinked: boolean; targetUserId: string | null }): Promise<PurgeRoles> {
  try {
    const { before } = await prisma.$transaction((tx) => changeQueue(tx, (accounts) => accounts.filter((id) => id !== discordUserId)))
    if (!wasLinked && !before.includes(discordUserId)) return null
    if (!(await prisma.discordRoleRule.count({ where: { enabled: true } }))) return null
    const posting = await discordPostingForPage()
    if (!posting) return { taken: [], error: NOT_CONNECTED }
    const result = await takeBackSyncedRoles(posting.writer, discordUserId, { why: "purged", targetUserId, signal: AbortSignal.timeout(NOW_BUDGET_MS) })
    return { taken: result.removed, error: result.status === "failed" ? result.error : null }
  } catch (error) {
    return { taken: [], error: error instanceof Error ? error.message : String(error) }
  }
}
