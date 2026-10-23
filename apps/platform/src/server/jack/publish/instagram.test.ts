import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({}) as Record<string, unknown>)
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const broadcast = vi.hoisted(() => ({ broadcastRoomEvent: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/jack/broadcast", () => broadcast)
vi.mock("@/server/jack/messages", () => ({ jackMessageInclude: {}, toMessageView: (row: unknown) => row }))
vi.mock("@/server/jack/decks/renders", () => ({ getRenderFile: vi.fn() }))

import { JACK_EVENT } from "@/lib/jack/types"
import { destroyImage, uploadImageBytes } from "@/server/cloudinary"
import { CLOUDINARY_FAKE, cloudinaryFake } from "@/server/connectors/cloudinary/fake/handlers"
import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { INSTAGRAM_FAKE, instagramFake } from "@/server/connectors/instagram/fake/handlers"
import { instagramGraph } from "@/server/connectors/instagram/graph"
import { instagramPublisher } from "@/server/connectors/instagram/publish"
import type { DeckView } from "@/server/jack/decks/service"
import { claimPublish, describePublish, finishInstagramPublishes, LEASE_MS, PUBLISH_CUTOFF_MS, PublishRefused, PublishRepeat, readContainers, SETTLE_MS, startInstagramPublish, type PublishDeps, type StartPublish } from "./instagram"
import { fakePublishDb, type FakePublishDb } from "./test-db"

// Before any real clock this runs on, so the fake's own timestamps (real time) always come after it
const T0 = new Date("2026-01-05T17:00:00Z").getTime()
let clock = T0
let store: FakePublishDb
let fakes: MountedFakes

const deck: DeckView = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "GM 2 recap",
  size: "post",
  version: 3,
  roomId: "room-1",
  createdById: "u1",
  createdAt: new Date(T0),
  updatedAt: new Date(T0),
  content: { css: "", slides: [1, 2, 3].map((n) => ({ id: `slide${n}`, html: `<section>${n}</section>` })) },
}
const slides = deck.content.slides.map((slide, i) => ({ ...slide, n: i + 1 }))

/** A slide render at the deck's size */
const png = (width = 1080, height = 1350) => sharp({ create: { width, height, channels: 3, background: "#1a2b3c" } }).png().toBuffer()

function deps(over: Partial<PublishDeps> = {}): PublishDeps {
  return {
    client: { ...instagramPublisher(instagramGraph(INSTAGRAM_FAKE.publishToken), INSTAGRAM_FAKE.userId), username: INSTAGRAM_FAKE.username },
    slidePng: () => png(),
    upload: (body, publicId) => uploadImageBytes(body, { publicId }),
    remove: (publicId) => destroyImage(publicId),
    // Waiting moves the clock on, so a wait past its end stops the loop
    sleep: async (ms) => {
      clock += ms
    },
    now: () => new Date(clock),
    ...over,
  }
}

const input = (over: Partial<StartPublish> = {}): StartPublish => ({
  deck,
  slides: [slides[0]],
  type: "post",
  caption: "GM 2 recap! #longhornsimracing",
  aiGenerated: false,
  createdById: "u1",
  approvedById: "u2",
  auditMetadata: { via: "jack", proposalId: "prop-1" },
  ...over,
})

type FakeState = {
  quota: { used: number; total: number }
  containers: { id: string; kind: string; status: string; caption: string; aiGenerated: boolean; altText: string | null }[]
  posts: { id: string; kind: string; caption: string }[]
}
/** The Instagram fake's view of what was made and posted */
const instagramState = async (): Promise<FakeState> => (await fetch(`${fakes.origin}/instagram/_fake/publish`)).json()
const knob = (body: Record<string, unknown>) => fetch(`${fakes.origin}/instagram/_fake/publish`, { method: "POST", body: JSON.stringify(body) })
const publishCalls = () => fakes.requests.filter((r) => r.service === "instagram" && r.path.endsWith("/media_publish")).length
/** The slide copies on the Cloudinary fake for a row */
const copies = async (rowId: string) => ((await (await fetch(`${fakes.origin}/cloudinary/_fake/state`)).json()) as { assets: { publicId: string }[] }).assets.filter((a) => a.publicId.startsWith(`jack/instagram/${rowId}/`))
const stored = (id: string) => store.instagramPublish.rows.get(id)!

beforeEach(() => {
  clock = T0
  store = fakePublishDb(() => new Date(clock))
  for (const key of Object.keys(db)) delete db[key]
  Object.assign(db, store)
  store.decks.set(deck.id, { roomId: "room-1", title: deck.title })
  fakes = mountFakes([instagramFake, cloudinaryFake])
  vi.stubEnv("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", CLOUDINARY_FAKE.cloudName)
  vi.stubEnv("CLOUDINARY_API_KEY", CLOUDINARY_FAKE.apiKey)
  vi.stubEnv("CLOUDINARY_API_SECRET", CLOUDINARY_FAKE.apiSecret)
  audit.createAuditLog.mockReset()
  broadcast.broadcastRoomEvent.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("startInstagramPublish", () => {
  it("posts one slide: a 4:5 JPEG on Cloudinary, one container with the caption, published with its link", async () => {
    const { row, state } = await startInstagramPublish(input({ altText: "The GM 2 podium", aiGenerated: true }), deps())

    expect(state).toBe("published")
    expect(row).toMatchObject({ status: "published", mediaType: "IMAGE", slideIds: ["slide1"], deckId: deck.id, version: 3, proposalId: null, createdById: "u1", approvedById: "u2", claimedAt: null, error: null })
    expect(row.igMediaId).toMatch(/^18099/)
    expect(row.permalink).toMatch(/^https:\/\/www\.instagram\.com\/p\//)
    expect(row.imageUrls).toEqual([expect.stringMatching(new RegExp(`^${fakes.origin}/cloudinary/res/lsr-fake/image/upload/v\\d+/jack/instagram/${row.id}/1\\.jpg$`))])

    const ig = await instagramState()
    expect(ig.containers).toEqual([expect.objectContaining({ kind: "IMAGE", status: "PUBLISHED", caption: "GM 2 recap! #longhornsimracing", aiGenerated: true, altText: "The GM 2 podium" })])
    expect(ig.posts).toHaveLength(1)
    expect(publishCalls()).toBe(1)
    // What Instagram downloaded: a 1080×1350 JPEG (the fake checks the type and the feed ratio too)
    const image = await fetch(row.imageUrls[0])
    expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({ format: "jpeg", width: 1080, height: 1350 })

    expect(audit.createAuditLog).toHaveBeenCalledTimes(1)
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "u2", actionType: "CREATE", entityType: "INSTAGRAM_PUBLISH", entityId: row.id, metadata: { via: "jack", proposalId: "prop-1", publishId: row.id } })
    expect(audit.createAuditLog.mock.calls[0][0].summary).toBe("Posted “GM 2 recap” as a post on Instagram.")
  })

  it("posts a carousel: an item per slide in order, then the carousel with the caption and the AI label", async () => {
    const { row, state } = await startInstagramPublish(input({ type: "carousel", slides, aiGenerated: true }), deps())
    expect(state).toBe("published")
    const ig = await instagramState()
    const items = ig.containers.filter((c) => c.kind === "CAROUSEL_ITEM")
    const carousel = ig.containers.find((c) => c.kind === "CAROUSEL")!
    expect(items).toHaveLength(3)
    expect(items.every((c) => c.caption === "" && !c.aiGenerated)).toBe(true)
    expect(carousel).toMatchObject({ caption: "GM 2 recap! #longhornsimracing", aiGenerated: true, status: "PUBLISHED" })
    expect(readContainers(row.containerIds as never)).toMatchObject({ items: items.map((c) => c.id), carousel: carousel.id, aiGenerated: true })
    expect(ig.posts).toEqual([expect.objectContaining({ kind: "CAROUSEL_ALBUM" })])
  })

  it("posts a story at 9:16 without a caption, fitting a 4:5 slide on bars", async () => {
    const { row } = await startInstagramPublish(input({ type: "story", caption: "ignored" }), deps())
    expect(row).toMatchObject({ status: "published", mediaType: "STORIES", caption: "" })
    const image = await fetch(row.imageUrls[0])
    expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({ width: 1080, height: 1920 })
    expect((await instagramState()).posts).toEqual([expect.objectContaining({ kind: "STORY" })])
  })

  it("refuses before making anything when Instagram's quota or the site's own cap is used up", async () => {
    await knob({ quotaTotal: 2, quotaUsage: 2 })
    await expect(startInstagramPublish(input(), deps())).rejects.toThrow(PublishRefused)
    expect(store.instagramPublish.rows.size).toBe(0)
    expect((await instagramState()).containers).toHaveLength(0)

    await knob({ quotaTotal: 50 })
    for (let i = 0; i < 10; i++) await store.instagramPublish.create({ data: { status: i % 2 ? "published" : "containers" } })
    await store.instagramPublish.create({ data: { status: "failed" } })
    await expect(startInstagramPublish(input(), deps())).rejects.toThrow(/already sent 10 posts to Instagram in the last 24 hours/)
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("fails without posting when Instagram can't use an image, and says which slide", async () => {
    await knob({ errorNext: 1 })
    await expect(startInstagramPublish(input({ type: "carousel", slides: slides.slice(0, 2) }), deps())).rejects.toThrow("Instagram couldn't use slide 1 (Error: The image couldn't be processed (fake). 2207001), so nothing was posted.")
    const [row] = store.instagramPublish.rows.values()
    expect(row).toMatchObject({ status: "failed", claimedAt: null })
    expect((await instagramState()).posts).toHaveLength(0)
    expect(publishCalls()).toBe(0)
    expect(audit.createAuditLog.mock.calls[0][0].summary).toMatch(/^Couldn't post/)
    // Nothing went out, so its public copies are gone
    expect(row.imageUrls).toEqual([])
    expect(await copies(row.id as string)).toEqual([])
  })

  it("says which slide couldn't be made into an image (a function without Chromium, a slide never rendered)", async () => {
    const noChromium = deps({ slidePng: () => Promise.reject(new Error("Could not find Chromium")) })
    await expect(startInstagramPublish(input({ type: "carousel", slides: slides.slice(1) }), noChromium)).rejects.toThrow(
      "slide 2 couldn't be turned into an image (Could not find Chromium). Open the deck page so its slides render, then try again.",
    )
    const [row] = store.instagramPublish.rows.values()
    expect(row.error).toMatch(/^Nothing was posted: slide 2 couldn't be turned into an image/)
    expect((await instagramState()).containers).toHaveLength(0)
  })

  it("fails before any container when Cloudinary won't take the images, and deletes the copies that did go up", async () => {
    await fetch(`${fakes.origin}/cloudinary/_fake/state`, { method: "POST", body: JSON.stringify({ fail: 1 }) })
    // One upload fails while the others of the carousel go up
    const removed: string[] = []
    const tracked = deps({ remove: async (publicId) => (removed.push(publicId), destroyImage(publicId)) })
    await expect(startInstagramPublish(input({ type: "carousel", slides }), tracked)).rejects.toThrow(/Cloudinary didn't take the image \(500/)
    const [row] = store.instagramPublish.rows.values()
    expect(row.status).toBe("failed")
    expect(row.error).toMatch(/^Nothing was posted: Cloudinary didn't take the image/)
    expect((await instagramState()).containers).toHaveLength(0)
    expect(removed.sort()).toEqual([1, 2, 3].map((n) => `jack/instagram/${row.id}/${n}`))
    expect(await copies(row.id as string)).toEqual([])
  })

  it("keeps a copy listed on the row when Cloudinary won't delete it", async () => {
    await knob({ errorNext: 1 })
    await expect(startInstagramPublish(input(), deps({ remove: async () => false }))).rejects.toThrow(/Instagram couldn't use the image/)
    const [row] = store.instagramPublish.rows.values()
    expect(row).toMatchObject({ status: "failed", imageUrls: [expect.stringContaining(`/jack/instagram/${row.id}/1.jpg`)] })
  })

  it("leaves a post Instagram is still processing to the follow-up, which posts it and tells the room", async () => {
    store.proposals.set("prop-1", { roomId: "room-9" })
    await knob({ processingReads: 50 })
    const { row, state } = await startInstagramPublish(input({ proposalId: "prop-1" }), deps(), { waitMs: 20_000 })
    expect(state).toBe("waiting")
    expect(row).toMatchObject({ status: "containers", claimedAt: null })
    expect(describePublish(row, "GM 2 recap")).toMatch(/Instagram is still processing the images/)

    // Instagram finishes; the job's next run posts it
    await knob({ ready: true })
    const counts = await finishInstagramPublishes(deps(), { deadline: clock + 60_000 })
    expect(counts).toMatchObject({ published: 1, failed: 0, waiting: 0, errors: [] })
    expect(stored(row.id)).toMatchObject({ status: "published" })
    expect(store.notes).toEqual([expect.objectContaining({ roomId: "room-9", kind: "system", content: "Posted “GM 2 recap” as a post on Instagram. → /admin/instagram#publishing" })])
    expect(broadcast.broadcastRoomEvent).toHaveBeenCalledWith("room-9", expect.objectContaining({ type: JACK_EVENT.created }))
  })

  it("doesn't take someone else's caption-less post for ours when the answer to a caption-less post was lost", async () => {
    // Media posted a caption-less photo from the app around the same time
    const foreign = { id: "18000000000000777", permalink: "https://www.instagram.com/p/SOMEONE/", timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "+0000"), caption: null, mediaType: "IMAGE" }
    const withForeign = (over: Partial<PublishDeps> = {}) => {
      const base = deps(over)
      return { ...base, client: { ...base.client, recentMedia: async (limit?: number, signal?: AbortSignal) => [foreign, ...(await base.client.recentMedia(limit, signal))] } }
    }
    // The post went out but its answer was lost: the container says PUBLISHED, but two caption-less posts can't be told apart
    await knob({ dropPublish: 1 })
    const lost = await startInstagramPublish(input({ caption: "" }), withForeign())
    expect(lost.row).toMatchObject({ status: "published", igMediaId: null, permalink: null, error: expect.stringMatching(/its link couldn't be found here/) })

    // A call that got no answer and didn't take: after the settle time it's posted, never matched to the other post
    await knob({ publishError: { code: 2, message: "Service temporarily unavailable" } })
    const waiting = await startInstagramPublish(input({ caption: "", proposalId: "prop-bare" }), withForeign(), { waitMs: 5_000 })
    expect(waiting.row.status).toBe("publishing")
    clock += SETTLE_MS
    await finishInstagramPublishes(withForeign(), { deadline: clock + 60_000 })
    expect(stored(waiting.row.id)).toMatchObject({ status: "published", igMediaId: expect.stringMatching(/^18099/) })
    expect(stored(waiting.row.id).igMediaId).not.toBe(foreign.id)
    expect((await instagramState()).posts).toHaveLength(2)
  })

  it("never posts twice: a publish whose answer was lost is found through the container's status", async () => {
    await knob({ dropPublish: 1 })
    const { row, state } = await startInstagramPublish(input(), deps())
    expect(state).toBe("published")
    expect(row.igMediaId).toMatch(/^18099/)
    expect(row.permalink).toMatch(/instagram\.com/)
    expect(publishCalls()).toBe(1)
    expect((await instagramState()).posts).toHaveLength(1)
  })

  it("waits out a publish call that got no answer before looking again, then posts it once", async () => {
    await knob({ publishError: { code: 2, message: "Service temporarily unavailable" } })
    const { row, state } = await startInstagramPublish(input(), deps(), { waitMs: 5_000 })
    expect(state).toBe("waiting")
    expect(row.status).toBe("publishing")
    expect(readContainers(row.containerIds as never).publishAttemptAt).not.toBeNull()

    // Within the settle time a look only waits: nothing is posted
    await finishInstagramPublishes(deps(), { deadline: clock + 60_000, waitMs: 1_000 })
    expect(stored(row.id).status).toBe("publishing")
    expect(publishCalls()).toBe(1)
    // After it the container is still FINISHED and no post has the caption, so it's posted, once
    clock += SETTLE_MS
    await finishInstagramPublishes(deps(), { deadline: clock + 60_000 })
    expect(stored(row.id).status).toBe("published")
    expect(publishCalls()).toBe(2)
    expect((await instagramState()).posts).toHaveLength(1)
  })

  it("fails a publish Instagram refuses, and a container that expired, saying nothing went out", async () => {
    await knob({ publishError: { code: 25, subcode: 2207050, message: "The account is restricted" } })
    await expect(startInstagramPublish(input(), deps())).rejects.toThrow(/^Instagram refused the post, so nothing was posted: .*code 25\/2207050/)

    await knob({ processingReads: 50 })
    const waiting = await startInstagramPublish(input({ proposalId: "prop-2" }), deps(), { waitMs: 3_000 })
    const [container] = (await instagramState()).containers.slice(-1)
    await knob({ expire: [container.id] })
    await finishInstagramPublishes(deps(), { deadline: clock + 60_000 })
    expect(stored(waiting.row.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/expired \(after 24 hours\) before it went out, so nothing was posted/) })
    expect((await instagramState()).posts).toHaveLength(0)
  })

  it("carries on with a proposal's row instead of making a second, unless someone holds it", async () => {
    await knob({ processingReads: 50 })
    const first = await startInstagramPublish(input({ proposalId: "prop-7" }), deps(), { waitMs: 3_000 })
    expect(first.state).toBe("waiting")
    expect(await claimPublish(first.row.id, new Date(clock))).toBe(true)
    expect(await claimPublish(first.row.id, new Date(clock))).toBe(false)
    // Held: a second apply of the same proposal waits instead of working it
    const second = await startInstagramPublish(input({ proposalId: "prop-7" }), deps(), { waitMs: 3_000 })
    expect(second).toMatchObject({ state: "waiting", row: { id: first.row.id } })
    expect(store.instagramPublish.rows.size).toBe(1)
    expect((await instagramState()).containers).toHaveLength(1)
    // Once the lease runs out, it can be taken again
    expect(await claimPublish(first.row.id, new Date(clock + LEASE_MS + 1))).toBe(true)
  })
})

describe("startInstagramPublish from the deck page (refuseRepeat)", () => {
  it("refuses the same pick while it's on its way or after it went out in the last day, under a lock on the deck, and makes nothing", async () => {
    await knob({ processingReads: 50 })
    const pick = input({ type: "carousel", slides: slides.slice(0, 2), proposalId: undefined, refuseRepeat: true })
    const first = await startInstagramPublish(pick, deps(), { waitMs: 3_000 })
    expect(first.state).toBe("waiting")
    expect(store.locks).toEqual([`instagram-publish:${deck.id}`])

    const containersBefore = (await instagramState()).containers.length
    const repeat = startInstagramPublish(pick, deps(), { waitMs: 3_000 })
    await expect(repeat).rejects.toThrow(PublishRepeat)
    await expect(startInstagramPublish(pick, deps(), { waitMs: 3_000 })).rejects.toThrow(/^These slides already went to Instagram as a carousel at Jan 5, 11:00 AM \(Instagram is processing\)\. See Content → Instagram\.$/)
    expect(store.instagramPublish.rows.size).toBe(1)
    expect((await instagramState()).containers).toHaveLength(containersBefore)

    // Other slides, another type, or the officer confirming it again: posted
    await knob({ ready: true })
    await startInstagramPublish({ ...pick, slides: slides.slice(1) }, deps())
    await startInstagramPublish({ ...pick, type: "post", slides: [slides[0]] }, deps())
    await startInstagramPublish({ ...pick, refuseRepeat: false }, deps())
    expect(store.instagramPublish.rows.size).toBe(4)
  })

  it("lets the pick go again once the last one failed, or went out over a day ago", async () => {
    const pick = input({ refuseRepeat: true })
    const old = await startInstagramPublish(pick, deps())
    expect(old.row.status).toBe("published")
    await expect(startInstagramPublish(pick, deps())).rejects.toThrow(/^This slide already went to Instagram as a post at .* \(Posted\)/)
    clock += 86_400_000 + 1
    const again = await startInstagramPublish(pick, deps())
    expect(again.row.status).toBe("published")

    stored(again.row.id).status = "failed"
    stored(old.row.id).status = "failed"
    expect((await startInstagramPublish(pick, deps())).row.status).toBe("published")
  })
})

describe("finishInstagramPublishes", () => {
  it("fails a post that still isn't out 2 hours after it was approved, instead of posting it late", async () => {
    store.proposals.set("prop-late", { roomId: "room-9" })
    await knob({ processingReads: 50 })
    const { row } = await startInstagramPublish(input({ proposalId: "prop-late" }), deps(), { waitMs: 3_000 })
    expect(row.status).toBe("containers")
    clock += PUBLISH_CUTOFF_MS + 1
    // Instagram is ready only now: too late
    await knob({ ready: true })
    const counts = await finishInstagramPublishes(deps(), { deadline: clock + 60_000 })
    expect(counts).toMatchObject({ published: 0, failed: 1 })
    expect(stored(row.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/^Nothing was posted: Instagram took too long .* Ask again to post it\.$/), imageUrls: [] })
    expect(publishCalls()).toBe(0)
    expect((await instagramState()).posts).toHaveLength(0)
    expect(store.notes.at(-1)?.content).toMatch(/^Couldn't post “GM 2 recap” as a post on Instagram: Nothing was posted: Instagram took too long/)
  })

  it("still records a late post that did go out: the container is checked before the cutoff", async () => {
    await knob({ dropPublish: 1, processingReads: 0 })
    // The answer is lost and the apply stops waiting before it looks again
    const { row } = await startInstagramPublish(input(), deps(), { waitMs: 1_000 })
    expect(row.status).toBe("publishing")
    clock += PUBLISH_CUTOFF_MS + 1
    await finishInstagramPublishes(deps(), { deadline: clock + 60_000 })
    expect(stored(row.id)).toMatchObject({ status: "published", igMediaId: expect.stringMatching(/^18099/) })
    expect(publishCalls()).toBe(1)
  })

  it("fails a late post whose publish call didn't take, after looking for it once more, without calling again", async () => {
    await knob({ publishError: { code: 2, message: "Service temporarily unavailable" } })
    const { row } = await startInstagramPublish(input(), deps(), { waitMs: 5_000 })
    expect(row.status).toBe("publishing")
    clock += PUBLISH_CUTOFF_MS + 1
    await finishInstagramPublishes(deps(), { deadline: clock + 60_000 })
    expect(stored(row.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/took too long/) })
    expect(publishCalls()).toBe(1)
    expect((await instagramState()).posts).toHaveLength(0)
  })

  it("fails a row a dead function left queued (nothing went out), and skips rows someone holds", async () => {
    const dead = await store.instagramPublish.create({ data: { status: "queued", claimedAt: new Date(clock - LEASE_MS - 1), deckId: deck.id, mediaType: "IMAGE", slideIds: ["slide1"] } })
    const held = await store.instagramPublish.create({ data: { status: "containers", claimedAt: new Date(clock - 1_000), deckId: deck.id } })
    const counts = await finishInstagramPublishes(deps(), { deadline: clock + 60_000 })
    expect(counts).toMatchObject({ failed: 1, busy: 1 })
    expect(stored(dead.id as string)).toMatchObject({ status: "failed", error: expect.stringMatching(/nothing was posted/) })
    expect(stored(held.id as string)).toMatchObject({ status: "containers" })
    expect(store.notes[0].content).toMatch(/^Couldn't post “GM 2 recap” as a post on Instagram: It stopped before/)
  })

  it("keeps a row whose check failed for the next run, saying so on it", async () => {
    const row = await store.instagramPublish.create({ data: { status: "containers", imageUrls: ["https://x"], containerIds: { items: ["17800000000000099"], carousel: null, aiGenerated: false, publishAttemptAt: null } } })
    const broken = deps()
    broken.client = { ...broken.client, containerStatus: () => Promise.reject(new TypeError("fetch failed")) }
    const counts = await finishInstagramPublishes(broken, { deadline: clock + 60_000 })
    expect(counts.errors).toEqual(["fetch failed"])
    expect(stored(row.id as string)).toMatchObject({ status: "containers", claimedAt: null, error: expect.stringMatching(/^The last check with Instagram failed \(fetch failed\)/) })
  })
})
