import { afterEach, describe, expect, it, vi } from "vitest"
import type { DigestCheck } from "./types"

const fakeCheck = (id: string, order: number): DigestCheck => ({
  id,
  label: id,
  href: "/admin",
  order,
  run: async () => ({ count: 0, severity: "info", items: [] }),
})

afterEach(() => {
  vi.doUnmock("./checks/groundwork")
  vi.doUnmock("./checks/memory")
  vi.doUnmock("./checks/sponsors-meetings")
  vi.resetModules()
})

describe("the digest check registry", () => {
  it("loads with unique ids, and finds nothing it doesn't know", async () => {
    const { DIGEST_CHECKS, findDigestCheck } = await import("./registry")
    expect(new Set(DIGEST_CHECKS.map((c) => c.id)).size).toBe(DIGEST_CHECKS.length)
    // Outside posts link to these: console paths only
    for (const check of DIGEST_CHECKS) expect(check.href, check.id).toMatch(/^\/admin(\/|$)/)
    expect(findDigestCheck("nope")).toBeUndefined()
  })

  it("sorts the tracks' checks by order, ties in track order", async () => {
    vi.doMock("./checks/sponsors-meetings", () => ({ CHECKS: [fakeCheck("prospects.quiet", 10), fakeCheck("action_items.overdue", 30)] }))
    vi.doMock("./checks/groundwork", () => ({ CHECKS: [fakeCheck("proposals.pending", 10)] }))
    vi.doMock("./checks/memory", () => ({ CHECKS: [fakeCheck("knowledge.unreviewed", 20)] }))
    const { DIGEST_CHECKS, findDigestCheck } = await import("./registry")
    expect(DIGEST_CHECKS.map((c) => c.id)).toEqual(["proposals.pending", "prospects.quiet", "knowledge.unreviewed", "action_items.overdue"])
    expect(findDigestCheck("knowledge.unreviewed")?.order).toBe(20)
  })

  it("throws at load when two tracks register the same id", async () => {
    vi.doMock("./checks/memory", () => ({ CHECKS: [fakeCheck("stale", 1)] }))
    vi.doMock("./checks/sponsors-meetings", () => ({ CHECKS: [fakeCheck("stale", 2)] }))
    await expect(import("./registry")).rejects.toThrow('Duplicate digest check "stale": registered by memory and sponsors-meetings')
  })
})
