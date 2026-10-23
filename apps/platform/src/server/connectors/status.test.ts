import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyConnector, ConnectorStatus } from "./types"

const db = vi.hoisted(() => ({ connectorState: { findMany: vi.fn(), findUnique: vi.fn() }, auditLog: { findMany: vi.fn() } }))
const registry = vi.hoisted(() => ({ connectors: [] as AnyConnector[] }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("./registry", () => ({
  get CONNECTORS() {
    return registry.connectors
  },
  findConnector: (id: string) => registry.connectors.find((c) => c.id === id),
}))

import { connectorStatus, listConnections, runConnectorSmoke } from "./status"

const stateRow = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  enabled: false,
  lastSyncAt: null,
  lastError: null,
  lastErrorAt: null,
  cursor: null,
  updatedAt: new Date(),
  ...fields,
})

function connector(id: string, overrides: Partial<AnyConnector> = {}): AnyConnector {
  const status: ConnectorStatus = {
    id,
    label: id.toUpperCase(),
    configured: true,
    missingEnv: [],
    missingSettings: [],
    enabled: true,
    state: "connected",
    lastSyncAt: null,
    lastError: null,
    lastErrorAt: null,
    hasSmoke: Boolean(overrides.smoke),
  }
  return {
    id,
    label: id.toUpperCase(),
    requiredEnv: [`${id.toUpperCase()}_TOKEN`],
    configured: (env) => Boolean(env[`${id.toUpperCase()}_TOKEN`]),
    enabled: async () => true,
    client: async () => ({}),
    status: async () => status,
    ...overrides,
  }
}

beforeEach(() => {
  registry.connectors = []
  db.connectorState.findMany.mockResolvedValue([])
  db.connectorState.findUnique.mockResolvedValue(null)
  db.auditLog.findMany.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

describe("listConnections", () => {
  it("lists registered connectors in registry order, then rows without code by id", async () => {
    registry.connectors = [connector("twitch"), connector("discord")]
    db.connectorState.findMany.mockResolvedValue([stateRow("teams"), stateRow("discord"), stateRow("site-traffic", { enabled: true }), stateRow("brand-new-thing")])

    const rows = await listConnections()
    expect(rows.map((r) => [r.id, r.label, r.registered])).toEqual([
      ["twitch", "TWITCH", true],
      ["discord", "DISCORD", true],
      ["brand-new-thing", "Brand new thing", false],
      ["site-traffic", "Site traffic", false],
      ["teams", "Microsoft Teams", false],
    ])
    expect(rows[0].requiredEnv).toEqual(["TWITCH_TOKEN"])
    expect(rows[3].status).toMatchObject({ configured: false, enabled: true, state: "not_configured", missingEnv: [], hasSmoke: false })
  })

  it("adds each connector's latest smoke test from the audit log", async () => {
    registry.connectors = [connector("discord", { smoke: async () => ({ ok: true, summary: "" }) })]
    const newer = new Date("2026-10-23T12:00:00Z")
    db.auditLog.findMany.mockResolvedValue([
      { entityId: "discord", createdAt: newer, metadata: { ok: false, summary: "401 Unauthorized", ms: 120 }, actor: { displayName: "Gray" } },
      { entityId: "discord", createdAt: new Date("2026-10-22T12:00:00Z"), metadata: { ok: true, summary: "Read 6 channels" }, actor: null },
    ])

    const [row] = await listConnections()
    expect(row.lastSmoke).toEqual({ ok: false, summary: "401 Unauthorized", at: newer, by: "Gray" })
    expect(db.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { entityType: "CONNECTOR", actionType: "SMOKE_TEST" }, orderBy: { createdAt: "desc" } }))
  })

  it("shows a connector whose status() throws as failing, without breaking the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const key = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc"
    registry.connectors = [
      connector("stripe", {
        status: async () => {
          throw new Error(`Invalid API Key provided: ${key}`)
        },
      }),
      connector("twitch"),
    ]
    const [stripe, twitch] = await listConnections()
    expect(stripe.status).toMatchObject({ id: "stripe", state: "error", lastError: "Couldn't read its status: Invalid API Key provided: [redacted]" })
    expect(twitch.status.state).toBe("connected")
  })

  it("redacts an error a hand-written status() returns", async () => {
    const key = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc"
    const base = await connector("stripe").status()
    registry.connectors = [connector("stripe", { status: async () => ({ ...base, lastError: `failed with ${key}` }) })]
    const [stripe] = await listConnections()
    expect(stripe.status.lastError).toBe("failed with [redacted]")
  })
})

describe("connectorStatus", () => {
  it("finds a registered connector, a row without code, or nothing", async () => {
    registry.connectors = [connector("discord")]
    expect(await connectorStatus("discord")).toMatchObject({ id: "discord", state: "connected" })
    db.connectorState.findUnique.mockResolvedValue(stateRow("google-drive"))
    expect(await connectorStatus("google-drive")).toMatchObject({ id: "google-drive", label: "Google Drive", state: "not_configured", configured: false })
    db.connectorState.findUnique.mockResolvedValue(null)
    expect(await connectorStatus("nope")).toBeNull()
  })
})

describe("runConnectorSmoke", () => {
  const env = { DISCORD_TOKEN: "set" }

  it("says when there's no smoke test, or the env is missing, without calling anything", async () => {
    expect(await runConnectorSmoke(connector("discord"), { env })).toEqual({ ok: false, summary: "No smoke test yet" })
    const smoke = vi.fn()
    expect(await runConnectorSmoke(connector("discord", { smoke }), { env: {} })).toEqual({ ok: false, summary: "Not set up: missing DISCORD_TOKEN" })
    expect(smoke).not.toHaveBeenCalled()
  })

  it("returns the result, with its time, and a summary that's redacted and short", async () => {
    const secret = "whsec_" + "a1B2c3D4e5F6g7H8"
    const result = await runConnectorSmoke(connector("discord", { smoke: async () => ({ ok: true, summary: `Read 6 channels with ${secret}` }) }), { env })
    expect(result).toMatchObject({ ok: true, summary: "Read 6 channels with [redacted]" })
    expect(result.ms).toEqual(expect.any(Number))

    const long = await runConnectorSmoke(connector("discord", { smoke: async () => ({ ok: false, summary: "x ".repeat(400), ms: 5 }) }), { env })
    expect(long.summary.length).toBeLessThanOrEqual(300)
    expect(long.ms).toBe(5)
  })

  it("turns a throw into a failed result, redacted", async () => {
    const key = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc"
    const result = await runConnectorSmoke(
      connector("discord", {
        smoke: async () => {
          throw new Error(`Invalid API Key provided: ${key}`)
        },
      }),
      { env },
    )
    expect(result).toMatchObject({ ok: false, summary: "Invalid API Key provided: [redacted]" })
  })

  it("gives up after the timeout and aborts the test's signal", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const pending = runConnectorSmoke(
      connector("discord", {
        smoke: (options) => {
          signal = options?.signal
          return new Promise(() => {})
        },
      }),
      { env, timeoutMs: 5_000 },
    )
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toMatchObject({ ok: false, summary: "No answer within 5 s" })
    expect(signal?.aborted).toBe(true)
  })
})
