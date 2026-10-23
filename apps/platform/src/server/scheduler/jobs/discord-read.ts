import { Prisma } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { discordConnector, DISCORD_CONNECTOR } from "@/server/connectors/discord/connector"
import { isSnowflake, snowflakeTime } from "@/server/connectors/discord/snowflake"
import { prismaDiscordStore } from "@/server/connectors/discord/store"
import { DEFAULT_BACKFILL_DAYS, rescan, syncMembers, syncMessages, type ChannelProblem, type GoneChannel, type SyncContext } from "@/server/connectors/discord/sync"
import { recordConnectorError, recordConnectorSync } from "@/server/connectors/state"
import type { JobContext, JobKind, JobResult } from "../types"

/**
 * Scheduled job kinds from the discord-read track (design §6, §12.1). The three syncs skip while the
 * Discord connector is off or not set up; the prune runs regardless, since keeping metadata past 12
 * months is what it prevents. Each sync records its outcome on the connector (Connections page).
 */

const DAY_MS = 86_400_000
/** Metadata older than this is deleted (design §12.1) */
export const DISCORD_RETENTION_DAYS = 365

const SKIPPED: JobResult = { summary: "Discord isn't connected (switched off or not set up)", status: "skipped" }

const syncConfig = z.object({ backfillDays: z.number().int().min(1).max(DISCORD_RETENTION_DAYS).optional() }).passthrough()

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** A sync with the connector's client, recording how it went: a sync that works stamps it, a failure is its last error */
async function withDiscord(ctx: JobContext, run: (sync: SyncContext) => Promise<{ result: JobResult; problems?: ChannelProblem[] }>): Promise<JobResult> {
  const client = await discordConnector.client()
  if (!client) return SKIPPED
  let outcome: Awaited<ReturnType<typeof run>>
  try {
    outcome = await run({ client, store: prismaDiscordStore, signal: ctx.signal, deadline: ctx.deadline, log: ctx.log })
  } catch (error) {
    await recordConnectorError(DISCORD_CONNECTOR, error)
    throw error
  }
  await recordConnectorSync(DISCORD_CONNECTOR)
  const problems = outcome.problems ?? []
  if (!problems.length) return outcome.result
  // What did work is saved; the run fails so the channels that didn't show on the Jobs and Connections pages
  const error = new Error(`${outcome.result.summary}. Couldn't read ${problems.map((p) => `${p.channel} (${p.error})`).join("; ")}`)
  await recordConnectorError(DISCORD_CONNECTOR, error)
  throw error
}

/**
 * Opted-in channels Discord deleted, which the run switched off: each goes in the audit log (as the
 * system, like the switch an admin flips) and the run's log, and the summary says so
 */
async function recordGone(ctx: JobContext, gone: GoneChannel[], threadsGone: number): Promise<string> {
  for (const channel of gone) {
    const line = `#${channel.name} no longer exists in Discord: switched it off and deleted ${plural(channel.messages, "stored message record")}`
    ctx.log(line)
    await createAuditLog({
      actorUserId: null,
      actionType: "DISABLE",
      entityType: "DISCORD_CHANNEL",
      entityId: channel.id,
      summary: line,
      before: { synced: true },
      after: { synced: false },
      metadata: { deleted: channel.messages, deletedInDiscord: true },
    })
  }
  if (threadsGone) ctx.log(`${plural(threadsGone, "thread")} deleted in Discord, dropped with ${threadsGone === 1 ? "its" : "their"} messages.`)
  const parts = [gone.length && `${gone.map((c) => `#${c.name}`).join(", ")} deleted in Discord (switched off)`, threadsGone && `${plural(threadsGone, "thread")} deleted in Discord`].filter(Boolean)
  return parts.length ? `; ${parts.join(", ")}` : ""
}

export const discordSyncJob: JobKind = {
  kind: "discord.sync",
  label: "Discord sync",
  description: `Reads new messages in the Discord channels admins opted in (and their threads): who posted when, length, attachments, replies and poll counts, never the text. A channel's first run reads back ${DEFAULT_BACKFILL_DAYS} days (config backfillDays). Then rebuilds the daily stats.`,
  defaultSchedule: "*/10 * * * *",
  budgetMs: 110_000,
  run(ctx) {
    const config = syncConfig.safeParse(ctx.config ?? {})
    const backfillDays = config.success ? config.data.backfillDays : undefined
    return withDiscord(ctx, async (sync) => {
      const result = await syncMessages(sync, { backfillDays })
      if (result.unfinished) ctx.log(`${plural(result.unfinished, "channel")} didn't finish; the next run picks up where this one stopped.`)
      const gone = await recordGone(ctx, result.gone, result.threadsGone)
      const where = [plural(result.channels, "channel"), ...(result.threads ? [plural(result.threads, "thread")] : [])].join(" and ")
      return {
        result: { summary: `Synced ${where}: ${plural(result.added, "new message")}${gone}`, counts: { channels: result.channels, threads: result.threads, messages: result.added, days: result.days } },
        problems: result.problems,
      }
    })
  },
}

export const discordRescanJob: JobKind = {
  kind: "discord.rescan",
  label: "Discord edits and deletions",
  description:
    "Reads the last 7 days of each opted-in Discord channel again: marks deleted messages, updates edits and poll counts, and refreshes older polls until they close. Discord has no feed of deletions without a bot online, so this is how they're noticed.",
  defaultSchedule: "7 * * * *",
  budgetMs: 110_000,
  run(ctx) {
    return withDiscord(ctx, async (sync) => {
      const result = await rescan(sync)
      if (result.unfinished) ctx.log(`${plural(result.unfinished, "channel")} didn't finish; the next run picks up where this one stopped.`)
      const gone = await recordGone(ctx, result.gone, result.threadsGone)
      const changes = [result.deleted && `${result.deleted} deleted`, result.updated && `${result.updated} updated`, result.added && `${result.added} added`, result.polls && plural(result.polls, "older poll") + " refreshed"].filter(Boolean)
      return {
        result: {
          summary: `Read ${plural(result.channels, "channel")} again: ${changes.length ? changes.join(", ") : "no changes"}${gone}`,
          counts: { channels: result.channels, deleted: result.deleted, updated: result.updated, added: result.added, polls: result.polls },
        },
        problems: result.problems,
      }
    })
  },
}

export const discordMembersJob: JobKind = {
  kind: "discord.members",
  label: "Discord members",
  description: "Reads the club server's member list (needs the Server Members intent): joins, leaves and roles, and today's member count. Bots aren't counted.",
  defaultSchedule: "17 * * * *",
  budgetMs: 60_000,
  run(ctx) {
    return withDiscord(ctx, async (sync) => {
      const result = await syncMembers(sync)
      if (!result.complete) ctx.log("The member list didn't finish, so nobody was marked as having left; the next run reads it all again.")
      return {
        result: {
          summary: `${plural(result.memberCount, "member")}; today ${result.joinedToday} joined, ${result.leftToday} left`,
          counts: { members: result.memberCount, new: result.joined, left: result.left },
        },
      }
    })
  },
}

export const discordPruneJob: JobKind = {
  kind: "discord.prune",
  label: "Prune Discord metadata",
  description: `Deletes Discord message metadata older than ${DISCORD_RETENTION_DAYS} days, members who left more than ${DISCORD_RETENTION_DAYS} days ago, and threads not read for ${DISCORD_RETENTION_DAYS} days. Also deletes anything left from channels that aren't opted in. The daily totals of opted-in channels (counts only) stay. Runs even while Discord is switched off.`,
  defaultSchedule: "40 4 * * *",
  budgetMs: 60_000,
  async run() {
    const pruned = await pruneDiscord(prisma, new Date(Date.now() - DISCORD_RETENTION_DAYS * DAY_MS))
    const done = [pruned.messages && plural(pruned.messages, "message"), pruned.members && plural(pruned.members, "former member")].filter(Boolean)
    const leftover = pruned.offThreads + pruned.offMessages + pruned.offStats
    const summary = [
      done.length ? `Deleted ${done.join(" and ")} older than ${DISCORD_RETENTION_DAYS} days` : `Nothing older than ${DISCORD_RETENTION_DAYS} days`,
      pruned.idleThreads && `${plural(pruned.idleThreads, "thread")} not read for ${DISCORD_RETENTION_DAYS} days`,
      leftover && `${plural(leftover, "leftover record")} from channels that aren't opted in`,
    ].filter(Boolean)
    return { summary: summary.join("; "), counts: { messages: pruned.messages, members: pruned.members, threads: pruned.idleThreads + pruned.offThreads, leftover: pruned.offMessages + pruned.offStats } }
  },
}

/** When a thread was made, from its id (0 for an id that isn't a snowflake) */
const snowflakeMs = (id: string) => (isSnowflake(id) ? snowflakeTime(id).getTime() : 0)

/**
 * The prune's deletions, given everything older than `cutoff` goes. Takes a client so
 * scripts/check-discord-read.ts can run it in a transaction it rolls back
 */
export async function pruneDiscord(db: Prisma.TransactionClient, cutoff: Date) {
  // Threads (their titles are members' words) in channels that aren't opted in. Switching a channel off deletes them; this catches one a sync saved just then
  const offThreads = await db.$executeRaw(Prisma.sql`
    DELETE FROM "DiscordChannel" t
    WHERE t."parentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DiscordChannel" p WHERE p.id = t."parentId" AND p.synced)`)
  // Threads not read for the retention period (one never read, by when it was made)
  const idle = await db.discordChannel.findMany({ where: { parentId: { not: null }, OR: [{ lastSyncedAt: { lt: cutoff } }, { lastSyncedAt: null }] }, select: { id: true, lastSyncedAt: true } })
  const idleIds = idle.filter((t) => t.lastSyncedAt || snowflakeMs(t.id) < cutoff.getTime()).map((t) => t.id)
  const idleThreads = idleIds.length ? (await db.discordChannel.deleteMany({ where: { id: { in: idleIds }, OR: [{ lastSyncedAt: { lt: cutoff } }, { lastSyncedAt: null }] } })).count : 0
  // Message records and daily totals from channels that aren't opted in (or no longer exist), one statement each, so a channel opted in meanwhile keeps what it synced
  const offMessages = await db.$executeRaw(Prisma.sql`
    DELETE FROM "DiscordMessage" m
    WHERE NOT EXISTS (
      SELECT 1 FROM "DiscordChannel" c JOIN "DiscordChannel" o ON o.id = coalesce(c."parentId", c.id)
      WHERE c.id = m."channelId" AND o.synced)`)
  const offStats = await db.$executeRaw(Prisma.sql`
    DELETE FROM "DiscordDailyStat" s
    WHERE NOT EXISTS (SELECT 1 FROM "DiscordChannel" c WHERE c.id = s."channelId" AND c."parentId" IS NULL AND c.synced)`)
  const messages = (await db.discordMessage.deleteMany({ where: { createdAt: { lt: cutoff } } })).count
  const members = (await db.discordMember.deleteMany({ where: { leftAt: { lt: cutoff } } })).count
  return { messages, members, idleThreads, offThreads, offMessages, offStats }
}

/** Scheduled job kinds from the discord-read track (design §6). The registry joins every track's jobs in a fixed order */
export const JOBS: JobKind[] = [discordSyncJob, discordRescanJob, discordMembersJob, discordPruneJob]
