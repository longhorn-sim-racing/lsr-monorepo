import { beforeEach, describe, expect, it, vi } from "vitest"

const decks = vi.hoisted(() => ({ getDeck: vi.fn() }))
vi.mock("@/server/jack/decks/service", async (original) => ({ ...(await original<typeof import("@/server/jack/decks/service")>()), getDeck: decks.getDeck }))
vi.mock("@/server/db", () => ({ prisma: {} }))

import { pickSlides, slidesById, slidesLabel, slideSource, slideThumbUrl } from "./slides"

const DECK = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "GM 2 recap",
  size: "post" as const,
  version: 4,
  roomId: "room-1",
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  content: { css: ".x{}", slides: ["a", "b", "c"].map((id) => ({ id: `slide-${id}`, html: `<section>${id}</section>` })) },
}

beforeEach(() => {
  decks.getDeck.mockReset()
  decks.getDeck.mockImplementation(async (id: string, version?: number) => (id === DECK.id && (version === undefined || version === 4) ? DECK : null))
})

describe("pickSlides", () => {
  it("picks every slide by default, or the numbers given in that order, at the version asked for", async () => {
    expect(await pickSlides(DECK.id)).toMatchObject({ deck: { version: 4 }, slides: [{ id: "slide-a", n: 1 }, { id: "slide-b", n: 2 }, { id: "slide-c", n: 3 }] })
    expect(await pickSlides(DECK.id, { version: 4, numbers: [3, 1] })).toMatchObject({ slides: [{ id: "slide-c", n: 3 }, { id: "slide-a", n: 1 }] })
    expect(decks.getDeck).toHaveBeenLastCalledWith(DECK.id, 4)
  })

  it("explains a missing deck, version or slide, and a slide listed twice, for Jack", async () => {
    expect(await pickSlides("nope")).toEqual({ error: "There's no deck with id nope. Call deck_view with no deck to list them." })
    expect(await pickSlides(DECK.id, { version: 9 })).toEqual({ error: `Deck ${DECK.id} has no version 9. Call deck_view to see its versions.` })
    expect(await pickSlides(DECK.id, { numbers: [2, 5, 6] })).toEqual({ error: "“GM 2 recap” (version 4) has 3 slides; there's no slide 5-6." })
    expect(await pickSlides(DECK.id, { numbers: [1, 1] })).toEqual({ error: "Slide 1 is listed twice." })
  })

  it("finds the same slides again by id at apply time, or null when one is gone", async () => {
    expect(await slidesById(DECK.id, 4, ["slide-b"])).toMatchObject({ slides: [{ id: "slide-b", n: 2 }] })
    expect(await slidesById(DECK.id, 4, ["slide-b", "slide-z"])).toBeNull()
    expect(await slidesById(DECK.id, 9, ["slide-b"])).toBeNull()
  })

  it("names renders, thumbnails and slide ranges the way the deck pages do", () => {
    expect(slideSource(DECK, DECK.content.slides[0])).toEqual({ size: "post", css: ".x{}", html: "<section>a</section>", roomId: "room-1" })
    expect(slideThumbUrl(DECK, "slide-a")).toBe(`/api/admin/jack/decks/${DECK.id}/slides/slide-a?v=4&kind=thumb`)
    expect(slidesLabel([{ n: 1 }, { n: 2 }, { n: 4 }])).toBe("slides 1-2 and 4")
    expect(slidesLabel([{ n: 3 }])).toBe("slide 3")
  })
})
