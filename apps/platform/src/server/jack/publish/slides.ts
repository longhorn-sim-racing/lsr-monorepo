import { slideImageUrl, type JackSlideData } from "@/lib/jack/decks"
import { redactSecrets } from "@/lib/redact"
import type { SlideSource } from "@/server/jack/decks/document"
import { getDeck, slideRange, type DeckView } from "@/server/jack/decks/service"

/**
 * Picking a deck version's slides to publish (#188, design §12.6), shared by the instagram.publish and
 * gallery.add kinds and the deck page's buttons. Slides are picked by number at a version (what Jack
 * and officers see) and kept by id from then on: a version never changes, so what the card showed is
 * exactly what goes out, whatever happens to the deck after.
 */

export type PickedSlide = JackSlideData & { n: number }

export type PickedSlides = { deck: DeckView; slides: PickedSlide[] }

/** The deck at `version` (its current one by default) and the slides by number (every slide by default), or why not, written for Jack */
export async function pickSlides(deckId: string, { version, numbers }: { version?: number; numbers?: number[] } = {}): Promise<PickedSlides | { error: string }> {
  const deck = await getDeck(deckId, version)
  if (!deck) return { error: version ? `Deck ${deckId} has no version ${version}. Call deck_view to see its versions.` : `There's no deck with id ${deckId}. Call deck_view with no deck to list them.` }
  const all = deck.content.slides.map((slide, i) => ({ ...slide, n: i + 1 }))
  if (!all.length) return { error: `“${deck.title}” has no slides yet.` }
  if (!numbers?.length) return { deck, slides: all }
  const missing = numbers.filter((n) => n < 1 || n > all.length)
  if (missing.length) return { error: `“${deck.title}” (version ${deck.version}) has ${all.length} slide${all.length === 1 ? "" : "s"}; there's no slide ${slideRange(missing)}.` }
  const repeated = numbers.filter((n, i) => numbers.indexOf(n) !== i)
  if (repeated.length) return { error: `Slide ${slideRange(repeated)} is listed twice.` }
  return { deck, slides: numbers.map((n) => all[n - 1]) }
}

/** The same slides again by id at the deck's version (apply time): null when the deck or one of them is gone */
export async function slidesById(deckId: string, version: number, ids: string[]): Promise<PickedSlides | null> {
  const deck = await getDeck(deckId, version)
  if (!deck) return null
  const all = deck.content.slides.map((slide, i) => ({ ...slide, n: i + 1 }))
  const slides = ids.map((id) => all.find((slide) => slide.id === id))
  return slides.every((slide): slide is PickedSlide => Boolean(slide)) ? { deck, slides } : null
}

/** How a slide renders (renders.ts names and caches renders by this) */
export function slideSource(deck: DeckView, slide: Pick<JackSlideData, "html">): SlideSource {
  return { size: deck.size, css: deck.content.css, html: slide.html, roomId: deck.roomId }
}

/**
 * A slide's full-size render, through `slidePng` (renders.ts getRenderFile: from the store, rendered on
 * a miss). The deck page and Jack's own checks render every slide, so it's usually stored; only the room
 * page's function has Chromium on Vercel (#215), so a slide never rendered can't be made from the deck
 * page, and the officer is told how to fix that
 */
export async function slideImage(deps: { slidePng(source: SlideSource): Promise<Buffer> }, deck: DeckView, slide: PickedSlide): Promise<Buffer> {
  try {
    return await deps.slidePng(slideSource(deck, slide))
  } catch (error) {
    const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200)
    throw new Error(`slide ${slide.n} couldn't be turned into an image (${reason}). Open the deck page so its slides render, then try again.`)
  }
}

/** The officer-only thumbnail of a slide at the deck's version, for cards and the history */
export function slideThumbUrl(deck: Pick<DeckView, "id" | "version">, slideId: string): string {
  return slideImageUrl(deck.id, deck.version, slideId, "thumb")
}

/** "slide 3" or "slides 1-4 and 6" */
export function slidesLabel(slides: Pick<PickedSlide, "n">[]): string {
  return `slide${slides.length === 1 ? "" : "s"} ${slideRange(slides.map((s) => s.n))}`
}
