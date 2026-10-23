// Cloudinary delivery URLs. Images are resized and re-encoded by Cloudinary's CDN, so they
// don't go through (or count against) Next's image optimizer.

const CLOUD_NAME = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME

/**
 * Where Jack's gallery adds (and the deck page's) put their copies: slides and room photos that were
 * officer-only until then. Deleting such a gallery image deletes its copy too, so its link stops working
 * everywhere (decks can use gallery photos by link)
 */
export const JACK_GALLERY_PREFIX = "gallery/jack/"

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
