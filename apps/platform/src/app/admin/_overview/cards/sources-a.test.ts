import type { ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ status: vi.fn(), trafficWeek: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/connectors/site-traffic/connector", () => ({ siteTrafficConnector: { status: mocks.status } }))
vi.mock("@/server/connectors/site-traffic/read", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/connectors/site-traffic/read")>()), trafficWeek: mocks.trafficWeek }))

import { CARDS } from "./sources-a"

const card = CARDS[0]

beforeEach(() => {
  mocks.status.mockResolvedValue({ state: "connected", lastSyncAt: new Date().toISOString() })
})

describe("the site traffic card", () => {
  it("is registered as site-traffic", () => {
    expect(CARDS.map((c) => c.id)).toEqual(["site-traffic"])
  })

  it("compares the latest week with the one before and lists the top pages", async () => {
    mocks.trafficWeek.mockResolvedValue({
      from: "2026-10-15",
      to: "2026-10-21",
      current: { days: 7, pageviews: 700, visitorDays: 280, visitorsPerDay: 40 },
      previous: { days: 7, pageviews: 560, visitorDays: 350, visitorsPerDay: 50 },
      topPages: [{ key: "/apply", pageviews: 180, visitorDays: 150, days: 7 }],
    })
    const html = renderToStaticMarkup((await card.Card()) as ReactElement)
    expect(html).toContain("Oct 15 to Oct 21 (UTC days)")
    expect(html).toContain("700")
    expect(html).toContain("+25%")
    expect(html).toContain("-20%")
    expect(html).toContain('href="/apply"')
  })

  it("links only paths on this site; any other page key is plain text", async () => {
    const keys = ["//evil.example/login", "/\\evil.example", "/\n/evil.example", "/\t/evil.example", "https://evil.example/", "(unknown)"]
    mocks.trafficWeek.mockResolvedValue({
      from: "2026-10-15",
      to: "2026-10-21",
      current: { days: 7, pageviews: 70, visitorDays: 28, visitorsPerDay: 4 },
      previous: undefined,
      topPages: [{ key: "/events/gm-2", pageviews: 20, visitorDays: 10, days: 7 }, ...keys.map((key) => ({ key, pageviews: 5, visitorDays: 5, days: 7 }))],
    })
    const html = renderToStaticMarkup((await card.Card()) as ReactElement)
    expect(html).toContain('href="/events/gm-2"')
    expect(html.match(/href=/g)).toHaveLength(1)
    expect(html).toContain("//evil.example/login")
    expect(html).not.toContain("href=\"//")
  })

  it("shows nothing until a snapshot exists", async () => {
    mocks.trafficWeek.mockResolvedValue(null)
    expect(await card.Card()).toBeNull()
  })
})
