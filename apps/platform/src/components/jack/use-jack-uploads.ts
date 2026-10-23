"use client"

import { useEffect, useState } from "react"
import type { ActionResult } from "@/lib/action-result"
import type { JackUploadTicket } from "@/lib/jack/files"
import { createUploadQueue, type UploadQueue, type UploadQueueState } from "@/lib/jack/upload-queue"
import { registerUpload, uploadToSignedUrl } from "@/lib/jack/upload"

type Options = {
  roomId: string
  createUpload: (input: { roomId: string; filename: string; size: number; type: string }) => Promise<ActionResult<JackUploadTicket>>
  removeUpload: (fileId: string) => Promise<ActionResult>
}

/**
 * The composer's files (G5): the upload queue (lib/jack/upload-queue.ts) for this room, mirrored into
 * React state. The room page mounts afresh for each room, so one queue serves the page's life.
 */
export function useJackUploads({ roomId, createUpload, removeUpload }: Options) {
  const [state, setState] = useState<UploadQueueState>({ items: [], notice: null })
  const [queue] = useState<UploadQueue>(() =>
    createUploadQueue(
      {
        roomId,
        createUpload,
        removeUpload,
        register: registerUpload,
        upload: uploadToSignedUrl,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        preview: (file) => URL.createObjectURL(file),
        revoke: (url) => URL.revokeObjectURL(url),
      },
      setState
    )
  )

  useEffect(() => () => queue.dispose(), [queue])

  return { items: state.items, notice: state.notice, add: queue.add, remove: queue.remove, clear: queue.clear, settle: queue.settle }
}
