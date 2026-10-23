import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ deliveryCounts: vi.fn(), bouncedRecipients: vi.fn(), readConnectorState: vi.fn() }))
vi.mock("@/server/connectors/resend/delivery", () => ({ deliveryCounts: mocks.deliveryCounts, bouncedRecipients: mocks.bouncedRecipients }))
vi.mock("@/server/connectors/state", () => ({ readConnectorState: mocks.readConnectorState }))

import { loadDeliveryTab } from "./delivery-panel"

const zero = { complained: 0, bounced: 0, failed: 0, suppressed: 0, clicked: 0, opened: 0, delivered: 0, delayed: 0, sent: 0 }
const now = Date.UTC(2026, 9, 22, 12)

beforeEach(() => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_" + "x".repeat(32))
  mocks.deliveryCounts.mockResolvedValue({ emails: 3, byStatus: { ...zero, delivered: 3 } })
  mocks.bouncedRecipients.mockResolvedValue({ rows: [], total: 0 })
  mocks.readConnectorState.mockResolvedValue({ enabled: true, lastSyncAt: new Date(now - 60_000) })
})

describe("loadDeliveryTab", () => {
  it("reads the last 30 days' outcomes, 90 days of bounces and the switch", async () => {
    const data = await loadDeliveryTab(now)
    expect(data).toEqual({ configured: true, enabled: true, lastEventAt: new Date(now - 60_000).toISOString(), counts: { emails: 3, byStatus: { ...zero, delivered: 3 } }, bounces: { rows: [], total: 0 } })
    expect(mocks.deliveryCounts).toHaveBeenCalledWith(new Date(now - 30 * 86_400_000))
    expect(mocks.bouncedRecipients).toHaveBeenCalledWith(new Date(now - 90 * 86_400_000), 200)
  })

  it("is off without a ConnectorState row", async () => {
    mocks.readConnectorState.mockResolvedValue(null)
    expect(await loadDeliveryTab(now)).toMatchObject({ configured: true, enabled: false, lastEventAt: null })
  })

  it("says it failed, rather than handing back zeros, when a read throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.bouncedRecipients.mockRejectedValue(new Error("connection timeout"))
    expect(await loadDeliveryTab(now)).toEqual({ configured: true, failed: true })
    expect(log).toHaveBeenCalled()
  })
})
