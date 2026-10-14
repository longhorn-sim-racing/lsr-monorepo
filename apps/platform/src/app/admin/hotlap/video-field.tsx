"use client"

import { useId, useRef, useState } from "react"
import { Film } from "lucide-react"
import { toast } from "sonner"
import { Button, Field, Input, Segmented } from "@/components/admin/kit"
import { MAX_UPLOAD_BYTES, uploadedVideo } from "@/lib/featured-video"
import { startVideoUpload } from "./actions"

type Kind = "upload" | "youtube"

/** Send a file to Cloudinary with a signed upload, reporting progress. Resolves to the uploaded video's address. */
function upload(file: File, signed: { cloudName: string; apiKey: string; params: Record<string, string>; signature: string }, onProgress: (percent: number) => void) {
  const form = new FormData()
  form.append("file", file)
  for (const [key, value] of Object.entries(signed.params)) form.append(key, value)
  form.append("api_key", signed.apiKey)
  form.append("signature", signed.signature)

  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `https://api.cloudinary.com/v1_1/${signed.cloudName}/video/upload`)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () => {
      let json: { secure_url?: string; error?: { message?: string } } = {}
      try {
        json = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status === 200 && json.secure_url) resolve(json.secure_url)
      else reject(new Error(json.error?.message ?? `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."))
    xhr.send(form)
  })
}

/**
 * The video for the hotlap or the clip: a file uploaded to Cloudinary, or a YouTube link. Posts the
 * chosen one as `name`.
 */
export function VideoField({ name, defaultValue, defaultKind }: { name: string; defaultValue?: string; defaultKind: Kind }) {
  const startedAsUpload = !!defaultValue && !!uploadedVideo(defaultValue)
  const [kind, setKind] = useState<Kind>(defaultValue ? (startedAsUpload ? "upload" : "youtube") : defaultKind)
  const [uploadUrl, setUploadUrl] = useState(startedAsUpload ? defaultValue! : "")
  const [youtubeUrl, setYoutubeUrl] = useState(defaultValue && !startedAsUpload ? defaultValue : "")
  const [progress, setProgress] = useState<number | null>(null)
  const [posterFailed, setPosterFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const youtubeId = useId()

  const uploading = progress !== null
  const preview = uploadUrl ? uploadedVideo(uploadUrl) : null

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Let the same file be picked again after a failed upload
    e.target.value = ""
    if (!file) return
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error("That video is over 100 MB. Trim it, or put it on YouTube and paste the link.")
      return
    }

    setProgress(0)
    try {
      const signed = await startVideoUpload()
      if (!signed.ok) {
        toast.error(signed.error)
        return
      }
      const url = await upload(file, signed.data, setProgress)
      setUploadUrl(url)
      setPosterFailed(false)
      toast.success("Video uploaded. Save to use it.")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.")
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <input type="hidden" name={name} value={kind === "upload" ? uploadUrl : youtubeUrl} />
      <Segmented
        label="Where the video comes from"
        value={kind}
        onChange={setKind}
        options={[
          { value: "upload", label: "Upload a file" },
          { value: "youtube", label: "YouTube link" },
        ]}
        className="w-fit"
      />
      {kind === "upload" ? (
        <Field label="Video file" hint="MP4, MOV, MKV or WebM, up to 100 MB. A long video can take a minute to be ready to play after it uploads.">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex aspect-video w-40 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-admin-surface">
              {preview && !posterFailed ? (
                // eslint-disable-next-line @next/next/no-img-element -- a Cloudinary frame, already sized
                <img src={preview.poster} alt="" className="h-full w-full object-cover" onError={() => setPosterFailed(true)} />
              ) : (
                <span className="flex flex-col items-center gap-1 px-2 text-center text-xs text-admin-subtle">
                  <Film className="size-4" aria-hidden />
                  {preview ? "Getting it ready" : "No video"}
                </span>
              )}
            </div>
            <input ref={inputRef} type="file" accept="video/*,.mkv,.mov,.mp4,.webm" hidden onChange={onFile} />
            <Button type="button" onClick={() => inputRef.current?.click()} pending={uploading}>
              {uploading ? `Uploading ${progress}%` : preview ? "Replace video" : "Upload video"}
            </Button>
          </div>
        </Field>
      ) : (
        <Field label="YouTube link" htmlFor={youtubeId} hint="A youtube.com/watch?v=, youtu.be/ or youtube.com/embed/ link.">
          <Input
            id={youtubeId}
            type="url"
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
          />
        </Field>
      )}
    </div>
  )
}
