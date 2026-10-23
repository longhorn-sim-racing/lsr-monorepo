import { describe, expect, it, vi } from "vitest"

// Activity's rows carry each email's delivery (Jack 2.0 sources-a)
const db = vi.hoisted(() => ({ notification: { findMany: vi.fn() } }))
const delivery = vi.hoisted(() => ({ deliveryFor: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => ({ requireOfficer: vi.fn(async () => ({ id: "officer-1" })) }))
vi.mock("@/server/services/notification.service", () => ({ TRANSACTIONAL_HEADROOM: 10 }))
vi.mock("@/server/audit/log", () => ({ createAuditLog: vi.fn() }))
vi.mock("@/lib/email/settings", () => ({ setSystemSetting: vi.fn(), getSystemSetting: vi.fn(), SETTINGS: {} }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/connectors/resend/delivery", () => delivery)

import { getRecentNotifications } from "./actions"

describe("getRecentNotifications", () => {
  it("adds each email's delivery from Resend's events, and null where there's none", async () => {
    const at = new Date("2026-10-20T23:00:01Z")
    db.notification.findMany.mockResolvedValue([
      { id: "n1", channel: "EMAIL", emailMessageId: "e1", user: { id: "u1", displayName: "A", email: "a@example.com" } },
      { id: "n2", channel: "EMAIL", emailMessageId: "e2", user: { id: "u2", displayName: "B", email: "b@example.com" } },
      { id: "n3", channel: "IN_APP", emailMessageId: null, user: { id: "u3", displayName: "C", email: "c@example.com" } },
    ])
    delivery.deliveryFor.mockResolvedValue(new Map([["e1", { status: "bounced", at, reason: "No such user" }]]))
    const rows = await getRecentNotifications(20, 0)
    expect(delivery.deliveryFor).toHaveBeenCalledWith(["e1", "e2", null])
    expect(rows.map((r) => [r.id, r.delivery])).toEqual([
      ["n1", { status: "bounced", at, reason: "No such user" }],
      ["n2", null],
      ["n3", null],
    ])
  })
})
