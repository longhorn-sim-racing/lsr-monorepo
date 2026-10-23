import { unexpectedError, type ActionResult } from "@/lib/action-result"
import { checkFile, MAX_FILES_PER_MESSAGE, type JackRegisterResult, type JackUploadTicket } from "./files"
import type { JackFileKindKey } from "./parts"
import type { uploadToSignedUrl } from "./upload"

/**
 * The files an officer is attaching in a room (G5, design §5), as plain logic so it runs in tests; the
 * composer's hook (components/jack/use-jack-uploads.ts) only mirrors it into React state.
 *
 * Each file is checked here first (the server's rules), then: createJackUpload saves it and signs an
 * upload, the bytes go straight to storage with progress, and the server checks and registers them.
 * Removing a file stops its upload and deletes what the server kept. `settle()` waits for every upload
 * before a send.
 */

/** A file in the composer, waiting to go with the next message */
export type PendingUpload = {
  /** This tab's id for it (the server's id is `fileId`, once it has one) */
  key: string
  name: string
  size: number
  kind: JackFileKindKey | null
  /** A local preview for photos (an object URL), shown until it's sent */
  previewUrl: string | null
  state: "uploading" | "checking" | "ready" | "error"
  /** 0 to 1 while uploading */
  progress: number
  error?: string
  fileId?: string
}

export type UploadQueueDeps = {
  roomId: string
  createUpload: (input: { roomId: string; filename: string; size: number; type: string }) => Promise<ActionResult<JackUploadTicket>>
  removeUpload: (fileId: string) => Promise<ActionResult>
  register: (fileId: string) => Promise<JackRegisterResult>
  upload: typeof uploadToSignedUrl
  /** Supabase's public anon key, sent with uploads to Storage (not to the local route) */
  apikey?: string
  /** Makes a photo's preview URL (URL.createObjectURL in the browser) */
  preview?: (file: File) => string
  /** Frees one (URL.revokeObjectURL) */
  revoke?: (url: string) => void
}

export type UploadQueueState = { items: PendingUpload[]; notice: string | null }

export type UploadsSettled = { ok: true; fileIds: string[] } | { ok: false; error: string }

export function createUploadQueue(deps: UploadQueueDeps, onChange: (state: UploadQueueState) => void) {
  let items: PendingUpload[] = []
  let notice: string | null = null
  let nextKey = 0
  const work = new Map<string, { done: Promise<void>; abort: AbortController }>()

  const emit = () => onChange({ items, notice })
  const update = (key: string, patch: Partial<PendingUpload>) => {
    items = items.map((item) => (item.key === key ? { ...item, ...patch } : item))
    emit()
  }
  const unpreview = (item: PendingUpload) => {
    if (item.previewUrl) deps.revoke?.(item.previewUrl)
  }

  async function run(key: string, file: File, signal: AbortSignal) {
    const ticket = await deps
      .createUpload({ roomId: deps.roomId, filename: file.name, size: file.size, type: file.type })
      .catch((error): ActionResult<JackUploadTicket> => ({ ok: false, error: unexpectedError(error, "Couldn't start the upload") }))
    if (signal.aborted) {
      // Removed while the server was saving it: delete what it saved
      if (ticket.ok) void deps.removeUpload(ticket.data.file.id).catch(() => {})
      return
    }
    if (!ticket.ok) return update(key, { state: "error", error: ticket.error })
    const fileId = ticket.data.file.id
    update(key, { fileId })

    const toStorage = /^https?:\/\//i.test(ticket.data.url)
    const sent = await deps.upload(ticket.data.url, file, ticket.data.contentType, {
      signal,
      apikey: toStorage ? deps.apikey : undefined,
      onProgress: (progress) => update(key, { progress }),
    })
    if (!sent.ok) {
      if (!sent.aborted) update(key, { state: "error", error: sent.error })
      return
    }

    update(key, { state: "checking", progress: 1 })
    const registered = await deps.register(fileId)
    if (signal.aborted) return
    update(key, registered.ok ? { state: "ready" } : { state: "error", error: registered.error })
  }

  return {
    get state(): UploadQueueState {
      return { items, notice }
    },

    /** Adds files (at most 10 waiting); refused ones show their reason without any upload */
    add(files: File[]) {
      if (!files.length) return
      const room = Math.max(0, MAX_FILES_PER_MESSAGE - items.length)
      const taken = files.slice(0, room)
      notice = files.length > taken.length ? `Up to ${MAX_FILES_PER_MESSAGE} files per message; ${files.length - taken.length} left out.` : null
      const added = taken.map((file) => {
        const check = checkFile({ name: file.name, type: file.type, size: file.size })
        const item: PendingUpload = {
          key: `upload-${++nextKey}`,
          name: check.ok ? check.filename : file.name,
          size: file.size,
          kind: check.ok ? check.kind : null,
          previewUrl: check.ok && check.kind === "IMAGE" && deps.preview ? deps.preview(file) : null,
          state: check.ok ? "uploading" : "error",
          progress: 0,
          ...(check.ok ? {} : { error: check.error }),
        }
        return { item, file, ok: check.ok }
      })
      items = [...items, ...added.map((a) => a.item)]
      emit()
      for (const { item, file, ok } of added) {
        if (!ok) continue
        const abort = new AbortController()
        const done = run(item.key, file, abort.signal)
          .catch((error) => update(item.key, { state: "error", error: unexpectedError(error, "The upload failed") }))
          .finally(() => work.delete(item.key))
        work.set(item.key, { done, abort })
      }
    },

    /** The chip's remove button: stops the upload and deletes what the server kept */
    remove(key: string) {
      const item = items.find((i) => i.key === key)
      if (!item) return
      work.get(key)?.abort.abort()
      unpreview(item)
      items = items.filter((i) => i.key !== key)
      notice = null
      emit()
      if (item.fileId) void deps.removeUpload(item.fileId).catch(() => {})
    },

    /** After a send: the files went with the message, so only the local previews go */
    clear() {
      items.forEach(unpreview)
      items = []
      notice = null
      emit()
    },

    /** Waits for every upload still going, then says which files can be sent, or what to fix first */
    async settle(): Promise<UploadsSettled> {
      await Promise.all([...work.values()].map((w) => w.done))
      if (items.some((item) => item.state === "error")) return { ok: false, error: "Some files couldn't be attached. Remove them (×), then send again." }
      return { ok: true, fileIds: items.flatMap((item) => (item.state === "ready" && item.fileId ? [item.fileId] : [])) }
    },

    /** Leaving the room: stops uploads still going (the cleanup job deletes what they left) and frees the previews */
    dispose() {
      for (const { abort } of work.values()) abort.abort()
      items.forEach(unpreview)
    },
  }
}

export type UploadQueue = ReturnType<typeof createUploadQueue>
