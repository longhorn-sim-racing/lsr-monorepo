import { createHash } from "node:crypto"
import { UPLOAD_EAGER } from "@/lib/featured-video"
import { serviceBaseUrl } from "@/server/connectors/base-url"

/** Cloudinary's API, or the local fake when JACK_FAKES lists "cloudinary" (connectors/cloudinary/fake) */
export function cloudinaryApiUrl(env: Readonly<Record<string, string | undefined>> = process.env) {
  return serviceBaseUrl("cloudinary", "https://api.cloudinary.com", env)
}

/** True when the server can upload to Cloudinary (browser image uploads use an unsigned preset instead). */
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

  const res = await fetch(`${cloudinaryApiUrl()}/v1_1/${cloud}/image/upload`, { method: "POST", body: form })
  const json = (await res.json()) as { public_id?: string; width?: number; height?: number; error?: { message: string } }
  if (!res.ok || !json.public_id) throw new Error(json.error?.message ?? `Cloudinary upload failed (${res.status})`)
  return { publicId: json.public_id, width: json.width ?? null, height: json.height ?? null }
}

/**
 * Delete an image uploaded by the server (best effort: a failure is reported, not thrown). `invalidate`
 * asks Cloudinary's CDN to drop its cached copies too, so the old link stops working, not just new ones.
 */
export async function destroyImage(publicId: string): Promise<boolean> {
  const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  const apiKey = process.env.CLOUDINARY_API_KEY
  const apiSecret = process.env.CLOUDINARY_API_SECRET
  if (!cloud || !apiKey || !apiSecret) return false

  const params: Record<string, string> = { invalidate: "true", public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) }
  const form = new FormData()
  for (const [key, value] of Object.entries(params)) form.append(key, value)
  form.append("api_key", apiKey)
  form.append("signature", signParams(params, apiSecret))

  try {
    const res = await fetch(`${cloudinaryApiUrl()}/v1_1/${cloud}/image/destroy`, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) })
    const json = (await res.json()) as { result?: string }
    return res.ok && (json.result === "ok" || json.result === "not found")
  } catch {
    return false
  }
}

const UPLOAD_TIMEOUT_MS = 30_000

/** An image the server uploaded: `secureUrl` is its public https link; `existing` when an asset was already there under that id (it's kept) */
export type UploadedImage = { publicId: string; secureUrl: string; width: number | null; height: number | null; bytes: number | null; existing: boolean }

/**
 * Upload image bytes the server made (a slide as a JPEG, a room photo's copy) under `publicId`. Signed;
 * an asset already under that id is kept, not replaced, so uploading the same thing again is safe. The
 * public link is what Instagram fetches and what the gallery shows. Throws without the API key, or with
 * Cloudinary's message (never the key or secret).
 */
export async function uploadImageBytes(body: Buffer, { publicId, filename = "image.jpg", contentType = "image/jpeg", signal }: { publicId: string; filename?: string; contentType?: string; signal?: AbortSignal }): Promise<UploadedImage> {
  const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  const apiKey = process.env.CLOUDINARY_API_KEY
  const apiSecret = process.env.CLOUDINARY_API_SECRET
  if (!cloud || !apiKey || !apiSecret) {
    throw new Error("Cloudinary uploads aren't set up: CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are missing")
  }

  const params: Record<string, string> = { overwrite: "false", public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) }
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(body)], { type: contentType }), filename)
  for (const [key, value] of Object.entries(params)) form.append(key, value)
  form.append("api_key", apiKey)
  form.append("signature", signParams(params, apiSecret))

  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
  const res = await fetch(`${cloudinaryApiUrl()}/v1_1/${cloud}/image/upload`, { method: "POST", body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  const json = (await res.json().catch(() => ({}))) as { public_id?: string; secure_url?: string; width?: number; height?: number; bytes?: number; existing?: boolean; error?: { message?: string } }
  if (!res.ok || !json.public_id || !json.secure_url) throw new Error(`Cloudinary didn't take the image (${res.status}${json.error?.message ? `: ${json.error.message.slice(0, 200)}` : ""})`)
  return { publicId: json.public_id, secureUrl: json.secure_url, width: json.width ?? null, height: json.height ?? null, bytes: json.bytes ?? null, existing: json.existing === true }
}

/** Cloudinary's Admin API ping, for a smoke test: whether the account answers with these credentials */
export async function pingCloudinary(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
  const apiKey = process.env.CLOUDINARY_API_KEY
  const apiSecret = process.env.CLOUDINARY_API_SECRET
  if (!cloud || !apiKey || !apiSecret) return { ok: false, detail: "Cloudinary's API key and secret aren't set" }
  const timeout = AbortSignal.timeout(10_000)
  const res = await fetch(`${cloudinaryApiUrl()}/v1_1/${cloud}/ping`, {
    headers: { authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const json = (await res.json().catch(() => ({}))) as { status?: string; error?: { message?: string } }
  return res.ok && json.status === "ok" ? { ok: true, detail: "Cloudinary answered" } : { ok: false, detail: `Cloudinary answered ${res.status}${json.error?.message ? `: ${json.error.message.slice(0, 120)}` : ""}` }
}
