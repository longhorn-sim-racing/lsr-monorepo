"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { unexpectedError, type ActionResult } from "@/lib/action-result"
import { checkFile, MAX_FILES_PER_MESSAGE, type JackRegisterResult, type JackUploadTicket } from "@/lib/jack/files"
import type { JackFileKindKey } from "@/lib/jack/parts"
import { registerUpload, uploadToSignedUrl } from "@/lib/jack/upload"

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

type Options = {
  roomId: string
  createUpload: (input: { roomId: string; filename: string; size: number; type: string }) => Promise<ActionResult<JackUploadTicket>>
  removeUpload: (fileId: string) => Promise<ActionResult>
  register?: (fileId: string) => Promise<JackRegisterResult>
  upload?: typeof uploadToSignedUrl
}

export type UploadsSettled = { ok: true; fileIds: string[] } | { ok: false; error: string }

/**
 * The files an officer is attaching in a room (G5, design §5). Each file is checked here first (the
 * same rules the server uses), then: createJackUpload saves it and signs an upload, the bytes go
 * straight to storage with progress, and the server checks and registers them. Removing a file stops
 * its upload and deletes what the server kept. `settle()` waits for every upload before a send.
 */
export function useJackUploads({ roomId, createUpload, removeUpload, register = registerUpload, upload = uploadToSignedUrl }: Options) {
  const [items, setItems] = useState<PendingUpload[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  // The list as of now (state lags a render behind), so settle() sees what the uploads just did
  const list = useRef<PendingUpload[]>([])
  const work = useRef(new Map<string, { done: Promise<void>; abort: AbortController }>())
  const previews = useRef(new Set<string>())
  const nextKey = useRef(0)

  const preview = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    previews.current.add(url)
    return url
  }, [])
  const unpreview = useCallback((url: string | null) => {
    if (!url) return
    URL.revokeObjectURL(url)
    previews.current.delete(url)
  }, [])

  const commit = useCallback((next: PendingUpload[]) => {
    list.current = next
    setItems(next)
  }, [])
  const update = useCallback((key: string, patch: Partial<PendingUpload>) => commit(list.current.map((item) => (item.key === key ? { ...item, ...patch } : item))), [commit])

  const run = useCallback(
    async (key: string, file: File, signal: AbortSignal) => {
      const ticket = await createUpload({ roomId, filename: file.name, size: file.size, type: file.type }).catch(
        (error): ActionResult<JackUploadTicket> => ({ ok: false, error: unexpectedError(error, "Couldn't start the upload") })
      )
      if (signal.aborted) {
        // Removed while the server was saving it: delete what it saved
        if (ticket.ok) void removeUpload(ticket.data.file.id).catch(() => {})
        return
      }
      if (!ticket.ok) return update(key, { state: "error", error: ticket.error })
      const fileId = ticket.data.file.id
      update(key, { fileId })

      const absolute = /^https?:\/\//i.test(ticket.data.url)
      const sent = await upload(ticket.data.url, file, ticket.data.contentType, {
        signal,
        apikey: absolute ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY : undefined,
        onProgress: (progress) => update(key, { progress }),
      })
      if (!sent.ok) {
        if (!sent.aborted) update(key, { state: "error", error: sent.error })
        return
      }

      update(key, { state: "checking", progress: 1 })
      const registered = await register(fileId)
      if (signal.aborted) return
      update(key, registered.ok ? { state: "ready" } : { state: "error", error: registered.error })
    },
    [roomId, createUpload, removeUpload, register, upload, update]
  )

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return
      const room = Math.max(0, MAX_FILES_PER_MESSAGE - list.current.length)
      const taken = files.slice(0, room)
      setNotice(files.length > taken.length ? `Up to ${MAX_FILES_PER_MESSAGE} files per message; ${files.length - taken.length} left out.` : null)
      const added = taken.map((file) => {
        const check = checkFile({ name: file.name, type: file.type, size: file.size })
        const item: PendingUpload = {
          key: `upload-${++nextKey.current}`,
          name: check.ok ? check.filename : file.name,
          size: file.size,
          kind: check.ok ? check.kind : null,
          previewUrl: check.ok && check.kind === "IMAGE" ? preview(file) : null,
          state: check.ok ? "uploading" : "error",
          progress: 0,
          ...(check.ok ? {} : { error: check.error }),
        }
        return { item, file, ok: check.ok }
      })
      commit([...list.current, ...added.map((a) => a.item)])
      for (const { item, file, ok } of added) {
        if (!ok) continue
        const abort = new AbortController()
        const done = run(item.key, file, abort.signal)
          .catch((error) => update(item.key, { state: "error", error: unexpectedError(error, "The upload failed") }))
          .finally(() => work.current.delete(item.key))
        work.current.set(item.key, { done, abort })
      }
    },
    [commit, run, update, preview]
  )

  const remove = useCallback(
    (key: string) => {
      const item = list.current.find((i) => i.key === key)
      if (!item) return
      work.current.get(key)?.abort.abort()
      unpreview(item.previewUrl)
      commit(list.current.filter((i) => i.key !== key))
      setNotice(null)
      if (item.fileId) void removeUpload(item.fileId).catch(() => {})
    },
    [commit, removeUpload, unpreview]
  )

  /** After a send: the files went with the message, so only the local previews go */
  const clear = useCallback(() => {
    for (const item of list.current) unpreview(item.previewUrl)
    commit([])
    setNotice(null)
  }, [commit, unpreview])

  /** Waits for every upload still going, then says which files can be sent, or what to fix first */
  const settle = useCallback(async (): Promise<UploadsSettled> => {
    await Promise.all([...work.current.values()].map((w) => w.done))
    if (list.current.some((item) => item.state === "error")) return { ok: false, error: "Some files couldn't be attached. Remove them (×), then send again." }
    return { ok: true, fileIds: list.current.flatMap((item) => (item.state === "ready" && item.fileId ? [item.fileId] : [])) }
  }, [])

  // Leaving the room: stop uploads still going (the cleanup job deletes what they left) and free the previews
  useEffect(() => {
    const running = work.current
    const urls = previews.current
    return () => {
      for (const { abort } of running.values()) abort.abort()
      for (const url of urls) URL.revokeObjectURL(url)
    }
  }, [])

  return { items, notice, add, remove, clear, settle }
}
