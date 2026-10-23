import { Prisma } from "@prisma/client"
import { TEAMS_CONNECTOR_ID, teamsConnector } from "@/server/connectors/teams/connector"
import { prisma } from "@/server/db"
import { ct } from "../../tools/time"
import { teamsMessageHref } from "../links"
import { cleanSnippet, HEADLINE_INPUT_CHARS, HEADLINE_OPTIONS, isoOrNull, queryCte, rankOf } from "../sql"
import type { SearchSource } from "../types"

/**
 * Messages from the officers' Teams channels (design §12.8), synced by the documents track while the
 * `teams` connector is on. Off (or never set up), Teams is neither searched nor read, whatever the
 * table still holds. Deleted messages lose their content and aren't searched.
 */

export const TEAMS_CONNECTOR = TEAMS_CONNECTOR_ID
export const TEAMS_OFF = "Teams isn't connected, so its messages can't be searched or read."

/** Whether an admin has switched the Teams connector on (its ConnectorState switch; no row means off) */
export async function teamsEnabled(): Promise<boolean> {
  return teamsConnector.enabled()
}

type TeamsRow = {
  id: string
  channelId: string
  replyToId: string | null
  authorName: string
  createdAt: Date
  channelName: string | null
  teamId: string | null
  rank: number
  snippet: string | null
}

/**
 * The most messages `read` shows of a thread, oldest first: its first message and the replies
 * around the one opened (the first replies when that's the first message)
 */
export const THREAD_MESSAGES = 30

const threadSelect = { id: true, authorName: true, content: true, createdAt: true, editedAt: true } as const

/** Which replies to show, from up to `slots` on each side of the opened one: half before, more when there are few after */
export function threadWindow<T>(before: T[], fromOpened: T[], slots: number): { before: T[]; fromOpened: T[] } {
  const keepBefore = Math.min(before.length, Math.max(Math.floor(slots / 2), slots - fromOpened.length))
  return { before: before.slice(0, keepBefore), fromOpened: fromOpened.slice(0, slots - keepBefore) }
}

export const teamsSource: SearchSource = {
  key: "teams",
  description: "messages in the officers' Teams channels (only while Teams is connected)",
  byDefault: true,
  async unavailable() {
    return (await teamsEnabled()) ? null : TEAMS_OFF
  },
  async search({ query, limit }) {
    const rows = await prisma.$queryRaw<TeamsRow[]>(Prisma.sql`
      WITH ${queryCte(query)},
      hits AS (
        SELECT t.id, t."channelId", t."replyToId", t."authorName", t."createdAt", t.content, c.name AS "channelName", c."teamId",
          ts_rank_cd(d.search, q.query, 32) AS rank
        FROM "JackSearchDoc" d
        CROSS JOIN q
        JOIN "TeamsMessage" t ON t.id = d."sourceId"
        LEFT JOIN "TeamsChannel" c ON c.id = t."channelId"
        WHERE d.source = 'teams' AND d.search @@ q.query AND t."deletedAt" IS NULL
        ORDER BY rank DESC, t."createdAt" DESC
        LIMIT ${limit}
      )
      SELECT h.id, h."channelId", h."replyToId", h."authorName", h."createdAt", h."channelName", h."teamId", h.rank,
        ts_headline('english', left(h.content, ${HEADLINE_INPUT_CHARS}::int), q.query, ${HEADLINE_OPTIONS}) AS snippet
      FROM hits h CROSS JOIN q
      ORDER BY h.rank DESC, h."createdAt" DESC`)
    return rows.map((row) => ({
      source: "teams",
      type: "teams",
      id: row.id,
      title: `${row.authorName} in ${row.channelName ? `#${row.channelName}` : "Teams"}`,
      url: teamsMessageHref(row, row.teamId),
      snippet: cleanSnippet(row.snippet),
      date: isoOrNull(row.createdAt),
      meta: { by: row.authorName, channel: row.channelName },
      rank: rankOf(row.rank),
    }))
  },
  readers: [
    {
      type: "teams",
      description: "a Teams message with its thread, by message id",
      async read(id) {
        if (!(await teamsEnabled())) return { ok: false, error: TEAMS_OFF }
        const message = await prisma.teamsMessage.findUnique({ where: { id }, select: { id: true, channelId: true, replyToId: true, createdAt: true, deletedAt: true } })
        if (!message || message.deletedAt) return { ok: false, error: `No Teams message ${id}: it may have been deleted.` }
        const rootId = message.replyToId ?? message.id
        const replies = { channelId: message.channelId, replyToId: rootId, deletedAt: null }
        // A reply opened: the replies just before it and from it on. The thread's first message opened: its first replies
        const opened = message.replyToId ? message : null
        const beforeOpened = opened ? { ...replies, OR: [{ createdAt: { lt: opened.createdAt } }, { createdAt: opened.createdAt, id: { lt: opened.id } }] } : null
        const slots = THREAD_MESSAGES - 1
        const [channel, root, before, fromOpened, replyCount, earlierCount] = await Promise.all([
          prisma.teamsChannel.findUnique({ where: { id: message.channelId }, select: { name: true, teamId: true } }),
          prisma.teamsMessage.findFirst({ where: { id: rootId, channelId: message.channelId, deletedAt: null }, select: threadSelect }),
          beforeOpened ? prisma.teamsMessage.findMany({ where: beforeOpened, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: slots, select: threadSelect }) : [],
          prisma.teamsMessage.findMany({
            where: opened ? { ...replies, OR: [{ createdAt: { gt: opened.createdAt } }, { createdAt: opened.createdAt, id: { gte: opened.id } }] } : replies,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: slots,
            select: threadSelect,
          }),
          prisma.teamsMessage.count({ where: replies }),
          beforeOpened ? prisma.teamsMessage.count({ where: beforeOpened }) : 0,
        ])
        const shown = threadWindow(before, fromOpened, slots)
        const earlierLeft = earlierCount - shown.before.length
        const laterLeft = replyCount - earlierCount - shown.fromOpened.length
        const notShown = (n: number, which: string) => `(${n} ${which} ${n === 1 ? "reply" : "replies"} not shown)`
        const line = (m: (typeof fromOpened)[number]) =>
          `${m.id === message.id ? "→ (the message you opened) " : ""}${ct(m.createdAt)} · ${m.authorName}${m.editedAt ? " (edited)" : ""}: ${m.content || "(no text)"}`
        const lines = [
          ...(root ? [line(root)] : []),
          ...(earlierLeft > 0 ? [notShown(earlierLeft, "earlier")] : []),
          ...[...shown.before].reverse().map(line),
          ...shown.fromOpened.map(line),
          ...(laterLeft > 0 ? [notShown(laterLeft, "later")] : []),
        ]
        const where = channel ? `#${channel.name}` : "Teams"
        return {
          ok: true,
          doc: {
            type: "teams",
            id: message.id,
            title: `Thread in ${where}`,
            url: teamsMessageHref(message, channel?.teamId ?? null),
            date: isoOrNull(message.createdAt),
            meta: { channel: channel?.name ?? null, replies: replyCount, shown: (root ? 1 : 0) + shown.before.length + shown.fromOpened.length },
            text: `# Thread in ${where}\n\n${lines.join("\n\n")}`,
          },
        }
      },
    },
  ],
}
