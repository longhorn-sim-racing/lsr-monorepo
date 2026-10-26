import { fromZonedTime } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { InstagramGraphError, type InstagramGraph } from "./graph"

/**
 * Instagram insights (#188, design §12.6; research/instagram.md §3): the account's daily totals, the
 * profile's follower count, and each post's numbers. Metric names are exactly the research's tables:
 * the old ones (impressions, profile_views, follower_count, plays) are gone and answer error 100.
 * Instagram returns an empty `data` list for "no data", which is kept as null, never 0.
 */

/** Account totals for one day (metric_type total_value). `saves` would be the account metric; posts use `saved` */
export const ACCOUNT_DAY_METRICS = ["reach", "accounts_engaged", "views", "total_interactions"] as const
/** Feed posts, carousels and reels all answer these (stories aren't in /me/media) */
export const POST_METRICS = ["reach", "likes", "comments", "saved", "shares", "views"] as const

export type AccountDayInsights = { reach: number | null; views: number | null; accountsEngaged: number | null; totalInteractions: number | null; follows: number | null; unfollows: number | null }
export type PostInsights = Record<(typeof POST_METRICS)[number], number | null>
export type InstagramProfile = { userId: string; username: string; followers: number; follows: number | null; mediaCount: number | null }

type Breakdown = { dimension_keys?: string[]; results?: { dimension_values?: string[]; value?: number }[] }
type InsightItem = { name: string; total_value?: { value?: number; breakdowns?: Breakdown[] }; values?: { value?: number }[] }

const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)

/** A metric's value from an insights answer: total_value for account metrics, values[0] for a post's lifetime ones; null when it isn't there */
export function insightValue(items: InsightItem[], name: string): number | null {
  const item = items.find((i) => i.name === name)
  if (!item) return null
  return numberOrNull(item.total_value?.value) ?? numberOrNull(item.values?.[0]?.value)
}

/** follows_and_unfollows split by follow_type: FOLLOWER are accounts that followed, NON_FOLLOWER those that unfollowed */
export function followsAndUnfollows(items: InsightItem[]): { follows: number | null; unfollows: number | null } {
  const results = items.find((i) => i.name === "follows_and_unfollows")?.total_value?.breakdowns?.find((b) => b.dimension_keys?.includes("follow_type"))?.results ?? []
  const pick = (type: string) => numberOrNull(results.find((r) => r.dimension_values?.[0] === type)?.value)
  if (!results.length) return { follows: null, unfollows: null }
  return { follows: pick("FOLLOWER") ?? 0, unfollows: pick("NON_FOLLOWER") ?? 0 }
}

/** A Central-time day (a chicagoDay() date) as Instagram's since/until: Unix seconds, both ends inclusive */
export function dayRange(day: Date): { since: number; until: number } {
  const ymd = day.toISOString().slice(0, 10)
  const start = fromZonedTime(`${ymd}T00:00:00`, DEFAULT_TIMEZONE).getTime()
  const next = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)).toISOString().slice(0, 10)
  const end = fromZonedTime(`${next}T00:00:00`, DEFAULT_TIMEZONE).getTime()
  return { since: Math.floor(start / 1000), until: Math.floor(end / 1000) - 1 }
}

/** Subcode 33: the object doesn't exist (a deleted post), or can't be read this way */
export const MISSING_OBJECT_SUBCODE = 33

/** A bad metric or parameter (code 100, but not a missing object): worth asking for the metrics one at a time */
const badMetric = (error: unknown) => error instanceof InstagramGraphError && error.code === 100 && error.subcode !== MISSING_OBJECT_SUBCODE

export function instagramInsights(graph: InstagramGraph) {
  /** Several metrics in one call; if Instagram refuses the set (one metric it won't give for this account or post), each one alone, and the refused ones are null */
  async function metrics(path: string, names: readonly string[], params: Record<string, string | number>, signal?: AbortSignal): Promise<InsightItem[]> {
    try {
      return (await graph.get<{ data: InsightItem[] }>(path, { metric: names.join(","), ...params }, signal)).data ?? []
    } catch (error) {
      if (!badMetric(error) || names.length === 1) throw error
    }
    const items: InsightItem[] = []
    for (const name of names) {
      try {
        items.push(...((await graph.get<{ data: InsightItem[] }>(path, { metric: name, ...params }, signal)).data ?? []))
      } catch (error) {
        if (!badMetric(error)) throw error
      }
    }
    return items
  }

  return {
    /** The account (`user_id` is the id insights calls use) and its follower count right now */
    async profile(signal?: AbortSignal): Promise<InstagramProfile> {
      const me = await graph.get<{ user_id?: string; id: string; username?: string; followers_count?: number; follows_count?: number; media_count?: number }>(
        "/me",
        { fields: "user_id,username,followers_count,follows_count,media_count" },
        signal,
      )
      return { userId: me.user_id ?? me.id, username: me.username ?? "", followers: numberOrNull(me.followers_count) ?? 0, follows: numberOrNull(me.follows_count), mediaCount: numberOrNull(me.media_count) }
    },

    /** One Central-time day's account totals, plus follows and unfollows (none under 100 followers) */
    async accountDay(igUserId: string, day: Date, signal?: AbortSignal): Promise<AccountDayInsights> {
      const range = dayRange(day)
      const path = `/${encodeURIComponent(igUserId)}/insights`
      const totals = await metrics(path, ACCOUNT_DAY_METRICS, { period: "day", metric_type: "total_value", ...range }, signal)
      // Breakdowns go one metric per call: an unsupported combination fails the whole call
      let follows: { follows: number | null; unfollows: number | null } = { follows: null, unfollows: null }
      try {
        const items = (await graph.get<{ data: InsightItem[] }>(path, { metric: "follows_and_unfollows", period: "day", metric_type: "total_value", breakdown: "follow_type", ...range }, signal)).data ?? []
        follows = followsAndUnfollows(items)
      } catch (error) {
        if (!badMetric(error)) throw error
      }
      return {
        reach: insightValue(totals, "reach"),
        views: insightValue(totals, "views"),
        accountsEngaged: insightValue(totals, "accounts_engaged"),
        totalInteractions: insightValue(totals, "total_interactions"),
        ...follows,
      }
    },

    /** A post's lifetime numbers. Carousel children have none: ask for the album */
    async post(mediaId: string, signal?: AbortSignal): Promise<PostInsights> {
      const items = await metrics(`/${encodeURIComponent(mediaId)}/insights`, POST_METRICS, {}, signal)
      return Object.fromEntries(POST_METRICS.map((name) => [name, insightValue(items, name)])) as PostInsights
    },
  }
}

export type InstagramInsightsApi = ReturnType<typeof instagramInsights>
