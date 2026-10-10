import { describe, expect, it, vi } from "vitest"
import { unexpectedError } from "./action-result"

describe("unexpectedError", () => {
  it("hides the message in production and says it's on our side", () => {
    vi.stubEnv("NODE_ENV", "production")
    const message = unexpectedError(new Error("connect ECONNREFUSED 10.0.0.1:5432"), "Couldn't save the user")
    expect(message).toMatch(/^Couldn't save the user\. Something went wrong on our side/)
    expect(message).not.toContain("ECONNREFUSED")
  })

  it("shows the message in development", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(unexpectedError(new Error("Unique constraint failed"), "Couldn't save")).toBe("Couldn't save: Unique constraint failed")
  })

  it("has a default subject and copes with non-errors", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(unexpectedError("weird")).toMatch(/^That didn't work\. Something went wrong on our side/)
  })
})
