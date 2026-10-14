import { describe, expect, it } from "vitest"
import { JACK_TITLE_MAX, jackPersonaSwitchSchema, jackRoomRenameSchema } from "./jack.schema"

const roomId = "5430dd65-2af7-4cdf-9aae-7547fde54d03"

describe("jackRoomRenameSchema", () => {
  it("trims the name", () => {
    expect(jackRoomRenameSchema.parse({ roomId, title: "  GM 1 planning  " })).toEqual({ roomId, title: "GM 1 planning" })
  })

  it("needs a name: empty or only spaces is an error", () => {
    for (const title of ["", "   "]) {
      const result = jackRoomRenameSchema.safeParse({ roomId, title })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toBe("Type a name for the room")
    }
  })

  it("keeps it under the title limit", () => {
    expect(jackRoomRenameSchema.safeParse({ roomId, title: "x".repeat(JACK_TITLE_MAX) }).success).toBe(true)
    expect(jackRoomRenameSchema.safeParse({ roomId, title: "x".repeat(JACK_TITLE_MAX + 1) }).success).toBe(false)
  })

  it("refuses a room id that isn't one", () => {
    expect(jackRoomRenameSchema.safeParse({ roomId: "not-a-room", title: "Anything" }).success).toBe(false)
  })
})

describe("jackPersonaSwitchSchema", () => {
  it("takes all three personas and nothing else", () => {
    for (const persona of ["jack", "lift", "stand"]) expect(jackPersonaSwitchSchema.safeParse({ roomId, persona }).success).toBe(true)
    expect(jackPersonaSwitchSchema.safeParse({ roomId, persona: "fable" }).success).toBe(false)
  })
})
