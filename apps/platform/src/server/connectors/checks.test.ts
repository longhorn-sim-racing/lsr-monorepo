import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ connectorState: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("./registry", () => ({
  CONNECTORS: [
    { id: "stripe", label: "Stripe" },
    { id: "resend", label: "Resend" },
    { id: "discord", label: "Discord" },
    { id: "twitch", label: "Twitch" },
    { id: "google-drive", label: "Google Drive" },
  ],
}))

import { CONNECTORS_WITH_OWN_CHECK, failingConnectors } from "./checks"

const NOW = new Date("2026-10-26T17:00:00Z")
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000)

beforeEach(() => {
  db.connectorState.findMany.mockResolvedValue([])
})

describe("failing connections", () => {
  it("lists switched-on connections whose last error is newer than their last sync, longest failing first, without the error", async () => {
    db.connectorState.findMany.mockResolvedValue([
      { id: "stripe", lastSyncAt: at(30), lastErrorAt: at(2) },
      { id: "resend", lastSyncAt: at(1), lastErrorAt: at(3) },
      { id: "discord", lastSyncAt: null, lastErrorAt: at(20) },
    ])
    const result = await failingConnectors.run({ now: NOW })
    expect(result).toEqual({
      count: 2,
      severity: "warning",
      items: [
        { title: "Discord is failing", href: "/admin/connections", detail: "Since Oct 25, 4:00 PM CT" },
        { title: "Stripe is failing", href: "/admin/connections", detail: "Since Oct 26, 10:00 AM CT" },
      ],
    })
  })

  it("leaves out the connections whose own checks say more", async () => {
    await failingConnectors.run({ now: NOW })
    expect(db.connectorState.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["stripe", "resend", "discord"] }, enabled: true, lastErrorAt: { not: null } })
    for (const id of ["google-drive", "sharepoint", "teams", "twitch", "instagram-insights"]) expect(CONNECTORS_WITH_OWN_CHECK.has(id)).toBe(true)
  })
})
