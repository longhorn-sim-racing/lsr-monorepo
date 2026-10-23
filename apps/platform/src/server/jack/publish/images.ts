import sharp from "sharp"
import { JACK_DECK_SIZES, type JackDeckSizeKey } from "@/lib/jack/decks"

/**
 * Slides as the JPEGs Instagram takes (research/instagram.md §3d): JPEG, sRGB, at most 8 MB, 1080 px
 * wide. Feed posts and carousels are 4:5 (1080×1350, the deck "post" size: the safest feed ratio, and a
 * carousel's every image takes its first image's ratio); stories are 9:16 (1080×1920). A slide of
 * another shape is fitted whole and centred, never cropped, on bars of the colour along its own edges,
 * so a dark slide gets dark bars.
 */

export type InstagramShape = "feed" | "story"

export const INSTAGRAM_CANVAS: Record<InstagramShape, { width: number; height: number; label: string }> = {
  feed: { width: 1080, height: 1350, label: "4:5" },
  story: { width: 1080, height: 1920, label: "9:16" },
}

/** Instagram refuses images over this (36000/2207004) */
export const MAX_INSTAGRAM_BYTES = 8 * 1024 * 1024
const QUALITIES = [90, 82, 74, 66]

export type InstagramJpeg = { body: Buffer; width: number; height: number; fitted: boolean }

const sameRatio = (a: { width: number; height: number }, b: { width: number; height: number }) => Math.abs(a.width / a.height - b.width / b.height) < 0.01

const RATIO: Record<JackDeckSizeKey, string> = { slides: "16:9", post: "4:5", story: "9:16", square: "1:1" }

/** Whether a deck of this size fills the shape exactly, or is fitted on bars; for the card and the dialogs */
export function fitNote(size: JackDeckSizeKey, shape: InstagramShape): string | null {
  const slide = JACK_DECK_SIZES[size]
  const canvas = INSTAGRAM_CANVAS[shape]
  if (sameRatio(slide, canvas)) return null
  const bars = slide.width / slide.height > canvas.width / canvas.height ? "above and below" : "at the sides"
  return `The slides are ${RATIO[size]}, so each sits whole on a ${canvas.label} image with bars ${bars}.`
}

/** The average colour of the slide's edges the bars touch: the top and bottom rows, or the left and right columns */
async function edgeColour(png: Buffer, width: number, height: number, bars: "vertical" | "horizontal"): Promise<{ r: number; g: number; b: number }> {
  const strips =
    bars === "vertical"
      ? [{ left: 0, top: 0, width, height: 1 }, { left: 0, top: height - 1, width, height: 1 }]
      : [{ left: 0, top: 0, width: 1, height }, { left: width - 1, top: 0, width: 1, height }]
  const means = await Promise.all(strips.map(async (region) => (await sharp(png).extract(region).removeAlpha().stats()).channels.map((c) => c.mean)))
  const mean = (i: number) => Math.round((means[0][i] + means[1][i]) / 2)
  return { r: mean(0), g: mean(1), b: mean(2) }
}

/**
 * A slide's full-size render (PNG) as an Instagram JPEG of `shape`: resized when it already has the
 * shape's ratio, else fitted whole on bars. Quality steps down only if a busy image would pass 8 MB.
 */
export async function instagramJpeg(png: Buffer, shape: InstagramShape): Promise<InstagramJpeg> {
  const canvas = INSTAGRAM_CANVAS[shape]
  const meta = await sharp(png).metadata()
  if (!meta.width || !meta.height) throw new Error("The slide's image couldn't be read")
  const fitted = !sameRatio({ width: meta.width, height: meta.height }, canvas)
  const background = fitted ? await edgeColour(png, meta.width, meta.height, meta.width / meta.height > canvas.width / canvas.height ? "vertical" : "horizontal") : { r: 0, g: 0, b: 0 }

  for (const quality of QUALITIES) {
    const body = await sharp(png)
      .resize({ width: canvas.width, height: canvas.height, fit: fitted ? "contain" : "fill", background: { ...background, alpha: 1 } })
      .flatten({ background })
      .toColorspace("srgb")
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer()
    if (body.length <= MAX_INSTAGRAM_BYTES) return { body, width: canvas.width, height: canvas.height, fitted }
  }
  throw new Error("The slide is too detailed to fit Instagram's 8 MB limit as a JPEG")
}
