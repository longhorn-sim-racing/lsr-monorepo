import { chicagoDay } from "@/lib/dates"
import { prisma } from "@/server/db"
import { changeOver } from "./twitch"

/**
 * Reads of the club's Instagram insights (#188, design §12.6), from the snapshots the insights jobs
 * keep, for the Instagram page's Insights section and Jack's instagram_insights. Account numbers are
 * per Central day and arrive up to 2 days late; a day without a row wasn't snapshotted. Weekly figures
 * are sums of daily numbers, so an account reached on two days counts twice.
 */

const DAY = 86_400_000

export type AccountDay = {
  date: Date
  followers: number
  reach: number | null
  views: number | null
  accountsEngaged: number | null
  totalInteractions: number | null
  follows: number | null
  unfollows: number | null
}

export type WeekTotals = { days: number; reach: number | null; views: number | null; accountsEngaged: number | null; totalInteractions: number | null; follows: number | null; unfollows: number | null }

export type PostWithInsights = {
  id: string
  permalink: string
  caption: string | null
  mediaType: string
  postedAt: Date
  hidden: boolean
  reach: number | null
  likes: number | null
  comments: number | null
  saved: number | null
  shares: number | null
  views: number | null
  insightsAt: Date | null
}

export const POST_SORTS = ["recent", "reach", "views", "likes", "comments", "saved", "shares"] as const
export type PostSort = (typeof POST_SORTS)[number]

const accountSelect = { date: true, followers: true, reach: true, views: true, accountsEngaged: true, totalInteractions: true, follows: true, unfollows: true } as const

/** Daily rows between two Central dates (inclusive), oldest first */
export async function instagramAccountDays({ from, to }: { from?: Date; to?: Date } = {}): Promise<AccountDay[]> {
  return prisma.instagramAccountDaily.findMany({ where: { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }, orderBy: { date: "asc" }, select: accountSelect })
}

/** Sums of the days that have numbers; null where no day had one */
export function sumDays(days: AccountDay[]): WeekTotals {
  const filled = days.filter((d) => d.reach !== null || d.views !== null)
  const sum = (key: keyof Omit<AccountDay, "date" | "followers">) => {
    const values = filled.map((d) => d[key]).filter((v): v is number => v !== null)
    return values.length ? values.reduce((a, b) => a + b, 0) : null
  }
  return { days: filled.length, reach: sum("reach"), views: sum("views"), accountsEngaged: sum("accountsEngaged"), totalInteractions: sum("totalInteractions"), follows: sum("follows"), unfollows: sum("unfollows") }
}

export type InstagramInsightsOverview = {
  followers: { latest: { date: Date; followers: number } | null; change7: number | null; change30: number | null }
  /** The last 7 complete Central days, and the 7 before */
  week: WeekTotals
  previousWeek: WeekTotals
  /** The newest day with account numbers in */
  lastDayWithNumbers: Date | null
  /** Posts from the last 30 days, most reached first */
  topPosts: PostWithInsights[]
  postsUpdatedAt: Date | null
}

export async function instagramInsightsOverview(now = new Date()): Promise<InstagramInsightsOverview> {
  const today = chicagoDay(now)
  const days = await instagramAccountDays({ from: new Date(today.getTime() - 400 * DAY) })
  const inRange = (from: number, to: number) => days.filter((d) => d.date.getTime() >= today.getTime() - from * DAY && d.date.getTime() <= today.getTime() - to * DAY)
  const withNumbers = days.filter((d) => d.reach !== null || d.views !== null)
  const [topPosts, updated] = await Promise.all([
    listPostInsights({ from: new Date(now.getTime() - 30 * DAY), sort: "reach", limit: 5 }),
    prisma.instagramPost.findFirst({ where: { insightsAt: { not: null } }, orderBy: { insightsAt: "desc" }, select: { insightsAt: true } }),
  ])
  const latest = days[days.length - 1]
  const points = days.map((d) => ({ date: d.date, value: d.followers }))
  return {
    followers: { latest: latest ? { date: latest.date, followers: latest.followers } : null, change7: changeOver(points, 7), change30: changeOver(points, 30) },
    week: sumDays(inRange(7, 1)),
    previousWeek: sumDays(inRange(14, 8)),
    lastDayWithNumbers: withNumbers[withNumbers.length - 1]?.date ?? null,
    topPosts: topPosts.filter((p) => p.reach !== null),
    postsUpdatedAt: updated?.insightsAt ?? null,
  }
}

const sortKey: Record<Exclude<PostSort, "recent">, keyof PostWithInsights> = { reach: "reach", views: "views", likes: "likes", comments: "comments", saved: "saved", shares: "shares" }

/** Posts posted in [from, to), with their numbers; sorted by date or by a number (posts without numbers last) */
export async function listPostInsights({ from, to, sort = "recent", limit = 30, match, id }: { from?: Date; to?: Date; sort?: PostSort; limit?: number; match?: string; id?: string } = {}): Promise<PostWithInsights[]> {
  const where = {
    ...(id ? { id } : {}),
    ...(match ? { caption: { contains: match, mode: "insensitive" as const } } : {}),
    postedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) },
  }
  const select = { id: true, permalink: true, caption: true, mediaType: true, postedAt: true, hidden: true, reach: true, likes: true, comments: true, saved: true, shares: true, views: true, insightsAt: true } as const
  if (sort === "recent") return prisma.instagramPost.findMany({ where, orderBy: { postedAt: "desc" }, take: limit, select })
  const key = sortKey[sort]
  return prisma.instagramPost.findMany({ where, orderBy: [{ [key]: { sort: "desc", nulls: "last" } }, { postedAt: "desc" }], take: limit, select })
}
