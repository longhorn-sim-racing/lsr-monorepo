// Cloudinary delivery URLs. Images are resized and re-encoded by Cloudinary's CDN, so they
// don't go through (or count against) Next's image optimizer.

const CLOUD_NAME = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME

type Options = {
  width?: number
  height?: number
  /** Cloudinary crop mode: "limit" never upscales; "fill" crops to the exact box. */
  crop?: "limit" | "fill"
  quality?: number | "auto"
}

export function cloudinaryUrl(publicId: string, { width, height, crop = "limit", quality = "auto" }: Options = {}) {
  const parts = ["f_auto", `q_${quality}`, `c_${crop}`]
  if (width) parts.push(`w_${width}`)
  if (height) parts.push(`h_${height}`)
  if (crop === "fill") parts.push("g_auto")
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${parts.join(",")}/${publicId}`
}
