import { afterEach, describe, expect, it, vi } from "vitest"
import { CLOUDINARY_FAKE, cloudinaryFake } from "./connectors/cloudinary/fake/handlers"
import { mountFakes } from "./connectors/fakes/testing"
import { destroyImage, signParams, signVideoUpload, uploadImageBytes } from "./cloudinary"

describe("destroyImage", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("deletes a copy with a signed request that also drops the CDN's cached copies (invalidate)", async () => {
    const fakes = mountFakes([cloudinaryFake])
    vi.stubEnv("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", CLOUDINARY_FAKE.cloudName)
    vi.stubEnv("CLOUDINARY_API_KEY", CLOUDINARY_FAKE.apiKey)
    vi.stubEnv("CLOUDINARY_API_SECRET", CLOUDINARY_FAKE.apiSecret)
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")
    const { secureUrl } = await uploadImageBytes(png, { publicId: "gallery/jack/file-x", contentType: "image/png", filename: "x.png" })

    // The fake checks the signature over every field, invalidate included
    expect(await destroyImage("gallery/jack/file-x")).toBe(true)
    const sent = fakes.requests.find((r) => r.path.endsWith("/image/destroy"))!
    expect(sent.body).toContain('name="invalidate"\r\n\r\ntrue')
    expect((await fetch(secureUrl)).status).toBe(404)
    // Gone already counts as deleted
    expect(await destroyImage("gallery/jack/file-x")).toBe(true)
  })

  it("reports false, never throws, without the API key", async () => {
    vi.stubEnv("CLOUDINARY_API_SECRET", "")
    expect(await destroyImage("gallery/jack/file-x")).toBe(false)
  })
})

describe("signParams", () => {
  it("matches the example in Cloudinary's signature docs", () => {
    const params = { eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: "1315060510" }
    expect(signParams(params, "abcd")).toBe("bfd09f95f331f558cbd1320e67aa8d488770583e")
  })
})

describe("signVideoUpload", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("signs a video upload that makes the MP4 and poster ahead of time", () => {
    vi.stubEnv("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", "demo")
    vi.stubEnv("CLOUDINARY_API_KEY", "key")
    vi.stubEnv("CLOUDINARY_API_SECRET", "secret")
    const signed = signVideoUpload()
    expect(signed).toMatchObject({ cloudName: "demo", apiKey: "key" })
    expect(signed?.params).toMatchObject({ asset_folder: "lsr/videos", eager: "q_auto/mp4|so_auto,c_limit,w_1280,q_auto/jpg", eager_async: "true" })
    expect(signed?.signature).toBe(signParams(signed!.params, "secret"))
  })

  it("is null without the API secret", () => {
    vi.stubEnv("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", "demo")
    vi.stubEnv("CLOUDINARY_API_KEY", "key")
    vi.stubEnv("CLOUDINARY_API_SECRET", "")
    expect(signVideoUpload()).toBeNull()
  })
})
