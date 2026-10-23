import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const service = vi.hoisted(() => ({ getProposalDetail: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/jack/proposals/service", () => service)

import { GET } from "./route"

const ID = "6b1f5c8e-2f0a-4d47-9a37-2d6c1e5b9f10"
const call = (id: string) => GET(new NextRequest(`https://example.org/api/admin/jack/proposals/${id}`), { params: Promise.resolve({ id }) })

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  service.getProposalDetail.mockResolvedValue({ id: ID, status: "PENDING", canApply: true })
})

describe("GET /api/admin/jack/proposals/[id]", () => {
  it("is for officers only", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"))
    const res = await call(ID)
    expect(res.status).toBe(403)
    expect(service.getProposalDetail).not.toHaveBeenCalled()
  })

  it("refuses an id that isn't one, and reports one that's gone", async () => {
    expect((await call("../../users")).status).toBe(400)
    expect(service.getProposalDetail).not.toHaveBeenCalled()
    service.getProposalDetail.mockResolvedValue(null)
    expect((await call(ID)).status).toBe(404)
  })

  it("sends the proposal as the viewer may act on it, never cached", async () => {
    const res = await call(ID)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ id: ID, status: "PENDING", canApply: true })
    expect(service.getProposalDetail).toHaveBeenCalledWith(ID, "officer-1")
  })
})
