import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackMessage: { findMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { contactDetails, draftTextTool, unsourcedDetails } from "./draft-text"
import type { JackToolContext } from "./types"

const ctx: JackToolContext = { roomId: "room-1", messageId: "reply-1", actor: { userId: "u-ana", displayName: "Ana" } }

async function call(input: unknown) {
  const parsed = draftTextTool.input.safeParse(input)
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "))
  return draftTextTool.run(parsed.data, ctx)
}

beforeEach(() => {
  db.jackMessage.findMany.mockResolvedValue([{ content: "Draft a follow-up to Jordan at Apex, jordan@apexsimrigs.example, about Tuesday" }])
})

describe("contact details in drafts", () => {
  it("finds email addresses and phone numbers, but not dates and times", () => {
    expect(contactDetails("Write to Jordan@Apex.example or call (512) 555-0123 / +1 512.555.0199")).toEqual({ emails: ["jordan@apex.example"], phones: ["5125550123", "15125550199"] })
    expect(contactDetails("GM 2 is Mon 2026-10-26 18:00, room 2.102; budget $12,500")).toEqual({ emails: [], phones: [] })
  })

  it("allows what an officer gave and the club's own addresses, nothing else", () => {
    const officerText = "Jordan's email is jordan@apexsimrigs.example and her cell is 512-555-0123"
    expect(unsourcedDetails("Hi Jordan (jordan@apexsimrigs.example, 512 555 0123), questions to info@longhornsimracing.org", officerText)).toEqual([])
    expect(unsourcedDetails("Copying sam@apexsimrigs.example; call 737-555-0100", officerText)).toEqual(["sam@apexsimrigs.example", "7375550100"])
  })
})

describe("draft_text", () => {
  it("is always loaded and never writes", () => {
    expect(draftTextTool.deferred).toBeFalsy()
    expect(draftTextTool.writes).toBeFalsy()
  })

  it("shows an email as a copyable draft, and tells Jack nothing was sent", async () => {
    const result = await call({ type: "email", to: "Jordan at Apex Sim Rigs", subject: "Following up from Tuesday", body: "Hi Jordan,\n\nThanks for meeting with us on Tuesday…" })
    expect(result.isError).toBeFalsy()
    expect(result.displays).toEqual([{ kind: "text_draft", draftKind: "email", to: "Jordan at Apex Sim Rigs", subject: "Following up from Tuesday", body: "Hi Jordan,\n\nThanks for meeting with us on Tuesday…" }])
    expect(result.label).toBe("Drafted an email to Jordan at Apex Sim Rigs")
    expect(JSON.parse(result.forModel)).toMatchObject({ shown: true, note: expect.stringMatching(/Nothing was sent/) })
    // Only officers' own messages count as what they gave
    expect(db.jackMessage.findMany.mock.calls[0][0].where).toEqual({ roomId: "room-1", kind: "user" })
  })

  it("keeps an address an officer gave, and refuses one they didn't", async () => {
    expect((await call({ type: "email", to: "jordan@apexsimrigs.example", body: "Hi Jordan" })).isError).toBeFalsy()
    const refused = await call({ type: "email", to: "Jordan", body: "Hi Jordan, cc sam@apexsimrigs.example" })
    expect(refused).toMatchObject({ isError: true, displays: [] })
    expect(refused.forModel).toMatch(/sam@apexsimrigs\.example/)
  })

  it("drops a subject and recipient from drafts that aren't emails, and checks Instagram's caption limits", async () => {
    expect((await call({ type: "agenda", subject: "x", to: "y", body: "1. Welcome" })).displays).toEqual([{ kind: "text_draft", draftKind: "agenda", body: "1. Welcome" }])
    expect((await call({ type: "caption", body: "x".repeat(2_201) })).forModel).toMatch(/at most 2,200 characters/)
    expect((await call({ type: "caption", body: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ") })).forModel).toMatch(/at most 30 hashtags/)
    expect((await call({ type: "caption", body: "Race night! #simracing #longhorns" })).isError).toBeFalsy()
  })
})
