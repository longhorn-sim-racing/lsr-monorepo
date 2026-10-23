import { describe, expect, it } from "vitest"
import { isAnswerMode, mentionNames, mentionPlaceholder, mentionsAssistant } from "./mentions"

describe("mentionsAssistant", () => {
  it("finds @Jack in any case, anywhere, as a word of its own", () => {
    for (const text of ["@Jack how many members?", "how many members @jack", "@JACK?", "Thanks @Jack, and (@jack) again", "line one\n@jack line two", "@Jack's take?", "hey @jack:"]) {
      expect(mentionsAssistant(text, "jack"), text).toBe(true)
    }
  })

  it("doesn't count Jack's name without the @, email addresses or longer names", () => {
    for (const text of ["Jack, how many members?", "jack how many", "mail gray@jack.example", "@jackson said so", "@ jack", "@@jack", "@jack_bot", "@jack2"]) {
      expect(mentionsAssistant(text, "jack"), text).toBe(false)
    }
  })

  it("takes the name of the persona answering the room too, and only that one", () => {
    expect(mentionsAssistant("@Lift dig into this", "lift")).toBe(true)
    expect(mentionsAssistant("@jack dig into this", "lift")).toBe(true)
    expect(mentionsAssistant("@Stand dig into this", "lift")).toBe(false)
    expect(mentionsAssistant("@lift dig into this", "jack")).toBe(false)
    expect(mentionsAssistant("@stand quick one", "stand")).toBe(true)
  })

  it("names what can be mentioned, Jack first", () => {
    expect(mentionNames("jack")).toEqual(["Jack"])
    expect(mentionNames("lift")).toEqual(["Jack", "Lift"])
  })
})

describe("answer modes", () => {
  it("knows the two modes", () => {
    expect(isAnswerMode("always")).toBe(true)
    expect(isAnswerMode("mention")).toBe(true)
    expect(isAnswerMode("never")).toBe(false)
    expect(isAnswerMode(undefined)).toBe(false)
  })

  it("tells the composer how to ask", () => {
    expect(mentionPlaceholder("jack")).toBe("Mention @Jack to ask him. Other messages are for the room.")
    expect(mentionPlaceholder("lift")).toBe("Mention @Lift to ask Lift (or @Jack). Other messages are for the room.")
  })
})
