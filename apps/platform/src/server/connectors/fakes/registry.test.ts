import { afterEach, describe, expect, it, vi } from "vitest"
import { FAKE_SERVICE_ID } from "../base-url"
import type { FakeService } from "./types"

const fake = (id: string): FakeService => ({ id, create: () => [] })

afterEach(() => {
  vi.doUnmock("./slots/sources-a")
  vi.doUnmock("./slots/discord-read")
  vi.resetModules()
})

describe("the fakes registry", () => {
  it("loads with unique, path-safe ids, starting with the example", async () => {
    const { FAKE_SERVICES, findFakeService } = await import("./registry")
    expect(new Set(FAKE_SERVICES.map((s) => s.id)).size).toBe(FAKE_SERVICES.length)
    for (const service of FAKE_SERVICES) expect(service.id).toMatch(FAKE_SERVICE_ID)
    expect(findFakeService("example")?.create().length).toBeGreaterThan(0)
    expect(findFakeService("nope")).toBeUndefined()
  })

  it("throws at load when two tracks register the same fake", async () => {
    vi.doMock("./slots/sources-a", () => ({ FAKES: [fake("stripe")] }))
    vi.doMock("./slots/discord-read", () => ({ FAKES: [fake("stripe")] }))
    await expect(import("./registry")).rejects.toThrow('Duplicate fake service "stripe": registered by sources-a and discord-read')
  })
})
