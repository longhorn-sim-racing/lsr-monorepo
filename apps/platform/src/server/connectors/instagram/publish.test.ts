import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { uploadImageBytes } from "@/server/cloudinary"
import { CLOUDINARY_FAKE, cloudinaryFake } from "../cloudinary/fake/handlers"
import { mountFakes, type MountedFakes } from "../fakes/testing"
import { INSTAGRAM_FAKE, instagramFake } from "./fake/handlers"
import { instagramGraph, InstagramGraphError } from "./graph"
import { containerBody, instagramPublisher, isLimitReached, isNotReady, isTransient } from "./publish"

let fakes: MountedFakes
const publisher = (token: string = INSTAGRAM_FAKE.publishToken) => instagramPublisher(instagramGraph(token), INSTAGRAM_FAKE.userId)

/** An image on the Cloudinary fake, where Instagram's fake fetches it */
async function hosted(width: number, height: number, format: "jpeg" | "png" = "jpeg"): Promise<string> {
  const image = sharp({ create: { width, height, channels: 3, background: "#123456" } })
  const body = await (format === "jpeg" ? image.jpeg() : image.png()).toBuffer()
  return (await uploadImageBytes(body, { publicId: `t/${width}x${height}-${format}-${Math.random()}`, contentType: `image/${format}` })).secureUrl
}

const graphError = (error: unknown) => (error instanceof InstagramGraphError ? { code: error.code, subcode: error.subcode } : error)

beforeEach(() => {
  fakes = mountFakes([instagramFake, cloudinaryFake])
  vi.stubEnv("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", CLOUDINARY_FAKE.cloudName)
  vi.stubEnv("CLOUDINARY_API_KEY", CLOUDINARY_FAKE.apiKey)
  vi.stubEnv("CLOUDINARY_API_SECRET", CLOUDINARY_FAKE.apiSecret)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the Instagram publisher, against the fake", () => {
  it("reads the account and the day's quota with the publishing token, sending it as a query or Bearer, never in a POST body", async () => {
    const ig = publisher()
    expect(await ig.account()).toEqual({ userId: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username, accountType: "Business" })
    expect(await ig.quota()).toEqual({ used: 0, total: 50 })
    const url = await hosted(1080, 1350)
    await ig.createContainer({ kind: "image", imageUrl: url, caption: "Hi" })
    const post = fakes.requests.find((r) => r.method === "POST" && r.service === "instagram")!
    expect(post.path).toBe(`/v26.0/${INSTAGRAM_FAKE.userId}/media`)
    expect(post.headers.get("authorization")).toBe(`Bearer ${INSTAGRAM_FAKE.publishToken}`)
    expect(post.body).not.toContain(INSTAGRAM_FAKE.publishToken)
  })

  it("refuses the feed's read token, which can't publish (code 10)", async () => {
    const error = await publisher(INSTAGRAM_FAKE.token).quota().catch((e: unknown) => e)
    expect(graphError(error)).toEqual({ code: 10, subcode: null })
    expect((error as InstagramGraphError).missingPermission).toBe(true)
  })

  it("makes a container, reports it processing then finished, publishes it once, and links the post", async () => {
    const ig = publisher()
    const id = await ig.createContainer({ kind: "image", imageUrl: await hosted(1080, 1350), caption: "GM 2", aiGenerated: true })
    // Not ready yet: 9007 (reading the status is the fake's clock)
    expect(graphError(await ig.publish(id).catch((e: unknown) => e))).toEqual({ code: 9007, subcode: 2207027 })
    expect(await ig.containerStatus(id)).toEqual({ code: "IN_PROGRESS", detail: null })
    expect(await ig.containerStatus(id)).toEqual({ code: "FINISHED", detail: null })
    const post = await ig.publish(id)
    expect(post).toEqual({ id: expect.stringMatching(/^18099/), partial: null })
    expect(await ig.containerStatus(id)).toMatchObject({ code: "PUBLISHED" })
    // Twice is an error, never a second post
    expect(isNotReady(await ig.publish(id).catch((e: unknown) => e))).toBe(false)
    expect(await ig.media(post.id)).toMatchObject({ id: post.id, caption: "GM 2", permalink: expect.stringMatching(/^https:\/\/www\.instagram\.com\/p\//) })
    expect((await ig.recentMedia(5))[0]).toMatchObject({ id: post.id, caption: "GM 2" })
    expect(await ig.quota()).toEqual({ used: 1, total: 50 })
  })

  it("is refused images Instagram would refuse: not a JPEG, a feed ratio outside 4:5 to 1.91:1, an unreachable link", async () => {
    const ig = publisher()
    expect(graphError(await ig.createContainer({ kind: "image", imageUrl: await hosted(1080, 1350, "png") }).catch((e: unknown) => e))).toEqual({ code: 36001, subcode: 2207005 })
    expect(graphError(await ig.createContainer({ kind: "image", imageUrl: await hosted(1080, 1920) }).catch((e: unknown) => e))).toEqual({ code: 36003, subcode: 2207009 })
    // A 9:16 image is fine as a story
    await expect(ig.createContainer({ kind: "story", imageUrl: await hosted(1080, 1920) })).resolves.toMatch(/^178/)
    expect(graphError(await ig.createContainer({ kind: "image", imageUrl: `${fakes.origin}/cloudinary/res/x/image/upload/v1/missing.jpg` }).catch((e: unknown) => e))).toEqual({ code: 9004, subcode: 2207052 })
    expect(graphError(await ig.createContainer({ kind: "image", imageUrl: await hosted(1080, 1350), caption: "#a ".repeat(31) }).catch((e: unknown) => e))).toEqual({ code: 36004, subcode: 2207010 })
  })

  it("makes a carousel from finished items only, and reports ERROR with Meta's detail", async () => {
    const ig = publisher()
    const items = [await ig.createContainer({ kind: "carousel_item", imageUrl: await hosted(1080, 1350) }), await ig.createContainer({ kind: "carousel_item", imageUrl: await hosted(1080, 1350) })]
    expect(graphError(await ig.createContainer({ kind: "carousel", children: items }).catch((e: unknown) => e))).toEqual({ code: 100, subcode: null })
    for (const id of items) await ig.containerStatus(id)
    const carousel = await ig.createContainer({ kind: "carousel", children: items, caption: "All of GM 2" })
    await ig.containerStatus(carousel)
    expect((await ig.publish(carousel)).id).toMatch(/^18099/)

    await fetch(`${fakes.origin}/instagram/_fake/publish`, { method: "POST", body: JSON.stringify({ errorNext: 1 }) })
    const broken = await ig.createContainer({ kind: "image", imageUrl: await hosted(1080, 1350) })
    await ig.containerStatus(broken)
    expect(await ig.containerStatus(broken)).toEqual({ code: "ERROR", detail: "Error: The image couldn't be processed (fake). 2207001" })
  })

  it("is refused once the day's quota is used up (code 9)", async () => {
    await fetch(`${fakes.origin}/instagram/_fake/publish`, { method: "POST", body: JSON.stringify({ quotaTotal: 1, quotaUsage: 1 }) })
    const ig = publisher()
    const id = await ig.createContainer({ kind: "image", imageUrl: await hosted(1080, 1350) })
    await ig.containerStatus(id)
    const error = await ig.publish(id).catch((e: unknown) => e)
    expect(isLimitReached(error)).toBe(true)
    expect(await ig.quota()).toEqual({ used: 1, total: 1 })
  })
})

describe("publishing errors and containers", () => {
  it("tells transient errors (no answer, Meta's own trouble, throttling) from refusals", () => {
    expect(isTransient(new TypeError("fetch failed"))).toBe(true)
    expect(isTransient(new InstagramGraphError(400, "/x", 2, null))).toBe(true)
    expect(isTransient(new InstagramGraphError(400, "/x", 80002, null))).toBe(true)
    expect(isTransient(new InstagramGraphError(500, "/x", null, null))).toBe(true)
    expect(isTransient(new InstagramGraphError(400, "/x", 25, 2207050))).toBe(false)
    expect(isNotReady(new InstagramGraphError(400, "/x", 9007, 2207027))).toBe(true)
  })

  it("builds Meta's fields: the AI label on a carousel, never on its items; alt text on single images", () => {
    expect(containerBody({ kind: "image", imageUrl: "u", caption: "c", altText: "a", aiGenerated: true })).toEqual({ image_url: "u", caption: "c", alt_text: "a", is_ai_generated: true })
    expect(containerBody({ kind: "carousel_item", imageUrl: "u" })).toEqual({ image_url: "u", is_carousel_item: true })
    expect(containerBody({ kind: "carousel", children: ["1", "2"], caption: "c", aiGenerated: true })).toEqual({ media_type: "CAROUSEL", children: "1,2", caption: "c", is_ai_generated: true })
    expect(containerBody({ kind: "story", imageUrl: "u" })).toEqual({ image_url: "u", media_type: "STORIES" })
  })
})
