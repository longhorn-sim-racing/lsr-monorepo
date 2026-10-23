import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { instagramInsightsConnector } from "@/server/connectors/instagram/connector"
import { instagramAccountDays, instagramInsightsOverview, listPostInsights, POST_SORTS, type PostWithInsights, type WeekTotals } from "@/server/queries/instagram-insights"
import { forModelWithLists, plural, tableDisplay } from "./display"
import { sourceConnection } from "./source-connection"
import { centralDateInput, centralRange, ct, ctShort } from "./time"

import type { JackTool, JackToolResult } from "./types"

/**
 * instagram_insights (#188, design §7.1, sources-b): the club account's Instagram numbers from the
 * snapshots the insights jobs keep: daily reach, views, accounts engaged, interactions, follows and
 * followers, and each post's reach, likes, comments, saves, shares and views. Captions are the club's
 * own posts but still outside text.
 */

const VIEWS = ["overview", "daily", "posts", "post"] as const

const input = z.object({
  view: z
    .enum(VIEWS)
    .default("overview")
    .describe("overview: followers, the last 7 days against the 7 before, and the top posts of the last 30 days. daily: the account's numbers per day. posts: posts with their numbers. post: one post, by postId or by text from its caption"),
  from: centralDateInput.optional().describe("First Central date, YYYY-MM-DD (daily: the day; posts: when it was posted). Default 30 days ago"),
  to: centralDateInput.optional().describe("Last Central date (default today)"),
  sort: z.enum(POST_SORTS).default("recent").describe("posts: newest first, or most reach, views, likes, comments, saves (saved) or shares first"),
  postId: z.string().trim().min(1).max(40).optional().describe("A post's id from a posts result (view post)"),
  match: z.string().trim().min(2).max(80).optional().describe("Text from a post's caption (view post or posts)"),
  limit: z.number().int().min(1).max(100).default(20).describe("Most posts to list"),
})

type Input = z.infer<typeof input>

const DATA_NOTES = [
  "Account numbers are per Central day and Instagram sends them up to 2 days late: the newest days may still grow.",
  "Weekly figures add up daily numbers, so an account reached on several days counts once per day.",
  "A post's numbers are lifetime totals as of insightsAt. Instagram keeps account numbers 90 days, which is why the site snapshots them.",
]

const day = (date: Date) => date.toISOString().slice(0, 10)
const snippet = (caption: string | null) => (caption ? (caption.length > 140 ? `${caption.slice(0, 137)}…` : caption) : null)

function postForModel(p: PostWithInsights) {
  return {
    id: p.id,
    posted: ct(p.postedAt),
    type: p.mediaType,
    caption: snippet(p.caption),
    link: p.permalink,
    reach: p.reach,
    likes: p.likes,
    comments: p.comments,
    saves: p.saved,
    shares: p.shares,
    views: p.views,
    numbersAsOf: p.insightsAt ? ct(p.insightsAt) : "not read yet",
    ...(p.hidden ? { hiddenOnSite: true } : {}),
  }
}

const postsTable = (posts: PostWithInsights[], caption?: string) =>
  tableDisplay(
    posts,
    [
      { header: "Posted", value: (p) => ctShort(p.postedAt) },
      { header: "Caption", value: (p) => snippet(p.caption) ?? "—" },
      { header: "Reach", value: (p) => p.reach ?? "—" },
      { header: "Likes", value: (p) => p.likes ?? "—" },
      { header: "Comments", value: (p) => p.comments ?? "—" },
      { header: "Saves", value: (p) => p.saved ?? "—" },
      { header: "Shares", value: (p) => p.shares ?? "—" },
      { header: "Views", value: (p) => p.views ?? "—" },
    ],
    caption,
  )

const change = (now: number | null, before: number | null) => (now !== null && before !== null && before > 0 ? `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}% on the week before` : undefined)
const weekForModel = (w: WeekTotals) => ({ daysWithNumbers: w.days, reach: w.reach, views: w.views, accountsEngaged: w.accountsEngaged, interactions: w.totalInteractions, follows: w.follows, unfollows: w.unfollows })

async function overview(now: Date): Promise<JackToolResult> {
  const [data, connection] = await Promise.all([instagramInsightsOverview(now), sourceConnection(instagramInsightsConnector, "Instagram insights")])
  const { followers, week, previousWeek } = data
  const displays: JackToolDisplay[] = [
    {
      kind: "stats",
      items: [
        { label: "Followers", value: followers.latest?.followers ?? "—", hint: followers.change30 !== null ? `${followers.change30 >= 0 ? "+" : ""}${followers.change30} in 30 days` : undefined },
        { label: "Reach (7 days)", value: week.reach ?? "—", hint: change(week.reach, previousWeek.reach) },
        { label: "Views (7 days)", value: week.views ?? "—", hint: change(week.views, previousWeek.views) },
        { label: "Interactions (7 days)", value: week.totalInteractions ?? "—", hint: change(week.totalInteractions, previousWeek.totalInteractions) },
      ],
    },
  ]
  if (data.topPosts.length) displays.push(postsTable(data.topPosts, "Most reached posts, last 30 days"))
  else if (!connection.connected) displays.push({ kind: "note", text: connection.note ?? "Instagram insights aren't connected." })
  return {
    forModel: forModelWithLists(
      {
        connection: connection.note,
        followers: { latest: followers.latest?.followers ?? null, asOf: followers.latest ? day(followers.latest.date) : null, changeLast7Days: followers.change7, changeLast30Days: followers.change30 },
        last7Days: weekForModel(week),
        previous7Days: weekForModel(previousWeek),
        newestDayWithNumbers: data.lastDayWithNumbers ? day(data.lastDayWithNumbers) : null,
        postNumbersUpdated: data.postsUpdatedAt ? ct(data.postsUpdatedAt) : null,
        dataNotes: DATA_NOTES,
      },
      [{ key: "topPostsLast30Days", items: data.topPosts.map(postForModel) }],
    ),
    label: "Looked at Instagram insights",
    displays,
  }
}

export const instagramInsightsTool: JackTool<Input> = {
  name: "instagram_insights",
  description:
    "Instagram insights for the club's account, from the snapshots the site keeps: followers over time; daily reach, views, accounts engaged, interactions, follows and unfollows; and each post's reach, likes, comments, saves, shares and views (top posts, a date range, or one post found by its caption). Says when Instagram isn't connected or how fresh the numbers are.",
  input,
  deferred: true,
  async run(args) {
    const now = new Date()
    if (args.view === "overview") return overview(now)
    const connection = await sourceConnection(instagramInsightsConnector, "Instagram insights")
    const range = centralRange(args, { fromDaysAgo: 30, toDaysAhead: 0 }, now)
    if (!range.ok) return { isError: true, forModel: range.error, label: "Instagram lookup failed", displays: [] }

    if (args.view === "daily") {
      const days = await instagramAccountDays({ from: new Date(`${range.from}T00:00:00Z`), to: new Date(`${range.to}T00:00:00Z`) })
      const rows = days.map((d) => ({ date: day(d.date), followers: d.followers, reach: d.reach, views: d.views, accountsEngaged: d.accountsEngaged, interactions: d.totalInteractions, follows: d.follows, unfollows: d.unfollows }))
      const charted = rows.filter((r) => r.reach !== null)
      return {
        forModel: forModelWithLists({ connection: connection.note, from: range.from, to: range.to, note: rows.length ? "Days without a row weren't snapshotted; null means Instagram had no number yet." : "No account snapshots in this range.", dataNotes: DATA_NOTES }, [{ key: "days", items: rows, keep: "last", whenTrimmed: "Ask for a shorter range." }]),
        label: `Looked at Instagram's daily numbers (${plural(rows.length, "day")})`,
        displays: charted.length > 1 ? [{ kind: "chart", chart: { type: "line", title: "Instagram reach and views per day", xKey: "date", series: [{ key: "reach", label: "Reach" }, { key: "views", label: "Views" }], rows: charted.map((r) => ({ date: r.date, reach: r.reach, views: r.views })) } }] : [],
      }
    }

    if (args.view === "post") {
      if (!args.postId && !args.match) return { isError: true, forModel: "Give a postId from a posts result, or match with text from its caption.", label: "Instagram lookup failed", displays: [] }
      const posts = await listPostInsights({ id: args.postId, match: args.match, limit: 5 })
      if (!posts.length) return { isError: true, forModel: args.postId ? `No post with id ${args.postId}.` : `No post's caption contains "${args.match}". Try view posts.`, label: "Looked at an Instagram post (none found)", displays: [] }
      return {
        forModel: forModelWithLists({ connection: connection.note, ...(posts.length > 1 ? { note: `${posts.length} posts match; each is listed.` } : {}), dataNotes: DATA_NOTES }, [{ key: "posts", items: posts.map(postForModel) }]),
        label: `Looked at an Instagram post (${ctShort(posts[0].postedAt)})`,
        displays: [postsTable(posts)],
      }
    }

    const posts = await listPostInsights({ from: range.start, to: new Date(range.end.getTime() + 1), sort: args.sort, match: args.match, limit: args.limit })
    return {
      forModel: forModelWithLists({ connection: connection.note, from: range.from, to: range.to, sort: args.sort, dataNotes: DATA_NOTES }, [{ key: "posts", items: posts.map(postForModel) }]),
      label: `Looked at Instagram posts (${plural(posts.length, "post")})`,
      displays: posts.length ? [postsTable(posts, `Posted ${range.from} to ${range.to}`)] : [{ kind: "note", text: connection.connected && !connection.failing ? "No posts in this range." : (connection.note ?? "No posts in this range.") }],
    }
  },
}
