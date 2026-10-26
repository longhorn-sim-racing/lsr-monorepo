import { loadSharp } from "@/server/jack/sharp"

/**
 * The copies made of an uploaded photo (design §5): the model copy Jack looks at (JPEG, upright,
 * EXIF and every other bit of metadata stripped, long edge at most 2000 px) and a small thumbnail for
 * the room. sharp drops metadata unless asked to keep it, so neither copy carries the photo's GPS
 * position or camera details. Animated GIFs give their first frame.
 */

export const MODEL_LONG_EDGE = 2000
export const THUMB_LONG_EDGE = 320

/** About 70 megapixels: a 48 MP phone photo fits; a decompression bomb (a tiny file that decodes huge) doesn't */
const MAX_INPUT_PIXELS = 70_000_000

export type ImageCopies = { width: number; height: number; model: Buffer; thumb: Buffer }

export async function imageCopies(body: Buffer): Promise<ImageCopies> {
  const sharp = await loadSharp()
  const input = sharp(body, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
  const meta = await input.metadata()
  if (!meta.width || !meta.height) throw new Error("Not an image sharp can read")
  // EXIF orientations 5 to 8 turn the picture a quarter turn
  const turned = (meta.orientation ?? 1) >= 5
  // The original is decoded once, for the model copy; the thumbnail is made from that small copy
  const model = await input
    .rotate()
    .resize({ width: MODEL_LONG_EDGE, height: MODEL_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer()
  const thumb = await sharp(model)
    .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer()
  return { width: turned ? meta.height : meta.width, height: turned ? meta.width : meta.height, model, thumb }
}
