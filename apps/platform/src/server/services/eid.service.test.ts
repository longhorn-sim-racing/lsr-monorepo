import { describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

vi.mock("@/server/db", () => ({ prisma: {} }))

import { assertEidAvailable, EID_TAKEN, setUserEid } from "./eid.service"

// A stand-in for the Prisma client: only the user lookups the EID service makes
function fakeDb(owner: { id: string } | null, update = vi.fn().mockResolvedValue({})) {
  return { user: { findUnique: vi.fn().mockResolvedValue(owner), update } } as unknown as Parameters<typeof setUserEid>[2]
}

describe("assertEidAvailable", () => {
  it("passes when nobody has the EID, or the user already does", async () => {
    await expect(assertEidAvailable(fakeDb(null)!, "abc123", "u1")).resolves.toBeUndefined()
    await expect(assertEidAvailable(fakeDb({ id: "u1" })!, "abc123", "u1")).resolves.toBeUndefined()
  })

  it("throws when another account has it", async () => {
    await expect(assertEidAvailable(fakeDb({ id: "u2" })!, "abc123", "u1")).rejects.toThrow(EID_TAKEN)
  })
})

describe("setUserEid", () => {
  it("saves an EID nobody else has", async () => {
    const update = vi.fn().mockResolvedValue({})
    expect(await setUserEid("u1", "abc123", fakeDb(null, update))).toBe("ok")
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { eid: "abc123" } })
  })

  it("clears the EID without checking for owners", async () => {
    const db = fakeDb({ id: "u2" })
    expect(await setUserEid("u1", null, db)).toBe("ok")
    expect(db!.user.findUnique).not.toHaveBeenCalled()
  })

  it("reports an EID on another account without writing", async () => {
    const update = vi.fn()
    expect(await setUserEid("u1", "abc123", fakeDb({ id: "u2" }, update))).toBe("taken")
    expect(update).not.toHaveBeenCalled()
  })

  it("reports a race the unique index catches", async () => {
    const clash = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    expect(await setUserEid("u1", "abc123", fakeDb(null, vi.fn().mockRejectedValue(clash)))).toBe("taken")
  })

  it("rethrows anything else", async () => {
    await expect(setUserEid("u1", "abc123", fakeDb(null, vi.fn().mockRejectedValue(new Error("db down"))))).rejects.toThrow("db down")
  })
})
