import Anthropic, { toFile } from "@anthropic-ai/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "../fakes/testing"
import { runConnectorSmoke } from "../status"
import { ANTHROPIC_FAKE_BAD_KEY, anthropicFake } from "./fake/handlers"
import { CLAUDE_FILES_CONNECTOR, claudeFilesClient, claudeFilesConnector } from "./files"

// The Files API client against its HTTP fake, through the fetch interceptor
const state = vi.hoisted(() => ({ enabled: false }))
vi.mock("@/server/db", () => ({
  prisma: {
    connectorState: {
      findUnique: vi.fn(async () => ({ id: "claude-files", enabled: state.enabled, lastSyncAt: null, lastError: null, lastErrorAt: null, cursor: null, updatedAt: new Date() })),
    },
  },
}))
vi.mock("../registry", () => ({ CONNECTORS: [], findConnector: () => undefined }))

const KEY = "sk-ant-" + "test-" + "x".repeat(20)
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64")

beforeEach(() => {
  state.enabled = false
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the Claude Files client against its fake", () => {
  it("uploads, finds and deletes files, at the real API's paths with the key and no beta header", async () => {
    const fakes = mountFakes([anthropicFake])
    const client = claudeFilesClient(KEY)
    const pdf = await client.upload({ name: "jack-1.pdf", bytes: Buffer.from("%PDF-1.7 x"), type: "application/pdf" })
    const photo = await client.upload({ name: "jack-2.jpg", bytes: png, type: "image/jpeg" })
    // Ids carry the kind, so fakeClaude can refuse one in the wrong block
    expect(pdf.id).toMatch(/^file_fake_pdf_/)
    expect(photo.id).toMatch(/^file_fake_image_/)
    expect(await client.visible([pdf.id, photo.id, "file_unknown"])).toEqual(new Set([pdf.id, photo.id]))
    expect(await client.remove(pdf.id)).toBe("deleted")
    expect(await client.remove(pdf.id)).toBe("gone")
    expect(await client.visible([pdf.id, photo.id])).toEqual(new Set([photo.id]))

    expect(fakes.requests.map((r) => `${r.method} ${r.service}${r.path}`)).toEqual([
      "POST anthropic/v1/files",
      "POST anthropic/v1/files",
      "GET anthropic/v1/files",
      "DELETE anthropic/v1/files/" + pdf.id,
      "DELETE anthropic/v1/files/" + pdf.id,
      "GET anthropic/v1/files",
    ])
    const first = fakes.requests[0]
    expect(first.headers.get("x-api-key")).toBe(KEY)
    expect(first.headers.get("anthropic-beta")).toBeNull()
    expect(first.headers.get("content-type")).toMatch(/^multipart\/form-data/)
    expect(new URL(fakes.requests[2].url).searchParams.getAll("ids[]")).toEqual([pdf.id, photo.id, "file_unknown"])
  })

  it("lists ids a hundred at a time", async () => {
    const fakes = mountFakes([anthropicFake])
    const ids = Array.from({ length: 150 }, (_, i) => `file_${i}`)
    expect((await claudeFilesClient(KEY).visible(ids)).size).toBe(0)
    expect(fakes.requests.map((r) => new URL(r.url).searchParams.getAll("ids[]").length)).toEqual([100, 50])
  })

  it("doesn't see an expired file", async () => {
    const fakes = mountFakes([anthropicFake])
    const client = claudeFilesClient(KEY)
    const { id } = await client.upload({ name: "jack-3.jpg", bytes: png, type: "image/jpeg" })
    await fetch(`${fakes.origin}/anthropic/_fake/expire/${id}`, { method: "POST" })
    expect(await client.visible([id])).toEqual(new Set())
    expect(await client.remove(id)).toBe("gone")
  })

  it("fails with the API's error, never the key, on a bad key", async () => {
    mountFakes([anthropicFake])
    const error = await claudeFilesClient(ANTHROPIC_FAKE_BAD_KEY)
      .upload({ name: "jack-4.jpg", bytes: png, type: "image/jpeg" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Anthropic.AuthenticationError)
    expect(String((error as Error).message)).not.toContain(ANTHROPIC_FAKE_BAD_KEY)
  })

  it("stops when the caller's signal aborts", async () => {
    const fakes = mountFakes([anthropicFake])
    const controller = new AbortController()
    controller.abort()
    await expect(claudeFilesClient(KEY).visible(["file_1"], { signal: controller.signal })).rejects.toBeInstanceOf(Anthropic.APIUserAbortError)
    expect(fakes.requests).toHaveLength(0)
  })
})

describe("the fake's checks", () => {
  // Straight through the SDK, to reach what our client never sends
  const sdk = () => new Anthropic({ apiKey: KEY, baseURL: "http://127.0.0.1:3999/anthropic", fetch: (input, init) => fetch(input, init), maxRetries: 0 })

  it("refuses bad file names and a bad expiry, and has no content for uploads", async () => {
    mountFakes([anthropicFake])
    const client = sdk()
    await expect(client.files.upload({ file: await toFile(png, "a:b.png", { type: "image/png" }) })).rejects.toMatchObject({ status: 400 })
    await expect(client.files.upload({ file: await toFile(png, "a.png", { type: "image/png" }), expires_in_seconds: 60 })).rejects.toMatchObject({ status: 400 })
    const file = await client.files.upload({ file: await toFile(png, "a.png", { type: "image/png" }), expires_in_seconds: 3_600 })
    expect(file).toMatchObject({ filename: "a.png", mime_type: "image/png", size_bytes: png.length, downloadable: false })
    expect(file.expires_at).not.toBeNull()
    await expect(client.files.download(file.id)).rejects.toMatchObject({ status: 400 })
    await expect(client.files.retrieveMetadata("file_nope")).rejects.toBeInstanceOf(Anthropic.NotFoundError)
  })

  it("pages a plain list, newest first", async () => {
    mountFakes([anthropicFake])
    const client = sdk()
    for (const name of ["1.png", "2.png", "3.png"]) await client.files.upload({ file: await toFile(png, name, { type: "image/png" }) })
    const names: string[] = []
    for await (const file of client.files.list({ limit: 2 })) names.push(file.filename)
    expect(names).toEqual(["3.png", "2.png", "1.png"])
  })
})

describe("the Claude Files connector", () => {
  it("is set up by the API key, and gives no client while switched off", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY)
    expect(claudeFilesConnector.id).toBe(CLAUDE_FILES_CONNECTOR)
    expect(claudeFilesConnector.configured({ ANTHROPIC_API_KEY: KEY })).toBe(true)
    expect(claudeFilesConnector.configured({})).toBe(false)
    expect(await claudeFilesConnector.client()).toBeNull()
    state.enabled = true
    expect(await claudeFilesConnector.client()).not.toBeNull()
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    expect(await claudeFilesConnector.client()).toBeNull()
  })

  it("passes its smoke test against the fake while switched off, leaving nothing behind", async () => {
    const fakes = mountFakes([anthropicFake])
    vi.stubEnv("ANTHROPIC_API_KEY", KEY)
    expect(await runConnectorSmoke(claudeFilesConnector)).toMatchObject({ ok: true, summary: "Uploaded, found and deleted a test file" })
    expect(fakes.requests.map((r) => r.method)).toEqual(["POST", "GET", "DELETE"])
  })

  it("fails its smoke test, redacted, on a bad key", async () => {
    mountFakes([anthropicFake])
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_FAKE_BAD_KEY)
    const result = await runConnectorSmoke(claudeFilesConnector)
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/401/)
  })
})
