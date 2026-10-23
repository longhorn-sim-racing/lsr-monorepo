import type { FakeService } from "../../fakes/types"
import { PUBLISH_SCOPE, publishingFake } from "./publishing"

/**
 * The Instagram Graph fake (research/instagram.md §7), mounted at /instagram: what the feed sync
 * (/me, /me/media, /refresh_access_token) and the insights jobs call, so either can run against it
 * (JACK_FAKES, or INSTAGRAM_GRAPH_URL=http://127.0.0.1:3999/instagram for the feed sync).
 * - Paths take an optional version prefix (/v26.0/me); the token comes as `access_token` or a Bearer
 *   header; errors use Graph's envelope with HTTP 400.
 * - Tokens have scopes and an issue time: without instagram_business_manage_insights an insights call
 *   gets code 10; an expired one gets 190/463, after a password change 190/460. A refresh needs a token at
 *   least a day old.
 * - Account insights check metric names (the removed impressions, profile_views and follower_count get
 *   code 100), period and metric_type, and breakdown pairs ("An unknown error has occurred." otherwise).
 *   Numbers are made up from the day, and a day that ended under 48 hours ago gets 60% of them: it fills
 *   in later, as Instagram's does. Under 100 followers, follows_and_unfollows comes back empty.
 * - Post insights check the metric set per media type; album children have none; a deleted post (or an
 *   id that isn't a media id) gets 100/33. Media ids it doesn't know but that look real (15+ digits) are
 *   answered as photos, so the eval copy's real posts get numbers.
 * - Publishing (T9b: containers, their status, media_publish, the quota) is in ./publishing.ts, for a
 *   token with instagram_business_content_publish (`publishToken`).
 */

export const INSTAGRAM_FAKE = {
  /** The read token with the insights permission, as a reconnected token will be */
  token: "IGfake-read-insights-token",
  /** Today's token: basic only (no insights) */
  basicToken: "IGfake-read-basic-token",
  /** The publishing app's token: basic and content_publish (no insights) */
  publishToken: "IGfake-publish-token",
  /** Professional account id (user_id, "IG_ID"); /me's `id` is the app-scoped one */
  userId: "17841400000000000",
  appScopedId: "26172548090000000",
  username: "lsr_fake",
  followers: 1_284,
} as const

const DAY = 86_400_000
const HOUR = 3_600_000

const ACCOUNT_METRICS: Record<string, { breakdowns: string[]; seriesOk?: boolean }> = {
  reach: { breakdowns: ["media_product_type", "follow_type"], seriesOk: true },
  accounts_engaged: { breakdowns: [] },
  views: { breakdowns: ["follow_type", "media_product_type"] },
  total_interactions: { breakdowns: ["media_product_type"] },
  likes: { breakdowns: ["media_product_type"] },
  comments: { breakdowns: ["media_product_type"] },
  saves: { breakdowns: ["media_product_type"] },
  shares: { breakdowns: ["media_product_type"] },
  follows_and_unfollows: { breakdowns: ["follow_type"] },
  profile_links_taps: { breakdowns: ["contact_button_type"] },
  replies: { breakdowns: [] },
  reposts: { breakdowns: [] },
}
const FEED_METRICS = ["reach", "likes", "comments", "saved", "shares", "views", "total_interactions", "profile_visits", "follows", "profile_activity", "reposts"]
const REEL_METRICS = ["reach", "likes", "comments", "saved", "shares", "views", "total_interactions", "ig_reels_avg_watch_time"]

type FakeToken = { scopes: string[]; issuedAt: number; expiresAt: number; dead: "expired" | "password" | null }
type FakeMedia = { id: string; caption: string; media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM"; timestamp: number; children?: string[] }

const SEEDED_POSTS: [daysAgo: number, type: FakeMedia["media_type"], caption: string][] = [
  [1, "IMAGE", "GM 2 recap: 38 drivers, one very wet Spa. Thanks for coming out!"],
  [4, "CAROUSEL_ALBUM", "Lone Star Cup Round 5 podium and the best moments from Long Beach"],
  [8, "VIDEO", "Onboard: the last lap at Monza, decided by 0.08 s"],
  [11, "IMAGE", "Practice nights are back every Tuesday in the Alienware lounge"],
  [15, "CAROUSEL_ALBUM", "Meet the officers for this semester"],
  [19, "IMAGE", "Recruiting is open: apply by Oct 31"],
  [26, "VIDEO", "Lone Star Cup Round 3 highlights"],
  [34, "IMAGE", "Welcome back! First general meeting this Monday"],
  [47, "IMAGE", "Sponsor shout-out: thanks to our partners"],
  [63, "CAROUSEL_ALBUM", "Season 2 awards night"],
]

/** A stable small number from text, for made-up insights */
function hash(text: string): number {
  let h = 2166136261
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619)
  return Math.abs(h)
}

const graphError = (message: string, code: number, subcode?: number, type = "OAuthException") =>
  Response.json({ error: { message, type, code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), fbtrace_id: "FakeTrace123" } }, { status: 400 })

export const instagramFake: FakeService = {
  id: "instagram",
  create() {
    const created = Date.now()
    const tokens = new Map<string, FakeToken>([
      [INSTAGRAM_FAKE.token, { scopes: ["instagram_business_basic", "instagram_business_manage_insights"], issuedAt: created - 3 * DAY, expiresAt: created + 57 * DAY, dead: null }],
      [INSTAGRAM_FAKE.basicToken, { scopes: ["instagram_business_basic"], issuedAt: created - 3 * DAY, expiresAt: created + 57 * DAY, dead: null }],
      [INSTAGRAM_FAKE.publishToken, { scopes: ["instagram_business_basic", PUBLISH_SCOPE], issuedAt: created - 3 * DAY, expiresAt: created + 57 * DAY, dead: null }],
    ])
    const media: FakeMedia[] = SEEDED_POSTS.map(([days, type, caption], i) => ({
      id: `180123456789000${String(i + 10)}`,
      caption,
      media_type: type,
      timestamp: created - days * DAY - 5 * HOUR,
      ...(type === "CAROUSEL_ALBUM" ? { children: [`179000000000000${i}1`, `179000000000000${i}2`] } : {}),
    }))
    const deleted = new Set<string>()
    const fewViewers = new Set<string>()
    let followers: number = INSTAGRAM_FAKE.followers
    let throttleNext = 0
    let issued = 0

    const children = new Set(media.flatMap((m) => m.children ?? []))
    const findMedia = (id: string) => media.find((m) => m.id === id)
    const publishing = publishingFake({ userId: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username, graphError, addPost: (post) => media.push(post) })

    /** The request's token, or the error Graph would answer */
    function auth(request: Request, url: URL): FakeToken | Response {
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const value = url.searchParams.get("access_token") ?? bearer
      if (!value) return graphError("An active access token must be used to query information about the current user.", 2500)
      const token = tokens.get(value)
      if (!token) return graphError("Invalid OAuth access token - Cannot parse access token", 190)
      if (token.dead === "password") return graphError("Error validating access token: The session has been invalidated because the user changed their password.", 190, 460)
      if (token.dead === "expired" || token.expiresAt <= Date.now()) return graphError("Error validating access token: Session has expired.", 190, 463)
      return token
    }

    const mediaJson = (m: FakeMedia) => ({
      id: m.id,
      caption: m.caption,
      media_type: m.media_type,
      media_url: m.media_type === "VIDEO" ? undefined : `https://scontent.cdninstagram.com/fake/${m.id}.jpg`,
      thumbnail_url: m.media_type === "VIDEO" ? `https://scontent.cdninstagram.com/fake/${m.id}-cover.jpg` : undefined,
      permalink: `https://www.instagram.com/p/FAKE${m.id.slice(-6)}/`,
      timestamp: new Date(m.timestamp).toISOString().replace(/\.\d{3}Z$/, "+0000"),
      like_count: 40 + (hash(m.id) % 90),
      comments_count: hash(m.id) % 12,
      ...(m.children ? { children: { data: m.children.map((id) => ({ id, media_type: "IMAGE", media_url: `https://scontent.cdninstagram.com/fake/${id}.jpg` })) } } : {}),
    })

    /** A day's made-up account numbers; the last 48 hours aren't all in yet */
    function accountValue(metric: string, since: number, until: number): number {
      const day = Math.floor(since / 86_400)
      const base = 160 + (hash(`${metric}:${day}`) % 140)
      const final = metric === "views" ? base * 3 : metric === "accounts_engaged" ? Math.round(base / 6) : metric === "total_interactions" ? Math.round(base / 3) : base
      return until * 1000 > Date.now() - 48 * HOUR ? Math.round(final * 0.6) : final
    }

    function accountInsights(url: URL): Response {
      const metrics = (url.searchParams.get("metric") ?? "").split(",").filter(Boolean)
      if (!metrics.length) return graphError("(#100) The parameter metric is required", 100)
      for (const metric of metrics) {
        if (!ACCOUNT_METRICS[metric]) return graphError(`(#100) metric[0] must be one of the following values: ${Object.keys(ACCOUNT_METRICS).join(", ")}`, 100)
      }
      const period = url.searchParams.get("period")
      if (period !== "day") return graphError("(#100) The parameter period is required and must be day for these metrics", 100)
      const metricType = url.searchParams.get("metric_type") ?? "time_series"
      if (metricType === "time_series" && metrics.some((m) => !ACCOUNT_METRICS[m].seriesOk)) return graphError("(#100) This metric only supports total_value", 100)
      const breakdown = url.searchParams.get("breakdown")
      if (breakdown && (metricType !== "total_value" || metrics.length !== 1 || !ACCOUNT_METRICS[metrics[0]].breakdowns.includes(breakdown))) return graphError("An unknown error has occurred.", 1, undefined, "OAuthException")
      const until = Number(url.searchParams.get("until") ?? Math.floor(Date.now() / 1000))
      const since = Number(url.searchParams.get("since") ?? until - 86_400)
      const data = metrics.flatMap((metric): Record<string, unknown>[] => {
        if (metric === "follows_and_unfollows") {
          if (followers < 100) return []
          const day = Math.floor(since / 86_400)
          const follows = 2 + (hash(`follows:${day}`) % 6)
          const unfollows = hash(`unfollows:${day}`) % 3
          return [{ name: metric, period: "day", title: "Follows and unfollows", total_value: { value: follows + unfollows, ...(breakdown ? { breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: follows }, { dimension_values: ["NON_FOLLOWER"], value: unfollows }] }] } : {}) }, id: `${INSTAGRAM_FAKE.userId}/insights/${metric}/day` }]
        }
        const value = accountValue(metric, since, until)
        if (metricType === "time_series") return [{ name: metric, period: "day", values: [{ value, end_time: new Date(until * 1000).toISOString().replace(/\.\d{3}Z$/, "+0000") }], id: `${INSTAGRAM_FAKE.userId}/insights/${metric}/day` }]
        return [{ name: metric, period: "day", title: metric, total_value: { value }, id: `${INSTAGRAM_FAKE.userId}/insights/${metric}/day` }]
      })
      return Response.json({ data, paging: { previous: "https://graph.instagram.com/fake-previous", next: "https://graph.instagram.com/fake-next" } })
    }

    function mediaInsights(mediaId: string, url: URL): Response {
      if (children.has(mediaId)) return graphError("(#10) Insights are not available for carousel children; use the album id", 10)
      const known = findMedia(mediaId)
      const looksReal = /^\d{15,}$/.test(mediaId)
      if (deleted.has(mediaId) || (!known && !looksReal)) return graphError(`Unsupported get request. Object with ID '${mediaId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, 100, 33, "GraphMethodException")
      if (fewViewers.has(mediaId)) return graphError("(#10) Not enough viewers for the media to show insights", 10)
      const allowed = known?.media_type === "VIDEO" ? REEL_METRICS : FEED_METRICS
      const metrics = (url.searchParams.get("metric") ?? "").split(",").filter(Boolean)
      const bad = metrics.find((m) => !allowed.includes(m))
      if (!metrics.length || bad) return graphError(`(#100) The Media Insights API does not support the ${bad ?? "empty"} metric for this media product type.`, 100)
      const h = hash(mediaId)
      const reach = 300 + (h % 900)
      const values: Record<string, number> = { reach, views: reach * 2 + (h % 50), likes: 40 + (h % 90), comments: h % 12, saved: h % 15, shares: h % 9, total_interactions: 60 + (h % 100), profile_visits: h % 20, follows: h % 4, reposts: h % 3, profile_activity: h % 7, ig_reels_avg_watch_time: 4_000 + (h % 3_000) }
      return Response.json({ data: metrics.map((m) => ({ name: m, period: "lifetime", values: [{ value: values[m] ?? 0 }], title: m, id: `${mediaId}/insights/${m}/lifetime` })) })
    }

    return [
      {
        // Test hooks: { expire: true } kills every token (190/463); { passwordChanged: true } (190/460); { throttle: N }; { followers: N }; { deleteMedia: [ids] }; { fewViewers: [ids] } (code 10, "Not enough viewers"); { addMedia: { id, type, caption, daysAgo } }
        method: "POST",
        path: "/_fake/state",
        async handle(request) {
          const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
          if (body.expire === true) for (const token of tokens.values()) token.dead = "expired"
          if (body.passwordChanged === true) for (const token of tokens.values()) token.dead = "password"
          if (typeof body.throttle === "number") throttleNext = body.throttle
          if (typeof body.followers === "number") followers = body.followers
          if (Array.isArray(body.deleteMedia)) for (const id of body.deleteMedia) deleted.add(String(id))
          if (Array.isArray(body.fewViewers)) for (const id of body.fewViewers) fewViewers.add(String(id))
          const add = body.addMedia as { id?: string; type?: FakeMedia["media_type"]; caption?: string; daysAgo?: number } | undefined
          if (add?.id) media.push({ id: add.id, media_type: add.type ?? "IMAGE", caption: add.caption ?? "", timestamp: Date.now() - (add.daysAgo ?? 0) * DAY })
          return Response.json({ followers, throttleNext, media: media.length, deleted: [...deleted] })
        },
      },
      ...publishing.routes,
      {
        method: "*",
        path: "/*",
        handle(request, ctx) {
          const url = new URL(request.url)
          // An optional version: /v26.0/me → /me
          const path = ctx.path.replace(/^\/v\d+\.\d+(?=\/)/, "")
          if (throttleNext > 0) {
            throttleNext--
            return new Response(JSON.stringify({ error: { message: "Application request limit reached", type: "OAuthException", code: 4, fbtrace_id: "FakeTrace123" } }), {
              status: 400,
              headers: { "content-type": "application/json", "x-business-use-case-usage": JSON.stringify({ [INSTAGRAM_FAKE.userId]: [{ type: "instagram", call_count: 100, total_cputime: 30, total_time: 40, estimated_time_to_regain_access: 5 }] }) },
            })
          }
          const token = auth(request, url)
          if (token instanceof Response) return token

          if (request.method === "GET" && path === "/me") {
            const fields = (url.searchParams.get("fields") ?? "id").split(",")
            const all: Record<string, unknown> = { id: INSTAGRAM_FAKE.appScopedId, user_id: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username, account_type: "Business", followers_count: followers, follows_count: 211, media_count: media.length }
            return Response.json(Object.fromEntries([["id", all.id], ...fields.filter((f) => f in all).map((f) => [f, all[f]])]))
          }
          if (request.method === "GET" && (path === "/me/media" || path === `/${INSTAGRAM_FAKE.userId}/media`)) {
            const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 25) || 25)
            const offset = Number(Buffer.from(url.searchParams.get("after") ?? "", "base64url").toString() || 0) || 0
            const sorted = media.filter((m) => !deleted.has(m.id)).sort((a, b) => b.timestamp - a.timestamp)
            const page = sorted.slice(offset, offset + limit)
            const after = offset + limit < sorted.length ? Buffer.from(String(offset + limit)).toString("base64url") : null
            return Response.json({ data: page.map(mediaJson), paging: { cursors: { before: Buffer.from(String(offset)).toString("base64url"), ...(after ? { after } : {}) } } })
          }
          if (request.method === "GET" && path === "/refresh_access_token") {
            if (url.searchParams.get("grant_type") !== "ig_refresh_token") return graphError("(#100) grant_type must be ig_refresh_token", 100)
            if (Date.now() - token.issuedAt < DAY) return graphError("(#100) The access token must be at least 24 hours old to refresh", 100)
            const fresh = `IGfake-refreshed-${++issued}`
            tokens.set(fresh, { ...token, issuedAt: Date.now(), expiresAt: Date.now() + 60 * DAY })
            return Response.json({ access_token: fresh, token_type: "bearer", expires_in: 5_184_000 })
          }
          const insights = /^\/([^/]+)\/insights$/.exec(path)
          if (request.method === "GET" && insights) {
            if (!token.scopes.includes("instagram_business_manage_insights")) return graphError("(#10) Application does not have permission for this action", 10)
            const target = decodeURIComponent(insights[1])
            if (target === INSTAGRAM_FAKE.userId || target === "me") return accountInsights(url)
            return mediaInsights(target, url)
          }
          const published = publishing.handle(request, url, path, token.scopes)
          if (published) return published
          return graphError(`Unsupported ${request.method.toLowerCase()} request. Object with ID '${path.split("/")[1] ?? ""}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, 100, 33, "GraphMethodException")
        },
      },
    ]
  },
}
