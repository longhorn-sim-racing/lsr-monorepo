import { serviceBaseUrl } from "../base-url"
import type { ConnectorEnv } from "../types"

/**
 * Vercel Web Analytics, read for the daily site traffic snapshot (design §12.5). Vercel has no
 * read-only token: the project-scoped token (VERCEL_ANALYTICS_TOKEN) can also change the production
 * project. So this client can only ever send GETs to the two page-view query paths below; any other
 * path is refused in code before a request is made, and the path is never built from outside input.
 * It never follows a redirect either (fetch would carry the token to wherever one points).
 */

export const SITE_TRAFFIC_REAL_URL = "https://api.vercel.com"

/** The longest one call may take */
export const SITE_TRAFFIC_TIMEOUT_MS = 20_000

/** The only paths this client calls */
export const SITE_TRAFFIC_PATHS = ["/v1/query/web-analytics/visits/aggregate", "/v1/query/web-analytics/visits/count"] as const
export type SiteTrafficPath = (typeof SITE_TRAFFIC_PATHS)[number]

/** The allowlist, checked at run time before every request: nothing reaches another path, whatever a caller passes */
export function assertSiteTrafficPath(path: string): asserts path is SiteTrafficPath {
  if (!(SITE_TRAFFIC_PATHS as readonly string[]).includes(path)) throw new Error(`The site traffic client only reads ${SITE_TRAFFIC_PATHS.join(" and ")}; it refused ${path}`)
}

/**
 * Every query counts the production site's public pages: admin pages are left out (officers browse
 * them all day, and they'd swamp the club's real traffic). Vercel's OData filter (research §3); if
 * Vercel ever refuses it, the smoke test shows its 400 and this is the one line to change
 */
export const PUBLIC_PAGES_FILTER = "environment eq 'production' and not startswith(requestPath,'/admin')"

/** SiteTrafficDaily.dimension values and the Vercel field each one groups by */
export const TRAFFIC_DIMENSIONS = { path: "requestPath", referrer: "referrerHostname", country: "country", device: "deviceType" } as const
export type TrafficDimension = keyof typeof TRAFFIC_DIMENSIONS

export class SiteTrafficApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "SiteTrafficApiError"
  }
}

const HINTS: Record<number, string> = {
  401: "the token is missing or malformed",
  402: "the dates are outside the plan's reporting window (a month on Hobby)",
  403: "the token is wrong, expired or for another project: make a new project-scoped token",
  404: "Web Analytics isn't on for the project, or VERCEL_ANALYTICS_PROJECT_ID is wrong",
  429: "Vercel is rate limiting; the next run tries again",
}

export type TrafficRange = { since: Date; until: Date }
export type TrafficRow = { key: string; pageviews: number; visitors: number }

/** One UTC day, first to last millisecond (exact instants, so no date rounding is left to Vercel) */
export function utcDay(day: string): TrafficRange {
  const since = new Date(`${day}T00:00:00.000Z`)
  return { since, until: new Date(since.getTime() + 86_400_000 - 1) }
}

/** A group's key as stored: Vercel leaves the referrer empty for direct visits, and a field null when it doesn't know */
export function trafficKey(dimension: TrafficDimension, value: unknown): string {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value)
  if (text) return text.slice(0, 500)
  return dimension === "referrer" ? "(direct)" : "(unknown)"
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)

export function siteTrafficClient(token: string, projectId: string, env: ConnectorEnv = process.env) {
  const base = serviceBaseUrl("site-traffic", SITE_TRAFFIC_REAL_URL, env)

  async function get(path: SiteTrafficPath, params: [string, string][], signal?: AbortSignal): Promise<unknown> {
    assertSiteTrafficPath(path)
    const query = new URLSearchParams([["projectId", projectId], ...params])
    const send = async () => {
      const timeout = AbortSignal.timeout(SITE_TRAFFIC_TIMEOUT_MS)
      // "manual": a redirect comes back as itself (fetch would otherwise follow it with the token, to a path the allowlist never saw)
      const response = await fetch(`${base}${path}?${query}`, { method: "GET", redirect: "manual", headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel()
        throw new SiteTrafficApiError(response.status, "redirect", `Vercel answered ${response.status || "a redirect"} on ${path.split("/").pop()}; the site traffic client never follows a redirect (the token would go with it)`)
      }
      return response
    }
    let response = await send()
    // A passing hiccup (Vercel's 500 or 503) gets one more try after a second
    if (response.status === 500 || response.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      signal?.throwIfAborted()
      response = await send()
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
      const code = body?.error?.code ?? "error"
      const hint = HINTS[response.status]
      const said = body?.error?.message ? `: ${body.error.message.slice(0, 300)}` : ""
      throw new SiteTrafficApiError(response.status, code, `Vercel answered ${response.status} (${code}) on ${path.split("/").pop()}${said}${hint ? `. Likely ${hint}` : ""}`)
    }
    return response.json()
  }

  const rangeParams = ({ since, until }: TrafficRange): [string, string][] => [
    ["since", String(since.getTime())],
    ["until", String(until.getTime())],
    ["filter", PUBLIC_PAGES_FILTER],
  ]

  return {
    /** Page views and visitors over the range (visitors are counted per day by Vercel) */
    async count(range: TrafficRange, signal?: AbortSignal): Promise<{ pageviews: number; visitors: number }> {
      const body = (await get("/v1/query/web-analytics/visits/count", rangeParams(range), signal)) as { data?: { pageviews?: unknown; visitors?: unknown } }
      return { pageviews: count(body.data?.pageviews), visitors: count(body.data?.visitors) }
    },
    /** The top `limit` groups of one dimension over the range, by page views; Vercel folds the rest into one "Others" group */
    async top(dimension: TrafficDimension, range: TrafficRange, limit = 100, signal?: AbortSignal): Promise<TrafficRow[]> {
      const field = TRAFFIC_DIMENSIONS[dimension]
      const body = (await get("/v1/query/web-analytics/visits/aggregate", [["by", field], ...rangeParams(range), ["limit", String(limit)]], signal)) as { data?: Record<string, unknown>[] }
      const rows = new Map<string, TrafficRow>()
      for (const row of Array.isArray(body.data) ? body.data : []) {
        const key = trafficKey(dimension, row[field])
        const seen = rows.get(key) ?? { key, pageviews: 0, visitors: 0 }
        seen.pageviews += count(row.pageviews)
        seen.visitors += count(row.visitors)
        rows.set(key, seen)
      }
      return [...rows.values()]
    },
  }
}

export type SiteTrafficClient = ReturnType<typeof siteTrafficClient>
