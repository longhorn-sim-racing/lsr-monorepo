import { describe, expect, it, vi } from "vitest"
import { createFakeRouter } from "./router"
import { FakeNetworkError, type FakeService } from "./types"

const counter: FakeService = {
  id: "counter",
  create() {
    let count = 0
    return [
      { method: "POST", path: "/v1/count", handle: () => Response.json({ count: ++count }) },
      { method: "GET", path: "/v1/count", handle: () => Response.json({ count }) },
      { method: "GET", path: "/v1/users/:userId/notes/:noteId", handle: (_request, { params, path, baseUrl }) => Response.json({ params, path, baseUrl }) },
      { method: "*", path: "/files/*", handle: (request, { params }) => Response.json({ method: request.method, rest: params["*"] }) },
      { method: "GET", path: "/boom", handle: () => Promise.reject(new Error("seed data missing")) },
      {
        method: "GET",
        path: "/drop",
        handle: () => {
          throw new FakeNetworkError("socket hang up")
        },
      },
    ]
  },
}

const call = (router: ReturnType<typeof createFakeRouter>, path: string, init?: RequestInit) => router(new Request(`http://127.0.0.1:3999${path}`, init))

describe("the fake router", () => {
  it("routes /<service>/<path> to the service's route by method and path", async () => {
    const router = createFakeRouter([counter])
    expect(await (await call(router, "/counter/v1/count", { method: "POST" })).json()).toEqual({ count: 1 })
    expect(await (await call(router, "/counter/v1/count", { method: "POST" })).json()).toEqual({ count: 2 })
    expect(await (await call(router, "/counter/v1/count?ignored=1")).json()).toEqual({ count: 2 })
  })

  it("passes decoded params, the path under the mount and the service's base", async () => {
    const router = createFakeRouter([counter])
    expect(await (await call(router, "/counter/v1/users/%40me/notes/42")).json()).toEqual({
      params: { userId: "@me", noteId: "42" },
      path: "/v1/users/%40me/notes/42",
      baseUrl: "http://127.0.0.1:3999/counter",
    })
  })

  it("matches the rest of the path with a trailing * and any method with *", async () => {
    const router = createFakeRouter([counter])
    expect(await (await call(router, "/counter/files/a/b%20c.txt", { method: "DELETE" })).json()).toEqual({ method: "DELETE", rest: "a/b c.txt" })
  })

  it("answers 404 for unknown paths and services, and 405 for a known path with the wrong method", async () => {
    const router = createFakeRouter([counter])
    const missing = await call(router, "/counter/v2/count")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ fake: true, error: "The counter fake has no route for GET /v2/count" })

    const unmounted = await call(router, "/discord/api/v10/users/@me")
    expect(unmounted.status).toBe(404)
    expect((await unmounted.json()).error).toMatch(/No fake is mounted at \/discord. Mounted: counter/)

    const wrongMethod = await call(router, "/counter/v1/count", { method: "DELETE" })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("POST, GET")
  })

  it("lists what's mounted at / and answers /_health", async () => {
    const router = createFakeRouter([counter])
    const index = await (await call(router, "/")).json()
    expect(index.services[0].id).toBe("counter")
    expect(index.services[0].routes).toContain("GET /counter/v1/users/:userId/notes/:noteId")
    expect(await (await call(router, "/_health")).json()).toEqual({ ok: true })
  })

  it("turns a handler's error into a 500, but passes a network error on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const router = createFakeRouter([counter])
    const failed = await call(router, "/counter/boom")
    expect(failed.status).toBe(500)
    expect((await failed.json()).error).toBe("The counter fake failed: seed data missing")
    await expect(call(router, "/counter/drop")).rejects.toBeInstanceOf(FakeNetworkError)
  })

  it("gives each router its own state", async () => {
    const first = createFakeRouter([counter])
    await call(first, "/counter/v1/count", { method: "POST" })
    const second = createFakeRouter([counter])
    expect(await (await call(second, "/counter/v1/count")).json()).toEqual({ count: 0 })
  })

  it("refuses ids that can't be a path, and two fakes with one id", () => {
    expect(() => createFakeRouter([{ ...counter, id: "Counter" }])).toThrow(/lowercase/)
    expect(() => createFakeRouter([counter, counter])).toThrow('Two fakes are called "counter"')
  })
})
