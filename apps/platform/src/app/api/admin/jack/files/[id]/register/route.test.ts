import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const service = vi.hoisted(() => ({ registerFile: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/jack/files/service", () => service)

import { POST } from "./route"

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const call = (id = ID) => POST(new Request(`https://example.org/api/admin/jack/files/${id}/register`, { method: "POST" }), { params: Promise.resolve({ id }) })
const file = { id: ID, filename: "a.png", kind: "IMAGE", sizeBytes: 10, url: `/api/admin/jack/files/${ID}` }

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  service.registerFile.mockResolvedValue({ ok: true, data: file })
})

describe("POST /api/admin/jack/files/[id]/register", () => {
  it("is for officers only", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"))
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: "Officers only" })
    expect(service.registerFile).not.toHaveBeenCalled()
  })

  it("registers the file as the signed-in officer and returns it", async () => {
    const res = await call()
    expect(service.registerFile).toHaveBeenCalledWith(ID, "officer-1")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ ok: true, file })
  })

  it("passes the reason on, with a status for each kind of problem", async () => {
    for (const [code, status] of [["bad_request", 422], ["not_found", 404], ["forbidden", 403], ["unavailable", 503]] as const) {
      service.registerFile.mockResolvedValue({ ok: false, code, error: `Problem: ${code}` })
      const res = await call()
      expect(res.status, code).toBe(status)
      expect(await res.json()).toEqual({ ok: false, error: `Problem: ${code}` })
    }
  })

  it("refuses an id that isn't one", async () => {
    expect((await call("nope")).status).toBe(404)
    expect(service.registerFile).not.toHaveBeenCalled()
  })
})
