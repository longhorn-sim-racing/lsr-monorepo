import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { PROPOSALS_PAGE, roomMessageUrl } from "@/lib/jack/proposals"
import { jackRoomTitle } from "@/lib/jack/types"
import type { DigestCheck } from "@/server/automation/types"
import { prisma } from "@/server/db"

/**
 * Proposals' "needs attention" checks (design §11.2: pending and stale proposals), for the digest and the
 * Overview. Items name the proposal (its server-written title) and its room, and link to the reply that
 * proposed it; never its payload.
 */

const DAY_MS = 86_400_000
const ITEMS = 5
/** A proposal waiting longer than this makes the check a warning */
const WAITING_DAYS = 3
/** How far back "went stale" looks */
const STALE_DAYS = 7

const day = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d")
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`

/** Proposals waiting for an officer to apply or discard them (pending and not expired), oldest first */
export const pendingProposals: DigestCheck = {
  id: "proposals.pending",
  label: "Proposals waiting for an officer",
  href: `${PROPOSALS_PAGE}?status=PENDING`,
  order: 10,
  async run({ now }) {
    const where = { status: "PENDING" as const, expiresAt: { gt: now } }
    const [count, rows] = await Promise.all([
      prisma.jackProposal.count({ where }),
      prisma.jackProposal.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: ITEMS,
        select: { title: true, roomId: true, messageId: true, createdAt: true, expiresAt: true, room: { select: { title: true } } },
      }),
    ])
    const waited = (row: { createdAt: Date }) => Math.floor((now.getTime() - row.createdAt.getTime()) / DAY_MS)
    return {
      count,
      severity: rows.some((row) => waited(row) > WAITING_DAYS) ? "warning" : "info",
      items: rows.map((row) => ({
        title: row.title,
        href: roomMessageUrl(row.roomId, row.messageId),
        detail: `In “${jackRoomTitle(row.room)}”, waiting ${waited(row) ? days(waited(row)) : "since today"} · expires ${day(row.expiresAt)}`,
      })),
    }
  },
}

/**
 * Proposals that went stale in the last week without anyone applying them: what they'd change moved on,
 * or nobody applied them within 14 days (a pending one past its expiry counts, before the sweep marks it)
 */
export const staleProposals: DigestCheck = {
  id: "proposals.stale",
  label: "Proposals that went stale",
  href: `${PROPOSALS_PAGE}?status=STALE`,
  order: 11,
  async run({ now }) {
    const since = new Date(now.getTime() - STALE_DAYS * DAY_MS)
    const where = {
      OR: [
        { status: "STALE" as const, updatedAt: { gte: since, lte: now } },
        { status: "PENDING" as const, expiresAt: { gte: since, lte: now } },
      ],
    }
    const [count, rows] = await Promise.all([
      prisma.jackProposal.count({ where }),
      prisma.jackProposal.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: ITEMS,
        select: { title: true, roomId: true, messageId: true, status: true, updatedAt: true, expiresAt: true, room: { select: { title: true } } },
      }),
    ])
    return {
      count,
      severity: "info",
      items: rows.map((row) => ({
        title: row.title,
        href: roomMessageUrl(row.roomId, row.messageId),
        detail: `In “${jackRoomTitle(row.room)}” · ${row.status === "PENDING" ? `nobody applied it by ${day(row.expiresAt)}` : `stale since ${day(row.updatedAt)}`}`,
      })),
    }
  },
}
