import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const service = vi.hoisted(() => ({ storeLocalUpload: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/jack/files/service", () => service)

import { PUT } from "./route"

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

/** The request uploadToSignedUrl sends: a PUT with the file in a form beside cacheControl */
function formPut(body: string, id = ID) {
  const form = new FormData()
  form.append("cacheControl", "3600")
  form.append("", new Blob([body], { type: "text/plain" }))
  return PUT(new Request(`https://example.org/api/admin/jack/files/${id}/upload`, { method: "PUT", body: form }), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  service.storeLocalUpload.mockResolvedValue({ ok: true, data: null })
})

describe("PUT /api/admin/jack/files/[id]/upload (local files store)", () => {
  it("is for officers only", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"))
    expect((await formPut("hi")).status).toBe(403)
    expect(service.storeLocalUpload).not.toHaveBeenCalled()
  })

  it("takes the file out of the form and stores it for the officer", async () => {
    const res = await formPut("hello")
    expect(res.status).toBe(200)
    const [id, officer, body] = service.storeLocalUpload.mock.calls[0]
    expect([id, officer, body.toString()]).toEqual([ID, "officer-1", "hello"])
  })

  it("passes refusals on (another store, not theirs, already uploaded)", async () => {
    service.storeLocalUpload.mockResolvedValue({ ok: false, code: "not_found", error: "Uploads go straight to Supabase Storage here." })
    expect((await formPut("hello")).status).toBe(404)
    service.storeLocalUpload.mockResolvedValue({ ok: false, code: "forbidden", error: "no" })
    expect((await formPut("hello")).status).toBe(403)
  })

  it("refuses a bad id or an oversized body before reading it", async () => {
    expect((await formPut("x", "nope")).status).toBe(404)
    const big = new Request(`https://example.org/api/admin/jack/files/${ID}/upload`, { method: "PUT", body: "x", headers: { "content-length": String(30_000_000) } })
    expect((await PUT(big, { params: Promise.resolve({ id: ID }) })).status).toBe(413)
    expect(service.storeLocalUpload).not.toHaveBeenCalled()
  })
})
