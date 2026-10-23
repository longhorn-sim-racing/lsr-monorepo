import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { pingCloudinary, uploadImageBytes, uploadRemoteImage } from "@/server/cloudinary"
import { mountFakes, type MountedFakes } from "../../fakes/testing"
import { CLOUDINARY_FAKE, cloudinaryFake } from "./handlers"
import { imageInfo } from "./image-size"

let fakes: MountedFakes
const jpeg = () => sharp({ create: { width: 640, height: 800, channels: 3, background: "#bf5700" } }).jpeg().toBuffer()

beforeEach(() => {
  fakes = mountFakes([cloudinaryFake])
  vi.stubEnv("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", CLOUDINARY_FAKE.cloudName)
  vi.stubEnv("CLOUDINARY_API_KEY", CLOUDINARY_FAKE.apiKey)
  vi.stubEnv("CLOUDINARY_API_SECRET", CLOUDINARY_FAKE.apiSecret)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("server uploads to Cloudinary, against the fake", () => {
  it("upload bytes, signed, and serve them back at the public link", async () => {
    const body = await jpeg()
    const uploaded = await uploadImageBytes(body, { publicId: "jack/instagram/pub-1/1" })
    expect(uploaded).toEqual({
      publicId: "jack/instagram/pub-1/1",
      secureUrl: expect.stringMatching(new RegExp(`^${fakes.origin}/cloudinary/res/lsr-fake/image/upload/v\\d+/jack/instagram/pub-1/1\\.jpg$`)),
      width: 640,
      height: 800,
      bytes: body.length,
      existing: false,
    })
    const request = fakes.requests[0]
    expect(request.path).toBe("/v1_1/lsr-fake/image/upload")
    // The secret never travels; the key and signature do
    expect(request.body).not.toContain(CLOUDINARY_FAKE.apiSecret)
    const served = await fetch(uploaded.secureUrl)
    expect(served.headers.get("content-type")).toBe("image/jpeg")
    expect(Buffer.from(await served.arrayBuffer()).equals(body)).toBe(true)
  })

  it("keep an asset already under that id instead of replacing it", async () => {
    const first = await uploadImageBytes(await jpeg(), { publicId: "gallery/jack/abc" })
    const again = await uploadImageBytes(await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).png().toBuffer(), { publicId: "gallery/jack/abc", contentType: "image/png" })
    expect(again).toMatchObject({ existing: true, width: 640, secureUrl: first.secureUrl })
  })

  it("fail with Cloudinary's message on a bad signature or a server error, and without the keys", async () => {
    vi.stubEnv("CLOUDINARY_API_SECRET", "not-the-secret")
    await expect(uploadImageBytes(await jpeg(), { publicId: "x" })).rejects.toThrow("Cloudinary didn't take the image (401: Invalid Signature)")
    vi.stubEnv("CLOUDINARY_API_SECRET", CLOUDINARY_FAKE.apiSecret)
    await fetch(`${fakes.origin}/cloudinary/_fake/state`, { method: "POST", body: JSON.stringify({ fail: 1 }) })
    await expect(uploadImageBytes(await jpeg(), { publicId: "x" })).rejects.toThrow("Cloudinary didn't take the image (500: Server error (fake))")
    vi.stubEnv("CLOUDINARY_API_KEY", "")
    await expect(uploadImageBytes(await jpeg(), { publicId: "x" })).rejects.toThrow("Cloudinary uploads aren't set up")
  })

  it("let the feed sync copy an image by URL through the fake too, and ping", async () => {
    const source = await uploadImageBytes(await jpeg(), { publicId: "source" })
    expect(await uploadRemoteImage(source.secureUrl, "instagram/123")).toEqual({ publicId: "instagram/123", width: 640, height: 800 })
    expect(await pingCloudinary()).toEqual({ ok: true, detail: "Cloudinary answered" })
    vi.stubEnv("CLOUDINARY_API_SECRET", "wrong")
    expect(await pingCloudinary()).toEqual({ ok: false, detail: "Cloudinary answered 401: Invalid api_secret" })
  })

  it("take any key in fake mode, so a developer's own env never reaches the real Cloudinary", async () => {
    vi.stubEnv("CLOUDINARY_API_KEY", "someones-real-key")
    vi.stubEnv("CLOUDINARY_API_SECRET", "someones-real-secret")
    await expect(uploadImageBytes(await jpeg(), { publicId: "y" })).resolves.toMatchObject({ publicId: "y" })
  })
})

describe("imageInfo", () => {
  it("reads a JPEG's and a PNG's size from their headers", async () => {
    expect(imageInfo(await jpeg())).toEqual({ format: "jpg", width: 640, height: 800 })
    expect(imageInfo(await sharp({ create: { width: 33, height: 7, channels: 4, background: "#fff" } }).png().toBuffer())).toEqual({ format: "png", width: 33, height: 7 })
    expect(imageInfo(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
