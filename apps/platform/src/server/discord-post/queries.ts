import type { DiscordPost, DiscordPostStatus, Prisma } from "@prisma/client"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { prisma } from "@/server/db"
import { FORMER_OFFICER } from "@/server/jack/messages"
import { discordEventUrl, roleSyncRefusal, type DiscordRole, type RoleSafety } from "@/server/connectors/discord/write"
import { postableChannels, postingChannels, type PostingChannel } from "./channels"
import { postUrl, readBody } from "./outbox"
import { isRoleCondition, linkedMembers, qualifying, ROLE_CONDITIONS } from "./role-sync"
import { waitingTakeBacks } from "./role-takeback"
import { describeRule, isRuleKind, readRuleConfig, RULE_INFO } from "./rules"
import { when } from "./time"

/**
 * What Community → Announcements and the Discord page's section show: standing rules, the outbox
 * (scheduled, sent, failed and cancelled posts), posting channels, and Discord proposals waiting for an
 * officer. Plain values, ready for client components.
 */

export const POST_VIEWS = ["scheduled", "sent", "problems", "all"] as const
export type PostListView = (typeof POST_VIEWS)[number]
export const POSTS_PAGE_SIZE = 25

const STATUSES: Record<PostListView, DiscordPostStatus[] | null> = {
  scheduled: ["SCHEDULED", "SENDING"],
  sent: ["SENT"],
  problems: ["FAILED", "CANCELLED"],
  all: null,
}

export type PostView = {
  id: string
  status: DiscordPostStatus
  source: string
  /** "Event reminders", "Jack, applied by Dylan", "Gray", "Weekly digest" */
  from: string
  /** The room a proposal came from, at its reply */
  fromHref: string | null
  channel: string
  /** "Sends Mon Oct 26, 6:00 PM CT", "Sent …" */
  when: string
  /** The text, with channel and role mentions and Discord times shown as words */
  text: string
  embed: { title: string | null; description: string | null; fields: { name: string; value: string }[] } | null
  poll: { question: string; answers: string[]; hours: number } | null
  ping: string | null
  error: string | null
  url: string | null
}

export type RuleView = {
  id: string
  kind: string
  label: string
  description: string
  enabled: boolean
  channelId: string | null
  /** "Acts on what happens after Oct 22, 3:00 PM CT" */
  since: string
  scheduled: number
  lastPost: string | null
  /** For the edit form */
  config: { offsets: number[]; series: string | null; top: number | null; pingRoleId: string | null; pingName: string | null; location: string | null }
}

export type PendingProposalView = { id: string; kind: string; title: string; href: string; when: string }

/**
 * Discord's own markup as words, for the page: <#id> → #name, <@&id> → @role, <t:unix:F> → a Central
 * time, bold markers and Markdown escapes dropped
 */
export function readableText(text: string, names: { channels: Map<string, string>; roles: Map<string, string> }): string {
  return text
    .replace(/<#(\d{17,20})>/g, (_, id: string) => `#${names.channels.get(id) ?? "channel"}`)
    .replace(/<@&(\d{17,20})>/g, (_, id: string) => `@${names.roles.get(id) ?? "role"}`)
    .replace(/<@!?(\d{17,20})>/g, "@member")
    .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_, unix: string) => when(new Date(Number(unix) * 1000)))
    .replace(/(?<!\\)\*\*/g, "")
    .replace(/\\([\\*_~`|<>[\]#\-+.])/g, "$1")
}

/** Role names the rules know (a rule saves its ping's name), for showing pings without asking Discord */
async function knownRoleNames(): Promise<Map<string, string>> {
  const rules = await prisma.discordRule.findMany({ select: { kind: true, config: true } })
  const names = new Map<string, string>()
  for (const rule of rules) {
    const ping = readRuleConfig(rule.kind, rule.config)?.ping
    if (ping) names.set(ping.roleId, ping.name)
  }
  return names
}

const sourceLabel = (source: string) => (source === "proposal" ? "Jack" : source === "digest" ? "Weekly digest" : source === "admin" ? "An officer" : "A standing rule")

function postWhen(post: Pick<DiscordPost, "status" | "scheduledFor" | "sentAt" | "claimedAt" | "createdAt">, now: Date): string {
  switch (post.status) {
    case "SCHEDULED":
      return post.scheduledFor <= now ? "Sending now" : `Sends ${when(post.scheduledFor)}`
    case "SENDING":
      return `Sending since ${when(post.claimedAt ?? post.scheduledFor)}`
    case "SENT":
      return `Sent ${when(post.sentAt ?? post.scheduledFor)}`
    case "FAILED":
      return `Failed, due ${when(post.scheduledFor)}`
    case "CANCELLED":
      return `Cancelled, was due ${when(post.scheduledFor)}`
  }
}

/** Posts for the page, with everything they need to show */
export async function toPostViews(posts: DiscordPost[], now = new Date()): Promise<PostView[]> {
  const channelIds = [...new Set(posts.flatMap((p) => [p.channelId, ...[...JSON.stringify(p.content).matchAll(/<#(\d{17,20})>/g)].map((m) => m[1])]))]
  const userIds = [...new Set(posts.flatMap((p) => [p.createdById, p.approvedById]).filter((id): id is string => Boolean(id)))]
  const ruleIds = [...new Set(posts.map((p) => p.ruleId).filter((id): id is string => Boolean(id)))]
  const proposalIds = [...new Set(posts.map((p) => p.proposalId).filter((id): id is string => Boolean(id)))]
  const [channels, users, rules, proposals, roles] = await Promise.all([
    prisma.discordChannel.findMany({ where: { id: { in: channelIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }),
    prisma.discordRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, kind: true } }),
    prisma.jackProposal.findMany({ where: { id: { in: proposalIds } }, select: { id: true, roomId: true, messageId: true } }),
    knownRoleNames(),
  ])
  const names = { channels: new Map(channels.map((c) => [c.id, c.name])), roles }
  const people = new Map(users.map((u) => [u.id, u.displayName]))
  const ruleKinds = new Map(rules.map((r) => [r.id, r.kind]))
  const rooms = new Map(proposals.map((p) => [p.id, roomMessageUrl(p.roomId, p.messageId)]))
  const person = (id: string | null) => (id ? (people.get(id) ?? FORMER_OFFICER) : null)

  return posts.map((post) => {
    const body = readBody(post.content)
    const kind = post.ruleId ? ruleKinds.get(post.ruleId) : undefined
    const approver = person(post.approvedById)
    const from =
      post.source === "rule"
        ? kind && isRuleKind(kind)
          ? RULE_INFO[kind].label
          : "A deleted rule"
        : post.source === "proposal"
          ? `Jack${approver ? `, applied by ${approver}` : ""}`
          : post.source === "admin"
            ? (person(post.createdById) ?? "An officer")
            : sourceLabel(post.source)
    const embed = body?.embeds?.[0]
    const roleId = body?.allowed_mentions.roles?.[0]
    const ping = body?.allowed_mentions.parse.includes("everyone") ? ((body.content ?? "").startsWith("@here") ? "@here" : "@everyone") : roleId ? `@${roles.get(roleId) ?? "a role"}` : null
    return {
      id: post.id,
      status: post.status,
      source: post.source,
      from,
      fromHref: post.proposalId ? (rooms.get(post.proposalId) ?? null) : null,
      channel: `#${names.channels.get(post.channelId) ?? post.channelId}`,
      when: postWhen(post, now),
      text: readableText(body?.content ?? "", names),
      embed: embed ? { title: embed.title ?? null, description: embed.description ? readableText(embed.description, names) : null, fields: (embed.fields ?? []).map((f) => ({ name: f.name, value: readableText(f.value, names) })) } : null,
      poll: body?.poll ? { question: body.poll.question.text, answers: body.poll.answers.map((a) => a.poll_media.text), hours: body.poll.duration } : null,
      ping,
      error: post.error,
      url: postUrl(post),
    }
  })
}

export async function postCounts(): Promise<Record<PostListView, number>> {
  const groups = await prisma.discordPost.groupBy({ by: ["status"], _count: { _all: true } })
  const count = (statuses: DiscordPostStatus[] | null) => groups.filter((g) => !statuses || statuses.includes(g.status)).reduce((n, g) => n + g._count._all, 0)
  return { scheduled: count(STATUSES.scheduled), sent: count(STATUSES.sent), problems: count(STATUSES.problems), all: count(null) }
}

/** One page of the outbox: scheduled soonest first, the rest newest first */
export async function listPosts(view: PostListView, page: number, now = new Date()): Promise<{ posts: PostView[]; total: number }> {
  const statuses = STATUSES[view]
  const where: Prisma.DiscordPostWhereInput = statuses ? { status: { in: statuses } } : {}
  const orderBy: Prisma.DiscordPostOrderByWithRelationInput[] = view === "scheduled" ? [{ scheduledFor: "asc" }] : view === "sent" ? [{ sentAt: "desc" }] : [{ createdAt: "desc" }]
  const [rows, total] = await Promise.all([prisma.discordPost.findMany({ where, orderBy, skip: (page - 1) * POSTS_PAGE_SIZE, take: POSTS_PAGE_SIZE }), prisma.discordPost.count({ where })])
  return { posts: await toPostViews(rows, now), total }
}

export async function listRules(): Promise<RuleView[]> {
  const [rules, channels, series, scheduled, sent] = await Promise.all([
    prisma.discordRule.findMany({ orderBy: [{ enabled: "desc" }, { createdAt: "asc" }] }),
    prisma.discordChannel.findMany({ where: { parentId: null }, select: { id: true, name: true } }),
    prisma.eventSeries.findMany({ select: { slug: true, title: true } }),
    prisma.discordPost.groupBy({ by: ["ruleId"], where: { status: "SCHEDULED", ruleId: { not: null } }, _count: { _all: true } }),
    prisma.discordPost.groupBy({ by: ["ruleId"], where: { status: "SENT", ruleId: { not: null } }, _max: { sentAt: true } }),
  ])
  const names = { channels: new Map(channels.map((c) => [c.id, c.name])), series: new Map(series.map((s) => [s.slug, s.title])) }
  const scheduledBy = new Map(scheduled.map((g) => [g.ruleId, g._count._all]))
  const sentBy = new Map(sent.map((g) => [g.ruleId, g._max.sentAt]))
  return rules.map((rule) => {
    const config = readRuleConfig(rule.kind, rule.config)
    const last = sentBy.get(rule.id)
    return {
      id: rule.id,
      kind: rule.kind,
      label: isRuleKind(rule.kind) ? RULE_INFO[rule.kind].label : rule.kind,
      description: describeRule(rule, names),
      enabled: rule.enabled,
      channelId: rule.channelId,
      since: `Acts on what happens after ${when(rule.cutoffAt)}`,
      scheduled: scheduledBy.get(rule.id) ?? 0,
      lastPost: last ? `Last posted ${when(last)}` : null,
      config: {
        offsets: config?.offsets ?? [],
        series: config?.series ?? null,
        top: config?.top ?? null,
        pingRoleId: config?.ping?.roleId ?? null,
        pingName: config?.ping?.name ?? null,
        location: config?.location ?? null,
      },
    }
  })
}

/** discord.post and discord.rule proposals no officer has applied or discarded yet */
export async function pendingDiscordProposals(now = new Date()): Promise<PendingProposalView[]> {
  const rows = await prisma.jackProposal.findMany({
    where: { kind: { in: ["discord.post", "discord.rule"] }, status: "PENDING", expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, kind: true, title: true, roomId: true, messageId: true, createdAt: true },
  })
  return rows.map((p) => ({ id: p.id, kind: p.kind, title: p.title, href: roomMessageUrl(p.roomId, p.messageId), when: when(p.createdAt) }))
}

export type ChannelsView = { allowed: PostingChannel[]; choices: PostingChannel[] }

export async function channelsView(): Promise<ChannelsView> {
  const [allowed, choices] = await Promise.all([postingChannels(), postableChannels()])
  return { allowed, choices }
}

export const seriesOptions = async () => (await prisma.eventSeries.findMany({ orderBy: { title: "asc" }, select: { slug: true, title: true } })).map((s) => ({ value: s.slug, label: s.title }))

// ---------------------------------------------------------------------------
// Community → Discord: role sync, the mirrored events, and a summary of the rules
// ---------------------------------------------------------------------------

export type RoleRuleView = {
  id: string
  roleId: string
  /** From Discord when it could be read; null otherwise */
  roleName: string | null
  condition: string
  conditionLabel: string
  enabled: boolean
  /** Why role sync won't touch the role (read live), or null when it's fine or Discord couldn't be read */
  refusal: string | null
  /** Linked members who meet the condition now (null when it can't be told) */
  qualifying: number | null
  /** Linked members who hold the role, as of the last member sync */
  holders: number
  /** Members in the server who hold it but aren't linked (role sync leaves members who never linked alone) */
  others: number
}

export type RoleSyncView = {
  rules: RoleRuleView[]
  linked: number
  /** Unlinked accounts whose roles the next run takes back (Discord couldn't be reached when they went) */
  waitingTakeBacks: number
  /** The server's roles role sync may hand out (read live; empty while Discord is off or can't be read) */
  safeRoles: { id: string; name: string }[]
  /** Discord could be read just now */
  live: boolean
  lastRun: { at: string; status: string | null; summary: string | null } | null
}

export async function roleSyncView(live: (RoleSafety & { roles: DiscordRole[] }) | null): Promise<RoleSyncView> {
  const [rules, members, job, waiting] = await Promise.all([
    prisma.discordRoleRule.findMany({ orderBy: { roleId: "asc" } }),
    linkedMembers(),
    prisma.scheduledJob.findUnique({ where: { key: "discord.role-sync" }, select: { lastRunAt: true, lastStatus: true, runs: { orderBy: { startedAt: "desc" }, take: 1, select: { summary: true } } } }),
    waitingTakeBacks(),
  ])
  const linkedIds = members.map((m) => m.discordUserId)
  const inServer = await prisma.discordMember.findMany({ where: { id: { in: linkedIds }, leftAt: null }, select: { roles: true } })
  const others = await Promise.all(rules.map((rule) => prisma.discordMember.count({ where: { id: { notIn: linkedIds }, leftAt: null, roles: { has: rule.roleId } } })))
  const views: RoleRuleView[] = []
  for (const [i, rule] of rules.entries()) {
    const role = live?.roles.find((r) => r.id === rule.roleId)
    const want = isRoleCondition(rule.condition) ? await qualifying(rule.condition, members).catch(() => null) : null
    views.push({
      id: rule.id,
      roleId: rule.roleId,
      roleName: role?.name ?? null,
      condition: rule.condition,
      conditionLabel: isRoleCondition(rule.condition) ? ROLE_CONDITIONS[rule.condition].label : rule.condition,
      enabled: rule.enabled,
      refusal: live ? roleSyncRefusal(role, live) : null,
      qualifying: want ? want.size : null,
      holders: inServer.filter((m) => m.roles.includes(rule.roleId)).length,
      others: others[i],
    })
  }
  const taken = new Set(rules.map((r) => r.roleId))
  const safeRoles = live
    ? live.roles
        .filter((r) => !taken.has(r.id) && !roleSyncRefusal(r, live))
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name }))
    : []
  return {
    rules: views,
    linked: members.length,
    waitingTakeBacks: waiting,
    safeRoles,
    live: Boolean(live),
    lastRun: job?.lastRunAt ? { at: when(job.lastRunAt), status: job.lastStatus, summary: job.runs[0]?.summary ?? null } : null,
  }
}

export type MirroredEventView = { eventId: string; title: string; starts: string; interested: number | null; discordUrl: string | null; past: boolean }

/** Events mirrored to Discord: upcoming soonest first, then the last few past ones, with how many members are interested */
export async function mirroredEvents(now = new Date()): Promise<{ events: MirroredEventView[]; mirrorOn: boolean }> {
  const [mirrors, rule] = await Promise.all([
    prisma.discordEventMirror.findMany({ where: { eventStartsAt: { gt: new Date(now.getTime() - 30 * 24 * 60 * 60_000) } }, orderBy: { eventStartsAt: "asc" }, take: 40 }),
    prisma.discordRule.findFirst({ where: { kind: "event_mirror", enabled: true }, select: { id: true } }),
  ])
  const events = await prisma.event.findMany({ where: { id: { in: mirrors.map((m) => m.eventId) } }, select: { id: true, title: true, startsAtUtc: true } })
  const byId = new Map(events.map((e) => [e.id, e]))
  const guildId = process.env.DISCORD_GUILD_ID?.trim()
  const views = mirrors.map((m) => {
    const event = byId.get(m.eventId)
    return { eventId: m.eventId, title: event?.title ?? "A deleted event", starts: when(event?.startsAtUtc ?? m.eventStartsAt), interested: m.interestedCount, discordUrl: guildId ? discordEventUrl(guildId, m.discordEventId) : null, past: m.eventStartsAt <= now }
  })
  return { events: [...views.filter((v) => !v.past), ...views.filter((v) => v.past).reverse().slice(0, 5)], mirrorOn: Boolean(rule) }
}

/** The standing rules in a line each, for the Discord page */
export async function ruleSummary(): Promise<{ on: string[]; off: number; scheduled: number }> {
  const [rules, channels, scheduled] = await Promise.all([
    prisma.discordRule.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.discordChannel.findMany({ where: { parentId: null }, select: { id: true, name: true } }),
    prisma.discordPost.count({ where: { status: "SCHEDULED" } }),
  ])
  const names = { channels: new Map(channels.map((c) => [c.id, c.name])) }
  return { on: rules.filter((r) => r.enabled).map((r) => describeRule(r, names)), off: rules.filter((r) => !r.enabled).length, scheduled }
}

