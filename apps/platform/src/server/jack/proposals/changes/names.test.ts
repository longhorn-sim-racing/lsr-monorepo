import { describe, expect, it } from "vitest"
import { matchName, nameTokens, normalizeName, sameFirstName, scoreName, type NameCandidate } from "./names"

const member = (id: string, displayName: string, handle = nameTokens(displayName).join("-"), email: string | null = `${id}@example.com`): NameCandidate => ({ id, displayName, handle, email })

const ana = member("ana", "Ana Torres")
const jose = member("jose", "José Núñez")
const matt = member("matt", "Matthew Gray", "matt-gray")
const mattB = member("mattb", "Matt Brown")
const obrien = member("ob", "Siobhan O'Brien")
const juan = member("juan", "Juan Carlos Perez")
const kim1 = member("kim1", "Alex Kim")
const kim2 = member("kim2", "Alex Kim", "alex-kim-2")

describe("normalizing names", () => {
  it("ignores case, accents and punctuation", () => {
    expect(normalizeName("  José  NÚÑEZ ")).toBe("jose nunez")
    expect(normalizeName("O'Brien-Smith, J.")).toBe("obrien smith j")
    expect(nameTokens("Mary-Jane  Watson")).toEqual(["mary", "jane", "watson"])
  })

  it("treats nicknames and the start of a name as the same first name", () => {
    expect(sameFirstName("matt", "matthew")).toBe(true)
    expect(sameFirstName("bill", "william")).toBe(true)
    expect(sameFirstName("chris", "christopher")).toBe(true)
    expect(sameFirstName("jo", "joseph")).toBe(false)
    expect(sameFirstName("ana", "maria")).toBe(false)
  })
})

describe("scoreName", () => {
  it("matches handles and emails exactly", () => {
    expect(scoreName("@matt-gray", matt)).toBe(4)
    expect(scoreName("MATT-GRAY", matt)).toBe(4)
    expect(scoreName("matt@example.com", matt)).toBe(4)
    expect(scoreName("other@example.com", matt)).toBe(0)
    expect(scoreName("@someone-else", matt)).toBe(0)
  })

  it("scores names from the same words down to a lone name", () => {
    expect(scoreName("jose nunez", jose)).toBe(3)
    expect(scoreName("Torres Ana", ana)).toBe(3)
    expect(scoreName("Matt Gray", matt)).toBe(2.5)
    expect(scoreName("Juan Perez", juan)).toBe(2.5)
    expect(scoreName("M. Gray", matt)).toBe(2)
    expect(scoreName("Matt G", matt)).toBe(2)
    expect(scoreName("Siobhan OBrien", obrien)).toBe(3)
    expect(scoreName("Matt", matt)).toBe(1)
    expect(scoreName("Gray", matt)).toBe(1)
    expect(scoreName("Matt Green", matt)).toBe(0)
    expect(scoreName("M", matt)).toBe(0)
  })
})

describe("matchName", () => {
  const everyone = [ana, jose, matt, mattB, obrien, juan, kim1, kim2]

  it("prefers the event's own list, even for a lone first name", () => {
    expect(matchName("Matt", [matt], everyone)).toEqual({ kind: "matched", member: matt })
    expect(matchName("matthew", [matt, ana], everyone)).toEqual({ kind: "matched", member: matt })
  })

  it("offers everyone a name could be on the list", () => {
    expect(matchName("Matt", [matt, mattB], everyone)).toEqual({ kind: "ambiguous", candidates: [matt, mattB] })
  })

  it("finds people who didn't register only by a fuller name", () => {
    expect(matchName("Jose Nunez", [ana], everyone)).toEqual({ kind: "matched", member: jose })
    expect(matchName("@matt-gray", [], everyone)).toEqual({ kind: "matched", member: matt })
    // A lone name across all members is a guess: offered, never matched
    expect(matchName("Juan", [ana], everyone)).toEqual({ kind: "ambiguous", candidates: [juan] })
    expect(matchName("Alex Kim", [], everyone)).toEqual({ kind: "ambiguous", candidates: [kim1, kim2] })
  })

  it("gives up on nobody, or on a name too common to help", () => {
    expect(matchName("Zed Nobody", [ana], everyone)).toEqual({ kind: "unmatched" })
    const many = Array.from({ length: 7 }, (_, i) => member(`s${i}`, `Sam Person${i}`))
    expect(matchName("Sam", [], many)).toEqual({ kind: "unmatched" })
  })
})
