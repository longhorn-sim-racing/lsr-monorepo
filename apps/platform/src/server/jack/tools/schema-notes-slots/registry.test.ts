import { describe, expect, it } from "vitest"
import { mergeTableNotes, SLOT_SCHEMA_NOTES, SLOT_TABLE_NOTES } from "./registry"

describe("the tracks' schema notes", () => {
  it("appends a second note on the same table instead of replacing it, and drops empty ones", () => {
    expect(mergeTableNotes({ User: "One site account per person." }, { User: " department is the officer's team. ", Meeting: "" }, { Meeting: "A club meeting." })).toEqual({
      User: "One site account per person. department is the officer's team.",
      Meeting: "A club meeting.",
    })
  })

  it("leaves out tracks with nothing to say", () => {
    expect(SLOT_SCHEMA_NOTES.every((note) => note.length > 0)).toBe(true)
    expect(Object.values(SLOT_TABLE_NOTES).every((note) => note.length > 0)).toBe(true)
  })
})
