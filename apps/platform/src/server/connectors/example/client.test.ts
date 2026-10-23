import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "../fakes/testing"
import { runConnectorSmoke } from "../status"
import { EXAMPLE_FAKE_TOKEN, exampleFake } from "./fake/handlers"
import { ExampleApiError, exampleClient, exampleConnector } from "./client"

// The template connector test: the real client against the fake, through the fetch interceptor
const state = vi.hoisted(() => ({ enabled: false }))
vi.mock("@/server/db", () => ({
  prisma: {
    connectorState: {
      findUnique: vi.fn(async () => ({ id: "example", enabled: state.enabled, lastSyncAt: null, lastError: null, lastErrorAt: null, cursor: null, updatedAt: new Date() })),
    },
  },
}))
// The status module reaches the registry; the example isn't registered, so keep it out of the picture
vi.mock("../registry", () => ({ CONNECTORS: [], findConnector: () => undefined }))

beforeEach(() => {
  state.enabled = false
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the example client against its fake", () => {
  it("adds and reads notes with the right key", async () => {
    const fakes = mountFakes([exampleFake])
    const client = exampleClient(EXAMPLE_FAKE_TOKEN)
    await client.addNote("Book the lounge")
    expect(await client.notes()).toEqual({ notes: ["Book the lounge"] })
    expect(fakes.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1/notes", "GET /v1/notes"])
  })

  it("fails with the status, never the key, on a wrong key", async () => {
    mountFakes([exampleFake])
    const error = await exampleClient("wrong-key").notes().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExampleApiError)
    expect(error).toMatchObject({ status: 401, message: "Example API answered 401 on /v1/notes" })
  })
})

describe("the example connector", () => {
  it("has no client until it's configured and switched on", async () => {
    mountFakes([exampleFake])
    expect(await exampleConnector.client()).toBeNull()
    vi.stubEnv("EXAMPLE_TOKEN", EXAMPLE_FAKE_TOKEN)
    expect(await exampleConnector.client()).toBeNull()
    state.enabled = true
    const client = await exampleConnector.client()
    expect(await client?.ping()).toEqual({ ok: true })
  })

  it("passes its smoke test against the fake while switched off", async () => {
    mountFakes([exampleFake])
    vi.stubEnv("EXAMPLE_TOKEN", EXAMPLE_FAKE_TOKEN)
    expect(await runConnectorSmoke(exampleConnector)).toMatchObject({ ok: true, summary: "Read 0 notes" })
  })

  it("fails its smoke test with a redacted reason", async () => {
    mountFakes([exampleFake])
    vi.stubEnv("EXAMPLE_TOKEN", "a-wrong-key")
    expect(await runConnectorSmoke(exampleConnector)).toMatchObject({ ok: false, summary: "ExampleApiError: Example API answered 401 on /v1/notes" })
  })
})
