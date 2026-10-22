import { Prisma } from "@prisma/client"
import {
  MAX_DECK_CSS,
  MAX_DECK_SLIDES,
  MAX_SLIDE_HTML,
  MAX_SLIDE_NOTES,
  parseDeckContent,
  type JackDeckContent,
  type JackDeckSizeKey,
  type JackSlideData,
} from "@/lib/jack/decks"
import { prisma } from "@/server/db"

/**
 * Jack's decks (#177): create one, read it (now or at an earlier version), and change it. Every change
 * writes a new JackDeckVersion with the whole deck and moves JackDeck.version to it, inside one
 * transaction that locks the deck row, so two rooms editing one deck can't lose each other's changes.
 * A change that leaves the deck as it was writes nothing.
 */

export type DeckView = {
  id: string
  title: string
  size: JackDeckSizeKey
  version: number
  roomId: string | null
  createdById: string | null
  createdAt: Date
  updatedAt: Date
  content: JackDeckContent
}

/** Who a change is for, and what it did ("Wrote slides 1-4"; a function is asked after the change is worked out) */
export type DeckChangeMeta = { userId: string | null; messageId?: string | null; summary: string | (() => string) }

const summaryOf = (meta: DeckChangeMeta) => (typeof meta.summary === "function" ? meta.summary() : meta.summary)

/** Checks a deck's content against the limits; the message is written for Jack */
export function deckContentProblem(content: JackDeckContent): string | null {
  if (content.slides.length > MAX_DECK_SLIDES) return `A deck can have at most ${MAX_DECK_SLIDES} slides; this would have ${content.slides.length}.`
  if (content.css.length > MAX_DECK_CSS) return `The deck CSS can be at most ${MAX_DECK_CSS.toLocaleString("en-US")} characters; this is ${content.css.length.toLocaleString("en-US")}.`
  for (const [i, slide] of content.slides.entries()) {
    if (slide.html.length > MAX_SLIDE_HTML) return `Slide ${i + 1} is ${slide.html.length.toLocaleString("en-US")} characters of HTML; the most is ${MAX_SLIDE_HTML.toLocaleString("en-US")}. Move shared styles into the deck CSS.`
    if ((slide.notes ?? "").length > MAX_SLIDE_NOTES) return `Slide ${i + 1}'s notes are longer than ${MAX_SLIDE_NOTES.toLocaleString("en-US")} characters.`
  }
  return null
}

function sameContent(a: JackDeckContent, b: JackDeckContent): boolean {
  return (
    a.css === b.css &&
    a.slides.length === b.slides.length &&
    a.slides.every((slide, i) => slide.id === b.slides[i].id && slide.html === b.slides[i].html && (slide.notes ?? "") === (b.slides[i].notes ?? ""))
  )
}

function toJson(content: JackDeckContent): Prisma.InputJsonValue {
  return { css: content.css, slides: content.slides.map((s) => ({ id: s.id, html: s.html, ...(s.notes ? { notes: s.notes } : {}) })) }
}

export async function createDeck(input: {
  title: string
  size: JackDeckSizeKey
  roomId: string | null
  content: JackDeckContent
  meta: DeckChangeMeta
}): Promise<{ ok: true; deck: DeckView } | { ok: false; error: string }> {
  const problem = deckContentProblem(input.content)
  if (problem) return { ok: false, error: problem }
  const deck = await prisma.jackDeck.create({
    data: {
      title: input.title,
      size: input.size,
      version: 1,
      roomId: input.roomId,
      createdById: input.meta.userId,
      versions: {
        create: { version: 1, summary: summaryOf(input.meta), content: toJson(input.content), messageId: input.meta.messageId ?? null, userId: input.meta.userId },
      },
    },
  })
  return { ok: true, deck: { ...deck, size: deck.size as JackDeckSizeKey, content: input.content } }
}

/** A deck as it is now, or at `version`. Null when there's no such deck or version */
export async function getDeck(id: string, version?: number): Promise<DeckView | null> {
  const deck = await prisma.jackDeck.findUnique({ where: { id } })
  if (!deck) return null
  const at = version ?? deck.version
  const row = await prisma.jackDeckVersion.findUnique({ where: { deckId_version: { deckId: id, version: at } }, select: { content: true } })
  if (!row) return null
  return { ...deck, version: at, size: deck.size as JackDeckSizeKey, content: parseDeckContent(row.content) }
}

export type DeckChange =
  | { ok: true; deck: DeckView; before: JackDeckContent; changed: boolean }
  | { ok: false; error: string }

/**
 * Changes a deck: `mutate` gets the current content and title and returns the new ones (or an error
 * for Jack). Runs in a transaction with the deck row locked; writes a version only if something changed
 */
export async function changeDeck(
  id: string,
  meta: DeckChangeMeta,
  mutate: (current: { content: JackDeckContent; title: string; size: JackDeckSizeKey }) => { content: JackDeckContent; title?: string } | { error: string }
): Promise<DeckChange> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; title: string; size: string; version: number }[]>`
      SELECT id, title, size::text AS size, version FROM "JackDeck" WHERE id = ${id} FOR UPDATE`
    const deck = locked[0]
    if (!deck) return { ok: false as const, error: `There's no deck with id ${id}. Call deck_view with no deck to list them.` }
    const row = await tx.jackDeckVersion.findUnique({ where: { deckId_version: { deckId: id, version: deck.version } }, select: { content: true } })
    const before = parseDeckContent(row?.content)
    const size = deck.size as JackDeckSizeKey

    const next = mutate({ content: before, title: deck.title, size })
    if ("error" in next) return { ok: false as const, error: next.error }
    const problem = deckContentProblem(next.content)
    if (problem) return { ok: false as const, error: problem }

    const title = next.title?.trim() || deck.title
    const full = await tx.jackDeck.findUniqueOrThrow({ where: { id } })
    if (sameContent(before, next.content) && title === deck.title) {
      return { ok: true as const, changed: false, before, deck: { ...full, size, content: before } }
    }

    const version = deck.version + 1
    await tx.jackDeckVersion.create({
      data: { deckId: id, version, summary: summaryOf(meta), content: toJson(next.content), messageId: meta.messageId ?? null, userId: meta.userId },
    })
    const updated = await tx.jackDeck.update({ where: { id }, data: { version, title } })
    return { ok: true as const, changed: true, before, deck: { ...updated, size, content: next.content } }
  })
}

export type DeckSummary = {
  id: string
  title: string
  size: JackDeckSizeKey
  version: number
  slides: number
  firstSlideId: string | null
  roomId: string | null
  roomTitle: string | null
  createdByName: string | null
  createdAt: Date
  updatedAt: Date
}

/** Decks newest first, optionally only one room's */
export async function listDecks({ roomId, take = 50 }: { roomId?: string; take?: number } = {}): Promise<DeckSummary[]> {
  const decks = await prisma.jackDeck.findMany({
    where: roomId ? { roomId } : {},
    orderBy: { updatedAt: "desc" },
    take,
    include: { room: { select: { title: true } }, createdBy: { select: { displayName: true } } },
  })
  if (!decks.length) return []
  const current = await prisma.jackDeckVersion.findMany({
    where: { OR: decks.map((d) => ({ deckId: d.id, version: d.version })) },
    select: { deckId: true, content: true },
  })
  const contentOf = new Map(current.map((row) => [row.deckId, parseDeckContent(row.content)]))
  return decks.map((d) => {
    const content = contentOf.get(d.id)
    return {
      id: d.id,
      title: d.title,
      size: d.size as JackDeckSizeKey,
      version: d.version,
      slides: content?.slides.length ?? 0,
      firstSlideId: content?.slides[0]?.id ?? null,
      roomId: d.roomId,
      roomTitle: d.room ? (d.room.title ?? "Untitled room") : null,
      createdByName: d.createdBy?.displayName ?? null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }
  })
}

export type DeckVersionSummary = { version: number; summary: string; slides: number; createdAt: Date; byName: string | null; messageId: string | null }

/** A deck's versions, newest first */
export async function listDeckVersions(id: string, take = 50): Promise<DeckVersionSummary[]> {
  const rows = await prisma.jackDeckVersion.findMany({
    where: { deckId: id },
    orderBy: { version: "desc" },
    take,
    select: { version: true, summary: true, content: true, createdAt: true, messageId: true, user: { select: { displayName: true } } },
  })
  return rows.map((row) => ({
    version: row.version,
    summary: row.summary,
    slides: parseDeckContent(row.content).slides.length,
    createdAt: row.createdAt,
    byName: row.user?.displayName ?? null,
    messageId: row.messageId,
  }))
}

/** Restores an earlier version as a new one (undo). The slides keep their ids, so their renders are reused */
export async function restoreDeckVersion(id: string, version: number, meta: Omit<DeckChangeMeta, "summary">): Promise<DeckChange> {
  const old = await prisma.jackDeckVersion.findUnique({ where: { deckId_version: { deckId: id, version } }, select: { content: true } })
  if (!old) return { ok: false, error: `Deck ${id} has no version ${version}.` }
  const content = parseDeckContent(old.content)
  return changeDeck(id, { ...meta, summary: `Restored version ${version}` }, () => ({ content }))
}

/** Slides in order with their 1-based numbers, for messages */
export function numbered(slides: JackSlideData[]): { n: number; slide: JackSlideData }[] {
  return slides.map((slide, i) => ({ n: i + 1, slide }))
}

/** "1", "1-3" or "1, 3 and 5-6" */
export function slideRange(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  const runs: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j
  }
  return runs.length <= 1 ? (runs[0] ?? "") : `${runs.slice(0, -1).join(", ")} and ${runs.at(-1)}`
}
