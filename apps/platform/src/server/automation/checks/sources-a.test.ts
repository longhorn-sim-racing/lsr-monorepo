import { beforeEach, describe, expect, it, vi } from "vitest"

const delivery = vi.hoisted(() => ({ bouncedRecipients: vi.fn() }))
vi.mock("@/server/connectors/resend/delivery", () => delivery)

import { BOUNCE_WINDOW_DAYS, CHECKS, emailBounces } from "./sources-a"

const now = new Date("2026-10-22T17:00:00Z")
const row = (recipient: string, status: string, subject: string | null, daysAgo: number) => ({
  recipient,
  failed: 1,
  lastStatus: status,
  lastAt: new Date(now.getTime() - daysAgo * 86_400_000),
  reason: "No such user",
  deliveredSince: false,
  lastEmail: subject ? { kind: "notification", subject, detail: null, link: "/admin/notifications" } : null,
  member: null,
})

beforeEach(() => {
  delivery.bouncedRecipients.mockResolvedValue({
    total: 3,
    rows: [row("a@example.com", "bounced", "GM 2 is tonight", 1), row("b@example.com", "bounced", "GM 2 is tonight", 2), row("c@example.com", "suppressed", null, 3)],
  })
})

describe("the email bounce check", () => {
  it("is registered, linking to the bounce list", () => {
    expect(CHECKS).toEqual([emailBounces])
    expect(emailBounces.href).toBe("/admin/notifications?tab=delivery")
  })

  it("counts addresses from the last week, grouped by email, with no address in the items", async () => {
    const result = await emailBounces.run({ now })
    expect(delivery.bouncedRecipients).toHaveBeenCalledWith(new Date(now.getTime() - BOUNCE_WINDOW_DAYS * 86_400_000), 500, { hideOfficerApplicants: true })
    expect(result).toMatchObject({ count: 3, severity: "warning", moreItems: 0 })
    expect(result.items.map((i) => i.title)).toEqual(["GM 2 is tonight: 2 addresses didn't get it", "An email sent outside the site: 1 address didn't get it"])
    expect(result.items[0].detail).toBe("Last Oct 21")
    expect(JSON.stringify(result)).not.toContain("@example.com")
  })

  it("is urgent when someone marked club mail as spam, and quiet when nothing bounced", async () => {
    delivery.bouncedRecipients.mockResolvedValueOnce({ total: 1, rows: [row("a@example.com", "complained", "News", 1)] })
    expect((await emailBounces.run({ now })).severity).toBe("danger")
    delivery.bouncedRecipients.mockResolvedValueOnce({ total: 0, rows: [] })
    expect(await emailBounces.run({ now })).toEqual({ count: 0, severity: "info", items: [], moreItems: 0 })
  })
})
