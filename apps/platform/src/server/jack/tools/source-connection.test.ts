import { describe, expect, it } from "vitest"
import type { AnyConnector, ConnectorStatus } from "@/server/connectors/types"
import { notConnected, notReadWhileOff, sourceConnection } from "./source-connection"

function connector(state: ConnectorStatus["state"], overrides: Partial<ConnectorStatus> = {}): AnyConnector {
  const status: ConnectorStatus = {
    id: "twitch",
    label: "Twitch",
    configured: state !== "not_configured",
    missingEnv: [],
    missingSettings: [],
    enabled: state === "connected" || state === "error",
    state,
    lastSyncAt: "2026-10-22T23:29:00.000Z",
    lastError: null,
    lastErrorAt: null,
    hasSmoke: true,
    ...overrides,
  }
  return { id: "twitch", label: "Twitch", requiredEnv: [], configured: () => true, enabled: async () => true, client: async () => null, status: async () => status } as unknown as AnyConnector
}

describe("sourceConnection", () => {
  it("says the same things the same way for every synced source: connected and how fresh, failing, off, not set up", async () => {
    expect(await sourceConnection(connector("connected"), "Twitch")).toEqual({ connected: true, failing: false, note: "Twitch: connected, last synced Thu 2026-10-22 18:29 CT." })
    expect(await sourceConnection(connector("connected", { lastSyncAt: null }), "Twitch")).toEqual({ connected: true, failing: false, note: "Twitch: connected, waiting for its first sync." })
    expect(await sourceConnection(connector("error"), "Twitch")).toEqual({ connected: true, failing: true, note: "Twitch: its last sync failed (System → Connections has why); last synced Thu 2026-10-22 18:29 CT." })
    expect(await sourceConnection(connector("off"), "Twitch")).toEqual({ connected: false, failing: false, note: "Twitch is switched off on System → Connections; what's stored was last synced Thu 2026-10-22 18:29 CT." })
    expect(await sourceConnection(connector("not_configured", { lastSyncAt: null, missingEnv: ["TWITCH_CLIENT_ID"], missingSettings: ["the club account"] }), "Twitch")).toEqual({
      connected: false,
      failing: false,
      note: "Twitch is not set up (missing: TWITCH_CLIENT_ID, the club account); it never synced.",
    })
  })

  it("answers for a source with nothing stored, and for one that's never read while it's off", async () => {
    const off = await sourceConnection(connector("off", { lastSyncAt: null }), "Stripe")
    expect(notConnected(off, "Stripe data")).toEqual({
      forModel: "Stripe is switched off on System → Connections; it never synced. There's no Stripe data to read. Say it isn't connected yet; an admin connects it on System → Connections.",
      label: "Stripe data: not connected",
      displays: [{ kind: "note", text: "Stripe data isn't connected yet." }],
    })
    const discord = await sourceConnection(connector("off"), "Discord")
    expect(notReadWhileOff(discord, "Discord")).toEqual({
      forModel: "Discord is switched off on System → Connections; what's stored was last synced Thu 2026-10-22 18:29 CT. Nothing from Discord is read while it isn't connected. Say it isn't connected; an admin connects it on System → Connections.",
      label: "Discord isn't connected",
      displays: [{ kind: "note", text: "Discord isn't connected." }],
    })
  })
})
