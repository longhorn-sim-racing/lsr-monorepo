import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { memoryDocumentStore } from "../documents/testing"
import { mountFakes } from "../fakes/testing"
import { driveClient } from "./client"
import { DRIVE_FAKE_ROOT_ID, DRIVE_FAKE_SA_EMAIL } from "./fake/fixtures"
import { googleDriveFake } from "./fake/handlers"
import { driveWebUrl, syncDrive, type DriveCursor, type DriveSyncOptions } from "./sync"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  const fakes = mountFakes([googleDriveFake])
  const store = memoryDocumentStore("drive")
  const saved: DriveCursor[] = []
  const run = (cursor: DriveCursor | null | undefined, extra: Partial<DriveSyncOptions> = {}) =>
    syncDrive({
      client: driveClient({ email: DRIVE_FAKE_SA_EMAIL, privateKey }, { retryDelayMs: 0 }),
      rootId: DRIVE_FAKE_ROOT_ID,
      store,
      cursor,
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      saveCursor: async (c) => {
        saved.push(structuredClone(c))
      },
      ...extra,
    })
  const mutate = (body: Record<string, string>) => fetch(`${fakes.origin}/google-drive/_fake/mutate`, { method: "POST", body: JSON.stringify(body) })
  const byName = (name: string) => [...store.rows.values()].find((row) => row.name === name)
  return { fakes, store, saved, run, mutate, byName }
}

describe("the first Drive sync", () => {
  it("walks the shared folder and reads every file's text the way room files are read", async () => {
    const { store, run, byName } = setup()
    const result = await run(null)
    expect(result.rootMissing).toBe(false)
    expect(result.more).toBe(false)
    expect(result.cursor.walk).toBeUndefined()
    expect(result.cursor.pageToken).toBeTruthy()
    expect(result.cursor.lastWalkAt).toBeTruthy()

    expect(byName("Storage Closet Inventory")).toMatchObject({ path: "/Operations", textStatus: "ok", mimeType: "application/vnd.google-apps.document", webUrl: "https://docs.google.com/document/d/fx-inventory/edit?usp=drivesdk", version: "1" })
    expect(byName("Storage Closet Inventory")!.text).toContain("7 Thrustmaster T300")
    // A Sheet exports its first tab only, as CSV
    expect(byName("Showcase Volunteer Signups")).toMatchObject({ path: "/Operations/2026", textStatus: "ok", text: "Name,Shift,Role\nFixture Volunteer 1,Morning,Setup\nFixture Volunteer 2,Afternoon,Check-in" })
    expect(byName("Sponsor Pitch Deck")!.text).toContain("Bronze, Silver, Gold")
    expect(byName("Venue Contract.pdf")).toMatchObject({ path: "/Sponsors", textStatus: "ok" })
    expect(byName("Venue Contract.pdf")!.text).toContain("Deposit: 250 dollars")
    expect(byName("Fixture GM transcript.vtt")).toMatchObject({ path: "/Meetings/Transcripts", textStatus: "ok" })
    expect(byName("Fixture GM transcript.vtt")!.text).toBe(
      "[0:01] Fixture President: Welcome to the fixture general meeting. First up, the fall showcase. We booked Hall B for the showcase.\n[0:10] Fixture Treasurer: The showcase budget is 400 dollars.",
    )
    expect(byName("Officer meeting notes.docx")!.text).toContain("Hall B is booked")
    expect(byName("Brand guide.pptx")!.text).toContain("--- Slide 2 ---\nLogos\nNever stretch the logo\nNotes: Use the white logo on dark photos")

    // Kept with their link, but no text, and why
    expect(byName("Signed Agreement.pdf")).toMatchObject({ textStatus: "restricted", text: null })
    expect(byName("Archive of Every Meeting")).toMatchObject({ textStatus: "too_large", text: null })
    expect(byName("Logo.png")).toMatchObject({ textStatus: "unsupported", text: null })

    // Never indexed: a file shared from outside the folder, a shortcut to it, a trashed file
    const names = store.live().map((row) => row.name)
    expect(names).not.toContain("Personal Budget")
    expect(names).not.toContain("Shortcut to someone's budget")
    expect(names).not.toContain("Old Budget")
    expect(names).toHaveLength(11)
  })

  it("keeps ids, names and page tokens in the cursor, never a token or key", async () => {
    const { run, saved } = setup()
    const { cursor } = await run(null)
    expect(Object.keys(cursor.folders!).sort()).toEqual(["fx-2026", "fx-brand", "fx-meetings", "fx-operations", "fx-sponsors", "fx-transcripts"])
    expect(cursor.folders!["fx-2026"]).toEqual({ name: "2026", parent: "fx-operations" })
    const json = JSON.stringify([cursor, ...saved])
    expect(json).not.toMatch(/ya29|PRIVATE KEY|Bearer/)
    // Saved after each page, so a run that dies resumes where it was
    expect(saved.length).toBeGreaterThan(5)
  })

  it("does nothing on the next run when nothing changed", async () => {
    const { run } = setup()
    const first = await run(null)
    const second = await run(first.cursor)
    expect(second.counts).toMatchObject({ indexed: 0, removed: 0, changes: 0 })
    expect(second.cursor.pageToken).toBe(first.cursor.pageToken)
  })

  it("stops at the deadline and carries on next run", async () => {
    const { store, run } = setup()
    const stopped = await run(null, { deadline: Date.now() - 1 })
    expect(stopped.more).toBe(true)
    expect(stopped.cursor.walk).toMatchObject({ full: true, queue: [{ id: DRIVE_FAKE_ROOT_ID, names: [] }] })
    expect(store.rows.size).toBe(0)
    const finished = await run(stopped.cursor)
    expect(finished.cursor.walk).toBeUndefined()
    expect(store.live()).toHaveLength(11)
  })
})

describe("the changes feed", () => {
  it("reads an edited file again and keeps unchanged ones", async () => {
    const { run, mutate, byName } = setup()
    const { cursor } = await run(null)
    await mutate({ op: "edit", id: "fx-inventory", text: "# Storage Closet Inventory\n- 9 Thrustmaster T300 sets" })
    const result = await run(cursor)
    expect(result.counts).toMatchObject({ indexed: 1, changes: 1 })
    expect(byName("Storage Closet Inventory")).toMatchObject({ version: "2", text: "# Storage Closet Inventory\n- 9 Thrustmaster T300 sets" })
  })

  it("adds a new file under the folder", async () => {
    const { run, mutate, byName } = setup()
    const { cursor } = await run(null)
    await mutate({ op: "add", id: "fx-new", name: "Showcase Run of Show", parent: "fx-sponsors", text: "Doors at noon." })
    await run(cursor)
    expect(byName("Showcase Run of Show")).toMatchObject({ path: "/Sponsors", text: "Doors at noon.", textStatus: "ok" })
  })

  it("removes what's trashed, deleted or moved out of the folder, and drops its text", async () => {
    const { store, run, mutate } = setup()
    const { cursor } = await run(null)
    await mutate({ op: "trash", id: "fx-venue" })
    await mutate({ op: "delete", id: "fx-pitch" })
    await mutate({ op: "move", id: "fx-signups", parent: "fx-outside" })
    const result = await run(cursor)
    expect(result.counts.removed).toBe(3)
    for (const id of ["fx-venue", "fx-pitch", "fx-signups"]) expect(store.rows.get(id)).toMatchObject({ text: null, deletedAt: expect.any(Date) })
  })

  it("ignores files shared with the service account from outside the folder", async () => {
    const { store, run, mutate } = setup()
    const { cursor } = await run(null)
    await mutate({ op: "edit", id: "fx-outside-file", text: "Still not the club's" })
    const result = await run(cursor)
    expect(result.counts).toMatchObject({ indexed: 0, ignored: 1 })
    expect(store.rows.has("fx-outside-file")).toBe(false)
  })

  it("walks a renamed folder again, so its files get the new path", async () => {
    const { run, mutate, byName } = setup()
    const { cursor } = await run(null)
    await mutate({ op: "rename", id: "fx-operations", name: "Ops" })
    const result = await run(cursor)
    expect(result.cursor.folders!["fx-operations"].name).toBe("Ops")
    expect(byName("Storage Closet Inventory")!.path).toBe("/Ops")
    expect(byName("Showcase Volunteer Signups")!.path).toBe("/Ops/2026")
    // Unchanged files aren't read again
    expect(result.counts.indexed).toBe(0)
  })

  it("does a full walk when a folder leaves the tree, removing what was in it", async () => {
    const { store, run, mutate } = setup()
    const { cursor } = await run(null)
    await mutate({ op: "move", id: "fx-meetings", parent: "fx-outside" })
    const result = await run(cursor)
    expect(result.cursor.walk).toBeUndefined()
    expect(result.cursor.folders).not.toHaveProperty("fx-meetings")
    expect(store.rows.get("fx-gm-vtt")).toMatchObject({ deletedAt: expect.any(Date), text: null })
    expect(store.rows.get("fx-officer-notes")).toMatchObject({ deletedAt: expect.any(Date), text: null })
    expect(store.rows.get("fx-inventory")!.deletedAt).toBeNull()
  })
})

describe("when the shared folder goes away", () => {
  it("says the root is missing, and still removes everything the feed reports gone", async () => {
    const { store, run, mutate } = setup()
    const { cursor } = await run(null)
    await mutate({ op: "unshare-root" })
    const missing = await run(cursor)
    expect(missing.rootMissing).toBe(true)
    expect(missing.cursor.rootMissingAt).toBeTruthy()
    expect(store.live()).toHaveLength(0)

    // Shared again: a full walk brings it all back
    await mutate({ op: "share-root" })
    const back = await run(missing.cursor)
    expect(back.rootMissing).toBe(false)
    expect(back.cursor.rootMissingAt).toBeUndefined()
    expect(store.live()).toHaveLength(11)
  })

  it("starts over when the root folder id changes", async () => {
    const { run } = setup()
    const { cursor } = await run(null)
    const moved = await run({ ...cursor, rootId: "some-other-root" })
    expect(moved.cursor.rootId).toBe(DRIVE_FAKE_ROOT_ID)
    expect(moved.counts.unchanged).toBe(11)
  })
})

describe("the weekly reconcile", () => {
  it("walks the whole folder again and removes files it no longer finds", async () => {
    const { store, run } = setup()
    const { cursor } = await run(null)
    // A file the feed never reported gone
    await store.save({ externalId: "ghost", name: "Ghost", path: "/", mimeType: "text/plain", webUrl: "https://drive.google.com/open?id=ghost", modifiedAt: new Date(), sizeBytes: 1, version: "1" }, { text: "boo", textStatus: "ok" }, new Date(Date.now() - 86_400_000))
    const later = await run({ ...cursor, lastWalkAt: new Date(Date.now() - 8 * 86_400_000).toISOString() })
    expect(later.counts.removed).toBe(1)
    expect(store.rows.get("ghost")).toMatchObject({ text: null, deletedAt: expect.any(Date) })
    expect(store.live()).toHaveLength(11)
  })
})

describe("driveWebUrl", () => {
  it("keeps Google's own https links and builds one otherwise", () => {
    expect(driveWebUrl({ id: "a", webViewLink: "https://docs.google.com/document/d/a/edit" })).toBe("https://docs.google.com/document/d/a/edit")
    expect(driveWebUrl({ id: "a b", webViewLink: "javascript:alert(1)" })).toBe("https://drive.google.com/open?id=a%20b")
    expect(driveWebUrl({ id: "a", webViewLink: "https://evil.example/google.com" })).toBe("https://drive.google.com/open?id=a")
  })
})
