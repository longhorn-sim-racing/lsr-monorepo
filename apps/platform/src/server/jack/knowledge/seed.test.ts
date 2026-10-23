import { describe, expect, it } from "vitest"
import { duplicateSeedTitles, isSeedFileName, parseSeedFile, parseSeedOwner, splitFrontMatter } from "./seed"

const file = (front: string, body = "The entry fee is $10, or $5 for returning drivers.") => `---\n${front}\n---\n\n${body}\n`

const GOOD = file(`title: LSC entry fee for Season 3
tags: [lsc, fees, Decision]
sourceNote: "Competition team post in Teams, Sep 28"
sourceDate: 2026-09-28
owner: "@Armando-Martinez"`)

describe("parseSeedFile", () => {
  it("reads the front matter and the text", () => {
    expect(parseSeedFile("lsc/fees.md", GOOD)).toEqual({
      ok: true,
      entry: {
        file: "lsc/fees.md",
        title: "LSC entry fee for Season 3",
        body: "The entry fee is $10, or $5 for returning drivers.",
        tags: ["lsc", "fees", "decision"],
        sourceNote: "Competition team post in Teams, Sep 28",
        sourceDate: "2026-09-28",
        owner: { kind: "handle", handle: "armando-martinez" },
      },
    })
  })

  it("takes a department as the owner, and tags the entry with it", () => {
    const parsed = parseSeedFile("fees.md", GOOD.replace('owner: "@Armando-Martinez"', 'owner: "Competition"'))
    expect(parsed).toMatchObject({ ok: true, entry: { owner: { kind: "department", id: "competition" }, tags: ["lsc", "fees", "decision", "competition"] } })
  })

  it("takes tags as a list too, and no owner", () => {
    const parsed = parseSeedFile("brand.md", file("title: Club colors\ntags:\n  - brand\n  - 'design'\nsourceNote: Media team\nsourceDate: 2026-09-01"))
    expect(parsed).toMatchObject({ ok: true, entry: { tags: ["brand", "design"], owner: null } })
  })

  it("lists every missing or bad field", () => {
    const parsed = parseSeedFile("bad.md", file("title: X\nsourceDate: 2026-02-30\nowner: Not A Handle\ncolour: blue", ""))
    expect(parsed).toEqual({
      ok: false,
      file: "bad.md",
      errors: [
        'Unknown field "colour" (the fields are title, tags, sourceNote, sourceDate, owner).',
        "title has to be 3 to 120 characters.",
        "tags is missing: give at least one, e.g. tags: [policy].",
        'sourceNote is missing: say where it came from, e.g. "Teams General, Dylan, Sep 28".',
        'sourceDate "2026-02-30" isn\'t a date like 2026-09-28.',
        'owner "Not A Handle" isn\'t a department (Executive, Competition, Community, Media, Business, Technology) or an officer\'s handle.',
        "The entry has no text after the front matter.",
      ],
    })
  })

  it("rejects emails, keys and tokens anywhere in the entry", () => {
    const withEmail = parseSeedFile("a.md", GOOD.replace("The entry fee", "Ask treasurer@example.com. The entry fee"))
    expect(withEmail).toMatchObject({ ok: false, errors: [expect.stringMatching(/email address/)] })
    // Built from pieces, so nothing scanning the repo mistakes it for a real key
    const key = "re_" + "a1b2c3d4".repeat(3)
    expect(parseSeedFile("b.md", GOOD.replace("Season 3", `Season 3 ${key}`))).toMatchObject({ ok: false, errors: [expect.stringMatching(/seems to hold a Resend key/)] })
    expect(parseSeedFile("c.md", GOOD.replace("$10", "$10 (password: lsrRacing2026)"))).toMatchObject({ ok: false, errors: [expect.stringMatching(/seems to hold a password or token/)] })
  })

  it("needs front matter that starts and ends", () => {
    expect(parseSeedFile("d.md", "Just text")).toMatchObject({ ok: false, errors: [expect.stringMatching(/start with front matter/)] })
    expect(parseSeedFile("e.md", "---\ntitle: Never ends\n")).toMatchObject({ ok: false, errors: [expect.stringMatching(/never ends/)] })
    expect(splitFrontMatter("---\ntitle: a\ntitle: b\n---\nx")).toEqual({ error: "title is in the front matter twice." })
  })
})

describe("owners and file names", () => {
  it("reads a department by name or id, and a handle with or without @", () => {
    expect(parseSeedOwner("Media")).toEqual({ kind: "department", id: "media" })
    expect(parseSeedOwner(" technology ")).toEqual({ kind: "department", id: "technology" })
    expect(parseSeedOwner("@Gray-Marshall")).toEqual({ kind: "handle", handle: "gray-marshall" })
    // @ makes it a handle even when it's a department's name
    expect(parseSeedOwner("@media")).toEqual({ kind: "handle", handle: "media" })
    expect(parseSeedOwner("Media team")).toBeNull()
  })

  it("skips the README and notes whose name starts with _", () => {
    expect(["dues.md", "README.md", "_index.md", "notes.txt", "Brand.MD"].filter(isSeedFileName)).toEqual(["dues.md", "Brand.MD"])
  })
})

describe("duplicateSeedTitles", () => {
  it("finds files that share a title, ignoring case", () => {
    const entry = (file: string, title: string) => ({ file, title, body: "x", tags: ["a"], sourceNote: "n", sourceDate: "2026-09-28", owner: null })
    expect(duplicateSeedTitles([entry("a.md", "Dues"), entry("b.md", "Brand"), entry("c.md", "dues")])).toEqual([{ title: "Dues", files: ["a.md", "c.md"] }])
  })
})
