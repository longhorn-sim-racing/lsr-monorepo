import { afterEach, describe, expect, it, vi } from "vitest"
import type { AnyConnector, ConnectorStatus } from "./types"

const fakeConnector = (id: string): AnyConnector => {
  const status: ConnectorStatus = {
    id,
    label: id,
    configured: false,
    missingEnv: ["FAKE_TOKEN"],
    missingSettings: [],
    enabled: false,
    state: "not_configured",
    lastSyncAt: null,
    lastError: null,
    lastErrorAt: null,
    hasSmoke: false,
  }
  return {
    id,
    label: id,
    requiredEnv: ["FAKE_TOKEN"],
    configured: (env) => Boolean(env.FAKE_TOKEN),
    enabled: async () => false,
    client: async () => null,
    status: async () => status,
  }
}

afterEach(() => {
  vi.doUnmock("./slots/groundwork")
  vi.doUnmock("./slots/sources-b")
  vi.doUnmock("./slots/discord-read")
  vi.resetModules()
})

describe("the connector registry", () => {
  it("loads with unique ids, and finds nothing it doesn't know", async () => {
    const { CONNECTORS, findConnector } = await import("./registry")
    expect(new Set(CONNECTORS.map((c) => c.id)).size).toBe(CONNECTORS.length)
    expect(findConnector("nope")).toBeUndefined()
  })

  it("joins the tracks' connectors in track order and finds them by id", async () => {
    vi.doMock("./slots/discord-read", () => ({ CONNECTORS: [fakeConnector("discord")] }))
    vi.doMock("./slots/groundwork", () => ({ CONNECTORS: [fakeConnector("storage")] }))
    const { CONNECTORS, findConnector } = await import("./registry")
    // Only the mocked ones: the other tracks' real connectors sit among them
    expect(CONNECTORS.map((c) => c.id).filter((id) => ["storage", "discord"].includes(id))).toEqual(["storage", "discord"])
    expect(findConnector("discord")?.configured({ FAKE_TOKEN: "x" })).toBe(true)
  })

  it("throws at load when two tracks register the same id", async () => {
    vi.doMock("./slots/sources-b", () => ({ CONNECTORS: [fakeConnector("twitch")] }))
    vi.doMock("./slots/discord-read", () => ({ CONNECTORS: [fakeConnector("twitch")] }))
    await expect(import("./registry")).rejects.toThrow('Duplicate connector "twitch": registered by sources-b and discord-read')
  })
})
