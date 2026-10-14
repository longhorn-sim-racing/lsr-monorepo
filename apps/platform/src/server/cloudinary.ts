import { createHash } from "node:crypto"
import { UPLOAD_EAGER } from "@/lib/featured-video"

/** True when the server can upload to Cloudinary (the browser uploads use an unsigned preset instead). */
export function cloudinaryUploadsConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET,
  )
}

/** Cloudinary's request signature: the parameters sorted by name as a query string, then the API secret, SHA-1 */
export function signParams(params: Record<string, string>, apiSecret: string) {
  const toSign = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&")
  return createHash("sha1").update(toSign + apiSecret).digest("hex")
}

/**
 * A signed upload the browser can send a video with, straight to Cloudinary (the unsigned preset only
 * takes images). Cloudinary also makes the MP4 and poster frame the home page plays. A signature is
 * good for an hour. Null when the API key isn't set.
 */
export function signVideoUpload() {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  const apiKey = process.env.CLOUDINARY_API_KEY
  const apiSecret = process.env.CLOUDINARY_API_SECRET
  if (!cloudName || !apiKey || !apiSecret) return null

  const params: Record<string, string> = {
    asset_folder: "lsr/videos",
    eager: UPLOAD_EAGER,
    eager_async: "true",
    timestamp: String(Math.floor(Date.now() / 1000)),
  }
  return { cloudName, apiKey, params, signature: signParams(params, apiSecret) }
}

/**
 * Copy an image into Cloudinary from a URL (Cloudinary fetches it). Signed, so it can choose the
 * public id; an asset that already exists under that id is kept, not replaced.
 */
export async function uploadRemoteImage(url: string, publicId: string) {
  const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  const apiKey = process.env.CLOUDINARY_API_KEY
  const apiSecret = process.env.CLOUDINARY_API_SECRET
  if (!cloud || !apiKey || !apiSecret) {
    throw new Error("Cloudinary uploads aren't set up: CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are missing")
  }

  const params: Record<string, string> = {
    overwrite: "false",
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  }

  const form = new FormData()
  form.append("file", url)
  for (const [key, value] of Object.entries(params)) form.append(key, value)
  form.append("api_key", apiKey)
  form.append("signature", signParams(params, apiSecret))

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: "POST", body: form })
  const json = (await res.json()) as { public_id?: string; width?: number; height?: number; error?: { message: string } }
  if (!res.ok || !json.public_id) throw new Error(json.error?.message ?? `Cloudinary upload failed (${res.status})`)
  return { publicId: json.public_id, width: json.width ?? null, height: json.height ?? null }
}

/** Delete an image uploaded by the server (best effort: a failure is reported, not thrown). */
export async function destroyImage(publicId: string): Promise<boolean> {
  const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  const apiKey = process.env.CLOUDINARY_API_KEY
  const apiSecret = process.env.CLOUDINARY_API_SECRET
  if (!cloud || !apiKey || !apiSecret) return false

  const params: Record<string, string> = { public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) }
  const form = new FormData()
  for (const [key, value] of Object.entries(params)) form.append(key, value)
  form.append("api_key", apiKey)
  form.append("signature", signParams(params, apiSecret))

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/destroy`, { method: "POST", body: form })
    const json = (await res.json()) as { result?: string }
    return res.ok && (json.result === "ok" || json.result === "not found")
  } catch {
    return false
  }
}
