import { describe, expect, it, vi } from "vitest"
import type { JackRegisterResult, JackUploadTicket } from "./files"
import { createUploadQueue, type UploadQueueDeps, type UploadQueueState } from "./upload-queue"
import type { UploadOutcome } from "./upload"

const ROOM = "11111111-1111-4111-8111-111111111111"

/** A promise the test resolves when it wants */
function later<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function setup(overrides: Partial<UploadQueueDeps> = {}) {
  let ids = 0
  const uploads: { url: string; progress?: (p: number) => void; finish: (o: UploadOutcome) => void; signal?: AbortSignal; apikey?: string }[] = []
  const deps: UploadQueueDeps = {
    roomId: ROOM,
    createUpload: vi.fn(async ({ filename, size }): Promise<{ ok: true; data: JackUploadTicket }> => {
      const id = `file-${++ids}`
      return { ok: true, data: { file: { id, filename, kind: "IMAGE", sizeBytes: size }, url: `https://storage.test/upload/${id}`, contentType: "image/png" } }
    }),
    removeUpload: vi.fn(async () => ({ ok: true as const })),
    register: vi.fn(async (id: string): Promise<JackRegisterResult> => ({ ok: true, file: { id, filename: "a.png", kind: "IMAGE", sizeBytes: 3, url: `/api/admin/jack/files/${id}` } })),
    upload: vi.fn((url: string, _file: Blob, _type: string, options: { onProgress?: (p: number) => void; signal?: AbortSignal; apikey?: string } = {}) => {
      const pending = later<UploadOutcome>()
      options.signal?.addEventListener("abort", () => pending.resolve({ ok: false, error: "Removed", aborted: true }))
      uploads.push({ url, progress: options.onProgress, finish: pending.resolve, signal: options.signal, apikey: options.apikey })
      return pending.promise
    }) as unknown as UploadQueueDeps["upload"],
    apikey: "anon",
    preview: (file) => `blob:${file.name}`,
    revoke: vi.fn(),
    ...overrides,
  }
  const states: UploadQueueState[] = []
  const queue = createUploadQueue(deps, (state) => states.push(state))
  return { queue, deps, uploads, states }
}

const png = (name = "car.png", size = 3) => new File([new Uint8Array(size)], name, { type: "image/png" })
const flush = () => new Promise((done) => setTimeout(done, 0))

describe("the upload queue", () => {
  it("uploads with progress, registers, and settles with the file ids", async () => {
    const { queue, uploads, deps } = setup()
    queue.add([png()])
    expect(queue.state.items[0]).toMatchObject({ name: "car.png", state: "uploading", progress: 0, previewUrl: "blob:car.png" })
    await flush()
    expect(uploads[0]).toMatchObject({ url: "https://storage.test/upload/file-1", apikey: "anon" })
    uploads[0].progress?.(0.4)
    expect(queue.state.items[0].progress).toBe(0.4)
    uploads[0].finish({ ok: true })
    expect(await queue.settle()).toEqual({ ok: true, fileIds: ["file-1"], keys: [queue.state.items[0].key] })
    expect(queue.state.items[0]).toMatchObject({ state: "ready", fileId: "file-1" })
    expect(deps.register).toHaveBeenCalledWith("file-1")
  })

  it("waits for uploads still going before a send", async () => {
    const { queue, uploads } = setup()
    queue.add([png("a.png"), png("b.png")])
    const settled = queue.settle()
    await flush()
    uploads[1].finish({ ok: true })
    uploads[0].finish({ ok: true })
    expect(await settled).toMatchObject({ ok: true, fileIds: ["file-1", "file-2"] })
  })

  it("refuses a file the rules refuse without uploading it, and blocks the send until it's removed", async () => {
    const { queue, deps } = setup()
    queue.add([new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })])
    expect(queue.state.items[0]).toMatchObject({ state: "error", error: expect.stringContaining("SVG"), previewUrl: null })
    expect(deps.createUpload).not.toHaveBeenCalled()
    expect(await queue.settle()).toMatchObject({ ok: false, error: expect.stringContaining("Remove them") })
    queue.remove(queue.state.items[0].key)
    expect(await queue.settle()).toEqual({ ok: true, fileIds: [], keys: [] })
  })

  it("shows the server's reason when it refuses, the upload fails, or the check fails", async () => {
    const refused = setup({ createUpload: vi.fn(async () => ({ ok: false as const, error: "You have 20 files waiting" })) })
    refused.queue.add([png()])
    await refused.queue.settle()
    expect(refused.queue.state.items[0]).toMatchObject({ state: "error", error: "You have 20 files waiting" })

    const dropped = setup()
    dropped.queue.add([png()])
    await flush()
    dropped.uploads[0].finish({ ok: false, error: "The upload didn't go through." })
    await dropped.queue.settle()
    expect(dropped.queue.state.items[0]).toMatchObject({ state: "error", error: "The upload didn't go through." })

    const checked = setup({ register: vi.fn(async () => ({ ok: false as const, error: "This isn't the PNG its name says" })) })
    checked.queue.add([png()])
    await flush()
    checked.uploads[0].finish({ ok: true })
    expect(await checked.queue.settle()).toMatchObject({ ok: false })
    expect(checked.queue.state.items[0].error).toBe("This isn't the PNG its name says")
  })

  it("removing a file stops its upload, deletes what the server kept and frees its preview", async () => {
    const { queue, uploads, deps } = setup()
    queue.add([png()])
    await flush()
    queue.remove(queue.state.items[0].key)
    expect(uploads[0].signal?.aborted).toBe(true)
    expect(deps.removeUpload).toHaveBeenCalledWith("file-1")
    expect(deps.revoke).toHaveBeenCalledWith("blob:car.png")
    expect(queue.state.items).toEqual([])
    expect(await queue.settle()).toEqual({ ok: true, fileIds: [], keys: [] })
  })

  it("deletes the server's file when removed before the upload even started", async () => {
    const started = later<{ ok: true; data: JackUploadTicket }>()
    const { queue, deps } = setup({ createUpload: vi.fn(() => started.promise) })
    queue.add([png()])
    queue.remove(queue.state.items[0].key)
    started.resolve({ ok: true, data: { file: { id: "late", filename: "car.png", kind: "IMAGE", sizeBytes: 3 }, url: "https://x", contentType: "image/png" } })
    await flush()
    expect(deps.removeUpload).toHaveBeenCalledWith("late")
    expect(deps.upload).not.toHaveBeenCalled()
  })

  it("takes at most 10 files per message and says how many were left out", () => {
    const { queue } = setup()
    queue.add(Array.from({ length: 12 }, (_, i) => png(`p${i}.png`)))
    expect(queue.state.items).toHaveLength(10)
    expect(queue.state.notice).toBe("Up to 10 files per message; 2 left out.")
  })

  it("sends no key to the local upload route", async () => {
    const { queue, uploads } = setup({
      createUpload: vi.fn(async () => ({ ok: true as const, data: { file: { id: "f", filename: "a.txt", kind: "TEXT" as const, sizeBytes: 1 }, url: "/api/admin/jack/files/f/upload", contentType: "text/plain" } })),
    })
    queue.add([new File(["x"], "a.txt")])
    await flush()
    expect(uploads[0].apikey).toBeUndefined()
  })

  it("clears after a send (the files went with it), freeing previews but deleting nothing", async () => {
    const { queue, uploads, deps } = setup()
    queue.add([png()])
    await flush()
    uploads[0].finish({ ok: true })
    const settled = await queue.settle()
    queue.clear(settled.ok ? settled.keys : [])
    expect(queue.state.items).toEqual([])
    expect(deps.revoke).toHaveBeenCalledWith("blob:car.png")
    expect(deps.removeUpload).not.toHaveBeenCalled()
  })

  it("keeps a file added while a send waits for uploads: it isn't sent, and stays for the next message", async () => {
    const { queue, uploads, deps } = setup()
    queue.add([png("first.png")])
    await flush()
    const settling = queue.settle()
    // Dropped in while Send waits for the first upload
    queue.add([png("second.png")])
    await flush()
    uploads[0].finish({ ok: true })
    const settled = await settling
    expect(settled).toEqual({ ok: true, fileIds: ["file-1"], keys: [queue.state.items[0].key] })
    queue.clear(settled.ok ? settled.keys : [])
    expect(queue.state.items).toEqual([expect.objectContaining({ name: "second.png", state: "uploading" })])
    expect(deps.revoke).toHaveBeenCalledWith("blob:first.png")
    expect(deps.revoke).not.toHaveBeenCalledWith("blob:second.png")
    // It goes with the next message
    uploads[1].finish({ ok: true })
    expect(await queue.settle()).toMatchObject({ ok: true, fileIds: ["file-2"] })
  })

  it("doesn't hold a send for a file that failed after the send started waiting", async () => {
    const { queue, uploads } = setup()
    queue.add([png("first.png")])
    await flush()
    const settling = queue.settle()
    queue.add([png("late.png")])
    await flush()
    uploads[1].finish({ ok: false, error: "The upload didn't go through." })
    uploads[0].finish({ ok: true })
    expect(await settling).toMatchObject({ ok: true, fileIds: ["file-1"] })
  })
})
