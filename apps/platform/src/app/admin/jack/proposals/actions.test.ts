import { beforeEach, describe, expect, it, vi } from "vitest"

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const service = vi.hoisted(() => ({ applyProposal: vi.fn(), discardProposal: vi.fn() }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/jack/proposals/service", () => service)

import { applyJackProposal, discardJackProposal } from "./actions"

const ID = "6b1f5c8e-2f0a-4d47-9a37-2d6c1e5b9f10"
const state = { id: ID, status: "APPLIED", updatedAt: "2026-10-22T15:00:00.000Z" }
const note = { id: "n1", content: "Gray applied: X" }

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1", displayName: "Gray" })
  service.applyProposal.mockResolvedValue({ ok: true, proposal: state, note })
  service.discardProposal.mockResolvedValue({ ok: false, error: "It was already applied.", proposal: state })
})

describe("the proposal card's actions", () => {
  it("need an officer", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"))
    await expect(applyJackProposal(ID)).rejects.toThrow()
    await expect(discardJackProposal(ID)).rejects.toThrow()
    expect(service.applyProposal).not.toHaveBeenCalled()
  })

  it("apply as the officer who clicked, with the rows they picked", async () => {
    expect(await applyJackProposal(ID, ["r1", "r2"])).toEqual({ ok: true, data: { proposal: state, note } })
    expect(service.applyProposal).toHaveBeenCalledWith(ID, { id: "officer-1", displayName: "Gray" }, { selectedRows: ["r1", "r2"] })
  })

  it("pass on why it didn't happen, with the proposal's state", async () => {
    expect(await discardJackProposal(ID)).toEqual({ ok: false, error: "It was already applied.", proposal: state })
  })

  it("refuse ids and rows that can't be real", async () => {
    expect(await applyJackProposal("nope")).toMatchObject({ ok: false })
    expect(await applyJackProposal(ID, [42 as unknown as string])).toMatchObject({ ok: false })
    expect(await applyJackProposal(ID, Array.from({ length: 2_001 }, (_, i) => `r${i}`))).toMatchObject({ ok: false })
    expect(service.applyProposal).not.toHaveBeenCalled()
  })
})
