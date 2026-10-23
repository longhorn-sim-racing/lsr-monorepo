import { describe, expect, it } from "vitest"
import { duplicateSeedTitles, isSeedFileName, parseSeedFile, parseSeedOwner, planSeedReload, splitFrontMatter, type LoadedSeed, type SeedFields } from "./seed"

const file = (front: string, body = "The entry fee is $10, or $5 for returning drivers.") => `---\n${front}\n---\n\n${body}\n`

const GOOD = file(`title: LSC entry fee for Season 3
tags: [lsc, fees, Decision]
sourceNote: "Competition team post in Teams, Sep 28"
sourceDate: 2026-09-28
owner: "@Test-Owner"`)

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
        owner: { kind: "handle", handle: "test-owner" },
      },
    })
  })

  it("takes a department as the owner, and tags the entry with it", () => {
    const parsed = parseSeedFile("fees.md", GOOD.replace('owner: "@Test-Owner"', 'owner: "Competition"'))
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

describe("planSeedReload", () => {
  const loadedAt = new Date("2026-10-25T17:00:00Z")
  const signedOff = new Date("2026-10-25T05:00:00Z")
  const later = new Date("2026-11-02T17:00:00Z")
  const file: SeedFields = { title: "LSC entry fee", body: "$10, or $5 for returning drivers.", tags: ["lsc", "fees"], sourceNote: "Teams General", sourceDate: new Date("2026-09-28T05:00:00Z"), ownerId: "officer-1" }
  // As the first load left it
  const loaded = (overrides: Partial<LoadedSeed> = {}): LoadedSeed => ({
    ...file,
    reviewedAt: signedOff,
    versions: [{ id: "v1", title: file.title, via: "seed", createdAt: loadedAt }],
    changes: [{ at: loadedAt, actionType: "CREATE", via: "seed" }],
    ...overrides,
  })

  it("leaves an entry alone when neither the file nor the sign-off changed", () => {
    expect(planSeedReload(loaded(), file, { approvedAt: signedOff })).toEqual({ action: "same" })
    expect(planSeedReload(loaded(), file, { approvedAt: null })).toEqual({ action: "same" })
  })

  it("updates what the file changed, on the newest version, reviewed as of the sign-off", () => {
    expect(planSeedReload(loaded(), { ...file, body: "$12 now.", sourceNote: "Teams General, Oct 30" }, { approvedAt: later })).toEqual({
      action: "update",
      baseVersionId: "v1",
      reviewedAt: later,
      changed: ["text", "source"],
      overwriting: false,
    })
    // A new sign-off alone re-dates the review
    expect(planSeedReload(loaded(), file, { approvedAt: later })).toMatchObject({ action: "update", reviewedAt: later, changed: ["review date"] })
  })

  it("never moves an officer's later review back, unless the text changes", () => {
    const reviewedLater = loaded({ reviewedAt: later })
    expect(planSeedReload(reviewedLater, file, { approvedAt: signedOff })).toEqual({ action: "same" })
    expect(planSeedReload(reviewedLater, { ...file, ownerId: "officer-2" }, { approvedAt: signedOff })).toMatchObject({ action: "update", reviewedAt: null, changed: ["owner"] })
    expect(planSeedReload(reviewedLater, { ...file, body: "New." }, { approvedAt: signedOff })).toMatchObject({ action: "update", reviewedAt: signedOff })
  })

  it("skips an entry edited on the site since the last load, unless told to overwrite it", () => {
    const edited = loaded({
      body: "$10; officers fixed this on the page.",
      versions: [
        { id: "v2", title: file.title, via: "admin", createdAt: later },
        { id: "v1", title: file.title, via: "seed", createdAt: loadedAt },
      ],
      changes: [
        { at: loadedAt, actionType: "CREATE", via: "seed" },
        { at: later, actionType: "UPDATE", via: "admin" },
      ],
    })
    // Even a typo fix in another file mustn't put the old text back
    expect(planSeedReload(edited, file, { approvedAt: signedOff })).toEqual({ action: "skip", reason: "edited on the site since the last load (by an officer on the Knowledge page, 2026-11-02)" })
    expect(planSeedReload(edited, file, { approvedAt: signedOff, overwrite: true })).toMatchObject({ action: "update", baseVersionId: "v2", changed: ["text"], overwriting: true })
  })

  it("skips one whose details an officer or Jack changed since, and counts the seed's own detail changes as loads", () => {
    const owner = loaded({ ownerId: "officer-2", changes: [{ at: loadedAt, actionType: "CREATE", via: "seed" }, { at: later, actionType: "UPDATE", via: "jack" }] })
    expect(planSeedReload(owner, file, { approvedAt: signedOff })).toMatchObject({ action: "skip", reason: expect.stringMatching(/details were changed on the site .*by Jack/) })

    // The seed changed the source last time (no version for that): still its own load, not an edit
    const reloaded = loaded({ sourceNote: "Old note", changes: [{ at: loadedAt, actionType: "CREATE", via: "seed" }, { at: later, actionType: "UPDATE", via: "seed" }] })
    expect(planSeedReload(reloaded, file, { approvedAt: null })).toMatchObject({ action: "update", changed: ["source"] })
    // A review or an archive isn't an edit
    const reviewed = loaded({ changes: [{ at: loadedAt, actionType: "CREATE", via: "seed" }, { at: later, actionType: "REVIEW", via: "admin" }] })
    expect(planSeedReload(reviewed, { ...file, body: "New." }, { approvedAt: null })).toMatchObject({ action: "update", changed: ["text"] })
  })
})
