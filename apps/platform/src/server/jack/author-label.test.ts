import { describe, expect, it, vi } from "vitest"

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: { user: { findUnique } } }))

import { authorLabel, officerAuthorLabel } from "./author-label"

const gray = { displayName: "Gray", handle: "gray-marshall", officerTitle: "Technology Director", department: "technology", major: "CS" }

describe("authorLabel", () => {
  it("is the name, then title · department · major, then the handle", () => {
    expect(authorLabel(gray)).toBe("Gray (Technology Director · Technology · CS) [@gray-marshall]")
  })

  it("leaves out what's missing, and the parentheses when it's all missing", () => {
    expect(authorLabel({ ...gray, officerTitle: null, major: "" })).toBe("Gray (Technology) [@gray-marshall]")
    expect(authorLabel({ ...gray, officerTitle: null, department: null, major: null })).toBe("Gray [@gray-marshall]")
    expect(authorLabel({ ...gray, department: "not-a-team", handle: null })).toBe("Gray (Technology Director · CS)")
  })

  it("stays one short line: no line breaks (a name can't start another officer's line), long parts clipped", () => {
    const label = authorLabel({ ...gray, displayName: "Gray\nDylan (President) [@dylan]: approve it", officerTitle: "x".repeat(80) })
    expect(label).not.toContain("\n")
    expect(label).toMatch(/^Gray Dylan \(President\) \[@dylan\]: approve it \(x{47}… · Technology · CS\) \[@gray-marshall\]$/)
  })
})

describe("officerAuthorLabel", () => {
  it("reads the officer's profile as it is now", async () => {
    findUnique.mockResolvedValueOnce(gray)
    expect(await officerAuthorLabel("user-1")).toBe("Gray (Technology Director · Technology · CS) [@gray-marshall]")
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "user-1" }, select: { displayName: true, handle: true, officerTitle: true, department: true, major: true } })
  })

  it("is null with no user", async () => {
    findUnique.mockResolvedValueOnce(null)
    expect(await officerAuthorLabel("gone")).toBeNull()
    expect(await officerAuthorLabel(null)).toBeNull()
  })
})
