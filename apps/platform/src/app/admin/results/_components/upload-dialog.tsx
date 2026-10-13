"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { unexpectedError } from "@/lib/action-result"
import { Button, Dialog, Field, Input } from "@/components/admin/kit"
import { uploadResult } from "../actions"
import { formatBytes } from "./result-labels"

// Server actions take request bodies up to Next's default of 1 MB (next.config sets no higher limit)
const MAX_BYTES = 1024 * 1024 - 8 * 1024

type Failure = { file: File; error: string }

/** Uploads one or more results files (e.g. a weekend's qualifying and race), one request per file. */
export function UploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [failures, setFailures] = useState<Failure[]>([])
  const [missing, setMissing] = useState(false)
  const [pending, setPending] = useState(false)

  const reset = () => {
    setFiles([])
    setFailures([])
    setMissing(false)
    if (input.current) input.current.value = ""
  }

  async function upload() {
    if (files.length === 0) {
      setMissing(true)
      return
    }
    setPending(true)
    const failed: Failure[] = []
    const uploaded: { id: string; filename: string }[] = []
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        failed.push({ file, error: `${file.name} is ${formatBytes(file.size)}; uploads are limited to 1 MB. Ask the Tech Team to raise the limit.` })
        continue
      }
      const formData = new FormData()
      formData.append("file", file)
      try {
        const result = await uploadResult(formData)
        if (result.ok) uploaded.push({ id: result.data.id, filename: file.name })
        else failed.push({ file, error: result.error })
      } catch (error) {
        console.error(error)
        failed.push({ file, error: unexpectedError(error, `Couldn't upload ${file.name}`) })
      }
    }
    setPending(false)

    if (uploaded.length === 1) {
      const [only] = uploaded
      toast.success(`Uploaded ${only.filename}`, { action: { label: "Set it up", onClick: () => router.push(`/admin/results/${only.id}`) } })
    } else if (uploaded.length > 1) {
      toast.success(`Uploaded ${uploaded.length} files`)
    }

    if (failed.length) {
      // Keep only the files that didn't make it, so "Upload" retries just those
      setFiles(failed.map((f) => f.file))
      setFailures(failed)
      if (input.current) input.current.value = ""
    } else {
      reset()
      onOpenChange(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        if (!next) reset()
        onOpenChange(next)
      }}
      title="Upload results"
      description="The .json files the race server saved. Upload a weekend's sessions together if you like; each becomes its own upload."
      footer={
        <>
          <Button
            onClick={() => {
              reset()
              onOpenChange(false)
            }}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={upload} pending={pending}>
            {files.length > 1 ? `Upload ${files.length} files` : "Upload"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Results files" htmlFor="results-files" error={missing ? "Choose at least one results file." : undefined}>
          <Input
            ref={input}
            id="results-files"
            type="file"
            accept=".json,application/json"
            multiple
            disabled={pending}
            className="h-auto py-1.5 file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-0.5 file:text-xs file:font-medium file:text-foreground"
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []))
              setFailures([])
              setMissing(false)
            }}
          />
        </Field>
        {files.length > 0 && (
          <ul className="flex flex-col gap-1.5 text-[13px]" aria-label="Chosen files">
            {files.map((file, i) => {
              const failure = failures.find((f) => f.file === file)
              return (
                <li key={`${file.name}-${i}`} className="flex flex-col rounded-md border bg-admin-surface px-2.5 py-1.5">
                  <span className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{file.name}</span>
                    <span className="shrink-0 text-xs text-admin-subtle">{formatBytes(file.size)}</span>
                  </span>
                  {failure && (
                    <span role="alert" className="text-xs font-medium text-tone-danger-foreground">
                      {failure.error}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
