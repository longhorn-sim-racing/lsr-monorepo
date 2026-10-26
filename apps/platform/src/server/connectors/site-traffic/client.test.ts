import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "../fakes/testing"
import { assertSiteTrafficPath, PUBLIC_PAGES_FILTER, SITE_TRAFFIC_PATHS, SITE_TRAFFIC_TIMEOUT_MS, SiteTrafficApiError, siteTrafficClient, trafficKey, utcDay } from "./client"
import { fakePageViews, SITE_TRAFFIC_FAKE_PROJECT, SITE_TRAFFIC_FAKE_TOKEN, SITE_TRAFFIC_FAKE_TOKEN_EXPIRED, siteTrafficFake } from "./fake/handlers"
import { parseFilter } from "./fake/odata"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const client = (token = SITE_TRAFFIC_FAKE_TOKEN, project = SITE_TRAFFIC_FAKE_PROJECT) => siteTrafficClient(token, project)

describe("the site traffic client against the fake", () => {
  it("reads a UTC day's total and top pages, public pages only", async () => {
    const fakes = mountFakes([siteTrafficFake])
    const day = yesterday()
    const range = utcDay(day)
    const total = await client().count(range)
    const pages = await client().top("path", range)

    // What the fake would count: production page views that day outside /admin
    const expected = fakePageViews(Date.now()).filter((v) => v.ts.startsWith(day) && v.environment === "production" && !v.requestPath!.startsWith("/admin"))
    expect(total.pageviews).toBe(expected.length)
    expect(total.visitors).toBe(new Set(expected.map((v) => v.visitor)).size)
    expect(pages.reduce((n, p) => n + p.pageviews, 0)).toBe(expected.length)
    expect(pages.some((p) => p.key.startsWith("/admin"))).toBe(false)

    for (const request of fakes.requests) {
      expect(request.method).toBe("GET")
      expect(SITE_TRAFFIC_PATHS).toContain(request.path)
      const params = new URL(request.url).searchParams
      expect(params.get("filter")).toBe(PUBLIC_PAGES_FILTER)
      expect(params.get("since")).toBe(String(range.since.getTime()))
      // count gets the exclusive end (Vercel rounds its `until` down to the day); aggregate the last millisecond
      expect(params.get("until")).toBe(String(range.until.getTime() + (request.path.endsWith("/count") ? 1 : 0)))
    }
    expect(fakes.requests[0].headers.get("authorization")).toBe(`Bearer ${SITE_TRAFFIC_FAKE_TOKEN}`)
  })

  it("groups referrers with (direct) for none, and folds the rest into Others past the limit", async () => {
    mountFakes([siteTrafficFake])
    const referrers = await client().top("referrer", utcDay(yesterday()))
    expect(referrers.map((r) => r.key)).toContain("(direct)")
    const top2 = await client().top("path", utcDay(yesterday()), 2)
    expect(top2).toHaveLength(3)
    expect(top2[2].key).toBe("Others")
  })

  it("says why a call failed, never with the token", async () => {
    mountFakes([siteTrafficFake])
    const expired = await client(SITE_TRAFFIC_FAKE_TOKEN_EXPIRED)
      .count(utcDay(yesterday()))
      .catch((e: unknown) => e)
    expect(expired).toBeInstanceOf(SiteTrafficApiError)
    expect(expired).toMatchObject({ status: 403, code: "forbidden" })
    expect(String((expired as Error).message)).toMatch(/make a new project-scoped token/)
    expect(String((expired as Error).message)).not.toContain(SITE_TRAFFIC_FAKE_TOKEN_EXPIRED)
    await expect(client(SITE_TRAFFIC_FAKE_TOKEN, "prj_other").count(utcDay(yesterday()))).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/Web Analytics isn't on/) })
    await expect(client("").count(utcDay(yesterday()))).rejects.toMatchObject({ status: 401 })
  })

  it("tries a 503 once more, and stops on a rate limit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 })
    const fakes = mountFakes([siteTrafficFake])
    await fetch("http://127.0.0.1:3999/site-traffic/_fake/fault", { method: "POST", body: JSON.stringify({ status: 503, times: 1 }) })
    const answer = client().count(utcDay(yesterday()))
    await vi.advanceTimersByTimeAsync(1_100)
    expect((await answer).pageviews).toBeGreaterThan(0)
    expect(fakes.requests.filter((r) => r.path.endsWith("/count"))).toHaveLength(2)

    await fetch("http://127.0.0.1:3999/site-traffic/_fake/fault", { method: "POST", body: JSON.stringify({ status: 429, times: 1 }) })
    await expect(client().count(utcDay(yesterday()))).rejects.toMatchObject({ status: 429, code: "rate_limited" })
  })

  it("keeps a timeout on every call and stops when the caller's signal aborts", async () => {
    const fakes = mountFakes([siteTrafficFake])
    const timeout = vi.spyOn(AbortSignal, "timeout")
    const reason = new DOMException("deadline", "TimeoutError")
    await expect(client().count(utcDay(yesterday()), AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(timeout).toHaveBeenCalledWith(SITE_TRAFFIC_TIMEOUT_MS)
    expect(fakes.requests).toHaveLength(0)
  })

  it("never follows a redirect: a 302 fails the call, and the token goes nowhere else", async () => {
    const fakes = mountFakes([siteTrafficFake])
    await fetch("http://127.0.0.1:3999/site-traffic/_fake/fault", { method: "POST", body: JSON.stringify({ status: 302, times: 1 }) })
    // Like real fetch, which the in-process fakes aren't: unless told otherwise it follows a redirect, Authorization and all (same origin)
    const fake = globalThis.fetch
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const response = await fake(input, init)
      const location = response.headers.get("location")
      const redirected = response.status >= 300 && response.status < 400 && location
      if (redirected && init?.redirect === "error") throw new TypeError("fetch failed")
      if (redirected && (init?.redirect ?? "follow") === "follow") return fake(new URL(location, String(input)), init)
      return response
    })

    await expect(client().count(utcDay(yesterday()))).rejects.toMatchObject({ status: 302, code: "redirect", message: expect.stringMatching(/never follows a redirect/) })
    const calls = fakes.requests.filter((r) => !r.path.startsWith("/_fake"))
    expect(calls.map((r) => r.path)).toEqual(["/v1/query/web-analytics/visits/count"])
  })

  it("refuses any path but the two page-view queries, before a request is made", () => {
    expect(() => assertSiteTrafficPath("/v9/projects/prj_x")).toThrow(/refused \/v9\/projects\/prj_x/)
    expect(() => assertSiteTrafficPath("/v1/query/web-analytics/visits/count/../../../../v9/projects")).toThrow()
    expect(() => assertSiteTrafficPath("/v1/query/web-analytics/visits/aggregate?x=1")).toThrow()
    for (const path of SITE_TRAFFIC_PATHS) expect(() => assertSiteTrafficPath(path)).not.toThrow()
  })
})

describe("the fake's checks", () => {
  it("rounds until as Vercel does: count down to the day, aggregate up to the hour", async () => {
    mountFakes([siteTrafficFake])
    const base = "http://127.0.0.1:3999/site-traffic/v1/query/web-analytics/visits"
    const day = yesterday()
    const since = Date.parse(`${day}T00:00:00.000Z`)
    const ask = async (path: string, until: number, extra = "") => {
      const url = `${base}/${path}?projectId=${SITE_TRAFFIC_FAKE_PROJECT}&since=${since}&until=${until}${extra}`
      return (await (await fetch(url, { headers: { authorization: `Bearer ${SITE_TRAFFIC_FAKE_TOKEN}` } })).json()) as { data: unknown }
    }
    const lastMs = since + 86_400_000 - 1
    // count: the day's last millisecond rounds down to its start, an empty range (what hit production)
    expect(((await ask("count", lastMs)).data as { pageviews: number }).pageviews).toBe(0)
    const whole = ((await ask("count", lastMs + 1)).data as { pageviews: number }).pageviews
    expect(whole).toBeGreaterThan(0)
    // aggregate: the last millisecond rounds up to midnight, the same day
    const rows = (await ask("aggregate", lastMs, "&by=country&limit=100")).data as { pageviews: number }[]
    expect(rows.reduce((n, r) => n + r.pageviews, 0)).toBe(whole)
  })

  it("answers Vercel's 400s for a bad query", async () => {
    mountFakes([siteTrafficFake])
    const base = `http://127.0.0.1:3999/site-traffic/v1/query/web-analytics/visits/aggregate?projectId=${SITE_TRAFFIC_FAKE_PROJECT}&since=2026-10-01&until=2026-10-02`
    const get = (query: string) => fetch(`${base}${query}`, { headers: { authorization: `Bearer ${SITE_TRAFFIC_FAKE_TOKEN}` } })
    expect((await get("")).status).toBe(400) // no by
    expect((await get("&by=day&by=week")).status).toBe(400) // two time granularities
    expect((await get("&by=requestPath&limit=101")).status).toBe(400)
    const hostname = await get(`&by=requestPath&filter=${encodeURIComponent("requestHostname eq 'x'")}`)
    expect(hostname.status).toBe(400)
    expect((await hostname.json()).error.message).toMatch(/Unsupported subject "requestHostname"/)
    expect((await get("&by=day&by=country")).status).toBe(200)
    expect((await fetch("http://127.0.0.1:3999/site-traffic/v9/projects", { headers: { authorization: `Bearer ${SITE_TRAFFIC_FAKE_TOKEN}` } })).status).toBe(404)
  })

  it("parses the OData filters the client sends", () => {
    const keep = parseFilter(PUBLIC_PAGES_FILTER)
    expect(keep({ environment: "production", requestPath: "/apply" })).toBe(true)
    expect(keep({ environment: "production", requestPath: "/admin/events" })).toBe(false)
    expect(keep({ environment: "preview", requestPath: "/apply" })).toBe(false)
    expect(parseFilter("country in ('US','MX') or (deviceType eq 'tablet')")({ country: "GB", deviceType: "tablet" })).toBe(true)
    expect(parseFilter("referrerHostname eq 'it''s'")({ referrerHostname: "it's" })).toBe(true)
    expect(() => parseFilter("requestPath gt '/'")).toThrow(/operator/)
  })
})

describe("trafficKey", () => {
  it("names empty groups", () => {
    expect(trafficKey("referrer", "")).toBe("(direct)")
    expect(trafficKey("country", null)).toBe("(unknown)")
    expect(trafficKey("path", "/apply")).toBe("/apply")
  })
})
