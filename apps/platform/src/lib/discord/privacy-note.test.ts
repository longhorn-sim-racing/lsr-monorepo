import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { privacyNoteText } from "./privacy-note"

// The note's wording lives in the discord-read track doc (/privacy §2.4 says the same); the bot posts this copy
const TRACK_DOC = path.join(__dirname, "../../../../../docs/jack-2/tracks/discord-read.md")

/** The quoted note under "The server privacy note", one paragraph per line */
function docNote(): string[] {
  const lines = readFileSync(TRACK_DOC, "utf8").split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith("### The server privacy note"))
  const quoted: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("> ")) break
    quoted.push(line.slice(2))
  }
  return quoted
}

describe("privacyNoteText", () => {
  it("is the note in the track doc, with the synced channels as links", () => {
    const paragraphs = docNote()
    expect(paragraphs).toHaveLength(5)
    expect(privacyNoteText(["111", "222"]).split("\n\n")).toEqual(paragraphs.map((p) => p.replace("<#channel> <#channel> …", "<#111> <#222>.")))
  })

  it("says it keeps who started a thread or forum post", () => {
    expect(privacyNoteText([])).toContain("the titles of public threads and forum posts in these channels, and who started them.")
  })
})
