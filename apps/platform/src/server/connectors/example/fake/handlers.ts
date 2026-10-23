import type { FakeService } from "../../fakes/types"

/** The only key the example fake accepts */
export const EXAMPLE_FAKE_TOKEN = "example-fake-token"

/**
 * The template for a service's fake, mounted at /example (client.ts is the real client that talks to
 * it). A real fake reproduces what its research file's "How to fake it locally" lists: the auth
 * errors, paging, rate limits and error shapes, plus test hooks (`POST /_fake/...`) to change its data.
 */
export const exampleFake: FakeService = {
  id: "example",
  create() {
    // State lives in create(), so each server start and each test mount begins fresh
    const notes: string[] = []
    const authorized = (request: Request) => request.headers.get("authorization") === `Bearer ${EXAMPLE_FAKE_TOKEN}`
    const unauthorized = () => Response.json({ message: "401: Unauthorized" }, { status: 401 })

    return [
      { method: "GET", path: "/v1/ping", handle: () => Response.json({ ok: true }) },
      {
        method: "GET",
        path: "/v1/notes",
        handle: (request) => (authorized(request) ? Response.json({ notes }) : unauthorized()),
      },
      {
        method: "POST",
        path: "/v1/notes",
        handle: async (request) => {
          if (!authorized(request)) return unauthorized()
          const body = (await request.json().catch(() => null)) as { text?: unknown } | null
          if (typeof body?.text !== "string" || !body.text.trim()) return Response.json({ message: "text is required" }, { status: 400 })
          notes.push(body.text.trim())
          return Response.json({ notes }, { status: 201 })
        },
      },
    ]
  },
}
