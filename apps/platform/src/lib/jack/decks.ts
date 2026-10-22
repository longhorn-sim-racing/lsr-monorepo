/**
 * Jack's slide decks and social graphics (#177). Plain values and types only: the server, the room
 * and the deck pages all import this.
 *
 * A deck is an ordered list of slides at one canvas size. A graphic is a deck at a social size,
 * usually one slide (several make a carousel). Each slide is HTML that Jack writes; the server renders
 * it to PNG in headless Chromium (src/server/jack/decks/).
 */

export type JackDeckSizeKey = "slides" | "post" | "story" | "square"

export type JackDeckSizeInfo = { width: number; height: number; label: string; kind: "deck" | "graphic" }

export const JACK_DECK_SIZES: Record<JackDeckSizeKey, JackDeckSizeInfo> = {
  slides: { width: 1920, height: 1080, label: "16:9 slides", kind: "deck" },
  post: { width: 1080, height: 1350, label: "Instagram post (4:5)", kind: "graphic" },
  story: { width: 1080, height: 1920, label: "Instagram story (9:16)", kind: "graphic" },
  square: { width: 1080, height: 1080, label: "Square post (1:1)", kind: "graphic" },
}

export const JACK_DECK_SIZE_KEYS = Object.keys(JACK_DECK_SIZES) as JackDeckSizeKey[]

export function isJackDeckSize(value: unknown): value is JackDeckSizeKey {
  return typeof value === "string" && value in JACK_DECK_SIZES
}

/** One slide: its HTML (the canvas's contents), and optional speaker notes */
export type JackSlideData = { id: string; html: string; notes?: string }

/** What a deck version holds (JackDeckVersion.content): the deck's shared CSS and its slides in order */
export type JackDeckContent = { css: string; slides: JackSlideData[] }

/** Most slides in one deck */
export const MAX_DECK_SLIDES = 40
/** Most characters of HTML in one slide, and of the deck's shared CSS */
export const MAX_SLIDE_HTML = 60_000
export const MAX_DECK_CSS = 30_000
export const MAX_SLIDE_NOTES = 4_000

/** Reads JackDeckVersion.content defensively (it's JSON from the database) */
export function parseDeckContent(value: unknown): JackDeckContent {
  const raw = (typeof value === "object" && value !== null ? value : {}) as { css?: unknown; slides?: unknown }
  const slides = Array.isArray(raw.slides)
    ? raw.slides.flatMap((slide): JackSlideData[] => {
        if (typeof slide !== "object" || slide === null) return []
        const { id, html, notes } = slide as Record<string, unknown>
        if (typeof id !== "string" || typeof html !== "string") return []
        return [{ id, html, ...(typeof notes === "string" && notes ? { notes } : {}) }]
      })
    : []
  return { css: typeof raw.css === "string" ? raw.css : "", slides }
}

/** The renders a slide image route serves: a small thumbnail, a 1280 px preview (what Jack looks at), or the full-size PNG */
export type JackRenderKind = "thumb" | "view" | "png"

/** The image route for one slide of one deck version. Content for a version never changes, so browsers can cache it */
export function slideImageUrl(deckId: string, version: number, slideId: string, kind: JackRenderKind, options: { download?: boolean } = {}): string {
  const params = new URLSearchParams({ v: String(version), kind })
  if (options.download) params.set("download", "1")
  return `/api/admin/jack/decks/${deckId}/slides/${slideId}?${params}`
}

export function deckPageUrl(deckId: string): string {
  return `/admin/jack/decks/${deckId}`
}
