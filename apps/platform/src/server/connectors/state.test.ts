import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ connectorState: { findUnique: vi.fn(), upsert: vi.fn() } }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)

import { connectorEnabled, errorText, recordConnectorError, recordConnectorSync, setConnectorEnabled } from "./state"

beforeEach(() => {
  db.connectorState.findUnique.mockResolvedValue(null)
  db.connectorState.upsert.mockResolvedValue({})
})

describe("connectorEnabled", () => {
  it("reads the switch, and a missing row is off", async () => {
    expect(await connectorEnabled("discord")).toBe(false)
    db.connectorState.findUnique.mockResolvedValue({ enabled: true })
    expect(await connectorEnabled("discord")).toBe(true)
    expect(db.connectorState.findUnique).toHaveBeenCalledWith({ where: { id: "discord" }, select: { enabled: true } })
  })
})

describe("setConnectorEnabled", () => {
  it("switches it on, creating the row when there's none, and audits the change", async () => {
    expect(await setConnectorEnabled("discord", true, { userId: "admin-1", label: "Discord" })).toEqual({ changed: true })
    expect(db.connectorState.upsert).toHaveBeenCalledWith({ where: { id: "discord" }, update: { enabled: true }, create: { id: "discord", enabled: true } })
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      actionType: "ENABLE",
      entityType: "CONNECTOR",
      entityId: "discord",
      summary: "Switched the Discord connector on",
      before: { enabled: false },
      after: { enabled: true },
    })
  })

  it("audits switching off, and writes no audit entry when nothing changed", async () => {
    db.connectorState.findUnique.mockResolvedValue({ enabled: true })
    await setConnectorEnabled("twitch", false, { userId: "admin-1" })
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "DISABLE", summary: "Switched the twitch connector off" }))

    audit.createAuditLog.mockClear()
    db.connectorState.findUnique.mockResolvedValue({ enabled: false })
    expect(await setConnectorEnabled("twitch", false, { userId: "admin-1" })).toEqual({ changed: false })
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })
})

describe("recordConnectorSync", () => {
  it("stamps the sync and keeps the cursor when none is given, without touching the switch", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-23T15:00:00Z") })
    try {
      await recordConnectorSync("discord")
    } finally {
      vi.useRealTimers()
    }
    const at = new Date("2026-10-23T15:00:00Z")
    expect(db.connectorState.upsert).toHaveBeenCalledWith({
      where: { id: "discord" },
      update: { lastSyncAt: at, cursor: undefined },
      create: { id: "discord", enabled: false, lastSyncAt: at, cursor: undefined },
    })
  })

  it("stores the cursor exactly as given: a delta link's token survives", async () => {
    const cursor = { deltaLink: "https://graph.microsoft.com/v1.0/sites/x/drive/root/delta?token=aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z" }
    await recordConnectorSync("sharepoint", { cursor })
    const call = db.connectorState.upsert.mock.calls[0][0]
    expect(call.update.cursor).toBe(cursor)
    expect(call.create.cursor).toBe(cursor)
  })

  it("clears the cursor with null", async () => {
    await recordConnectorSync("discord", { cursor: null })
    expect(db.connectorState.upsert.mock.calls[0][0].update.cursor).toBe(Prisma.DbNull)
  })
})

describe("recordConnectorError", () => {
  it("stores the error redacted, and a new row stays off", async () => {
    const key = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc"
    const stored = await recordConnectorError("stripe", new Error(`Invalid API Key provided: ${key}`))
    expect(stored).toBe("Invalid API Key provided: [redacted]")
    const call = db.connectorState.upsert.mock.calls[0][0]
    expect(call.update).toEqual({ lastError: stored, lastErrorAt: expect.any(Date) })
    expect(call.create).toEqual({ id: "stripe", enabled: false, lastError: stored, lastErrorAt: expect.any(Date) })
    expect(JSON.stringify(call)).not.toContain(key)
  })

  it("masks a secret env var's value wherever it shows up", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "fake-discord-bot-token-value-123")
    const stored = await recordConnectorError("discord", "request to https://discord.com/api/v10?x=1 failed with fake-discord-bot-token-value-123")
    expect(stored).toBe("request to https://discord.com/api/v10 failed with [redacted DISCORD_BOT_TOKEN]")
  })
})

describe("errorText", () => {
  it("keeps the error's kind and message on one line", () => {
    expect(errorText(new Error("boom"))).toBe("boom")
    expect(errorText(new TypeError("fetch failed"))).toBe("TypeError: fetch failed")
    expect(errorText("plain")).toBe("plain")
    expect(errorText("")).toBe("Unknown error")
    expect(errorText({ code: 50001 })).toBe('{"code":50001}')
    expect(errorText(undefined)).toBe("undefined")
  })

  it("adds the cause, where fetch puts the reason a request failed", () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }) })
    expect(errorText(refused)).toBe("TypeError: fetch failed (connect ECONNREFUSED 127.0.0.1:443)")
    // Node gives an AggregateError with no message when every address refused
    const everyAddress = new TypeError("fetch failed", { cause: Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }) })
    expect(errorText(everyAddress)).toBe("TypeError: fetch failed (AggregateError: ECONNREFUSED)")
    expect(errorText(new Error("sync failed", { cause: "rate limited" }))).toBe("sync failed (rate limited)")
  })

  it("stops after a few causes, even when an error is its own cause", () => {
    const loop = new Error("loop")
    loop.cause = loop
    expect(errorText(loop)).toBe("loop (loop (loop))")
  })

  it("leaves the cause's secrets for redaction to mask", async () => {
    const key = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc"
    const stored = await recordConnectorError("stripe", new TypeError("fetch failed", { cause: new Error(`bad key ${key}`) }))
    expect(stored).toBe("TypeError: fetch failed (bad key [redacted])")
  })
})
