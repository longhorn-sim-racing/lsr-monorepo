import type { ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

const checks = vi.hoisted(() => ({ runDigestChecks: vi.fn() }))
vi.mock("@/server/automation/run-checks", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/automation/run-checks")>()), runDigestChecks: checks.runDigestChecks }))
vi.mock("@/server/automation/registry", () => ({ DIGEST_CHECKS: [] }))

import { CARDS } from "./automation"

const card = CARDS[0]
const AT = new Date("2026-10-26T17:00:00Z")

describe("the Needs attention card", () => {
  it("is registered first on the Overview", () => {
    expect(CARDS.map((c) => [c.id, c.order])).toEqual([["needs-attention", 0]])
  })

  it("lists what needs attention live, most urgent first, with each check's first items and the ones that couldn't run", async () => {
    checks.runDigestChecks.mockResolvedValue({
      at: AT,
      outcomes: [
        {
          check: { id: "action_items.overdue", label: "Overdue action items", href: "/admin/action-items?status=overdue", order: 20 },
          result: {
            count: 5,
            severity: "warning",
            items: [
              { title: "Dylan: 2 overdue", href: "/admin/action-items?owner=dylan", detail: "Oldest due Oct 10" },
              { title: "Alex: 1 overdue", href: "/admin/action-items?owner=alex" },
              { title: "Sam: 1 overdue", href: "/admin/action-items?owner=sam" },
              { title: "Kim: 1 overdue", href: "/admin/action-items?owner=kim" },
            ],
          },
          error: null,
        },
        { check: { id: "jack.spend", label: "Jack's monthly budget", href: "/admin/jack/usage", order: 95 }, result: { count: 1, severity: "danger", items: [{ title: "October: $50.20 of $50 spent", href: "/admin/jack/usage" }] }, error: null },
        { check: { id: "knowledge.stale", label: "Knowledge over 6 months old", href: "/admin/knowledge?view=stale", order: 81 }, result: { count: 0, severity: "info", items: [] }, error: null },
        { check: { id: "twitch.attention", label: "Twitch connection", href: "/admin/streams", order: 60 }, result: null, error: "Twitch answered 401" },
      ],
    })
    const html = renderToStaticMarkup((await card.Card()) as ReactElement)
    expect(html).toContain("6 things across the console")
    expect(html.indexOf("Jack&#x27;s monthly budget")).toBeLessThan(html.indexOf("Overdue action items"))
    expect(html).toContain('href="/admin/action-items?owner=dylan"')
    expect(html).toContain("Oldest due Oct 10")
    expect(html).not.toContain("Kim: 1 overdue")
    // Only the items cut here (the check's own count can be in other units)
    expect(html).toContain("and 1 more")
    expect(html).not.toContain("Knowledge over 6 months old")
    expect(html).toContain("Couldn&#x27;t check: Twitch connection")
    expect(html).not.toContain("401")
    expect(html).toContain('href="/admin/jack/recurring#digest"')
  })

  it("says so plainly when nothing needs attention", async () => {
    checks.runDigestChecks.mockResolvedValue({ at: AT, outcomes: [] })
    expect(renderToStaticMarkup((await card.Card()) as ReactElement)).toContain("Nothing needs attention right now.")
  })
})
