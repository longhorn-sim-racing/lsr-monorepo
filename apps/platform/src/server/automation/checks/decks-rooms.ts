import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { formatUsd } from "@/lib/jack/spend"
import { jackRoomTitle } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import { getMonthSpend } from "@/server/jack/spend"
import type { DigestCheck } from "../types"

/** Digest and Overview "needs attention" checks from the decks-rooms track (design §11.2) */

const USAGE_PAGE = "/admin/jack/usage"
/** Jack's spend this month past this share of the cap needs attention (at the cap he stops answering) */
export const SPEND_WARNING_RATIO = 0.8
const DAY_MS = 86_400_000
/** Thumbs-down with a note from this many days back are listed as eval candidates */
const FEEDBACK_DAYS = 7
const ITEMS = 5

/** Jack's spend this month (Central Time) is near the monthly cap, or has reached it and replies have stopped */
export const jackSpendNearCap: DigestCheck = {
  id: "jack.spend",
  label: "Jack's monthly budget",
  href: USAGE_PAGE,
  order: 95,
  async run({ now }) {
    const spend = await getMonthSpend(now)
    const ratio = spend.budgetUsd > 0 ? spend.totalUsd / spend.budgetUsd : 1
    if (ratio < SPEND_WARNING_RATIO) return { count: 0, severity: "info", items: [] }
    const reached = ratio >= 1
    return {
      count: 1,
      severity: reached ? "danger" : "warning",
      items: [
        {
          title: `${spend.month}: ${formatUsd(spend.totalUsd)} of ${formatUsd(spend.budgetUsd, { wholeIfRound: true })} spent`,
          href: USAGE_PAGE,
          detail: reached ? "Jack stops answering until the 1st" : `${Math.round(ratio * 100)}% of the cap`,
        },
      ],
    }
  },
}

/**
 * Thumbs-down with a note in the last week: eval candidates (the Usage page lists them with the question
 * and the answer). Items name the room only; the note stays in the console
 */
export const jackFeedbackNotes: DigestCheck = {
  id: "jack.feedback",
  label: "Jack answers marked wrong (eval candidates)",
  href: `${USAGE_PAGE}#feedback`,
  order: 96,
  async run({ now }) {
    const where = { rating: "down", note: { not: null }, createdAt: { gte: new Date(now.getTime() - FEEDBACK_DAYS * DAY_MS), lte: now } }
    const [count, rows] = await Promise.all([
      prisma.jackFeedback.count({ where }),
      prisma.jackFeedback.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: ITEMS,
        select: { createdAt: true, message: { select: { id: true, roomId: true, room: { select: { title: true } } } } },
      }),
    ])
    return {
      count,
      severity: "info",
      items: rows.map((row) => ({
        title: `Thumbs-down in “${jackRoomTitle(row.message.room)}”`,
        href: roomMessageUrl(row.message.roomId, row.message.id),
        detail: `Rated ${formatInTimeZone(row.createdAt, DEFAULT_TIMEZONE, "MMM d")}`,
      })),
    }
  },
}

export const CHECKS: DigestCheck[] = [jackSpendNearCap, jackFeedbackNotes]
