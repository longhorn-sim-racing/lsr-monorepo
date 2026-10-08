import { createHash } from "node:crypto"

/** True when the server can upload to Cloudinary (the browser uploads use an unsigned preset instead). */
export function cloudinaryUploadsConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET,
  )
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
  const toSign = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&")
  const signature = createHash("sha1").update(toSign + apiSecret).digest("hex")

  const form = new FormData()
  form.append("file", url)
  for (const [key, value] of Object.entries(params)) form.append(key, value)
  form.append("api_key", apiKey)
  form.append("signature", signature)

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: "POST", body: form })
  const json = (await res.json()) as { public_id?: string; width?: number; height?: number; error?: { message: string } }
  if (!res.ok || !json.public_id) throw new Error(json.error?.message ?? `Cloudinary upload failed (${res.status})`)
  return { publicId: json.public_id, width: json.width ?? null, height: json.height ?? null }
}
