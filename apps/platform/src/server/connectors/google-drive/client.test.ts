import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { sleep } from "../documents/bytes"
import { driveClient, DriveApiError, driveQueryString, DRIVE_FILE_FIELDS } from "./client"
import { DRIVE_FAKE_ROOT_ID, DRIVE_FAKE_SA_EMAIL } from "./fake/fixtures"
import { googleDriveFake } from "./fake/handlers"
import { parseDriveQuery, parseFields, project } from "./fake/query"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const client = () => driveClient({ email: DRIVE_FAKE_SA_EMAIL, privateKey }, { retryDelayMs: 0 })
const hook = (fakes: MountedFakes, path: string, body: unknown = {}) => fetch(`${fakes.origin}/google-drive/_fake/${path}`, { method: "POST", body: JSON.stringify(body) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the Drive client against the fake", () => {
  it("lists a folder's children with the fields it needs, never trashed ones", async () => {
    const fakes = mountFakes([googleDriveFake])
    const page = await client().listChildren(DRIVE_FAKE_ROOT_ID)
    const names = page.files!.map((f) => f.name)
    expect(names).toContain("Operations")
    expect(names).not.toContain("Old Budget")
    expect(page.files!.find((f) => f.name === "Operations")).toMatchObject({ mimeType: "application/vnd.google-apps.folder", parents: [DRIVE_FAKE_ROOT_ID], version: "1" })
    const sent = new URL(fakes.requests.at(-1)!.url)
    expect(sent.searchParams.get("q")).toBe(`'${DRIVE_FAKE_ROOT_ID}' in parents and trashed = false`)
    expect(sent.searchParams.get("fields")).toContain(DRIVE_FILE_FIELDS)
    expect(fakes.requests.at(-1)!.headers.get("authorization")).toMatch(/^Bearer ya29\./)
  })

  it("pages through a listing", async () => {
    const fakes = mountFakes([googleDriveFake])
    await hook(fakes, "config", { maxPageSize: 2 })
    const drive = client()
    const first = await drive.listChildren(DRIVE_FAKE_ROOT_ID)
    expect(first.files).toHaveLength(2)
    expect(first.nextPageToken).toBeTruthy()
    const second = await drive.listChildren(DRIVE_FAKE_ROOT_ID, first.nextPageToken)
    expect(second.files!.map((f) => f.id)).not.toContain(first.files![0].id)
  })

  it("backs off and retries on rate limits and server errors", async () => {
    const fakes = mountFakes([googleDriveFake])
    await hook(fakes, "fail", { status: 403, reason: "userRateLimitExceeded", count: 1 })
    await hook(fakes, "fail", { status: 503, reason: "backendError", count: 1 })
    expect((await client().getFile(DRIVE_FAKE_ROOT_ID)).id).toBe(DRIVE_FAKE_ROOT_ID)
  })

  it("gives up after a few tries, with the status and reason (never the token)", async () => {
    const fakes = mountFakes([googleDriveFake])
    await hook(fakes, "fail", { status: 500, reason: "backendError", count: 10 })
    const error = await client()
      .getFile(DRIVE_FAKE_ROOT_ID)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriveApiError)
    expect(error).toMatchObject({ status: 500, reason: "backendError", message: `Google Drive answered 500 (backendError) on /drive/v3/files/${DRIVE_FAKE_ROOT_ID}` })
    expect(String((error as Error).message)).not.toMatch(/ya29/)
  })

  it("doesn't retry a 404 or a permission error", async () => {
    const fakes = mountFakes([googleDriveFake])
    await expect(client().getFile("no-such-file")).rejects.toMatchObject({ status: 404, reason: "notFound" })
    expect(fakes.requests.filter((r) => r.path.startsWith("/drive/v3/files/no-such-file"))).toHaveLength(1)
  })

  it("signs in again once when its token stops working", async () => {
    const fakes = mountFakes([googleDriveFake])
    const drive = client()
    await drive.getFile(DRIVE_FAKE_ROOT_ID)
    await hook(fakes, "expire-tokens")
    await drive.getFile(DRIVE_FAKE_ROOT_ID)
    expect(fakes.requests.filter((r) => r.path === "/token")).toHaveLength(2)
  })

  it("exports Docs as Markdown and refuses one over the export limit", async () => {
    mountFakes([googleDriveFake])
    const drive = client()
    expect((await drive.exportFile("fx-inventory", "text/markdown", 1_000_000))?.toString()).toContain("7 Thrustmaster T300")
    await expect(drive.exportFile("fx-archive", "text/markdown", 1_000_000)).rejects.toMatchObject({ status: 403, reason: "exportSizeLimitExceeded" })
    expect(await drive.exportFile("fx-inventory", "text/markdown", 10)).toBeNull()
  })

  it("downloads stored files, and gets a 403 for one whose downloads are off", async () => {
    mountFakes([googleDriveFake])
    const drive = client()
    expect((await drive.download("fx-gm-vtt", 1_000_000))?.toString()).toMatch(/^WEBVTT/)
    await expect(drive.download("fx-restricted", 1_000_000)).rejects.toMatchObject({ status: 403, reason: "cannotDownloadFile" })
    await expect(drive.download("fx-inventory", 1_000_000)).rejects.toMatchObject({ status: 403, reason: "fileNotDownloadable" })
  })

  it("stops waiting as soon as the caller's signal aborts", async () => {
    const fakes = mountFakes([googleDriveFake])
    const controller = new AbortController()
    controller.abort()
    await expect(client().getFile(DRIVE_FAKE_ROOT_ID, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(fakes.requests.filter((r) => r.path.startsWith("/drive"))).toHaveLength(0)
    await expect(sleep(10_000, controller.signal)).rejects.toBeDefined()
  })
})

describe("driveQueryString", () => {
  it("escapes quotes and backslashes", () => {
    expect(driveQueryString("it's a\\b")).toBe("'it\\'s a\\\\b'")
    expect(parseDriveQuery(`${driveQueryString("it's")} in parents`)({ id: "x", name: "", mimeType: "", parents: ["it's"], trashed: false, modifiedTime: "", text: "" })).toBe(true)
  })
})

describe("the fake's query language", () => {
  const file = { id: "1", name: "Sponsor Deck", mimeType: "application/pdf", parents: ["p"], trashed: false, modifiedTime: "2026-10-10T00:00:00Z", text: "the lone star cup schedule" }

  it("handles and, or, not, parentheses and the fields we send", () => {
    expect(parseDriveQuery("'p' in parents and trashed = false")(file)).toBe(true)
    expect(parseDriveQuery("not ('q' in parents or mimeType = 'application/pdf')")(file)).toBe(false)
    expect(parseDriveQuery("name contains 'deck' and modifiedTime > '2026-01-01T00:00:00Z'")(file)).toBe(true)
    expect(parseDriveQuery(`fullText contains '"lone star"'`)(file)).toBe(true)
    expect(parseDriveQuery(`fullText contains '"star lone"'`)(file)).toBe(false)
  })

  it("refuses what Drive's language doesn't have, as a 400 would", () => {
    expect(() => parseDriveQuery("parents contains 'p'")).toThrow()
    expect(() => parseDriveQuery("'p' in parents and")).toThrow()
    expect(() => parseDriveQuery("name = 'unterminated")).toThrow()
  })

  it("projects only the fields asked for", () => {
    const selection = parseFields("nextPageToken,files(id,capabilities/canDownload)")
    expect(project({ nextPageToken: "t", kind: "x", files: [{ id: "1", name: "n", capabilities: { canDownload: true, canEdit: false } }] }, selection)).toEqual({ nextPageToken: "t", files: [{ id: "1", capabilities: { canDownload: true } }] })
  })
})
