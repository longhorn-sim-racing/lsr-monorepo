import { Prisma } from "@prisma/client"
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

export const TEAMS_CONNECTOR = "teams"
export const TEAMS_OFF = "Teams isn't connected, so its messages can't be searched or read."

/** Whether an admin has switched the Teams connector on (ConnectorState; no row means off) */
export async function teamsEnabled(): Promise<boolean> {
  const state = await prisma.connectorState.findUnique({ where: { id: TEAMS_CONNECTOR }, select: { enabled: true } })
  return state?.enabled ?? false
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

/** Messages shown with the one `read` opens: its thread, oldest first */
const THREAD_MESSAGES = 30

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
        const message = await prisma.teamsMessage.findUnique({ where: { id }, select: { id: true, channelId: true, replyToId: true, deletedAt: true } })
        if (!message || message.deletedAt) return { ok: false, error: `No Teams message ${id}: it may have been deleted.` }
        const rootId = message.replyToId ?? message.id
        const [channel, thread] = await Promise.all([
          prisma.teamsChannel.findUnique({ where: { id: message.channelId }, select: { name: true, teamId: true } }),
          prisma.teamsMessage.findMany({
            where: { channelId: message.channelId, deletedAt: null, OR: [{ id: rootId }, { replyToId: rootId }] },
            orderBy: { createdAt: "asc" },
            take: THREAD_MESSAGES,
            select: { id: true, authorName: true, content: true, createdAt: true, editedAt: true },
          }),
        ])
        const lines = thread.map(
          (m) => `${m.id === message.id ? "→ (the message you opened) " : ""}${ct(m.createdAt)} · ${m.authorName}${m.editedAt ? " (edited)" : ""}: ${m.content || "(no text)"}`,
        )
        const where = channel ? `#${channel.name}` : "Teams"
        return {
          ok: true,
          doc: {
            type: "teams",
            id: message.id,
            title: `Thread in ${where}`,
            url: teamsMessageHref(message, channel?.teamId ?? null),
            date: isoOrNull(thread.find((m) => m.id === message.id)?.createdAt),
            meta: { channel: channel?.name ?? null, messages: thread.length },
            text: `# Thread in ${where}\n\n${lines.join("\n\n")}`,
          },
        }
      },
    },
  ],
}
