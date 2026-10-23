import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { ClaudeFilesClient } from "@/server/connectors/anthropic/files"
import { memoryStore, type MemoryStore } from "@/server/jack/decks/memory-store"

type Row = {
  id: string
  roomId: string
  messageId: string | null
  filename: string
  kind: "IMAGE" | "PDF" | "CSV" | "TEXT"
  sizeBytes: number
  status: "READY" | "UPLOADING" | "FAILED"
  storagePath: string
  modelCopyPath: string | null
  thumbPath: string | null
  anthropicFileId: string | null
  pageCount: number | null
  textStatus: string | null
  text: string | null
  width: number | null
  height: number | null
  createdAt: Date
  position: number
  message: { createdAt: Date; author: { displayName: string } | null } | null
}

const state = vi.hoisted(() => ({ files: [] as Row[], claude: null as ClaudeFilesClient | null, sendIds: true }))

vi.mock("@/server/db", () => {
  const where = (row: Row, w: Record<string, unknown>) =>
    Object.entries(w).every(([key, value]) => (key === "messageId" ? row.messageId !== null : row[key as keyof Row] === value))
  const pick = (row: Row, select: Record<string, unknown>) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof Row]]))
  return {
    prisma: {
      jackFile: {
        findMany: vi.fn(async ({ where: w, take, select }: { where: Record<string, unknown>; take: number; select: Record<string, unknown> }) =>
          state.files
            .filter((row) => where(row, w))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take)
            .map((row) => pick(row, select))
        ),
        count: vi.fn(async ({ where: w }: { where: Record<string, unknown> }) => state.files.filter((row) => where(row, w)).length),
        findFirst: vi.fn(async ({ where: w, select }: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
          const row = state.files.find((r) => where(r, w))
          return row ? pick(row, select) : null
        }),
        updateMany: vi.fn(async ({ where: w, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
          const hits = state.files.filter((row) => Object.entries(w).every(([key, value]) => row[key as keyof Row] === value))
          for (const row of hits) Object.assign(row, data)
          return { count: hits.length }
        }),
      },
    },
  }
})
vi.mock("@/server/jack/files/claude", async (original) => ({
  ...(await original<typeof import("@/server/jack/files/claude")>()),
  claudeFilesForUploads: async () => state.claude,
  claudeIdsReachModel: () => state.sendIds,
}))

import { setJackFileStore } from "@/server/jack/decks/storage"
import { memoryClaudeFiles } from "@/server/jack/files/test-claude"
import { JACK_TOOLS } from "./index"
import { TOOLS } from "./registry/groundwork"
import { roomFilesTool } from "./room-files"
import type { JackToolContext } from "./types"

const ROOM = "room-1"
const ctx: JackToolContext = { roomId: ROOM, actor: { userId: "officer-1", displayName: "Gray" } }
let store: MemoryStore
let claude: ReturnType<typeof memoryClaudeFiles>
let n = 0

beforeEach(() => {
  state.files = []
  state.sendIds = true
  store = memoryStore()
  setJackFileStore(store)
  claude = memoryClaudeFiles()
  state.claude = claude.client
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => setJackFileStore(null))

function add(fields: Partial<Row> & Pick<Row, "kind" | "filename">): Row {
  n++
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const row: Row = {
    id,
    roomId: ROOM,
    messageId: "msg-1",
    sizeBytes: 1_000,
    status: "READY",
    storagePath: `rooms/${ROOM}/${id}/original`,
    modelCopyPath: null,
    thumbPath: null,
    anthropicFileId: null,
    pageCount: null,
    textStatus: "ok",
    text: null,
    width: null,
    height: null,
    createdAt: new Date(Date.UTC(2026, 9, 22, 18, n)),
    position: 0,
    message: { createdAt: new Date(Date.UTC(2026, 9, 22, 18, n)), author: { displayName: "Dylan" } },
    ...fields,
  }
  state.files.push(row)
  return row
}

async function photo(fields: Partial<Row> = {}) {
  const row = add({ kind: "IMAGE", filename: "grid.jpg", width: 1600, height: 900, textStatus: "none", ...fields })
  row.modelCopyPath = `rooms/${ROOM}/${row.id}/derived/model.jpg`
  row.thumbPath = `rooms/${ROOM}/${row.id}/derived/thumb.jpg`
  await store.put(row.modelCopyPath, Buffer.from(`jpeg-${row.id}`), "image/jpeg")
  return row
}

const run = (input: Partial<Parameters<typeof roomFilesTool.run>[0]>) => roomFilesTool.run(roomFilesTool.input.parse(input), ctx)

describe("room_files: listing", () => {
  it("lists the room's posted files newest first, with who posted them when, and deckUrls for photos", async () => {
    const csv = add({ kind: "CSV", filename: "laps.csv", sizeBytes: 48_200 })
    const pic = await photo()
    add({ kind: "TEXT", filename: "draft.txt", messageId: null }) // still in an officer's composer
    add({ kind: "TEXT", filename: "elsewhere.txt", roomId: "room-2" })

    const out = await run({})
    const result = JSON.parse(out.forModel)
    expect(result.total).toBe(2)
    expect(result.files).toEqual([
      { id: pic.id, name: "grid.jpg", kind: "photo", size: "1 KB", dimensions: "1600×900", postedBy: "Dylan", posted: expect.stringMatching(/CT$/), deckUrl: `https://jack.assets/room/${pic.id}`, status: "READY" },
      { id: csv.id, name: "laps.csv", kind: "CSV", size: "48 KB", postedBy: "Dylan", posted: expect.stringMatching(/CT$/), status: "READY" },
    ])
    expect(out.label).toBe("Listed 2 files in this room")
    expect(out.displays).toEqual([{ kind: "files", files: [expect.objectContaining({ id: pic.id, thumbUrl: expect.stringContaining("variant=thumb") }), expect.objectContaining({ id: csv.id })] }])
  })

  it("says when there are more than it listed, and when there are none", async () => {
    expect(await run({})).toMatchObject({ label: "No files in this room yet" })
    for (let i = 0; i < 3; i++) add({ kind: "TEXT", filename: `${i}.txt` })
    expect(JSON.parse((await run({ limit: 2 })).forModel)).toMatchObject({ total: 3, note: "The newest 2 of 3; raise limit to see more." })
  })
})

describe("room_files: reading", () => {
  it("only reads this room's posted files", async () => {
    const other = add({ kind: "TEXT", filename: "other.txt", roomId: "room-2", text: "secret" })
    expect(await run({ file: other.id })).toMatchObject({ isError: true, forModel: expect.stringContaining(`There's no file with id ${other.id} in this room`) })
    expect(await run({ file: "nope" })).toMatchObject({ isError: true })
  })

  it("pages a file's text with its outline, links as written (a tool result web_fetch never opens)", async () => {
    const text = `# Plan\nSee https://club.example/plan?draft=1\n\n## Budget\n${"Numbers and more numbers. ".repeat(100)}`
    const doc = add({ kind: "TEXT", filename: "plan.md", text })
    const first = JSON.parse((await run({ file: doc.id, maxChars: 500 })).forModel)
    expect(first).toMatchObject({ id: doc.id, name: "plan.md", total: text.length, offset: 0, outline: [{ heading: "Plan", level: 1, offset: 0 }, { heading: "Budget", level: 2, offset: expect.any(Number) }] })
    expect(first.text).toContain("https://club.example/plan?draft=1")
    const next = JSON.parse((await run({ file: doc.id, offset: first.nextOffset, maxChars: 500 })).forModel)
    expect(next.offset).toBe(first.nextOffset)

    const found = await run({ file: doc.id, query: "budget" })
    expect(JSON.parse(found.forModel)).toMatchObject({ query: "budget", matched: expect.any(Number) })
    expect(found.label).toMatch(/^Searched “plan\.md”/)
  })

  it("shows a photo again: by Claude Files id when it's there, uploading it if it isn't", async () => {
    const pic = await photo()
    const out = await run({ file: pic.id })
    const saved = state.files.find((f) => f.id === pic.id)!.anthropicFileId
    expect(saved).toMatch(/^file_mem_image_/)
    expect(out.images).toEqual([{ caption: `File ${pic.id}: "grid.jpg":`, fileId: saved }])
    expect(JSON.parse(out.forModel)).toMatchObject({ deckUrl: `https://jack.assets/room/${pic.id}`, note: "The photo follows." })
    expect(out.label).toBe("Looked at “grid.jpg”")
  })

  it("shows a photo's model copy inline when Claude Files is off", async () => {
    const pic = await photo()
    state.claude = null
    expect((await run({ file: pic.id })).images).toEqual([{ caption: `File ${pic.id}: "grid.jpg":`, mediaType: "image/jpeg", data: Buffer.from(`jpeg-${pic.id}`).toString("base64") }])
    store.files.clear()
    expect(await run({ file: pic.id })).toMatchObject({ isError: true, label: "Photo not loaded" })
  })

  it("shows a PDF as a document, or its text with textOnly, or when it's too long", async () => {
    const pdf = add({ kind: "PDF", filename: "packet.pdf", pageCount: 3, text: "--- Page 1 ---\nWelcome" })
    await store.put(pdf.storagePath, Buffer.from("%PDF-1.7"), "application/pdf")
    const shown = await run({ file: pdf.id })
    expect(shown.documents).toEqual([{ caption: `File ${pdf.id}: "packet.pdf":`, title: "packet.pdf", source: { type: "file", fileId: expect.stringMatching(/^file_mem_pdf_/) } }])
    expect(JSON.parse(shown.forModel)).toMatchObject({ pages: 3 })

    const text = await run({ file: pdf.id, textOnly: true })
    expect(text.documents).toBeUndefined()
    expect(JSON.parse(text.forModel)).toMatchObject({ text: "--- Page 1 ---\nWelcome" })

    const long = add({ kind: "PDF", filename: "handbook.pdf", pageCount: 240, textStatus: "truncated", text: "--- Page 1 ---\nIntro" })
    const result = await run({ file: long.id })
    expect(result.documents).toBeUndefined()
    expect(JSON.parse(result.forModel)).toMatchObject({ shownAs: expect.stringContaining("extracted text"), note: expect.stringContaining("stops at a limit") })
  })

  it("never sends a Files API id the model can't read (fakes on)", async () => {
    state.sendIds = false
    const pdf = add({ kind: "PDF", filename: "packet.pdf", pageCount: 3, text: "Welcome" })
    const out = await run({ file: pdf.id })
    expect(out.documents).toBeUndefined()
    expect(claude.calls).toEqual([])
  })

  it("says when there's no text to read", async () => {
    const scan = add({ kind: "PDF", filename: "scan.pdf", pageCount: null, textStatus: "failed" })
    expect(JSON.parse((await run({ file: scan.id })).forModel)).toMatchObject({ note: "Its text couldn't be read." })
  })
})

describe("room_files in the tool list", () => {
  it("is always loaded, right after the propose_* tools and before web_links", () => {
    const names = TOOLS.map((t) => t.name)
    expect(names.indexOf("room_files")).toBe(names.filter((name) => name.startsWith("propose_")).length)
    expect(names.at(-1)).toBe("web_links")
    expect(roomFilesTool.deferred).toBeUndefined()
    expect(roomFilesTool.writes).toBeUndefined()
    expect(JACK_TOOLS).toContain(roomFilesTool)
  })

  it("stays small in the cached prompt", () => {
    const size = JSON.stringify({ name: roomFilesTool.name, description: roomFilesTool.description, input_schema: z.toJSONSchema(roomFilesTool.input) }).length
    expect(size).toBeLessThanOrEqual(3_000)
  })
})
