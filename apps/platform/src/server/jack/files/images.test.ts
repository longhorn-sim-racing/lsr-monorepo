import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { imageFile } from "./fixtures"
import { imageCopies, MODEL_LONG_EDGE, THUMB_LONG_EDGE } from "./images"

describe("imageCopies", () => {
  it("makes a JPEG model copy with no EXIF (camera, GPS) and a small thumbnail", async () => {
    const photo = await imageFile("jpeg", { width: 640, height: 480 })
    expect((await sharp(photo).metadata()).exif).toBeDefined()
    const copies = await imageCopies(photo)
    expect(copies).toMatchObject({ width: 640, height: 480 })
    const model = await sharp(copies.model).metadata()
    expect(model).toMatchObject({ format: "jpeg", width: 640, height: 480 })
    expect(model.exif).toBeUndefined()
    expect(copies.model.includes(Buffer.from("Secret Model"))).toBe(false)
    const thumb = await sharp(copies.thumb).metadata()
    expect(Math.max(thumb.width!, thumb.height!)).toBe(THUMB_LONG_EDGE)
    expect(thumb.exif).toBeUndefined()
  })

  it("caps the long edge at 2000 px and never enlarges", async () => {
    const wide = await imageCopies(await imageFile("png", { width: 3000, height: 1000 }))
    expect(await sharp(wide.model).metadata()).toMatchObject({ width: MODEL_LONG_EDGE, height: 667 })
    const small = await imageCopies(await imageFile("webp", { width: 120, height: 80 }))
    expect(await sharp(small.model).metadata()).toMatchObject({ width: 120, height: 80 })
    expect(await sharp(small.thumb).metadata()).toMatchObject({ width: 120, height: 80 })
  })

  it("turns a phone photo upright from its EXIF orientation", async () => {
    // Orientation 6: stored 64 wide by 48 tall, shown turned a quarter, 48 wide by 64 tall
    const copies = await imageCopies(await imageFile("jpeg", { width: 64, height: 48, orientation: 6 }))
    expect(copies).toMatchObject({ width: 48, height: 64 })
    expect(await sharp(copies.model).metadata()).toMatchObject({ width: 48, height: 64 })
  })

  it("reads GIFs (first frame) and refuses what isn't an image", async () => {
    expect((await imageCopies(await imageFile("gif"))).width).toBe(64)
    await expect(imageCopies(Buffer.from("not an image"))).rejects.toThrow()
  })
})
