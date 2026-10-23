import { describe, expect, it } from "vitest"
import { isCardImagePath, isProposalStatus, latestProposalState, noteLink, noteWithLink, roomMessageUrl } from "./proposals"
import type { JackProposalState } from "./types"

describe("room notes with a link", () => {
  it("adds a site path after an arrow, and reads it back", () => {
    const note = noteWithLink("Dylan applied: Edit the page “LSC Rules”", "/admin/pages/abc-123")
    expect(note).toBe("Dylan applied: Edit the page “LSC Rules” → /admin/pages/abc-123")
    expect(noteLink(note)).toEqual({ text: "Dylan applied: Edit the page “LSC Rules”", path: "/admin/pages/abc-123" })
  })

  it("leaves off anything that isn't a plain site path", () => {
    for (const path of ["https://evil.example/x", "//evil.example", "/\\evil.example", "/a b", "javascript:alert(1)", "", null, undefined]) {
      expect(noteWithLink("Applied", path), String(path)).toBe("Applied")
    }
  })

  it("doesn't take a link out of notes that only look like one", () => {
    expect(noteLink("Alex renamed this room “Plans → /admin”")).toBeNull()
    expect(noteLink("Gray switched this room to Lift")).toBeNull()
    expect(noteLink("x → https://evil.example")).toBeNull()
  })
})

describe("latestProposalState", () => {
  const at = (status: JackProposalState["status"], updatedAt: string): JackProposalState => ({ status, updatedAt })

  it("takes the newest copy, and the further-along one when they're from the same moment", () => {
    expect(latestProposalState(at("PENDING", "2026-10-22T10:00:00.000Z"), at("APPLIED", "2026-10-22T10:01:00.000Z"))?.status).toBe("APPLIED")
    expect(latestProposalState(at("APPLIED", "2026-10-22T10:01:00.000Z"), at("APPLYING", "2026-10-22T10:00:30.000Z"))?.status).toBe("APPLIED")
    expect(latestProposalState(at("APPLYING", "2026-10-22T10:00:00.000Z"), at("PENDING", "2026-10-22T10:00:00.000Z"))?.status).toBe("APPLYING")
    expect(latestProposalState(at("PENDING", "2026-10-22T10:00:00.000Z"), at("STALE", "2026-10-22T10:00:00.000Z"))?.status).toBe("STALE")
  })

  it("skips missing copies", () => {
    expect(latestProposalState(undefined, null)).toBeNull()
    expect(latestProposalState(undefined, at("PENDING", "2026-10-22T10:00:00.000Z"))?.status).toBe("PENDING")
  })
})

describe("helpers", () => {
  it("knows the statuses", () => {
    expect(isProposalStatus("PENDING")).toBe(true)
    expect(isProposalStatus("pending")).toBe(false)
    expect(isProposalStatus("toString")).toBe(false)
  })

  it("links to a room's message", () => {
    expect(roomMessageUrl("r1", "m 1")).toBe("/admin/jack/r1?m=m%201")
    expect(roomMessageUrl("r1", null)).toBe("/admin/jack/r1")
  })

  it("lets a card load pictures only from this site's officer-only slide and room file routes", () => {
    const deck = "11111111-1111-4111-8111-111111111111"
    expect(isCardImagePath(`/api/admin/jack/decks/${deck}/slides/slide-a?v=3&kind=thumb`)).toBe(true)
    expect(isCardImagePath(`/api/admin/jack/files/${deck}?variant=thumb`)).toBe(true)
    for (const url of [
      "https://evil.example/x.jpg",
      "//evil.example/x.jpg",
      "/\\evil.example/x.jpg",
      `/api/admin/jack/decks/${deck}/export?format=pdf`,
      `/api/admin/jack/files/${deck}/../../../x`,
      `/api/admin/jack/files/${deck}?variant=thumb#"onerror`,
      "/admin/jack",
      "javascript:alert(1)",
    ]) {
      expect(isCardImagePath(url), url).toBe(false)
    }
  })
})
