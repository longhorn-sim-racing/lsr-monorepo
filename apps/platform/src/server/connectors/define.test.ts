import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ connectorState: { findUnique: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { buildConnectorStatus, defineConnector, missingEnv } from "./define"

type Row = { enabled: boolean; lastSyncAt: Date | null; lastError: string | null; lastErrorAt: Date | null }
const row = (fields: Partial<Row> = {}): Row & { id: string; cursor: null; updatedAt: Date } => ({
  id: "discord",
  enabled: false,
  lastSyncAt: null,
  lastError: null,
  lastErrorAt: null,
  cursor: null,
  updatedAt: new Date(),
  ...fields,
})

const ENV = { DISCORD_BOT_TOKEN: "x", DISCORD_GUILD_ID: "1" }
const base = { id: "discord", label: "Discord", requiredEnv: ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"], env: ENV, hasSmoke: true }

beforeEach(() => {
  db.connectorState.findUnique.mockResolvedValue(null)
})

describe("missingEnv", () => {
  it("names the missing and blank ones, never values", () => {
    expect(missingEnv(["A", "B", "C"], { A: "set", B: "  " })).toEqual(["B", "C"])
    expect(missingEnv([], {})).toEqual([])
  })
})

describe("buildConnectorStatus", () => {
  it("is not set up while env or a setting is missing, even when switched on", () => {
    expect(buildConnectorStatus({ ...base, env: { DISCORD_BOT_TOKEN: "x" }, row: row({ enabled: true }) })).toMatchObject({
      configured: false,
      missingEnv: ["DISCORD_GUILD_ID"],
      enabled: true,
      state: "not_configured",
    })
    expect(buildConnectorStatus({ ...base, missingSettings: ["instagram_publish"], row: row({ enabled: true }) })).toMatchObject({
      configured: false,
      missingSettings: ["instagram_publish"],
      state: "not_configured",
    })
  })

  it("is off without a row or with the switch off", () => {
    expect(buildConnectorStatus({ ...base, row: null })).toMatchObject({ configured: true, enabled: false, state: "off", lastSyncAt: null, lastError: null })
    expect(buildConnectorStatus({ ...base, row: row() }).state).toBe("off")
  })

  it("is failing when the last error is newer than the last sync, and connected otherwise", () => {
    const earlier = new Date("2026-10-23T10:00:00Z")
    const later = new Date("2026-10-23T11:00:00Z")
    expect(buildConnectorStatus({ ...base, row: row({ enabled: true }) }).state).toBe("connected")
    expect(buildConnectorStatus({ ...base, row: row({ enabled: true, lastSyncAt: later, lastError: "429", lastErrorAt: earlier }) })).toMatchObject({
      state: "connected",
      lastSyncAt: later.toISOString(),
      lastError: "429",
      lastErrorAt: earlier.toISOString(),
    })
    expect(buildConnectorStatus({ ...base, row: row({ enabled: true, lastSyncAt: earlier, lastError: "429", lastErrorAt: later }) }).state).toBe("error")
    expect(buildConnectorStatus({ ...base, row: row({ enabled: true, lastError: "401", lastErrorAt: later }) }).state).toBe("error")
  })

  it("redacts a stored error again on the way out", () => {
    const token = "Bot " + "MTA" + "x".repeat(21) + ".Gabcde." + "y".repeat(30)
    expect(buildConnectorStatus({ ...base, row: row({ lastError: `401 with ${token}`, lastErrorAt: new Date() }) }).lastError).toBe("401 with Bot [redacted]")
  })

  it("adds details only when there are some", () => {
    expect(buildConnectorStatus({ ...base, row: null })).not.toHaveProperty("details")
    expect(buildConnectorStatus({ ...base, row: null, details: [{ label: "Token expires", value: "Nov 3" }] }).details).toEqual([{ label: "Token expires", value: "Nov 3" }])
  })
})

describe("defineConnector", () => {
  const createClient = vi.fn((env: Record<string, string | undefined>) => ({ token: env.DISCORD_BOT_TOKEN }))

  it("refuses an id that can't be a ConnectorState id", () => {
    expect(() => defineConnector({ id: "Discord Bot", label: "Discord", requiredEnv: [], createClient })).toThrow(/lowercase/)
  })

  it("is configured from its required env, purely", () => {
    const connector = defineConnector({ id: "discord", label: "Discord", requiredEnv: ["DISCORD_BOT_TOKEN"], createClient })
    expect(connector.configured({})).toBe(false)
    expect(connector.configured({ DISCORD_BOT_TOKEN: "x" })).toBe(true)
    expect(db.connectorState.findUnique).not.toHaveBeenCalled()
  })

  it("gives a client only when configured, switched on and with its settings saved", async () => {
    const missingSettings = vi.fn(async () => ["instagram_publish"])
    const connector = defineConnector({ id: "instagram-publish", label: "Instagram publishing", requiredEnv: ["DISCORD_BOT_TOKEN"], missingSettings, createClient })

    expect(await connector.client()).toBeNull()
    expect(db.connectorState.findUnique).not.toHaveBeenCalled()

    vi.stubEnv("DISCORD_BOT_TOKEN", "tok")
    expect(await connector.client()).toBeNull()
    expect(missingSettings).not.toHaveBeenCalled()

    db.connectorState.findUnique.mockResolvedValue({ enabled: true })
    expect(await connector.client()).toBeNull()
    expect(createClient).not.toHaveBeenCalled()

    missingSettings.mockResolvedValue([])
    expect(await connector.client()).toEqual({ token: "tok" })
  })

  it("reads enabled from ConnectorState and builds its status from env, settings and the row", async () => {
    const connector = defineConnector({
      id: "discord",
      label: "Discord",
      requiredEnv: ["DISCORD_BOT_TOKEN"],
      createClient,
      smoke: async () => ({ ok: true, summary: "ok" }),
      details: async () => [{ label: "Server", value: "LSR" }],
    })
    expect(await connector.enabled()).toBe(false)
    vi.stubEnv("DISCORD_BOT_TOKEN", "tok")
    db.connectorState.findUnique.mockResolvedValue(row({ enabled: true }))
    expect(await connector.enabled()).toBe(true)
    expect(await connector.status()).toMatchObject({ id: "discord", label: "Discord", state: "connected", hasSmoke: true, details: [{ label: "Server", value: "LSR" }] })
  })
})
