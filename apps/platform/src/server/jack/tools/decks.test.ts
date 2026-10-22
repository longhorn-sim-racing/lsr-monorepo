import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { JackDeckDisplay } from "@/lib/jack/parts"
import type { JackToolContext } from "./types"

/*
 * The deck tools against an in-memory stand-in for the deck tables, with rendering faked: a slide whose
 * HTML says TOO-TALL gets a layout problem, every other slide comes back clean.
 */

type DeckRow = { id: string; title: string; size: string; version: number; roomId: string | null; createdById: string | null; createdAt: Date; updatedAt: Date }
type VersionRow = { deckId: string; version: number; summary: string; content: unknown; messageId: string | null; userId: string | null; createdAt: Date }

const db = vi.hoisted(() => ({ decks: new Map<string, DeckRow>(), versions: [] as VersionRow[], clock: 0 }))

vi.mock("@/server/db", () => {
  const tick = () => new Date(Date.UTC(2026, 9, 21, 20, 0, db.clock++))
  const prisma = {
    jackDeck: {
      async create({ data }: { data: Omit<DeckRow, "id" | "createdAt" | "updatedAt"> & { versions: { create: Omit<VersionRow, "deckId" | "createdAt"> } } }) {
        const { versions, ...fields } = data
        const row: DeckRow = { ...fields, id: randomUUID(), createdAt: tick(), updatedAt: tick() }
        db.decks.set(row.id, row)
        db.versions.push({ ...versions.create, deckId: row.id, createdAt: tick() })
        return { ...row }
      },
      async findUnique({ where }: { where: { id: string } }) {
        const row = db.decks.get(where.id)
        return row ? { ...row } : null
      },
      async findUniqueOrThrow({ where }: { where: { id: string } }) {
        const row = db.decks.get(where.id)
        if (!row) throw new Error("not found")
        return { ...row }
      },
      async update({ where, data }: { where: { id: string }; data: Partial<DeckRow> }) {
        const row = db.decks.get(where.id)!
        Object.assign(row, data, { updatedAt: tick() })
        return { ...row }
      },
      async findMany({ where, take }: { where: { roomId?: string }; take: number }) {
        return [...db.decks.values()]
          .filter((d) => !where.roomId || d.roomId === where.roomId)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, take)
          .map((d) => ({ ...d, room: d.roomId ? { title: "GM planning" } : null, createdBy: null }))
      },
    },
    jackDeckVersion: {
      async findUnique({ where }: { where: { deckId_version: { deckId: string; version: number } } }) {
        const { deckId, version } = where.deckId_version
        return db.versions.find((v) => v.deckId === deckId && v.version === version) ?? null
      },
      async create({ data }: { data: Omit<VersionRow, "createdAt"> }) {
        if (db.versions.some((v) => v.deckId === data.deckId && v.version === data.version)) throw new Error("unique violation")
        const row = { ...data, createdAt: tick() }
        db.versions.push(row)
        return row
      },
      async findMany({ where }: { where: { deckId?: string; OR?: { deckId: string; version: number }[] } }) {
        const rows = where.OR
          ? db.versions.filter((v) => where.OR!.some((w) => w.deckId === v.deckId && w.version === v.version))
          : db.versions.filter((v) => v.deckId === where.deckId).sort((a, b) => b.version - a.version)
        return rows.map((v) => ({ ...v, user: null }))
      },
    },
    async $transaction(work: (tx: unknown) => Promise<unknown>) {
      return work(prisma)
    },
    async $queryRaw(_strings: TemplateStringsArray, id: string) {
      const row = db.decks.get(id)
      return row ? [{ id: row.id, title: row.title, size: row.size, version: row.version }] : []
    },
  }
  return { prisma }
})

vi.mock("@/server/jack/decks/renders", () => ({
  ensureRender: vi.fn(async (source: { html: string }, options?: { withView?: boolean }) => ({
    key: "k",
    issues: source.html.includes("TOO-TALL") ? ["The content is 81px taller than the slide, so the bottom is cut off."] : [],
    view: options?.withView ? Buffer.from(`img:${source.html}`) : undefined,
    cached: false,
    ms: 1,
  })),
}))

vi.mock("@/server/jack/decks/assets", async (original) => ({
  ...(await original<typeof import("@/server/jack/decks/assets")>()),
  findGalleryAssets: vi.fn(async () => ({
    assets: [{ url: "https://res.cloudinary.com/demo/image/upload/c_limit,w_2000,h_2000,q_auto:good/gallery/cota/1", about: "Members at COTA; album \"COTA trip\"", width: 2400, height: 1600, group: "gallery", album: "COTA trip" }],
    albums: [{ title: "COTA trip", slug: "cota-trip", photos: 12, date: "2026-09-20" }],
  })),
}))

import { ensureRender } from "@/server/jack/decks/renders"
import { deckArrangeTool, deckAssetsTool, deckCreateTool, deckEditTool, deckGuideTool, deckRenderTool, deckRestoreTool, deckViewTool, deckWriteTool } from "./decks"

const ctx: JackToolContext = { roomId: "room-1", messageId: "reply-1", actor: { userId: "officer-gray", displayName: "Gray" } }
const slide = (text: string) => `<section class="slide dark"><h2 class="title">${text}</h2></section>`

async function newDeck(slides = [slide("One"), slide("Two")]) {
  const out = await deckCreateTool.run({ title: "GM 2", size: "slides", slides: slides.map((html) => ({ html })) }, ctx)
  const id = /id ([0-9a-f-]{36})/.exec(out.forModel)![1]
  return { id, out }
}

const contentOf = (id: string, version?: number) => {
  const deck = db.decks.get(id)!
  return db.versions.find((v) => v.deckId === id && v.version === (version ?? deck.version))!.content as { css: string; slides: { id: string; html: string; notes?: string }[] }
}

beforeEach(() => {
  db.decks.clear()
  db.versions.length = 0
  vi.mocked(ensureRender).mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("deck_create", () => {
  it("creates the deck with its first slides as version 1, checks them, and links the deck page", async () => {
    const { id, out } = await newDeck()
    expect(out.isError).toBeUndefined()
    expect(out.label).toBe("Created “GM 2” (2 slides)")
    expect(out.forModel).toContain(`Deck "GM 2" (id ${id}): 16:9 slides, 1920×1080, 2 slides, version 1. Link: http://localhost:3000/admin/jack/decks/${id}`)
    expect(out.forModel).toContain("Layout checks:\n- Slides 1-2: no layout problems found.")
    const display = out.displays![0] as JackDeckDisplay
    expect(display).toMatchObject({ kind: "deck", deckId: id, title: "GM 2", size: "slides", version: 1 })
    expect(display.focus).toEqual(display.slideIds)
    expect(db.decks.get(id)).toMatchObject({ roomId: "room-1", createdById: "officer-gray", version: 1 })
    expect(db.versions[0]).toMatchObject({ version: 1, summary: "Created with 2 slides", messageId: "reply-1", userId: "officer-gray" })
  })
})

describe("deck_write", () => {
  it("adds slides, saves a version, and reports only the new slides' checks", async () => {
    const { id } = await newDeck()
    vi.mocked(ensureRender).mockClear()
    const out = await deckWriteTool.run({ deck: id, slides: [{ slide: 3, html: slide("Three TOO-TALL"), notes: "From standings" }] }, ctx)
    expect(out.label).toBe("Wrote slide 3 of “GM 2”")
    expect(out.forModel).toContain("- Slide 3: The content is 81px taller than the slide")
    expect(ensureRender).toHaveBeenCalledTimes(1)
    expect(contentOf(id).slides.map((s) => s.notes ?? null)).toEqual([null, null, "From standings"])
    expect(db.versions.at(-1)).toMatchObject({ version: 2, summary: "Wrote slide 3" })
  })

  it("re-checks every slide when the deck CSS changes", async () => {
    const { id } = await newDeck()
    vi.mocked(ensureRender).mockClear()
    const out = await deckWriteTool.run({ deck: id, css: ".big{font-size:120px}" }, ctx)
    expect(out.label).toBe("Restyled “GM 2”")
    expect(ensureRender).toHaveBeenCalledTimes(2)
    expect(contentOf(id).css).toBe(".big{font-size:120px}")
  })

  it("writes nothing when nothing changes", async () => {
    const { id } = await newDeck()
    const out = await deckWriteTool.run({ deck: id, slides: [{ slide: 1, html: slide("One") }] }, ctx)
    expect(out.forModel).toContain("Nothing changed")
    expect(db.decks.get(id)!.version).toBe(1)
  })

  it("explains a bad write without changing the deck", async () => {
    const { id } = await newDeck()
    const out = await deckWriteTool.run({ deck: id, slides: [{ slide: 5, html: slide("Five") }] }, ctx)
    expect(out).toMatchObject({ isError: true, label: "Slides not written" })
    expect(out.forModel).toContain("the deck has 2 slides")
    expect(db.decks.get(id)!.version).toBe(1)
  })

  it("says when there's no such deck", async () => {
    const out = await deckWriteTool.run({ deck: randomUUID(), slides: [{ slide: 1, html: slide("x") }] }, ctx)
    expect(out).toMatchObject({ isError: true })
    expect(out.forModel).toMatch(/There's no deck with id .* Call deck_view with no deck to list them/)
  })
})

describe("deck_edit", () => {
  it("finds and replaces in a slide and checks just that slide", async () => {
    const { id } = await newDeck()
    vi.mocked(ensureRender).mockClear()
    const out = await deckEditTool.run({ deck: id, edits: [{ slide: 2, find: "Two", replace: "Second" }] }, ctx)
    expect(out.label).toBe("Edited slide 2 of “GM 2”")
    expect(contentOf(id).slides[1].html).toBe(slide("Second"))
    expect(ensureRender).toHaveBeenCalledTimes(1)
    expect((out.displays![0] as JackDeckDisplay).version).toBe(2)
  })

  it("applies all of the edits or none of them", async () => {
    const { id } = await newDeck()
    const out = await deckEditTool.run({ deck: id, edits: [{ slide: 1, find: "One", replace: "First" }, { slide: 2, find: "missing", replace: "x" }] }, ctx)
    expect(out).toMatchObject({ isError: true, label: "Edit not made" })
    expect(contentOf(id).slides[0].html).toBe(slide("One"))
  })
})

describe("deck_arrange", () => {
  it("reorders and renames", async () => {
    const { id } = await newDeck()
    const before = contentOf(id).slides.map((s) => s.id)
    const out = await deckArrangeTool.run({ deck: id, order: [2, 1], title: "GM 2 deck" }, ctx)
    expect(out.label).toBe("Reordered the slides and renamed the deck to “GM 2 deck”")
    expect(db.versions.at(-1)).toMatchObject({ summary: "Reordered the slides and renamed the deck to “GM 2 deck”" })
    expect(contentOf(id).slides.map((s) => s.id)).toEqual([before[1], before[0]])
    expect(db.decks.get(id)!.title).toBe("GM 2 deck")
  })

  it("deletes and duplicates", async () => {
    const { id } = await newDeck([slide("A"), slide("B"), slide("C")])
    const out = await deckArrangeTool.run({ deck: id, order: [1, 1, 3] }, ctx)
    expect(out.forModel).toContain("Done: Deleted 1 slide, duplicated 1. Slides are now numbered in their new order.")
    expect(out.label).toBe("Deleted 1 slide, duplicated 1 in “GM 2”")
    expect(contentOf(id).slides.map((s) => s.html)).toEqual([slide("A"), slide("A"), slide("C")])
  })
})

describe("deck_view", () => {
  it("lists recent decks with their ids when no deck is given", async () => {
    const { id } = await newDeck()
    const out = await deckViewTool.run({}, ctx)
    expect(out.forModel).toContain(`- "GM 2" id ${id}: 16:9 slides, 2 slides, version 1, updated `)
  })

  it("shows the CSS, each slide's HTML and notes, and the versions", async () => {
    const { id } = await newDeck()
    await deckWriteTool.run({ deck: id, slides: [{ slide: 2, notes: "Say the date" }] }, ctx)
    const out = await deckViewTool.run({ deck: id, history: true }, ctx)
    expect(out.forModel).toContain("## Deck CSS\n(none)")
    expect(out.forModel).toContain(`## Slide 2\n${slide("Two")}\nNotes: Say the date`)
    expect(out.forModel).toContain("## Versions (newest first)\n- 2: Wrote slide 2 (2 slides")
    expect(out.forModel).toContain("- 1: Created with 2 slides")
  })
})

describe("deck_render", () => {
  it("shows the model each slide's preview with its checks", async () => {
    const { id } = await newDeck([slide("A"), slide("B TOO-TALL")])
    const out = await deckRenderTool.run({ deck: id }, ctx)
    expect(out.images?.map((i) => i.caption)).toEqual(["Slide 1:", "Slide 2:"])
    expect(Buffer.from(out.images![1].data, "base64").toString()).toBe(`img:${slide("B TOO-TALL")}`)
    expect(out.forModel).toContain("- Slide 1: no layout problems found.\n- Slide 2: The content is 81px taller")
    expect(out.label).toBe("Looked at all 2 slides of “GM 2”")
  })

  it("renders only the slides asked for, and refuses ones that don't exist", async () => {
    const { id } = await newDeck([slide("A"), slide("B"), slide("C")])
    expect((await deckRenderTool.run({ deck: id, slides: [3] }, ctx)).label).toBe("Looked at slide 3 of “GM 2”")
    expect(await deckRenderTool.run({ deck: id, slides: [4] }, ctx)).toMatchObject({ isError: true, forModel: "The deck has 3 slides; there's no slide 4." })
  })
})

describe("deck_restore", () => {
  it("brings back an earlier version as the newest", async () => {
    const { id } = await newDeck()
    await deckEditTool.run({ deck: id, edits: [{ slide: 1, find: "One", replace: "Uno" }] }, ctx)
    const out = await deckRestoreTool.run({ deck: id, version: 1 }, ctx)
    expect(out.forModel).toContain("Restored version 1 as version 3.")
    expect(contentOf(id).slides[0].html).toBe(slide("One"))
    expect(db.versions.at(-1)).toMatchObject({ version: 3, summary: "Restored version 1" })
  })
})

describe("deck_guide and deck_assets", () => {
  it("returns the design guide", async () => {
    const out = await deckGuideTool.run({}, ctx)
    expect(out.forModel).toMatch(/^# LSR slide kit/)
  })

  it("lists the site's images and the gallery's, with sizes and what they show", async () => {
    const out = await deckAssetsTool.run({}, ctx)
    expect(out.forModel).toContain("/images/lsr-hero.webp | 3840×2160 landscape | The club's orange Mercedes GT3")
    expect(out.forModel).toContain("gallery/cota/1 | 2400×1600 landscape | Members at COTA")
    expect(out.forModel).toContain("Gallery albums: COTA trip (12 photos, 2026-09-20).")
  })
})
