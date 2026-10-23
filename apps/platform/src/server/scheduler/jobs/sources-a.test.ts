import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  stripeClient: vi.fn(),
  siteClient: vi.fn(),
  syncStripe: vi.fn(),
  snapshotSiteTraffic: vi.fn(),
  readConnectorState: vi.fn(),
  recordConnectorSync: vi.fn(),
  recordConnectorError: vi.fn(),
  deleteMany: vi.fn(),
}))
vi.mock("@/server/connectors/stripe/connector", () => ({ stripeConnector: { client: mocks.stripeClient } }))
vi.mock("@/server/connectors/site-traffic/connector", () => ({ siteTrafficConnector: { client: mocks.siteClient } }))
vi.mock("@/server/connectors/stripe/sync", () => ({ syncStripe: mocks.syncStripe }))
vi.mock("@/server/connectors/site-traffic/snapshot", () => ({ snapshotSiteTraffic: mocks.snapshotSiteTraffic }))
vi.mock("@/server/connectors/state", () => ({ readConnectorState: mocks.readConnectorState, recordConnectorSync: mocks.recordConnectorSync, recordConnectorError: mocks.recordConnectorError }))
vi.mock("@/server/db", () => ({ prisma: { emailEvent: { deleteMany: mocks.deleteMany } } }))

import type { JobContext } from "../types"
import { EMAIL_EVENT_RETENTION_DAYS, JOBS } from "./sources-a"

const job = (kind: string) => JOBS.find((j) => j.kind === kind)!
const ctx = (): JobContext => ({ signal: new AbortController().signal, deadline: Date.now() + 60_000, startedAt: Date.now(), log: vi.fn(), config: null, job: { id: "j1", key: "k" } })
const syncResult = (over: Record<string, unknown> = {}) => ({ summary: "Last 120 days: the balance, 6 payouts", counts: { payouts: 6 }, more: false, errors: [], ...over })

beforeEach(() => {
  mocks.readConnectorState.mockResolvedValue({ cursor: null })
  mocks.stripeClient.mockResolvedValue({ mode: "test", open: () => ({}) })
  mocks.syncStripe.mockResolvedValue(syncResult())
  mocks.recordConnectorError.mockImplementation(async (_id, error: unknown) => String(error))
})

describe("stripe.sync", () => {
  it("skips while the connector is off or not set up", async () => {
    mocks.stripeClient.mockResolvedValue(null)
    expect(await job("stripe.sync").run(ctx())).toMatchObject({ status: "skipped" })
    expect(mocks.syncStripe).not.toHaveBeenCalled()
  })

  it("backfills on its first run and marks the backfill done once it finished", async () => {
    await job("stripe.sync").run(ctx())
    expect(mocks.syncStripe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ backfill: true }))
    expect(mocks.recordConnectorSync).toHaveBeenCalledWith("stripe", { cursor: { backfilledAt: expect.any(String) } })
  })

  it("looks back the usual way after that, keeping the cursor", async () => {
    mocks.readConnectorState.mockResolvedValue({ cursor: { backfilledAt: "2026-10-01T10:00:00.000Z" } })
    await job("stripe.sync").run(ctx())
    expect(mocks.syncStripe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ backfill: false }))
    expect(mocks.recordConnectorSync).toHaveBeenCalledWith("stripe", {})
  })

  it("doesn't count a backfill cut short as done", async () => {
    mocks.syncStripe.mockResolvedValue(syncResult({ more: true }))
    await job("stripe.sync").run(ctx())
    expect(mocks.recordConnectorSync).toHaveBeenCalledWith("stripe", {})
  })

  it("fails with what went wrong, recorded on the connector", async () => {
    mocks.syncStripe.mockResolvedValue(syncResult({ errors: ["disputes: Stripe 403"] }))
    await expect(job("stripe.sync").run(ctx())).rejects.toThrow(/Failed: disputes: Stripe 403/)
    expect(mocks.recordConnectorError).toHaveBeenCalledWith("stripe", expect.any(Error))
    expect(mocks.recordConnectorSync).not.toHaveBeenCalled()
  })

  it("records a bad key as the connector's error", async () => {
    mocks.stripeClient.mockRejectedValue(new Error("STRIPE_READONLY_KEY must be a restricted key"))
    await expect(job("stripe.sync").run(ctx())).rejects.toThrow(/restricted key/)
    expect(mocks.recordConnectorError).toHaveBeenCalled()
  })
})

describe("site-traffic.snapshot", () => {
  it("skips while the connector is off", async () => {
    mocks.siteClient.mockResolvedValue(null)
    expect(await job("site-traffic.snapshot").run(ctx())).toMatchObject({ status: "skipped" })
  })

  it("snapshots and records the sync", async () => {
    mocks.siteClient.mockResolvedValue({})
    mocks.snapshotSiteTraffic.mockResolvedValue({ summary: "Stored 1 of 1 missing day", counts: { days: 1, rows: 40, skipped: 0 }, more: false })
    expect(await job("site-traffic.snapshot").run(ctx())).toEqual({ summary: "Stored 1 of 1 missing day", counts: { days: 1, rows: 40, skipped: 0 } })
    expect(mocks.recordConnectorSync).toHaveBeenCalledWith("site-traffic")
  })

  it("records a failure on the connector", async () => {
    mocks.siteClient.mockResolvedValue({})
    mocks.snapshotSiteTraffic.mockRejectedValue(new Error("Vercel answered 403"))
    await expect(job("site-traffic.snapshot").run(ctx())).rejects.toThrow("Vercel answered 403")
    expect(mocks.recordConnectorError).toHaveBeenCalledWith("site-traffic", expect.any(Error))
  })
})

describe("email-events.prune", () => {
  it("deletes delivery events older than a year", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 4 })
    const before = Date.now()
    expect(await job("email-events.prune").run(ctx())).toMatchObject({ summary: `Deleted 4 delivery events older than ${EMAIL_EVENT_RETENTION_DAYS} days` })
    const cutoff = mocks.deleteMany.mock.calls[0][0].where.occurredAt.lt as Date
    expect(Math.abs(cutoff.getTime() - (before - EMAIL_EVENT_RETENTION_DAYS * 86_400_000))).toBeLessThan(5_000)
  })
})
