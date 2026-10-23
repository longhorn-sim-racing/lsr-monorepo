import { beforeEach, describe, expect, it, vi } from "vitest"
import { memoryStore, type MemoryStore } from "@/server/jack/decks/memory-store"
import { createFakeFileDb } from "./test-db"

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("@/server/db", () => ({
  get prisma() {
    return db.current
  },
}))

import { claudeIdsReachModel, claudeUploadName, deleteClaudeFiles, ensureClaudeIds, isEncryptedPdf, MAX_DOCUMENT_PAGES, pdfFitsAsDocument, type ClaudeCandidate } from "./claude"
import { memoryClaudeFiles } from "./test-claude"

let fake: ReturnType<typeof createFakeFileDb>
let store: MemoryStore
let claude: ReturnType<typeof memoryClaudeFiles>

beforeEach(() => {
  fake = createFakeFileDb()
  db.current = fake
  store = memoryStore()
  claude = memoryClaudeFiles()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("what goes to Claude Files", () => {
  it("names uploads by our id, never the officer's file name", () => {
    expect(claudeUploadName("abc", "PDF")).toBe("jack-abc.pdf")
    expect(claudeUploadName("abc", "IMAGE")).toBe("jack-abc.jpg")
  })

  it("takes a PDF as a document only when pdf.js opened it and it isn't too long", () => {
    expect(pdfFitsAsDocument({ pageCount: 12, textStatus: "ok" })).toBe(true)
    expect(pdfFitsAsDocument({ pageCount: 12, textStatus: "none" })).toBe(true) // a scan: Claude sees the pages
    expect(pdfFitsAsDocument({ pageCount: MAX_DOCUMENT_PAGES + 1, textStatus: "truncated" })).toBe(false)
    expect(pdfFitsAsDocument({ pageCount: null, textStatus: "failed" })).toBe(false)
  })

  it("spots an encrypted PDF", () => {
    expect(isEncryptedPdf(Buffer.from("%PDF-1.7\ntrailer << /Encrypt 5 0 R >>"))).toBe(true)
    expect(isEncryptedPdf(Buffer.from("%PDF-1.7\ntrailer << /Root 1 0 R >>"))).toBe(false)
  })

  it("never sends Files API ids to the model while JACK_FAKES covers anthropic", () => {
    expect(claudeIdsReachModel({})).toBe(true)
    expect(claudeIdsReachModel({ JACK_FAKES: "discord" })).toBe(true)
    expect(claudeIdsReachModel({ JACK_FAKES: "all" })).toBe(false)
    expect(claudeIdsReachModel({ JACK_FAKES: "anthropic" })).toBe(false)
  })
})

describe("deleteClaudeFiles", () => {
  it("counts a copy that's already gone as deleted, and lists the ones it couldn't delete", async () => {
    const { id } = await claude.client.upload({ name: "a", bytes: Buffer.from("x"), type: "image/jpeg" })
    expect(await deleteClaudeFiles([id, "file_gone", id], { client: claude.client })).toEqual({ deleted: 2, failed: [] })
    claude.state.failDeletes = true
    expect(await deleteClaudeFiles(["file_1"], { client: claude.client })).toEqual({ deleted: 0, failed: ["file_1"] })
    expect(await deleteClaudeFiles(["file_2"], { client: null })).toEqual({ deleted: 0, failed: ["file_2"] })
  })
})

describe("ensureClaudeIds", () => {
  const candidate = (fields: Partial<ClaudeCandidate> & Pick<ClaudeCandidate, "id" | "kind">): ClaudeCandidate => {
    fake.addFile({ status: "READY", ...fields })
    return { storagePath: `rooms/r/${fields.id}/original`, modelCopyPath: null, anthropicFileId: null, pageCount: null, textStatus: "ok", ...fields }
  }

  it("keeps copies that are there, forgets the ones that are gone, and uploads what's missing", async () => {
    const kept = candidate({ id: "kept", kind: "IMAGE", modelCopyPath: "m/kept.jpg", anthropicFileId: (await claude.client.upload({ name: "k", bytes: Buffer.from("k"), type: "image/jpeg" })).id })
    const gone = candidate({ id: "gone", kind: "IMAGE", modelCopyPath: "m/gone.jpg", anthropicFileId: "file_mem_image_gone" })
    const fresh = candidate({ id: "fresh", kind: "PDF", pageCount: 3 })
    await store.put("m/gone.jpg", Buffer.from("jpeg"), "image/jpeg")
    await store.put(fresh.storagePath, Buffer.from("%PDF-1.7"), "application/pdf")

    const ids = await ensureClaudeIds(claude.client, [kept, gone, fresh], { store })

    expect(ids.get("kept")).toBe(kept.anthropicFileId)
    expect(ids.get("gone")).toMatch(/^file_mem_image_/)
    expect(ids.get("gone")).not.toBe("file_mem_image_gone")
    expect(ids.get("fresh")).toMatch(/^file_mem_pdf_/)
    expect(fake.file("gone")!.anthropicFileId).toBe(ids.get("gone"))
    expect(fake.file("fresh")!.anthropicFileId).toBe(ids.get("fresh"))
    // One check for every recorded copy at once
    expect(claude.calls.filter((call) => call.startsWith("check"))).toEqual([`check ${kept.anthropicFileId},file_mem_image_gone`])
  })

  it("leaves out what can't go: no photo copy, a long or unreadable PDF, an encrypted one, other kinds", async () => {
    const files = [
      candidate({ id: "no-copy", kind: "IMAGE" }),
      candidate({ id: "long", kind: "PDF", pageCount: 400 }),
      candidate({ id: "broken", kind: "PDF", pageCount: null, textStatus: "failed" }),
      candidate({ id: "locked", kind: "PDF", pageCount: 2 }),
      candidate({ id: "sheet", kind: "CSV" }),
    ]
    await store.put(files[3].storagePath, Buffer.from("%PDF-1.7 /Encrypt"), "application/pdf")
    expect((await ensureClaudeIds(claude.client, files, { store })).size).toBe(0)
    expect(claude.files.size).toBe(0)
  })

  it("uploads nothing when told not to, and deletes its copy when another request recorded one first", async () => {
    const file = candidate({ id: "race", kind: "IMAGE", modelCopyPath: "m/race.jpg" })
    await store.put("m/race.jpg", Buffer.from("jpeg"), "image/jpeg")
    expect((await ensureClaudeIds(claude.client, [file], { store, upload: false })).size).toBe(0)

    fake.file("race")!.anthropicFileId = "file_other"
    expect((await ensureClaudeIds(claude.client, [file], { store })).size).toBe(0)
    expect(claude.files.size).toBe(0)
    expect(claude.calls.at(-1)).toMatch(/^delete file_mem_image_/)
  })

  it("trusts what's recorded when the check fails, and never throws", async () => {
    const file = candidate({ id: "x", kind: "IMAGE", modelCopyPath: "m/x.jpg", anthropicFileId: "file_recorded" })
    claude.state.failChecks = true
    expect((await ensureClaudeIds(claude.client, [file], { store })).get("x")).toBe("file_recorded")
  })
})
