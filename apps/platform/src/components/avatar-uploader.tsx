"use client"

import { useRef, useState, useTransition } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { saveAvatar, clearAvatar } from "@/app/drivers/[handle]/edit/actions"

const primaryButton =
  "h-11 rounded-none bg-lsr-orange px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal"
const outlineButton =
  "h-11 rounded-none border-white/20 bg-transparent px-6 font-sans text-[10px] font-bold uppercase tracking-widest text-white transition-all hover:bg-white hover:text-lsr-charcoal"

export function AvatarUploader({ initialUrl }: { initialUrl?: string | null }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(initialUrl ?? null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const busy = uploading || isPending

  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME!
  const preset = process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET!

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return

    setError(null)
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("upload_preset", preset)

      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/upload`, {
        method: "POST",
        body: fd,
      })
      const json = await res.json()
      if (!json.secure_url) {
        setError("That upload didn't work. Try another image.")
        return
      }

      setPreview(json.secure_url as string)
      startTransition(async () => {
        await saveAvatar(json.secure_url as string)
      })
    } catch {
      setError("That upload didn't work. Check your connection and try again.")
    } finally {
      setUploading(false)
    }
  }

  function chooseFile() {
    inputRef.current?.click()
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="h-20 w-20 shrink-0 overflow-hidden border border-white/15 bg-black">
        {preview ? (
          <Image src={preview} alt="Your photo" width={80} height={80} className="h-20 w-20 object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-sans text-[10px] font-bold uppercase tracking-widest text-white/35">
            No photo
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onFile}
          />
          <Button type="button" onClick={chooseFile} disabled={busy} className={primaryButton}>
            {uploading ? "Uploading…" : preview ? "Change photo" : "Upload photo"}
          </Button>
          {preview && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              className={outlineButton}
              onClick={() =>
                startTransition(async () => {
                  setError(null)
                  await clearAvatar()
                  setPreview(null)
                })
              }
            >
              Remove
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="border border-red-400/30 bg-red-500/10 px-4 py-3 font-sans text-xs leading-relaxed text-red-200">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
