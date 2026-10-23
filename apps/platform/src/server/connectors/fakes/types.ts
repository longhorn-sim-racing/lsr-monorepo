/**
 * HTTP fakes for the outside services (design §12). A service's fake lives in
 * `src/server/connectors/<service>/fake/handlers.ts` and is registered in `fakes/slots/<track>.ts`.
 * The same fake runs two ways: in the local fakes server (`pnpm jack:fakes`), and in tests through
 * mountFakes() (`fakes/testing.ts`), which answers `fetch` in-process. Either way the real client runs,
 * pointed at the fake by serviceBaseUrl().
 *
 * Fakes speak the web's own Request and Response. Routes use the real API's paths: the fake for
 * "https://discord.com/api/v10" serves "/api/v10/users/@me" under its mount, "/discord".
 */

export type FakeMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "*"

/** What a route handler gets besides the request */
export type FakeContext = {
  /** The `:name` parts of the route's path, decoded, plus "*" for the rest when the path ends in "/*" */
  params: Record<string, string>
  /** The request's path under the service's mount, e.g. "/api/v10/users/@me" */
  path: string
  /** The service's own base on the fakes server, e.g. "http://127.0.0.1:3999/discord", for absolute links (next-page URLs) */
  baseUrl: string
}

export type FakeRoute = {
  method: FakeMethod
  /** Under the service's mount: "/api/v10/channels/:channelId/messages". A last segment "*" matches the rest */
  path: string
  handle(request: Request, ctx: FakeContext): Response | Promise<Response>
}

export type FakeService = {
  /** Its name in JACK_FAKES and the path it's mounted under: "discord" (lowercase letters, digits, dashes) */
  id: string
  /**
   * A fresh fake with its own state (seeded data, a fake clock, toggles). The server builds one when it
   * starts; each test mount builds its own, so tests never share state
   */
  create(): FakeRoute[]
}

/** Throw it from a handler to make the call fail like a dropped connection: fetch rejects, the server hangs up */
export class FakeNetworkError extends Error {
  constructor(message = "fake network error") {
    super(message)
    this.name = "FakeNetworkError"
  }
}
