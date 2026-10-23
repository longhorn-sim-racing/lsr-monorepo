import { vi } from "vitest"
import { DEFAULT_FAKES_URL } from "../base-url"
import { FAKE_SERVICES } from "./registry"
import { createFakeRouter } from "./router"
import { FakeNetworkError, type FakeService } from "./types"

/**
 * Test helper: answers `fetch` with the HTTP fakes, in-process, so a connector test runs the real client
 * code against the same fake the local server runs. Tests only; the app never imports it.
 *
 *   const fakes = mountFakes([discordFake])   // or mountFakes() for every registered fake
 *   const client = discordClient(...)          // build clients after mounting
 *   ...
 *   expect(fakes.requests[0].headers.get("authorization")).toBe("Bot ...")
 *   fakes.restore()                            // or vi.unstubAllGlobals() in afterEach
 *
 * It sets JACK_FAKES to the mounted ids and JACK_FAKES_URL to the fake origin with vi.stubEnv (the
 * Vitest config unstubs env after each test), so serviceBaseUrl() points clients here. A fetch to any
 * other origin rejects: tests never reach the network.
 */

export type FakeRequestLog = {
  method: string
  url: string
  /** The fake service it went to ("discord"), or null when nothing is mounted at its path */
  service: string | null
  /** Under the service's mount: "/api/v10/users/@me" (the whole path when no service matched) */
  path: string
  headers: Headers
  /** The body as text ("" when none) */
  body: string
}

export type MountedFakes = {
  /** Where the fakes answer: DEFAULT_FAKES_URL unless `origin` was given */
  origin: string
  /** Every request the fakes got, oldest first */
  requests: FakeRequestLog[]
  /** Puts back the fetch that was there before mounting */
  restore(): void
}

export function mountFakes(services: readonly FakeService[] = FAKE_SERVICES, options: { origin?: string } = {}): MountedFakes {
  const origin = new URL(options.origin ?? DEFAULT_FAKES_URL).origin
  const router = createFakeRouter(services)
  const ids = new Set(services.map((service) => service.id))
  const requests: FakeRequestLog[] = []
  const previous = globalThis.fetch

  vi.stubEnv("JACK_FAKES", [...ids].join(",") || "none")
  vi.stubEnv("JACK_FAKES_URL", origin)

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== origin) {
      throw new TypeError(`fetch to ${url.origin} isn't faked: tests never reach the network (does the client build its URL with serviceBaseUrl()?)`)
    }
    const [first = "", ...rest] = url.pathname.split("/").filter(Boolean)
    const service = ids.has(first) ? first : null
    requests.push({
      method: request.method,
      url: request.url,
      service,
      path: service ? `/${rest.join("/")}` : url.pathname,
      headers: new Headers(request.headers),
      body: request.body ? await request.clone().text() : "",
    })
    try {
      return await router(request)
    } catch (error) {
      if (error instanceof FakeNetworkError) throw new TypeError("fetch failed", { cause: error })
      throw error
    }
  }

  vi.stubGlobal("fetch", fakeFetch)
  return { origin, requests, restore: () => vi.stubGlobal("fetch", previous) }
}
