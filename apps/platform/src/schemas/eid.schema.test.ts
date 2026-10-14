import { describe, expect, it } from "vitest"
import { eidInputSchema } from "./eid.schema"

describe("eidInputSchema", () => {
  it("lowercases and trims a UT EID", () => {
    expect(eidInputSchema.parse("  ABC1234 ")).toBe("abc1234")
  })

  it("treats blank as removing the EID", () => {
    expect(eidInputSchema.parse("")).toBeNull()
    expect(eidInputSchema.parse("   ")).toBeNull()
  })

  it.each(["1234abc", "ab-123", "abc 123", "a", "abcdefghijklmnopq"])("rejects %j", (value) => {
    expect(eidInputSchema.safeParse(value).success).toBe(false)
  })
})
