import type { FakeService } from "../../fakes/types"
import { FILTER_FIELDS, mentions, parseFilter, type Event } from "./odata"

/**
 * The Vercel Web Analytics fake, mounted at /site-traffic (research/vercel-analytics.md §7): the two
 * page-view query endpoints over about 45 days of made-up page views on the club's paths, deterministic
 * (a seeded random generator, days counted back from when the fake starts). It reproduces Vercel's
 * auth (401 without a token, 403 for a wrong or expired one), "Web Analytics not found." for an unknown
 * project, the 400s for bad by/since/until/limit/filter, the OData filter (production only unless the
 * filter names environment), per-day visitors, the top-N plus "Others" layout, and the Hobby plan's
 * one-month window (clamped, or a 402 with POST /_fake/plan). POST /_fake/fault makes the next calls
 * answer 429 (with Vercel's rate-limit body), 503 or 410. Every other path is a 404.
 */

/** The token and project the fake knows. Built from pieces so no scanner mistakes it for a real token */
export const SITE_TRAFFIC_FAKE_TOKEN = "vcp_" + "jackfakesitetraffic000000000001"
export const SITE_TRAFFIC_FAKE_TOKEN_EXPIRED = "vcp_" + "jackfakesitetrafficexpired000001"
export const SITE_TRAFFIC_FAKE_PROJECT = "prj_" + "jackfakeproject01"
const PROJECT_NAME = "lsr-monorepo"

const DAY = 86_400_000
const DAYS_OF_DATA = 45
const TIME_BY = ["hour", "day", "week", "month", "year"] as const
const MONTH = 30 * DAY

const PATHS: [string, string, number][] = [
  ["/", "/", 30],
  ["/events", "/events", 12],
  ["/events/gm-2", "/events/[slug]", 6],
  ["/events/lsc-round-5", "/events/[slug]", 5],
  ["/lone-star-cup", "/lone-star-cup", 8],
  ["/apply", "/apply", 7],
  ["/drivers/test-driver", "/drivers/[handle]", 4],
  ["/news/season-3-kickoff", "/news/[slug]", 4],
  ["/sponsors", "/sponsors", 3],
  // Officers browse the console all day; the app's filter leaves these out
  ["/admin", "/admin", 10],
  ["/admin/events", "/admin/events", 6],
]
const REFERRERS: [string | null, number][] = [
  [null, 40],
  ["instagram.com", 18],
  ["discord.com", 12],
  ["google.com", 15],
  ["linktr.ee", 8],
  ["t.co", 3],
]
const COUNTRIES: [string, number][] = [
  ["US", 88],
  ["MX", 4],
  ["IN", 3],
  ["GB", 2],
  ["DE", 2],
]
const DEVICES: [string, number][] = [
  ["mobile", 58],
  ["desktop", 38],
  ["tablet", 4],
]

/** mulberry32: a small seeded generator, so every start has the same data */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function pick<T>(next: () => number, weighted: [T, number][]): T {
  const total = weighted.reduce((n, [, w]) => n + w, 0)
  let roll = next() * total
  for (const [value, weight] of weighted) {
    roll -= weight
    if (roll < 0) return value
  }
  return weighted[weighted.length - 1][0]
}

type PageView = Event & { ts: string; visitor: string }

/** About 45 days of page views up to `now`, a busier day every week (a general meeting) */
export function fakePageViews(now: number): PageView[] {
  const next = random(42)
  const views: PageView[] = []
  const today = Math.floor(now / DAY) * DAY
  for (let d = DAYS_OF_DATA; d >= 0; d--) {
    const day = today - d * DAY
    const busy = new Date(day).getUTCDay() === 2
    const count = Math.round((busy ? 140 : 60) + next() * 40)
    for (let i = 0; i < count; i++) {
      const at = day + Math.floor(next() * DAY)
      if (at > now) continue
      const [requestPath, route] = (() => {
        const [path, pattern] = pick(
          next,
          PATHS.map(([p, r, w]) => [[p, r], w] as [[string, string], number]),
        )
        return [path, pattern]
      })()
      views.push({
        ts: new Date(at).toISOString(),
        requestPath,
        route,
        referrerHostname: pick(next, REFERRERS),
        country: pick(next, COUNTRIES),
        deviceType: pick(next, DEVICES),
        browserName: next() < 0.6 ? "Safari" : "Chrome",
        osName: next() < 0.55 ? "iOS" : "Windows",
        environment: next() < 0.95 ? "production" : "preview",
        // Visitors are a hash of the request that changes every day, like Vercel's
        visitor: `${new Date(day).toISOString().slice(0, 10)}:${Math.floor(next() * (busy ? 90 : 45))}`,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
      })
    }
  }
  return views
}

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => Response.json({ error: { code, message, ...extra } }, { status, headers })

/** A `since`/`until` value: ms since the epoch, or a date string. A date-only string is snapped to its day's start (or end, for `until`) */
function instant(raw: string, end: boolean): number | null {
  if (/^\d+$/.test(raw)) return Number(raw)
  const time = Date.parse(raw)
  if (Number.isNaN(time)) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && end ? time + DAY - 1 : time
}

function bucket(ts: string, by: (typeof TIME_BY)[number]): string {
  const d = new Date(ts)
  if (by === "hour") d.setUTCMinutes(0, 0, 0)
  else {
    d.setUTCHours(0, 0, 0, 0)
    if (by === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
    if (by === "month") d.setUTCDate(1)
    if (by === "year") d.setUTCMonth(0, 1)
  }
  return d.toISOString()
}

export const siteTrafficFake: FakeService = {
  id: "site-traffic",
  create() {
    const now = Date.now()
    const views = fakePageViews(now)
    let plan: "clamp" | "402" = "clamp"
    let fault: { status: number; times: number } | null = null

    /** Auth, the project, faults, dates and the filter; the matching views, or the error */
    const select = (request: Request, { requireDates }: { requireDates: boolean }): { views: PageView[]; params: URLSearchParams; since: number | null; until: number | null; filter: string | null } | Response => {
      if (fault && fault.times > 0) {
        fault.times -= 1
        if (fault.status === 429) {
          const reset = Math.ceil((Date.now() + 30_000) / 1000)
          return fail(429, "rate_limited", "Rate limit exceeded", { limit: { remaining: 0, reset, resetMs: reset * 1000, total: 100 } }, { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })
        }
        return fail(fault.status, fault.status === 410 ? "gone" : "service_unavailable", fault.status === 410 ? "Gone" : "Service unavailable")
      }
      const auth = request.headers.get("authorization") ?? ""
      if (!auth.startsWith("Bearer ") || !auth.slice(7).trim()) return fail(401, "unauthorized", "The request is not authorized.")
      const token = auth.slice(7).trim()
      if (token !== SITE_TRAFFIC_FAKE_TOKEN) {
        return fail(403, "forbidden", `Not authorized: Trying to access resource under scope "lsr-team". You must re-authenticate to this scope or use a token with access to this scope.${token === SITE_TRAFFIC_FAKE_TOKEN_EXPIRED ? " (token expired)" : ""}`)
      }
      const params = new URL(request.url).searchParams
      const project = params.get("projectId")
      if (!project) return fail(400, "bad_request", "One of the provided values in the request query is invalid: projectId is required.")
      if (project !== SITE_TRAFFIC_FAKE_PROJECT && project !== PROJECT_NAME) return fail(404, "not_found", "Web Analytics not found.")

      const rawSince = params.get("since")
      const rawUntil = params.get("until")
      if (requireDates && (!rawSince || !rawUntil)) return fail(400, "bad_request", "One of the provided values in the request query is invalid: since and until are required.")
      if (Boolean(rawSince) !== Boolean(rawUntil)) return fail(400, "bad_request", "One of the provided values in the request query is invalid: pass since and until together.")
      let since = rawSince ? instant(rawSince, false) : null
      const until = rawUntil ? instant(rawUntil, true) : null
      if ((rawSince && since === null) || (rawUntil && until === null)) return fail(400, "bad_request", "One of the provided values in the request query is invalid: since and until take a timestamp in ms or a date.")
      // Hobby's reporting window is one month
      if (since !== null && since < now - MONTH) {
        if (plan === "402") return fail(402, "payment_required", "The requested range is outside your plan's reporting window.")
        since = now - MONTH
      }

      const filter = params.get("filter")
      if (filter && filter.length > 2048) return fail(400, "bad_request", "One of the provided values in the request query is invalid: filter is longer than 2048 characters.")
      let predicate: (event: Event) => boolean = () => true
      if (filter) {
        try {
          predicate = parseFilter(filter)
        } catch (error) {
          return fail(400, "bad_request", error instanceof Error ? error.message : "Invalid filter")
        }
      }
      const productionOnly = !filter || !mentions(filter, "environment")
      const matching = views.filter((view) => {
        const at = Date.parse(view.ts)
        return (since === null || at >= since) && (until === null || at <= until) && (!productionOnly || view.environment === "production") && predicate(view)
      })
      return { views: matching, params, since, until, filter }
    }

    const distinct = (list: PageView[]) => new Set(list.map((v) => v.visitor)).size

    return [
      {
        method: "GET",
        path: "/v1/query/web-analytics/visits/count",
        handle: (request) => {
          const picked = select(request, { requireDates: false })
          if (picked instanceof Response) return picked
          return Response.json({ version: 1, query: { ...(picked.filter ? { filter: picked.filter } : {}) }, data: { pageviews: picked.views.length, visitors: distinct(picked.views) } })
        },
      },
      {
        method: "GET",
        path: "/v1/query/web-analytics/visits/aggregate",
        handle: (request) => {
          const picked = select(request, { requireDates: true })
          if (picked instanceof Response) return picked
          const by = picked.params.getAll("by")
          const allowed = [...TIME_BY, ...FILTER_FIELDS] as readonly string[]
          if (!by.length || by.length > 2 || new Set(by).size !== by.length || by.some((b) => !allowed.includes(b)) || by.filter((b) => (TIME_BY as readonly string[]).includes(b)).length > 1) {
            return fail(400, "bad_request", "One of the provided values in the request query is invalid: by takes 1 or 2 different dimensions, at most one of them a time granularity.")
          }
          const rawLimit = picked.params.get("limit")
          const limit = rawLimit === null ? 10 : Number(rawLimit)
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, "bad_request", "One of the provided values in the request query is invalid: limit is between 1 and 100.")

          const groups = new Map<string, { fields: Record<string, string | null>; views: PageView[] }>()
          for (const view of picked.views) {
            const fields: Record<string, string | null> = {}
            for (const b of by) {
              if ((TIME_BY as readonly string[]).includes(b)) fields.timestamp = bucket(view.ts, b as (typeof TIME_BY)[number])
              else fields[b] = view[b] ?? null
            }
            const key = JSON.stringify(fields)
            const group = groups.get(key) ?? { fields, views: [] }
            group.views.push(view)
            groups.set(key, group)
          }
          const timeSeries = by.length === 1 && (TIME_BY as readonly string[]).includes(by[0])
          const sorted = [...groups.values()].sort(timeSeries ? (a, b) => String(a.fields.timestamp).localeCompare(String(b.fields.timestamp)) : (a, b) => b.views.length - a.views.length)
          const row = (fields: Record<string, unknown>, views: PageView[]) => ({ ...fields, pageviews: views.length, visitors: distinct(views) })
          const data = sorted.slice(0, limit).map((g) => row(g.fields, g.views))
          const rest = sorted.slice(limit)
          if (rest.length) {
            // Beyond the limit, everything else is one "Others" group (Vercel's real layout for it is unverified)
            const others = Object.fromEntries(by.filter((b) => !(TIME_BY as readonly string[]).includes(b)).map((b) => [b, "Others"]))
            data.push(row(others, rest.flatMap((g) => g.views)))
          }
          return Response.json({
            version: 1,
            query: { since: new Date(picked.since!).toISOString(), until: new Date(picked.until!).toISOString(), groupBy: by, limit, ...(picked.filter ? { filter: picked.filter } : {}) },
            data,
          })
        },
      },
      {
        method: "POST",
        path: "/_fake/fault",
        handle: async (request) => {
          const body = (await request.json().catch(() => ({}))) as { status?: number; times?: number }
          fault = body.status ? { status: body.status, times: body.times ?? 1 } : null
          return Response.json({ ok: true, fault })
        },
      },
      {
        method: "POST",
        path: "/_fake/plan",
        handle: async (request) => {
          const body = (await request.json().catch(() => ({}))) as { window?: string }
          plan = body.window === "402" ? "402" : "clamp"
          return Response.json({ ok: true, plan })
        },
      },
      { method: "*", path: "/*", handle: () => fail(404, "not_found", "The requested endpoint was not found.") },
    ]
  },
}
