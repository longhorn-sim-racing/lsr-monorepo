import Stripe from "stripe"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakesEnabledFor, fakesOrigin, serviceBaseUrl, serviceFetch } from "../base-url"
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

  it("rejects a request whose signal is already aborted, like fetch", async () => {
    const fakes = mountFakes([exampleFake])
    const reason = new DOMException("The operation timed out.", "TimeoutError")
    await expect(fetch("http://127.0.0.1:3999/example/v1/ping", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
    expect(fakes.requests).toHaveLength(0)
  })

  it("runs the Stripe SDK against a fake under /stripe, through serviceFetch()", async () => {
    // Stripe takes a host but no base path, so serviceFetch() adds the mount
    const balance: FakeService = {
      id: "stripe",
      create: () => [
        {
          method: "GET",
          path: "/v1/balance",
          handle: () => Response.json({ object: "balance", available: [{ amount: 4200, currency: "usd", source_types: { card: 4200 } }], pending: [], livemode: false }),
        },
      ],
    }
    const fakes = mountFakes([balance])
    const key = "sk_" + "test_" + "x".repeat(24)
    const fakesUrl = fakesEnabledFor("stripe") ? new URL(fakesOrigin()) : null
    const stripe = new Stripe(key, {
      ...(fakesUrl && { host: fakesUrl.hostname, port: Number(fakesUrl.port || 80), protocol: "http" as const }),
      httpClient: Stripe.createFetchHttpClient(serviceFetch("stripe")),
      maxNetworkRetries: 0,
      telemetry: false,
    })

    expect((await stripe.balance.retrieve()).available[0].amount).toBe(4200)
    expect(fakes.requests).toHaveLength(1)
    expect(fakes.requests[0]).toMatchObject({ method: "GET", service: "stripe", path: "/v1/balance", url: "http://127.0.0.1:3999/stripe/v1/balance" })
    expect(fakes.requests[0].headers.get("authorization")).toBe(`Bearer ${key}`)
  })

  it("puts the previous fetch back", () => {
    const before = globalThis.fetch
    const fakes = mountFakes([exampleFake])
    expect(globalThis.fetch).not.toBe(before)
    fakes.restore()
    expect(globalThis.fetch).toBe(before)
  })
})
