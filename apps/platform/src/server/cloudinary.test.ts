import { afterEach, describe, expect, it, vi } from "vitest"
import { signParams, signVideoUpload } from "./cloudinary"

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
