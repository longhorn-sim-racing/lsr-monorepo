import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ galleryAlbum: { findFirst: vi.fn() }, jackMessage: { create: vi.fn() } }))
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
const connector = vi.hoisted(() => ({ client: vi.fn() }))
const slides = vi.hoisted(() => ({ slidesById: vi.fn() }))
const flow = vi.hoisted(() => ({ startInstagramPublish: vi.fn(), publishDeps: vi.fn((client: unknown) => ({ client })) }))
const gallery = vi.hoisted(() => ({ addToGallery: vi.fn() }))
const broadcast = vi.hoisted(() => ({ broadcastRoomEvent: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("next/cache", () => cache)
vi.mock("@/server/connectors/instagram/publish-connector", () => ({ instagramPublishConnector: connector }))
vi.mock("@/server/jack/publish/slides", () => slides)
vi.mock("@/server/jack/publish/instagram", async (original) => ({ ...(await original<typeof import("@/server/jack/publish/instagram")>()), ...flow }))
vi.mock("@/server/jack/publish/gallery", async (original) => ({ ...(await original<typeof import("@/server/jack/publish/gallery")>()), ...gallery }))
vi.mock("@/server/jack/broadcast", () => broadcast)
vi.mock("@/server/jack/messages", () => ({ jackMessageInclude: {}, toMessageView: (row: unknown) => row }))
vi.mock("@/server/jack/decks/renders", () => ({ getRenderFile: vi.fn() }))

import { PublishRefused, PublishRepeat } from "@/server/jack/publish/instagram"
import { addDeckToGallery, publishDeckToInstagram, readInstagramQuota } from "./publish-actions"

const DECK_ID = "11111111-1111-4111-8111-111111111111"
const deck = { id: DECK_ID, title: "GM 2 recap", size: "post", version: 3, roomId: "room-1", content: { css: "", slides: [] } }
const picked = (ids: string[]) => ({ deck, slides: ids.map((id, i) => ({ id, html: "<section/>", n: i + 1 })) })
const client = { quota: vi.fn(), username: "lsr_fake" }

beforeEach(() => {
  vi.clearAllMocks()
  guards.requireOfficer.mockResolvedValue({ id: "u1", displayName: "Gray" })
  connector.client.mockResolvedValue(client)
  client.quota.mockResolvedValue({ used: 3, total: 50 })
  slides.slidesById.mockImplementation(async (_deck: string, _version: number, ids: string[]) => picked(ids))
  db.jackMessage.create.mockImplementation(async ({ data }: { data: unknown }) => data)
  db.galleryAlbum.findFirst.mockResolvedValue(null)
})

describe("Publish to Instagram on the deck page", () => {
  it("posts the officer's pick right away (their press is the approval), audited as from the deck page, with a room note", async () => {
    flow.startInstagramPublish.mockResolvedValue({ state: "published", row: { id: "pub-1", mediaType: "CAROUSEL", slideIds: ["slideaaa", "slidebbb"], status: "published", error: null, permalink: "https://www.instagram.com/p/X/" } })
    const result = await publishDeckToInstagram({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa", "slidebbb"], type: "carousel", caption: " GM 2! ", aiLabel: true })
    expect(result).toEqual({ ok: true, data: { state: "published", permalink: "https://www.instagram.com/p/X/", summary: "Posted “GM 2 recap” as a carousel of 2 slides on Instagram." } })
    expect(flow.startInstagramPublish.mock.calls[0][0]).toMatchObject({ type: "carousel", caption: "GM 2!", aiGenerated: true, createdById: "u1", approvedById: "u1", auditMetadata: { via: "deck_page", deckId: DECK_ID, version: 3 }, refuseRepeat: true })
    expect(flow.startInstagramPublish.mock.calls[0][0].proposalId).toBeUndefined()
    expect(db.jackMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: { roomId: "room-1", kind: "system", authorUserId: "u1", content: "Gray on the deck page: Posted “GM 2 recap” as a carousel of 2 slides on Instagram. → /admin/instagram#publishing" } }))
    expect(broadcast.broadcastRoomEvent).toHaveBeenCalledWith("room-1", expect.anything())
  })

  it("refuses a pick that doesn't fit the type, a caption Instagram won't take, and publishing that's off", async () => {
    expect(await publishDeckToInstagram({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa", "slidebbb"], type: "post" })).toEqual({ ok: false, error: "A post is one slide; 2 are picked." })
    expect(await publishDeckToInstagram({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], type: "carousel" })).toEqual({ ok: false, error: "A carousel takes 2 to 20 slides; 1 is picked." })
    expect(await publishDeckToInstagram({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], type: "post", caption: "#a ".repeat(31) })).toMatchObject({ ok: false, error: expect.stringMatching(/at most 30 hashtags/) })
    expect(await publishDeckToInstagram({ deckId: "not-a-uuid", version: 3, slideIds: ["slideaaa"], type: "post" })).toMatchObject({ ok: false })
    connector.client.mockResolvedValue(null)
    expect(await publishDeckToInstagram({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], type: "post" })).toMatchObject({ ok: false, error: expect.stringMatching(/isn't switched on/) })
    slides.slidesById.mockResolvedValue(null)
    expect(await publishDeckToInstagram({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], type: "post" })).toMatchObject({ ok: false, error: expect.stringMatching(/doesn't exist anymore/) })
    expect(flow.startInstagramPublish).not.toHaveBeenCalled()
  })

  it("sends a story without its caption, and says nothing was posted when a limit stops it", async () => {
    flow.startInstagramPublish.mockRejectedValue(new PublishRefused("Instagram's limit of 50 API posts a day is used up (50 in the last 24 hours). Try again tomorrow."))
    expect(await publishDeckToInstagram({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], type: "story", caption: "dropped", altText: "dropped" })).toEqual({ ok: false, error: "Instagram's limit of 50 API posts a day is used up (50 in the last 24 hours). Try again tomorrow. Nothing was posted." })
    expect(flow.startInstagramPublish.mock.calls[0][0]).toMatchObject({ type: "story", caption: "", altText: undefined })
  })

  it("refuses the same pick again while it's on its way or just went out, unless the officer confirms posting it again", async () => {
    flow.startInstagramPublish.mockRejectedValueOnce(new PublishRepeat("These slides already went to Instagram as a carousel at Oct 23, 3:04 PM (Instagram is processing). See Content → Instagram.", "pub-1"))
    const pick = { deckId: DECK_ID, version: 3, slideIds: ["slideaaa", "slidebbb"], type: "carousel" as const, caption: "GM 2!" }
    expect(await publishDeckToInstagram(pick)).toEqual({
      ok: false,
      error: "These slides already went to Instagram as a carousel at Oct 23, 3:04 PM (Instagram is processing). See Content → Instagram. Nothing new was posted.",
      repeat: true,
    })
    expect(db.jackMessage.create).not.toHaveBeenCalled()

    flow.startInstagramPublish.mockResolvedValueOnce({ state: "waiting", row: { id: "pub-2", mediaType: "CAROUSEL", slideIds: ["slideaaa", "slidebbb"], status: "containers", error: null, permalink: null } })
    expect(await publishDeckToInstagram({ ...pick, again: true })).toMatchObject({ ok: true, data: { state: "waiting" } })
    expect(flow.startInstagramPublish.mock.calls.map(([request]) => request.refuseRepeat)).toEqual([true, false])
  })

  it("reads the quota for the dialog, or null when publishing is off", async () => {
    expect(await readInstagramQuota()).toEqual({ ok: true, data: { used: 3, total: 50, account: "lsr_fake" } })
    connector.client.mockResolvedValue(null)
    expect(await readInstagramQuota()).toEqual({ ok: true, data: null })
  })
})

describe("Permissions", () => {
  it("refuses anyone who isn't an officer before any work: nothing posted, added or read from Instagram", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("Forbidden"))
    await expect(publishDeckToInstagram({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], type: "post" })).rejects.toThrow("Forbidden")
    await expect(addDeckToGallery({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], album: { kind: "existing", id: "44444444-4444-4444-8444-444444444444" } })).rejects.toThrow("Forbidden")
    await expect(readInstagramQuota()).rejects.toThrow("Forbidden")
    expect(flow.startInstagramPublish).not.toHaveBeenCalled()
    expect(gallery.addToGallery).not.toHaveBeenCalled()
    expect(connector.client).not.toHaveBeenCalled()
    expect(slides.slidesById).not.toHaveBeenCalled()
    expect(db.galleryAlbum.findFirst).not.toHaveBeenCalled()
    expect(db.jackMessage.create).not.toHaveBeenCalled()
  })
})

describe("Add to gallery on the deck page", () => {
  it("adds the picked slides to an existing album, with a room note", async () => {
    gallery.addToGallery.mockResolvedValue({ album: { id: "a1", title: "GM 2", slug: "gm-2", created: false }, added: [{ rowId: "slide:slideaaa", imageId: "i1" }], already: [], missing: [] })
    const ALBUM = "44444444-4444-4444-8444-444444444444"
    expect(await addDeckToGallery({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], album: { kind: "existing", id: ALBUM } })).toEqual({ ok: true, data: { summary: "Added 1 image to the gallery album “GM 2”.", added: 1 } })
    expect(gallery.addToGallery.mock.calls[0][0]).toMatchObject({ target: { albumId: ALBUM }, actorUserId: "u1", auditMetadata: { via: "deck_page", deckId: DECK_ID, version: 3 }, items: [{ rowId: "slide:slideaaa", kind: "slide", alt: "GM 2 recap, slide 1" }] })
    expect(db.jackMessage.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ content: "Gray on the deck page: Added 1 image to the gallery album “GM 2”. → /admin/gallery" }) }))
  })

  it("makes a new album, unless one has that title", async () => {
    gallery.addToGallery.mockResolvedValue({ album: { id: "a2", title: "GM 2 graphics", slug: "gm-2-graphics", created: true }, added: [], already: [{ rowId: "slide:slideaaa", albumTitle: null }], missing: [] })
    expect(await addDeckToGallery({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], album: { kind: "new", title: "GM 2 graphics", date: "2026-10-19" }, alt: "Recap" })).toMatchObject({ ok: true, data: { added: 0 } })
    expect(gallery.addToGallery.mock.calls[0][0]).toMatchObject({ target: { newAlbum: { title: "GM 2 graphics", date: "2026-10-19" } }, items: [{ alt: "Recap" }] })
    // Nothing added: no note
    expect(db.jackMessage.create).not.toHaveBeenCalled()

    db.galleryAlbum.findFirst.mockResolvedValue({ id: "a2" })
    expect(await addDeckToGallery({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], album: { kind: "new", title: "gm 2 GRAPHICS" } })).toEqual({ ok: false, error: "An album called “gm 2 GRAPHICS” already exists. Pick it from the list instead." })
    expect(await addDeckToGallery({ deckId: DECK_ID, version: 3, slideIds: ["slideaaa"], album: { kind: "new", title: " " } })).toEqual({ ok: false, error: "Give the new album a title" })
  })
})
