import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { fitNote } from "@/lib/jack/publish"
import { instagramJpeg } from "./images"

/** A solid slide render, optionally with a band of another colour across its middle */
async function slide(width: number, height: number, colour = "#0b0b0b", band?: string): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 4, background: colour } })
  if (!band) return base.png().toBuffer()
  const stripe = await sharp({ create: { width: Math.round(width / 2), height: Math.round(height / 2), channels: 4, background: band } }).png().toBuffer()
  return base.composite([{ input: stripe, gravity: "centre" }]).png().toBuffer()
}

/** The colour of one pixel of a JPEG */
async function pixel(jpeg: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return [data[i], data[i + 1], data[i + 2]]
}

const near = (actual: number[], expected: number[]) => actual.every((v, i) => Math.abs(v - expected[i]) <= 6)

describe("instagramJpeg", () => {
  it("resizes a post-size slide to 1080×1350 JPEG without bars", async () => {
    const jpeg = await instagramJpeg(await slide(1080, 1350, "#bf5700"), "feed")
    expect(jpeg).toMatchObject({ width: 1080, height: 1350, fitted: false })
    const meta = await sharp(jpeg.body).metadata()
    expect(meta).toMatchObject({ format: "jpeg", width: 1080, height: 1350, space: "srgb", hasAlpha: false })
    expect(meta.exif).toBeUndefined()
    expect(near(await pixel(jpeg.body, 0, 0), [0xbf, 0x57, 0x00])).toBe(true)
  })

  it("fits a 16:9 slide whole on a 4:5 image, with bars above and below in its edge colour", async () => {
    const jpeg = await instagramJpeg(await slide(1920, 1080, "#1a2b3c", "#ffffff"), "feed")
    expect(jpeg).toMatchObject({ width: 1080, height: 1350, fitted: true })
    // The slide is 1080×608 in the middle; the bars match its (dark) edges, and the white band is whole
    expect(near(await pixel(jpeg.body, 540, 10), [0x1a, 0x2b, 0x3c])).toBe(true)
    expect(near(await pixel(jpeg.body, 540, 1340), [0x1a, 0x2b, 0x3c])).toBe(true)
    expect(near(await pixel(jpeg.body, 540, 675), [255, 255, 255])).toBe(true)
  })

  it("fits a square or 4:5 slide on a 9:16 story, and a story-size slide fills it", async () => {
    const square = await instagramJpeg(await slide(1080, 1080, "#ffffff"), "story")
    expect(square).toMatchObject({ width: 1080, height: 1920, fitted: true })
    expect(near(await pixel(square.body, 540, 5), [255, 255, 255])).toBe(true)
    expect(await instagramJpeg(await slide(1080, 1920), "story")).toMatchObject({ fitted: false, height: 1920 })
  })

  it("stays under Instagram's 8 MB", async () => {
    const noise = await sharp(Buffer.from(Array.from({ length: 1080 * 1350 * 3 }, (_, i) => (i * 7919) % 251)), { raw: { width: 1080, height: 1350, channels: 3 } })
      .png()
      .toBuffer()
    const jpeg = await instagramJpeg(noise, "feed")
    expect(jpeg.body.length).toBeLessThanOrEqual(8 * 1024 * 1024)
  })
})

describe("fitNote", () => {
  it("says how a deck's slides go on each shape, and nothing when they fill it", () => {
    expect(fitNote("post", "feed")).toBeNull()
    expect(fitNote("story", "story")).toBeNull()
    expect(fitNote("slides", "feed")).toBe("The slides are 16:9, so each sits whole on a 4:5 image with bars above and below.")
    expect(fitNote("square", "story")).toBe("The slides are 1:1, so each sits whole on a 9:16 image with bars above and below.")
    expect(fitNote("story", "feed")).toBe("The slides are 9:16, so each sits whole on a 4:5 image with bars at the sides.")
  })
})
