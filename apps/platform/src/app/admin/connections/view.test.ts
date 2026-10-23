import { describe, expect, it } from "vitest"
import type { ConnectionRow } from "@/server/connectors/status"
import type { ConnectorStatus } from "@/server/connectors/types"
import { connectionsSummary, toConnectionView, when } from "./view"

const NOW = new Date("2026-10-23T15:00:00Z")

function row(status: Partial<ConnectorStatus> = {}, extra: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "discord",
    label: "Discord",
    registered: true,
    requiredEnv: ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"],
    lastSmoke: null,
    status: {
      id: "discord",
      label: "Discord",
      configured: true,
      missingEnv: [],
      missingSettings: [],
      enabled: false,
      state: "off",
      lastSyncAt: null,
      lastError: null,
      lastErrorAt: null,
      hasSmoke: true,
      ...status,
    },
    ...extra,
  }
}

describe("when", () => {
  it("shows a time as Central time and how long ago", () => {
    expect(when("2026-10-23T14:55:00Z", NOW)).toEqual({ ago: "5 minutes ago", at: "Oct 23, 2026, 9:55 AM" })
    expect(when(null, NOW)).toBeNull()
    expect(when("not a date", NOW)).toBeNull()
  })
})

describe("toConnectionView", () => {
  it("marks each required env var set or missing, by name only", () => {
    const view = toConnectionView(row({ missingEnv: ["DISCORD_GUILD_ID"], state: "not_configured", configured: false }), NOW)
    expect(view.env).toEqual([
      { name: "DISCORD_BOT_TOKEN", present: true },
      { name: "DISCORD_GUILD_ID", present: false },
    ])
    expect(view.state).toBe("not_configured")
  })

  it("shows a row without code as planned, whatever its status says", () => {
    expect(toConnectionView(row({ state: "not_configured" }, { registered: false, requiredEnv: [] }), NOW).state).toBe("planned")
  })

  it("says whether the last error is still current", () => {
    const failing = toConnectionView(row({ lastSyncAt: "2026-10-23T13:00:00Z", lastError: "401", lastErrorAt: "2026-10-23T14:00:00Z" }), NOW)
    expect(failing.lastError).toMatchObject({ text: "401", current: true, ago: "about 1 hour ago" })
    expect(failing.lastSync?.ago).toBe("about 2 hours ago")

    const recovered = toConnectionView(row({ lastSyncAt: "2026-10-23T14:30:00Z", lastError: "429", lastErrorAt: "2026-10-23T14:00:00Z" }), NOW)
    expect(recovered.lastError?.current).toBe(false)
    expect(toConnectionView(row(), NOW).lastError).toBeNull()
  })

  it("carries the last smoke test and the details", () => {
    const view = toConnectionView(
      row({ details: [{ label: "Server", value: "LSR" }] }, { lastSmoke: { ok: true, summary: "Read 6 channels", at: new Date("2026-10-22T15:00:00Z"), by: "Gray" } }),
      NOW,
    )
    expect(view.lastSmoke).toMatchObject({ ok: true, summary: "Read 6 channels", by: "Gray", ago: "1 day ago" })
    expect(view.details).toEqual([{ label: "Server", value: "LSR" }])
  })
})

describe("connectionsSummary", () => {
  it("counts by state, leaving out the empty ones", () => {
    const views = [
      toConnectionView(row({ state: "connected", enabled: true }), NOW),
      toConnectionView(row({ state: "error", enabled: true }), NOW),
      toConnectionView(row(), NOW),
      toConnectionView(row({}, { registered: false }), NOW),
      toConnectionView(row({}, { registered: false }), NOW),
    ]
    expect(connectionsSummary(views)).toBe("1 connected · 1 failing · 1 off · 2 not built yet")
    expect(connectionsSummary([])).toBe("Outside services Jack and the console use.")
  })
})
