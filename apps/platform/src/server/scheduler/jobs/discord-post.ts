import { recordConnectorError } from "@/server/connectors/state"
import { DISCORD_CONNECTOR } from "@/server/connectors/discord/connector"
import { postingChannelIds } from "@/server/discord-post/channels"
import { discordPosting } from "@/server/discord-post/connection"
import { runEventMirror } from "@/server/discord-post/event-mirror"
import { sendDuePosts } from "@/server/discord-post/outbox"
import { duePostProblem } from "@/server/discord-post/post-check"
import { runRoleSync } from "@/server/discord-post/role-sync"
import { runDiscordRules } from "@/server/discord-post/rule-runner"
import type { JobKind, JobResult } from "../types"

/**
 * Scheduled job kinds from the discord-post track (design §6, §12.1). All four skip while the Discord
 * connector is off or not set up (nothing is posted or changed; due posts wait, and are cancelled once
 * they're more than 6 hours late). Rules that post are one dispatcher job (`discord.rules`), which
 * queues posts; `discord.posts` sends them. The event mirror and role sync have their own. Every one is
 * safe to run again: posts are keyed (`dedupeKey`) and claimed before they're sent, the mirror keeps one
 * row per event, and role sync only changes what differs.
 */

const SKIPPED: JobResult = { summary: "Discord isn't connected (switched off or not set up)", status: "skipped" }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A Discord failure also shows on Connections (the connector's last error) */
async function failed(error: unknown): Promise<never> {
  await recordConnectorError(DISCORD_CONNECTOR, error)
  throw error
}

export const discordPostsJob: JobKind = {
  kind: "discord.posts",
  label: "Discord posts",
  description:
    "Sends the Discord posts that are due (standing rules, applied proposals, officers' scheduled posts), at most 10 a run, each with its own nonce so a retry can't post twice. Checks posts a stopped run left sending against the channel, and cancels posts more than 6 hours late.",
  defaultSchedule: "*/2 * * * *",
  budgetMs: 60_000,
  async run(ctx) {
    const posting = await discordPosting()
    if (!posting) return SKIPPED
    const allowed = await postingChannelIds()
    const run = await sendDuePosts(posting.writer, { now: new Date(), deadline: ctx.deadline, signal: ctx.signal, log: ctx.log, check: (post, now) => duePostProblem(post, now, allowed) }).catch(failed)
    const parts = [run.sent && `sent ${run.sent}`, run.failed && `${run.failed} failed`, run.cancelled && `${run.cancelled} cancelled`, run.deferred && `${run.deferred} waiting on a rate limit`, run.confirmed && `${run.confirmed} confirmed after a stopped run`].filter(Boolean)
    return { summary: parts.length ? `Posts: ${parts.join(", ")}` : "No posts due", counts: { sent: run.sent, failed: run.failed, cancelled: run.cancelled, deferred: run.deferred, confirmed: run.confirmed } }
  },
}

export const discordRulesJob: JobKind = {
  kind: "discord.rules",
  label: "Discord standing rules",
  description:
    "Runs the switched-on standing rules (event reminders, new events, results, standings, Twitch live): queues one post per new thing since each rule was switched on (public events only, at most 3 a rule a run), schedules reminders up to 8 days ahead, and cancels reminders for events that moved, were cancelled or unpublished. The posts job sends them.",
  defaultSchedule: "*/5 * * * *",
  budgetMs: 60_000,
  async run(ctx) {
    if (!(await discordPosting())) return SKIPPED
    const run = await runDiscordRules({ now: new Date(), log: ctx.log, signal: ctx.signal })
    if (run.errors.length) throw new Error(`${run.errors.join("; ")}${run.queued ? ` (queued ${plural(run.queued, "post")} from the other rules)` : ""}`)
    const parts = [run.queued && `queued ${plural(run.queued, "post")}`, run.refreshed && `${run.refreshed} updated`, run.cancelled && `${run.cancelled} cancelled`, run.skipped && `${plural(run.skipped, "rule")} skipped`].filter(Boolean)
    return {
      summary: run.rules || run.skipped ? `${plural(run.rules, "rule")}: ${parts.length ? parts.join(", ") : "nothing new"}` : "No standing rules switched on",
      counts: { rules: run.rules, queued: run.queued, refreshed: run.refreshed, cancelled: run.cancelled, skipped: run.skipped },
    }
  },
}

export const discordEventMirrorJob: JobKind = {
  kind: "discord.event-mirror",
  label: "Discord event mirror",
  description:
    "While an event mirror rule is on: adds each upcoming public event (next 60 days) to the club server's Events list, updates it when the event changes, takes it off when the event is cancelled, postponed or unpublished, and reads how many members are interested. At most 10 changes a run.",
  defaultSchedule: "*/15 * * * *",
  budgetMs: 60_000,
  async run(ctx) {
    const posting = await discordPosting()
    if (!posting) return SKIPPED
    const run = await runEventMirror(posting.writer, { now: new Date(), log: ctx.log, signal: ctx.signal }).catch(failed)
    if (run.status === "no-rule") return { summary: "No event mirror rule is switched on", status: "skipped" }
    const parts = [run.created && `${run.created} added`, run.updated && `${run.updated} updated`, run.removed && `${run.removed} removed`, run.gone && `${run.gone} deleted in Discord`, run.counted && `${plural(run.counted, "interested count")} updated`].filter(Boolean)
    return { summary: parts.length ? `Discord events: ${parts.join(", ")}` : "Discord events up to date", counts: { created: run.created, updated: run.updated, removed: run.removed, counted: run.counted } }
  },
}

export const discordRoleSyncJob: JobKind = {
  kind: "discord.role-sync",
  label: "Discord role sync",
  description:
    "Gives linked members the Discord roles their role sync rules say, and takes them away when they stop qualifying. First takes back the roles of every rule (on or off) from unlinked accounts still waiting, because Discord couldn't be reached or refused a role (an unlink, an account deletion or a purge takes them back right away otherwise). Plain roles only (no moderation permissions, below the bot's own role); purged members never; at most 25 changes a run, each in the audit log. Runs after the member sync.",
  defaultSchedule: "27 * * * *",
  budgetMs: 60_000,
  async run(ctx) {
    const posting = await discordPosting()
    if (!posting) return SKIPPED
    const run = await runRoleSync(posting, { now: new Date(), log: ctx.log, signal: ctx.signal }).catch(failed)
    const counts = { added: run.added, removed: run.removed, takenBack: run.takenBack, waiting: run.waiting, refused: run.refused }
    const takeBack = [run.takenBack && `${run.takenBack} taken back from unlinked accounts`, run.waiting && `${run.waiting} waiting for the next run`].filter(Boolean)
    // Queued take-backs still run with no rule on
    if (!run.rules && !run.refused && !run.skipped) return takeBack.length ? { summary: `No role sync rules switched on; ${takeBack.join(", ")}`, counts } : { summary: "No role sync rules switched on" }
    const parts = [`${run.added} added`, `${run.removed} removed`, ...takeBack, run.refused && `${plural(run.refused, "rule")} refused`, run.skipped && `${plural(run.skipped, "rule")} skipped`].filter(Boolean)
    return { summary: `Role sync over ${plural(run.rules, "rule")}: ${parts.join(", ")}`, counts }
  },
}

/** Scheduled job kinds from the discord-post track (design §6). The registry joins every track's jobs in a fixed order */
export const JOBS: JobKind[] = [discordPostsJob, discordRulesJob, discordEventMirrorJob, discordRoleSyncJob]
