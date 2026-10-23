import { afterEach, describe, expect, it, vi } from "vitest"
import { serviceBaseUrl } from "../base-url"
import { exampleFake } from "../example/fake/handlers"
import { mountFakes } from "./testing"
import { FakeNetworkError, type FakeService } from "./types"

afterEach(() => {
  vi.unstubAllGlobals()
})

const flaky: FakeService = {
  id: "flaky",
  create: () => [
    {
      method: "GET",
      path: "/v1/drop",
      handle: () => {
        throw new FakeNetworkError()
      },
    },
  ],
}

describe("mountFakes", () => {
  it("answers fetch with the fakes and points serviceBaseUrl at them", async () => {
    const fakes = mountFakes([exampleFake])
    expect(process.env.JACK_FAKES).toBe("example")
    expect(process.env.JACK_FAKES_URL).toBe("http://127.0.0.1:3999")

    const base = serviceBaseUrl("example", "https://api.example.com")
    expect(base).toBe("http://127.0.0.1:3999/example")
    const response = await fetch(`${base}/v1/ping`)
    expect(await response.json()).toEqual({ ok: true })
    expect(fakes.requests).toHaveLength(1)
    expect(fakes.requests[0]).toMatchObject({ method: "GET", service: "example", path: "/v1/ping", body: "" })
  })

  it("logs each request's headers and body", async () => {
    const fakes = mountFakes([exampleFake])
    await fetch("http://127.0.0.1:3999/example/v1/notes", { method: "POST", headers: { authorization: "Bearer nope" }, body: JSON.stringify({ text: "hi" }) })
    expect(fakes.requests[0].headers.get("authorization")).toBe("Bearer nope")
    expect(fakes.requests[0].body).toBe('{"text":"hi"}')
  })

  it("mounts every registered fake by default, on another origin when asked", async () => {
    const fakes = mountFakes(undefined, { origin: "http://localhost:4100" })
    expect(process.env.JACK_FAKES?.split(",")).toContain("example")
    expect(serviceBaseUrl("example", "https://api.example.com")).toBe("http://localhost:4100/example")
    expect((await fetch("http://localhost:4100/example/v1/ping")).ok).toBe(true)
    expect(fakes.origin).toBe("http://localhost:4100")
  })

  it("never lets a test reach the network", async () => {
    mountFakes([exampleFake])
    await expect(fetch("https://api.example.com/v1/ping")).rejects.toThrow(/isn't faked/)
  })

  it("logs a request to an unmounted path with no service, and the router answers 404", async () => {
    const fakes = mountFakes([exampleFake])
    expect((await fetch("http://127.0.0.1:3999/discord/api/v10/users/@me")).status).toBe(404)
    expect(fakes.requests[0]).toMatchObject({ service: null, path: "/discord/api/v10/users/@me" })
  })

  it("turns a fake's network error into a rejected fetch, like a dropped connection", async () => {
    mountFakes([flaky])
    const failure = fetch("http://127.0.0.1:3999/flaky/v1/drop")
    await expect(failure).rejects.toThrow(TypeError)
    await expect(failure).rejects.toMatchObject({ message: "fetch failed", cause: expect.any(FakeNetworkError) })
  })

  it("puts the previous fetch back", () => {
    const before = globalThis.fetch
    const fakes = mountFakes([exampleFake])
    expect(globalThis.fetch).not.toBe(before)
    fakes.restore()
    expect(globalThis.fetch).toBe(before)
  })
})
