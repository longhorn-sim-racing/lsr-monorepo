import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { formatUsd } from "@/lib/jack/spend"
import { jackRoomTitle } from "@/lib/jack/types"
import { ACTIVE_STATUSES, PUBLISH_HISTORY, TYPE_LABEL } from "@/lib/jack/publish"
import { publishAccount } from "@/server/connectors/instagram/publish-token"
import { prisma } from "@/server/db"
import { getMonthSpend } from "@/server/jack/spend"
import type { DigestCheck, DigestItem } from "../types"

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

/** A post on its way to Instagram for longer than this needs a look (the follow-up job may be off) */
const PUBLISH_STUCK_MS = 20 * 60_000
/** The publishing token needs a new paste when it runs out within this long */
const TOKEN_WARN_MS = 10 * DAY_MS

/**
 * Instagram publishing: posts that failed in the last week, posts still waiting on Instagram after 20
 * minutes, and a publishing token that's running out or couldn't be renewed. Items name the deck and
 * link to the publish history; they never carry Instagram's error text
 */
export const instagramPublishNeedsAttention: DigestCheck = {
  id: "instagram-publish.attention",
  label: "Instagram posts",
  href: PUBLISH_HISTORY,
  order: 62,
  async run({ now }) {
    const [failed, stuck, account] = await Promise.all([
      prisma.instagramPublish.findMany({ where: { status: "failed", updatedAt: { gte: new Date(now.getTime() - FEEDBACK_DAYS * DAY_MS), lte: now } }, orderBy: { updatedAt: "desc" }, take: ITEMS, select: { deckId: true, mediaType: true, updatedAt: true } }),
      prisma.instagramPublish.findMany({ where: { status: { in: ACTIVE_STATUSES }, createdAt: { lt: new Date(now.getTime() - PUBLISH_STUCK_MS) } }, orderBy: { createdAt: "asc" }, take: ITEMS, select: { deckId: true, mediaType: true, createdAt: true } }),
      publishAccount(),
    ])
    const [failedCount, stuckCount] = await Promise.all([
      prisma.instagramPublish.count({ where: { status: "failed", updatedAt: { gte: new Date(now.getTime() - FEEDBACK_DAYS * DAY_MS), lte: now } } }),
      prisma.instagramPublish.count({ where: { status: { in: ACTIVE_STATUSES }, createdAt: { lt: new Date(now.getTime() - PUBLISH_STUCK_MS) } } }),
    ])
    const deckIds = [...new Set([...failed, ...stuck].flatMap((row) => (row.deckId ? [row.deckId] : [])))]
    const titles = new Map((deckIds.length ? await prisma.jackDeck.findMany({ where: { id: { in: deckIds } }, select: { id: true, title: true } }) : []).map((d) => [d.id, d.title]))
    const what = (row: { deckId: string | null; mediaType: string }) => `${TYPE_LABEL[row.mediaType as keyof typeof TYPE_LABEL] ?? "a post"} of “${(row.deckId && titles.get(row.deckId)) || "a deleted deck"}”`
    const day = (date: Date) => formatInTimeZone(date, DEFAULT_TIMEZONE, "MMM d, h:mm a")

    const items: DigestItem[] = []
    const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt) : null
    const tokenTrouble = account.connected && (Boolean(account.refreshError) || (expiresAt !== null && expiresAt.getTime() - now.getTime() < TOKEN_WARN_MS))
    if (tokenTrouble) {
      items.push({
        title: account.refreshError ? "The Instagram publishing token couldn't be renewed: an admin pastes a new one" : "The Instagram publishing token runs out soon: check its renewal job, or paste a new one",
        href: PUBLISH_HISTORY,
        detail: expiresAt ? `Runs out ${formatInTimeZone(expiresAt, DEFAULT_TIMEZONE, "MMM d")}` : undefined,
      })
    }
    for (const row of stuck) items.push({ title: `Still waiting on Instagram: ${what(row)}`, href: PUBLISH_HISTORY, detail: `Approved ${day(row.createdAt)} CT` })
    for (const row of failed) items.push({ title: `Couldn't post ${what(row)}`, href: PUBLISH_HISTORY, detail: `${day(row.updatedAt)} CT` })
    const count = failedCount + stuckCount + (tokenTrouble ? 1 : 0)
    if (!count) return { count: 0, severity: "info", items: [] }
    return { count, severity: tokenTrouble && account.refreshError ? "danger" : "warning", items: items.slice(0, ITEMS) }
  },
}

export const CHECKS: DigestCheck[] = [jackSpendNearCap, jackFeedbackNotes, instagramPublishNeedsAttention]
