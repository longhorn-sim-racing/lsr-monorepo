import { beforeEach, describe, expect, it, vi } from "vitest"

const decks = vi.hoisted(() => ({ getDeck: vi.fn() }))
const connector = vi.hoisted(() => ({ client: vi.fn() }))
const flow = vi.hoisted(() => ({ startInstagramPublish: vi.fn(), publishDeps: vi.fn((client: unknown) => ({ client })) }))
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/decks/service", async (original) => ({ ...(await original<typeof import("@/server/jack/decks/service")>()), getDeck: decks.getDeck }))
vi.mock("@/server/connectors/instagram/publish-connector", () => ({ instagramPublishConnector: connector }))
vi.mock("@/server/jack/publish/instagram", async (original) => ({ ...(await original<typeof import("@/server/jack/publish/instagram")>()), ...flow }))

import { PublishRefused } from "@/server/jack/publish/instagram"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { instagramPublishKind, instagramPublishSchema, publishTitle } from "./instagram-publish"

const DECK_ID = "11111111-1111-4111-8111-111111111111"
const deckAt = (size: "post" | "slides" | "story" = "post") => ({
  id: DECK_ID,
  title: "GM 2 recap",
  size,
  version: 3,
  roomId: "room-1",
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { css: "", slides: ["a", "b", "c"].map((id) => ({ id: `slide-${id}`, html: `<section>${id}</section>` })) },
})
const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const meta = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: meta })
const payload = (p: Record<string, unknown>) => instagramPublishSchema.parse({ deck: DECK_ID, ...p })
const client = { quota: vi.fn(), username: "lsr_fake" }

beforeEach(() => {
  vi.clearAllMocks()
  decks.getDeck.mockImplementation(async (id: string, version?: number) => (id === DECK_ID && (version === undefined || version === 3) ? deckAt() : null))
  connector.client.mockResolvedValue(client)
  client.quota.mockResolvedValue({ used: 2, total: 50 })
})

describe("instagram.publish: proposing", () => {
  it("describes a carousel on the server: the slides as pictures, the caption, the quota, and a confirm", async () => {
    const prepared = await instagramPublishKind.prepare(payload({ type: "carousel", caption: "GM 2 recap!\n\nThanks @lsr_media #LSR" }), ctx)
    expect(prepared.before).toEqual({ deckId: DECK_ID, version: 3, slideIds: ["slide-a", "slide-b", "slide-c"] })
    expect(prepared.targetId).toBe(DECK_ID)
    expect(prepared.view.title).toBe("Post “GM 2 recap” (slides 1-3) as an Instagram carousel")
    expect(prepared.view.summary).toBe(
      "Applying it posts slides 1-3 of “GM 2 recap” (version 3) as a carousel on the club's Instagram, right away and in public. It can't be taken down from here (delete it in the Instagram app). Caption: 35 characters, 1 hashtag, tagging @lsr_media. It isn't marked as made with AI. Instagram's API posts in the last 24 hours: 2 of 50.",
    )
    expect(prepared.view.images).toEqual(["a", "b", "c"].map((id, i) => ({ url: `/api/admin/jack/decks/${DECK_ID}/slides/slide-${id}?v=3&kind=thumb`, alt: `Slide ${i + 1} of “GM 2 recap”`, label: `Slide ${i + 1}` })))
    expect(prepared.view.preview).toEqual({
      label: "Caption",
      blocks: [
        { t: "p", c: [{ t: "text", v: "GM 2 recap!" }] },
        { t: "p", c: [{ t: "text", v: "Thanks @lsr_media #LSR" }] },
      ],
    })
    expect(prepared.view.links).toEqual([
      { title: "The deck", url: `/admin/jack/decks/${DECK_ID}` },
      { title: "Publish history", url: "/admin/instagram#publishing" },
    ])
    expect(instagramPublishKind).toMatchObject({ tool: "propose_deck_publish", permission: "officer", destructive: true })
  })

  it("says how other shapes fit, the AI label, and that publishing is off when it is", async () => {
    decks.getDeck.mockResolvedValue(deckAt("slides"))
    connector.client.mockResolvedValue(null)
    const prepared = await instagramPublishKind.prepare(payload({ type: "story", slides: [2], aiLabel: true }), ctx)
    expect(prepared.view.title).toBe("Post slide 2 of “GM 2 recap” as an Instagram story")
    expect(prepared.view.summary).toContain("(a story shows for 24 hours)")
    expect(prepared.view.summary).toContain("The slides are 16:9, so each sits whole on a 9:16 image with bars above and below.")
    expect(prepared.view.summary).toContain("It's marked on Instagram as made with AI.")
    expect(prepared.view.summary).toContain("Instagram publishing isn't switched on yet (System → Connections), so applying fails until an admin sets it up.")
    expect(prepared.view.preview).toBeUndefined()
  })

  it("refuses input Jack can fix: the wrong count for the type, a story caption, alt text on a carousel, caption limits, missing slides", async () => {
    const refused = (p: Record<string, unknown>) => instagramPublishKind.prepare(payload(p), ctx)
    await expect(refused({ type: "post" })).rejects.toThrow(new ProposalInputError('A post is one slide; this picks 3. Use type "carousel" for 2-20 slides, or pick one slide.'))
    await expect(refused({ type: "story", slides: [1, 2] })).rejects.toThrow("A story is one slide; this picks 2. Propose one story per slide.")
    await expect(refused({ type: "carousel", slides: [1] })).rejects.toThrow("A carousel takes 2 to 20 slides; this picks 1.")
    await expect(refused({ type: "story", slides: [1], caption: "Hi" })).rejects.toThrow(/Stories don't take a caption/)
    await expect(refused({ type: "carousel", altText: "x" })).rejects.toThrow("altText is for single-image posts only.")
    await expect(refused({ type: "carousel", caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") })).rejects.toThrow(/at most 30 hashtags/)
    await expect(refused({ type: "post", slides: [7] })).rejects.toThrow("“GM 2 recap” (version 3) has 3 slides; there's no slide 7.")
    await expect(refused({ type: "post", slides: [1], version: 8 })).rejects.toThrow(`Deck ${DECK_ID} has no version 8.`)
  })

  it("keeps titles short", () => {
    expect(publishTitle("post", "x".repeat(300), "slide 1").length).toBe(200)
  })
})

describe("instagram.publish: applying", () => {
  const before = { deckId: DECK_ID, version: 3, slideIds: ["slide-c", "slide-a"] }

  it("posts the slides pinned when it was proposed, as the officer who applied it, for the one who asked", async () => {
    flow.startInstagramPublish.mockResolvedValue({ state: "published", row: { id: "pub-1", mediaType: "CAROUSEL", slideIds: ["slide-c", "slide-a"], status: "published", error: null, permalink: "https://www.instagram.com/p/ABC/" } })
    const result = await instagramPublishKind.apply(payload({ type: "carousel", caption: "Hi", aiLabel: true }), applyCtx(before))

    const [request, deps] = flow.startInstagramPublish.mock.calls[0]
    expect(request).toMatchObject({ type: "carousel", caption: "Hi", aiGenerated: true, proposalId: "prop-1", createdById: "u1", approvedById: "u2", auditMetadata: meta })
    expect(request.slides.map((s: { id: string; n: number }) => [s.id, s.n])).toEqual([
      ["slide-c", 3],
      ["slide-a", 1],
    ])
    expect(deps).toEqual({ client })
    expect(result).toEqual({
      summary: "Posted “GM 2 recap” as a carousel of 2 slides on Instagram.",
      links: [
        { title: "The post on Instagram", url: "https://www.instagram.com/p/ABC/" },
        { title: "Publish history", url: "/admin/instagram#publishing" },
      ],
      created: [{ type: "INSTAGRAM_PUBLISH", id: "pub-1" }],
      counts: { slides: 2 },
    })
  })

  it("says when Instagram is still processing it", async () => {
    flow.startInstagramPublish.mockResolvedValue({ state: "waiting", row: { id: "pub-1", mediaType: "IMAGE", slideIds: ["slide-a"], status: "containers", error: null, permalink: null } })
    const result = await instagramPublishKind.apply(payload({ type: "post", slides: [1] }), applyCtx({ ...before, slideIds: ["slide-a"] }))
    expect(result.summary).toMatch(/^Sent “GM 2 recap” as a post to Instagram\. Instagram is still processing the images/)
    expect(result.links).toEqual([{ title: "Publish history", url: "/admin/instagram#publishing" }])
  })

  it("fails before posting when publishing is off, goes stale when the deck is gone, and says nothing was posted on a refusal", async () => {
    connector.client.mockResolvedValue(null)
    await expect(instagramPublishKind.apply(payload({ type: "post", slides: [1] }), applyCtx(before))).rejects.toThrow(/isn't switched on .* nothing was posted/)
    expect(flow.startInstagramPublish).not.toHaveBeenCalled()

    connector.client.mockResolvedValue(client)
    await expect(instagramPublishKind.apply(payload({ type: "post" }), applyCtx({ ...before, version: 9 }))).rejects.toThrow(StaleProposalError)
    await expect(instagramPublishKind.apply(payload({ type: "post" }), applyCtx(null))).rejects.toThrow(StaleProposalError)

    flow.startInstagramPublish.mockRejectedValue(new PublishRefused("Instagram's limit of 50 API posts a day is used up (50 in the last 24 hours). Try again tomorrow."))
    await expect(instagramPublishKind.apply(payload({ type: "post" }), applyCtx(before))).rejects.toThrow("Try again tomorrow. Nothing was posted.")
  })

  it("is stale only when the deck version is gone", async () => {
    expect(await instagramPublishKind.checkStale(payload({ type: "post" }), before)).toBeNull()
    expect(await instagramPublishKind.checkStale(payload({ type: "post" }), { ...before, version: 9 })).toBe("The deck was deleted since this was proposed.")
  })
})
