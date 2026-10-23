import { formatInTimeZone } from "date-fns-tz"
import { z } from "zod"
import type { JackChartSpec, JackToolDisplay } from "@/lib/jack/parts"
import { prisma } from "@/server/db"
import { discordConnector } from "@/server/connectors/discord/connector"
import { discordActivity, discordJoinsByMonth, discordPolls, type DiscordPollView } from "@/server/queries/discord"
import { forModelWithLists, plural, tableDisplay } from "./display"
import { notReadWhileOff, sourceConnection } from "./source-connection"
import { CLUB_TZ, ct } from "./time"
import type { JackTool } from "./types"

/**
 * discord_activity and discord_polls (#188, design §7.1 and §12.1): the club Discord from the synced
 * metadata, aggregates only. Discord's Developer Policy bans profiling individual users, so neither
 * tool lists or ranks people; message text isn't stored (search reads Discord live). Both load through
 * tool search, and say Discord isn't connected while the connector is off.
 */

const AGGREGATE_ONLY = "Counts only: Discord activity is never broken down by person (Discord's developer policy), so don't try to work out who posted what."

/** A Central date for the model and tables: "2026-10-19" */
const day = (date: Date) => date.toISOString().slice(0, 10)

/**
 * Discord's connection, said the way every synced source says it (sourceConnection): off or not set up,
 * the tools say so and read nothing; otherwise the note says how fresh the counts are, or that the last
 * sync failed
 */
const discordConnection = () => sourceConnection(discordConnector, "Discord")

/** Groups daily counts into weeks (Mondays) or months for a long period */
function series(daily: { date: Date; messages: number }[], by: "day" | "week" | "month"): { period: string; messages: number }[] {
  if (by === "day") return daily.map((d) => ({ period: day(d.date), messages: d.messages }))
  const groups = new Map<string, number>()
  for (const d of daily) {
    const key = by === "month" ? day(d.date).slice(0, 7) : day(new Date(d.date.getTime() - ((d.date.getUTCDay() + 6) % 7) * 86_400_000))
    groups.set(key, (groups.get(key) ?? 0) + d.messages)
  }
  return [...groups].map(([period, messages]) => ({ period: by === "week" ? `week of ${period}` : period, messages }))
}

const activityInput = z.object({
  days: z.number().int().min(1).max(365).default(30).describe("How many days back, today included (default 30)"),
  channel: z.string().trim().min(1).max(100).optional().describe("Only this channel, by name (with or without #). Default: every synced channel"),
})

export const discordActivityTool: JackTool<z.infer<typeof activityInput>> = {
  name: "discord_activity",
  description:
    "Discord server activity from the synced channels: messages per channel and over time (threads count toward their channel), how many members were active, the busiest day, members in the server over time with joins and leaves, and how many members linked their Discord account. Aggregates only, never per person. Only channels an admin opted in are counted; message text isn't stored (search Discord for what was said).",
  input: activityInput,
  deferred: true,
  async run({ days, channel }) {
    const connection = await discordConnection()
    if (!connection.connected) return notReadWhileOff(connection, "Discord")
    const now = new Date()
    let channelId: string | undefined
    if (channel) {
      const wanted = channel.replace(/^#/, "").toLowerCase()
      const rows = await prisma.discordChannel.findMany({ where: { parentId: null }, select: { id: true, name: true, synced: true } })
      const found = rows.find((c) => c.name.toLowerCase() === wanted)
      if (!found) return { isError: true, forModel: `No Discord channel called #${wanted}. Channels: ${rows.filter((c) => c.synced).map((c) => `#${c.name}`).join(", ") || "none synced yet"}.`, label: "Discord lookup failed", displays: [] }
      if (!found.synced) return { isError: true, forModel: `#${found.name} isn't synced (an admin opts channels in on Community → Discord), so there's no activity for it.`, label: "Discord lookup failed", displays: [] }
      channelId = found.id
    }
    const [activity, joins] = await Promise.all([discordActivity({ days, channelId, now }), days > 31 ? discordJoinsByMonth(Math.ceil(days / 30), now) : Promise.resolve(null)])
    const by = days <= 31 ? "day" : days <= 120 ? "week" : "month"
    const overTime = series(activity.daily, by)
    const members = activity.members
    const latest = members.at(-1)
    const first = members[0]
    const result = {
      period: { from: day(activity.firstDay), to: day(activity.lastDay), days },
      ...(channel ? { channel: `#${channel.replace(/^#/, "")}` } : {}),
      connection: connection.note,
      messages: activity.messages,
      activeMembers: activity.activeMembers,
      membersNow: latest?.memberCount ?? null,
      ...(latest && first && latest !== first ? { memberChange: { from: day(first.date), to: day(latest.date), change: latest.memberCount - first.memberCount } } : {}),
      joined: members.reduce((n, m) => n + (m.joined ?? 0), 0),
      left: members.reduce((n, m) => n + (m.left ?? 0), 0),
      linkedMembers: activity.linkedMembers,
      definitions: `Active members = distinct people who posted in the period. Joined and left come from the member sync, which started ${first ? day(first.date) : "recently"}; days before it have no member counts. Deleted messages aren't counted.`,
      note: AGGREGATE_ONLY,
    }
    const channels = activity.channels.map((c) => ({
      channel: `#${c.name}`,
      ...(c.category ? { category: c.category } : {}),
      messages: c.messages,
      activeMembers: c.activeMembers,
      ...(c.busiestDay ? { busiestDay: day(c.busiestDay), busiestDayMessages: c.busiestDayMessages } : {}),
    }))

    const chart: JackChartSpec = { type: by === "day" ? "bar" : "line", title: `Messages per ${by}${channel ? ` in #${channel.replace(/^#/, "")}` : ""}`, xKey: "period", series: [{ key: "messages", label: "Messages" }], rows: overTime }
    const displays: JackToolDisplay[] = [
      {
        kind: "stats",
        items: [
          { label: "Messages", value: activity.messages, hint: `Last ${plural(days, "day")}` },
          { label: "Active members", value: activity.activeMembers },
          ...(latest ? [{ label: "Members now", value: latest.memberCount, hint: result.joined || result.left ? `+${result.joined} / −${result.left}` : undefined }] : []),
          { label: "Linked accounts", value: activity.linkedMembers },
        ],
      },
      { kind: "chart", chart },
      ...(channelId ? [] : [tableDisplay(channels, [{ header: "Channel", value: (c) => c.channel }, { header: "Messages", value: (c) => c.messages }, { header: "Active members", value: (c) => c.activeMembers }])]),
    ]
    return {
      forModel: forModelWithLists(result, [
        { key: "channels", items: channels },
        { key: "messagesOverTime", items: overTime, keep: "last", whenTrimmed: "Ask for fewer days." },
        { key: "membersOverTime", items: members.map((m) => ({ date: day(m.date), members: m.memberCount, joined: m.joined, left: m.left })), keep: "last" },
        ...(joins ? [{ key: "joinsByMonth", items: joins.map((j) => ({ ...j, note: "current members only" })) }] : []),
      ]),
      label: `Looked at Discord activity (${plural(activity.messages, "message")}, last ${plural(days, "day")})`,
      displays,
    }
  },
}

const pollsInput = z.object({
  status: z.enum(["open", "closed", "all"]).default("all").describe("Open polls, closed ones, or both"),
  search: z.string().trim().min(1).max(100).optional().describe("Only polls whose question or answers contain these words"),
  days: z.number().int().min(1).max(365).default(90).describe("Polls posted in the last this many days (default 90)"),
  limit: z.number().int().min(1).max(50).default(10).describe("Most polls to return, newest first"),
})

function pollForModel(view: DiscordPollView) {
  const total = view.totalVotes
  return {
    question: view.poll.question,
    channel: view.channel,
    posted: ct(view.postedAt),
    ...(view.poll.expiresAt ? { [view.status === "open" ? "closes" : "closed"]: ct(new Date(view.poll.expiresAt)) } : {}),
    status: view.status === "open" ? "open (counts so far)" : view.status === "final" ? "closed, final counts" : "closed, Discord hasn't finalized the counts yet",
    ...(view.poll.multiselect ? { multipleChoice: true } : {}),
    totalVotes: total,
    answers: view.poll.answers.map((a) => ({ answer: a.text, votes: a.votes, ...(total && a.votes !== null ? { percent: Math.round((a.votes / total) * 100) } : {}) })),
    ...(view.poll.countedAt ? { countsAsOf: ct(new Date(view.poll.countedAt)) } : { note: "Discord hasn't reported counts for this poll yet" }),
  }
}

export const discordPollsTool: JackTool<z.infer<typeof pollsInput>> = {
  name: "discord_polls",
  description:
    "Polls in the club Discord's synced channels: each poll's question, answers and vote counts (open polls so far, closed ones final), with when it was posted and closes. Totals only: who voted is never read. Filter by open or closed, words in the question, and how far back.",
  input: pollsInput,
  deferred: true,
  async run({ status, search, days, limit }) {
    const connection = await discordConnection()
    if (!connection.connected) return notReadWhileOff(connection, "Discord")
    const { polls, matched } = await discordPolls({ days, status, search, limit })
    if (!polls.length) {
      const what = `${status === "all" ? "" : `${status} `}polls${search ? ` matching “${search}”` : ""} in the last ${plural(days, "day")}`
      return { forModel: `No ${what} in the synced Discord channels. ${connection.note}`, label: "Looked at Discord polls (none)", displays: [{ kind: "note", text: `No ${what}.` }] }
    }
    const rows = polls.map(pollForModel)
    const displays: JackToolDisplay[] = [
      tableDisplay(
        polls,
        [
          { header: "Poll", value: (p) => p.poll.question },
          { header: "Channel", value: (p) => p.channel },
          { header: "Posted", value: (p) => formatInTimeZone(p.postedAt, CLUB_TZ, "MMM d") },
          { header: "Votes", value: (p) => p.totalVotes },
          { header: "Status", value: (p) => (p.status === "open" ? "Open" : p.status === "final" ? "Final" : "Closing") },
        ],
        matched > polls.length ? `${polls.length} of ${matched}` : undefined,
      ),
    ]
    if (polls.length === 1) {
      const only = polls[0]
      displays.push({ kind: "chart", chart: { type: "bar", title: only.poll.question, xKey: "answer", series: [{ key: "votes", label: "Votes" }], rows: only.poll.answers.map((a) => ({ answer: a.text, votes: a.votes })) } })
    }
    return {
      forModel: forModelWithLists({ connection: connection.note, matched, filters: { status, search: search ?? null, days }, note: "Vote totals only; Discord's voters are never read." }, [{ key: "polls", items: rows, whenTrimmed: "Narrow it with search or fewer days." }]),
      label: `Looked at Discord polls (${plural(polls.length, "poll")})`,
      displays,
    }
  },
}
