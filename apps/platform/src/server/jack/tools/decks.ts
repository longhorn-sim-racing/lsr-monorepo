import { createHash } from "node:crypto"
import { z } from "zod"
import { deckPageUrl, JACK_DECK_SIZE_KEYS, JACK_DECK_SIZES, MAX_DECK_SLIDES, type JackDeckContent } from "@/lib/jack/decks"
import type { JackDeckDisplay } from "@/lib/jack/parts"
import { getSiteUrl } from "@/lib/site-url"
import { findGalleryAssets, orientation, roomPhotoAssets, SITE_ASSETS } from "@/server/jack/decks/assets"
import { DESIGN_GUIDE } from "@/server/jack/decks/design-guide"
import { applyEdits, applyOrder, applyWrites, newSlideId, type Applied } from "@/server/jack/decks/edits"
import { isScreenshotPath, SCREENSHOT_DEVICES, screenshotSite } from "@/server/jack/decks/renderer"
import { ASSET_FILES, ensureRender } from "@/server/jack/decks/renders"
import { changeDeck, createDeck, getDeck, listDecks, listDeckVersions, restoreDeckVersion, slideRange, type DeckView } from "@/server/jack/decks/service"
import { jackFileStore } from "@/server/jack/decks/storage"
import { ct } from "./time"
import type { JackModelImage, JackTool, JackToolContext, JackToolResult } from "./types"

/**
 * Jack's slide decks and social graphics (#177). Shaped like file tools: create, write slides, edit by
 * find and replace, arrange, view, render, restore, plus the design guide and the photo catalog.
 * Every change saves a version (undo is deck_restore). Each write renders the slides it changed and
 * reports the layout checks; deck_render shows Jack the images themselves.
 *
 * These write only Jack's own decks, never club data.
 */

/** Most slides one deck_render call shows (each is about 1,200 image tokens at 1280 px) */
export const MAX_RENDER_SLIDES = 10

const deckId = z.string().trim().min(1).max(64).describe("The deck's id (from deck_create, or deck_view with no deck to list them)")
const slideNumber = z.number().int().min(1).max(MAX_DECK_SLIDES)
const html = z.string().min(1).describe('The whole slide: one <section class="slide dark|light">…</section> using the kit classes (see deck_guide)')
const notes = z.string().max(4_000).describe("Speaker notes: what to say, and where the numbers came from. Not shown on the slide")

export function deckLink(id: string): string {
  return `${getSiteUrl()}${deckPageUrl(id)}`
}

function deckDisplay(deck: DeckView, focus?: string[]): JackDeckDisplay {
  return {
    kind: "deck",
    deckId: deck.id,
    title: deck.title,
    size: deck.size,
    version: deck.version,
    slideIds: deck.content.slides.map((s) => s.id),
    ...(focus?.length ? { focus } : {}),
  }
}

function header(deck: DeckView): string {
  const { width, height, label } = JACK_DECK_SIZES[deck.size]
  const count = deck.content.slides.length
  return `Deck "${deck.title}" (id ${deck.id}): ${label}, ${width}×${height}, ${count} slide${count === 1 ? "" : "s"}, version ${deck.version}. Link: ${deckLink(deck.id)}`
}

/**
 * How long a write waits for its slides' checks. Past this the renders carry on in the background
 * (and land in the cache), and Jack is told to look with deck_render, so a slow first render never
 * makes a saved change look like a failed one
 */
export const CHECK_WAIT_MS = 25_000

/** Renders the given slides (from the store when they're cached) and lists what the layout checks found */
async function checkSlides(deck: DeckView, ids: string[], signal?: AbortSignal): Promise<string> {
  const targets = deck.content.slides.map((slide, i) => ({ slide, n: i + 1 })).filter(({ slide }) => ids.includes(slide.id))
  if (!targets.length) return ""
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const slow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CHECK_WAIT_MS)
    })
    const renders = Promise.all(targets.map(({ slide }) => ensureRender({ size: deck.size, css: deck.content.css, html: slide.html, roomId: deck.roomId })))
    renders.catch(() => {})
    const results = await Promise.race([renders, slow]).finally(() => clearTimeout(timer))
    if (signal?.aborted) return ""
    if (!results) return "The slides are saved. Rendering them for the layout checks is taking a while (photos loading for the first time); call deck_render to check them."
    const lines: string[] = []
    const clean: number[] = []
    results.forEach((result, i) => {
      const n = targets[i].n
      if (result.issues.length) lines.push(...result.issues.map((issue) => `- Slide ${n}: ${issue}`))
      else clean.push(n)
    })
    if (clean.length) lines.push(`- Slide${clean.length === 1 ? "" : "s"} ${slideRange(clean)}: no layout problems found.`)
    return `Layout checks:\n${lines.join("\n")}`
  } catch (error) {
    console.error(`[jack] Couldn't render deck ${deck.id}:`, error)
    return `The slides were saved, but rendering them to check the layout failed (${error instanceof Error ? error.message : String(error)}). Try deck_render later.`
  }
}

/** The ids of every slide whose picture a change affected: the slides it touched, or all of them when the deck CSS changed */
function affected(applied: Applied): string[] {
  return applied.cssChanged ? applied.content.slides.map((s) => s.id) : applied.touched
}

function meta(ctx: JackToolContext, summary: string | (() => string)) {
  return { userId: ctx.actor.userId, messageId: ctx.messageId ?? null, summary }
}

const fail = (forModel: string, label: string): JackToolResult => ({ isError: true, forModel, label, displays: [] })

// ---------------------------------------------------------------------------------------------------

export const deckGuideTool: JackTool<Record<string, never>> = {
  name: "deck_guide",
  description:
    "The LSR design guide: how slides work, the brand, the slide kit's CSS classes, layout numbers for each size, and working templates for decks and Instagram graphics. Read it before you make or restyle a deck or graphic (once per reply is enough).",
  input: z.object({}).strict(),
  design: true,
  async run() {
    return { forModel: DESIGN_GUIDE, label: "Read the LSR design guide" }
  },
}

export const deckAssetsInput = z.object({
  query: z.string().trim().max(120).optional().describe('Words to match in gallery albums and photo descriptions, e.g. "COTA" or "GM 1"'),
  album: z.string().trim().max(120).optional().describe("Only this gallery album (its title or slug)"),
})

export const deckAssetsTool: JackTool<z.infer<typeof deckAssetsInput>> = {
  name: "deck_assets",
  description:
    "The images slides can use: photos officers posted in this room, the site's photos and livery renders, the LSR and sponsor logos (each with what it shows), and the club's gallery photos on Cloudinary (searchable by album and description). Use only URLs from here, exactly as given.",
  input: deckAssetsInput,
  design: true,
  async run(input, ctx) {
    const [gallery, room] = await Promise.all([findGalleryAssets({ query: input.query, album: input.album, limit: 30 }), roomPhotoAssets(ctx.roomId)])
    const line = (a: { url: string; about: string; width: number; height: number }) =>
      `${a.url} | ${a.width && a.height ? `${a.width}×${a.height} ${orientation(a.width, a.height)}` : "size unknown"} | ${a.about}`
    const site = input.query || input.album ? [] : SITE_ASSETS
    const text = [
      room.length ? `Photos officers posted in this room (they load only in this room's decks):\n${room.map(line).join("\n")}` : null,
      site.length ? `Site photos, renders and logos (relative URLs load from the club site):\n${site.map(line).join("\n")}` : null,
      gallery.assets.length
        ? `Gallery photos${input.query || input.album ? " matching the search" : " (newest albums first)"}:\n${gallery.assets.map(line).join("\n")}`
        : `No gallery photos match${input.query ? ` "${input.query}"` : ""}${input.album ? ` in album "${input.album}"` : ""}.`,
      `Gallery albums: ${gallery.albums.map((a) => `${a.title} (${a.photos} photos${a.date ? `, ${a.date}` : ""})`).join("; ") || "none"}.`,
    ]
      .filter(Boolean)
      .join("\n\n")
    return { forModel: text, label: input.query || input.album ? `Looked for photos: ${input.query ?? input.album}` : "Listed the club's photos and logos" }
  },
}

export const deckCreateInput = z.object({
  title: z.string().trim().min(1).max(120).describe('What it is, e.g. "GM 2 slides" or "Recruiting story"'),
  size: z.enum(JACK_DECK_SIZE_KEYS as [string, ...string[]]).describe("slides: 16:9 deck (1920×1080). post: Instagram post 4:5 (1080×1350). story: Instagram story 9:16 (1080×1920). square: 1:1 post (1080×1080)"),
  css: z.string().max(30_000).optional().describe("The deck's shared CSS: classes every slide can use, on top of the kit"),
  slides: z
    .array(z.object({ html, notes: notes.optional() }))
    .max(8)
    .optional()
    .describe("The first slides, in order (at most 8 here; add more with deck_write)"),
})

export const deckCreateTool: JackTool<z.infer<typeof deckCreateInput>> = {
  name: "deck_create",
  description:
    "Start a new slide deck or social graphic, optionally with its first slides and shared CSS. Read deck_guide first. Returns the deck's id and link, and the layout checks for the slides you wrote.",
  input: deckCreateInput,
  design: true,
  writes: true,
  async run(input, ctx) {
    const content: JackDeckContent = {
      css: input.css ?? "",
      slides: (input.slides ?? []).map((s) => ({ id: newSlideId(), html: s.html, ...(s.notes?.trim() ? { notes: s.notes.trim() } : {}) })),
    }
    const size = input.size as DeckView["size"]
    const count = content.slides.length
    const created = await createDeck({
      title: input.title,
      size,
      roomId: ctx.roomId,
      content,
      meta: meta(ctx, count ? `Created with ${count} slide${count === 1 ? "" : "s"}` : "Created"),
    })
    if (!created.ok) return fail(created.error, "Deck not created")
    const deck = created.deck
    const checks = await checkSlides(deck, content.slides.map((s) => s.id), ctx.signal)
    return {
      forModel: [header(deck), checks].filter(Boolean).join("\n\n"),
      label: `Created “${deck.title}”${count ? ` (${count} slide${count === 1 ? "" : "s"})` : ""}`,
      displays: count ? [deckDisplay(deck, content.slides.map((s) => s.id))] : [],
    }
  },
}

export const deckWriteInput = z.object({
  deck: deckId,
  css: z.string().max(30_000).optional().describe("Replaces the deck's shared CSS (every slide re-renders)"),
  slides: z
    .array(
      z.object({
        slide: slideNumber.describe("The slide's number. An existing number replaces that slide; one past the last adds a slide at the end"),
        html: html.optional().describe("The whole slide's HTML. Leave out to change only the notes"),
        notes: notes.optional(),
        insert: z.boolean().optional().describe("Insert a new slide at this number instead of replacing the one there"),
      })
    )
    .max(8)
    .optional()
    .describe("Slides to write, applied in order (numbers count the deck as it is after the ones before). At most 8 per call; 3 or 4 keeps each call quick"),
})

export const deckWriteTool: JackTool<z.infer<typeof deckWriteInput>> = {
  name: "deck_write",
  description:
    "Write whole slides into a deck (new ones, or replacing existing ones) and/or replace its shared CSS. For small changes to a slide use deck_edit instead. Returns the layout checks for what changed.",
  input: deckWriteInput,
  design: true,
  writes: true,
  async run(input, ctx) {
    if (!input.slides?.length && input.css === undefined) return fail("Give slides to write, css, or both.", "Nothing to write")
    let applied: Applied | null = null
    const numbers = (input.slides ?? []).map((s) => s.slide)
    const wrote = numbers.length ? `Wrote slide${numbers.length === 1 ? "" : "s"} ${slideRange(numbers)}` : null
    const summary = [wrote, input.css !== undefined ? "changed the deck CSS" : null].filter(Boolean).join(" and ")
    const change = await changeDeck(input.deck, meta(ctx, summary[0].toUpperCase() + summary.slice(1)), ({ content }) => {
      const result = applyWrites(content, input.slides ?? [], input.css)
      if ("error" in result) return result
      applied = result
      return { content: result.content }
    })
    if (!change.ok) return fail(change.error, "Slides not written")
    const deck = change.deck
    if (!change.changed || !applied) return { forModel: `${header(deck)}\n\nNothing changed: the deck already had exactly this.`, label: `No change to “${deck.title}”` }
    const ids = affected(applied)
    const checks = await checkSlides(deck, ids, ctx.signal)
    const label = wrote ? `${wrote}${input.css !== undefined ? " and restyled" : ""} of “${deck.title}”` : `Restyled “${deck.title}”`
    return {
      forModel: [header(deck), checks].filter(Boolean).join("\n\n"),
      label,
      displays: [deckDisplay(deck, ids)],
    }
  },
}

const oneEdit = z.object({
  slide: slideNumber.optional().describe("The slide to edit. Leave out to edit the deck's shared CSS"),
  find: z.string().min(1).max(20_000).describe("Exact text to find, copied from deck_view (enough of it to be unique)"),
  replace: z.string().max(20_000).describe("What to put in its place"),
  all: z.boolean().optional().describe("Replace every match instead of requiring exactly one"),
  notes: z.boolean().optional().describe("Edit the slide's speaker notes instead of its HTML"),
})

export const deckEditInput = z.preprocess(
  // A single edit sent flat ({ deck, slide, find, replace }) instead of in a list is still one edit
  (value) => {
    if (typeof value !== "object" || value === null || "edits" in value || !("find" in value)) return value
    const { deck, ...edit } = value as Record<string, unknown>
    return { deck, edits: [edit] }
  },
  z.object({
    deck: deckId,
    edits: z.array(oneEdit).min(1).max(20).describe("Find-and-replace edits, applied in order. All of them apply, or none"),
  })
)

export const deckEditTool: JackTool<z.infer<typeof deckEditInput>> = {
  name: "deck_edit",
  description:
    "Change part of a slide (its HTML or its notes) or the deck CSS by exact find and replace, like fixing a word, a color, a size or one card. Cheaper and safer than rewriting the slide. Returns the layout checks for what changed.",
  input: deckEditInput,
  design: true,
  writes: true,
  async run(input, ctx) {
    let applied: Applied | null = null
    const slides = [...new Set(input.edits.flatMap((e) => (e.slide === undefined ? [] : [e.slide])))]
    const cssEdited = input.edits.some((e) => e.slide === undefined)
    const onlyNotes = input.edits.every((e) => e.notes)
    const what = [slides.length ? `${onlyNotes ? "the notes on " : ""}slide${slides.length === 1 ? "" : "s"} ${slideRange(slides)}` : null, cssEdited ? "the deck CSS" : null].filter(Boolean).join(" and ")
    const change = await changeDeck(input.deck, meta(ctx, `Edited ${what}`), ({ content }) => {
      const result = applyEdits(content, input.edits)
      if ("error" in result) return result
      applied = result
      return { content: result.content }
    })
    if (!change.ok) return fail(change.error, "Edit not made")
    const deck = change.deck
    if (!change.changed || !applied) return { forModel: `${header(deck)}\n\nNothing changed.`, label: `No change to “${deck.title}”` }
    const ids = affected(applied)
    const checks = await checkSlides(deck, ids, ctx.signal)
    return {
      forModel: [header(deck), checks || "Only the notes changed, so nothing was re-rendered."].filter(Boolean).join("\n\n"),
      label: `Edited ${what} of “${deck.title}”`,
      displays: [deckDisplay(deck, ids)],
    }
  },
}

export const deckArrangeInput = z.object({
  deck: deckId,
  order: z
    .array(slideNumber)
    .min(1)
    .max(MAX_DECK_SLIDES)
    .optional()
    .describe("Every slide to keep, by its current number, in the new order. Leaving a number out deletes that slide; listing one twice duplicates it"),
  title: z.string().trim().min(1).max(120).optional().describe("A new title for the deck"),
})

export const deckArrangeTool: JackTool<z.infer<typeof deckArrangeInput>> = {
  name: "deck_arrange",
  description: "Reorder, delete or duplicate a deck's slides, and/or rename the deck. Undo with deck_restore.",
  input: deckArrangeInput,
  design: true,
  writes: true,
  async run(input, ctx) {
    if (!input.order && !input.title) return fail("Give an order, a title, or both.", "Nothing to change")
    let applied: (Applied & { summary?: string }) | null = null
    // "Reordered the slides", "Deleted 1 slide, duplicated 1", "Renamed the deck to “…”", or both joined
    const describe = () => {
      const arranged = applied?.summary ? applied.summary[0].toUpperCase() + applied.summary.slice(1) : null
      const renamed = input.title ? `${arranged ? "renamed" : "Renamed"} the deck to “${input.title}”` : null
      return [arranged, renamed].filter(Boolean).join(" and ")
    }
    const change = await changeDeck(input.deck, meta(ctx, describe), ({ content }) => {
      if (!input.order) return { content, title: input.title }
      const result = applyOrder(content, input.order)
      if ("error" in result) return result
      applied = result
      return { content: result.content, title: input.title }
    })
    if (!change.ok) return fail(change.error, "Slides not arranged")
    const deck = change.deck
    if (!change.changed) return { forModel: `${header(deck)}\n\nNothing changed.`, label: `No change to “${deck.title}”` }
    const done = applied as (Applied & { summary?: string }) | null
    const checks = done?.touched.length ? await checkSlides(deck, done.touched, ctx.signal) : ""
    const summary = describe()
    return {
      forModel: [header(deck), `Done: ${summary}.${done ? " Slides are now numbered in their new order." : ""}`, checks].filter(Boolean).join("\n\n"),
      label: input.title ? summary : `${summary} in “${deck.title}”`,
      displays: [deckDisplay(deck, done?.touched)],
    }
  },
}

export const deckViewInput = z.object({
  deck: deckId.optional().describe("The deck to show. Leave out to list recent decks (this room's first)"),
  slides: z.array(slideNumber).max(MAX_DECK_SLIDES).optional().describe("Only these slides' HTML (default: all)"),
  history: z.boolean().optional().describe("Also list the deck's versions, for deck_restore"),
})

export const deckViewTool: JackTool<z.infer<typeof deckViewInput>> = {
  name: "deck_view",
  description:
    "Show a deck's slides as HTML (with the deck CSS and notes) so you can edit them, and optionally its version history. With no deck, lists recent decks with their ids.",
  input: deckViewInput,
  design: true,
  async run(input, ctx) {
    if (!input.deck) {
      const [here, all] = await Promise.all([listDecks({ roomId: ctx.roomId, take: 15 }), listDecks({ take: 15 })])
      const others = all.filter((d) => d.roomId !== ctx.roomId)
      const line = (d: (typeof all)[number]) =>
        `- "${d.title}" id ${d.id}: ${JACK_DECK_SIZES[d.size].label}, ${d.slides} slide${d.slides === 1 ? "" : "s"}, version ${d.version}, updated ${ct(d.updatedAt)}${d.roomId === ctx.roomId ? "" : ` (room: ${d.roomTitle ?? "deleted"})`}`
      const text = [`In this room:\n${here.map(line).join("\n") || "- none"}`, others.length ? `Elsewhere:\n${others.slice(0, 10).map(line).join("\n")}` : null].filter(Boolean).join("\n\n")
      return { forModel: text, label: `Listed decks (${here.length} in this room)` }
    }
    const deck = await getDeck(input.deck)
    if (!deck) return fail(`There's no deck with id ${input.deck}. Call deck_view with no deck to list them.`, "Deck not found")
    const wanted = input.slides?.length ? new Set(input.slides) : null
    const slides = deck.content.slides
      .map((slide, i) => ({ slide, n: i + 1 }))
      .filter(({ n }) => !wanted || wanted.has(n))
      .map(({ slide, n }) => `## Slide ${n}\n${slide.html}${slide.notes ? `\nNotes: ${slide.notes}` : ""}`)
    const versions = input.history ? await listDeckVersions(deck.id, 30) : []
    const text = [
      header(deck),
      `## Deck CSS\n${deck.content.css || "(none)"}`,
      ...slides,
      versions.length ? `## Versions (newest first)\n${versions.map((v) => `- ${v.version}: ${v.summary} (${v.slides} slides, ${ct(v.createdAt)}${v.byName ? `, for ${v.byName}` : ""})`).join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n\n")
    return { forModel: text, label: `Looked at “${deck.title}”${input.slides?.length ? ` (slide${input.slides.length === 1 ? "" : "s"} ${slideRange(input.slides)})` : ""}` }
  },
}

export const deckRenderInput = z.object({
  deck: deckId,
  slides: z.array(slideNumber).max(MAX_RENDER_SLIDES).optional().describe(`The slides to look at (default: all, up to ${MAX_RENDER_SLIDES})`),
})

export const deckRenderTool: JackTool<z.infer<typeof deckRenderInput>> = {
  name: "deck_render",
  // Up to ten slides from a cold browser, with photos loading for the first time
  timeoutMs: 100_000,
  description: `Look at slides as images (1280 px previews) to check the design: balance, contrast, crowding, photos, anything the layout checks can't see. Also returns the checks. At most ${MAX_RENDER_SLIDES} slides per call.`,
  input: deckRenderInput,
  design: true,
  async run(input, ctx) {
    const deck = await getDeck(input.deck)
    if (!deck) return fail(`There's no deck with id ${input.deck}. Call deck_view with no deck to list them.`, "Deck not found")
    const all = deck.content.slides.map((slide, i) => ({ slide, n: i + 1 }))
    if (!all.length) return fail("This deck has no slides yet. Add some with deck_write.", "Nothing to render")
    const bad = input.slides?.find((n) => n > all.length)
    if (bad) return fail(`The deck has ${all.length} slides; there's no slide ${bad}.`, "Slide not found")
    const targets = input.slides?.length ? all.filter(({ n }) => input.slides!.includes(n)) : all.slice(0, MAX_RENDER_SLIDES)

    const rendered = await Promise.all(targets.map(({ slide }) => ensureRender({ size: deck.size, css: deck.content.css, html: slide.html, roomId: deck.roomId }, { withView: true, signal: ctx.signal })))
    const images: JackModelImage[] = []
    const lines: string[] = []
    rendered.forEach((result, i) => {
      const n = targets[i].n
      if (result.view) images.push({ caption: `Slide ${n}:`, mediaType: "image/jpeg", data: result.view.toString("base64") })
      lines.push(result.issues.length ? result.issues.map((issue) => `- Slide ${n}: ${issue}`).join("\n") : `- Slide ${n}: no layout problems found.`)
    })
    const more = !input.slides?.length && all.length > MAX_RENDER_SLIDES ? `\n\nShowing slides 1-${MAX_RENDER_SLIDES} of ${all.length}; ask for the rest by number.` : ""
    return {
      forModel: `${header(deck)}\n\nLayout checks:\n${lines.join("\n")}${more}`,
      images,
      label:
        all.length === 1
          ? `Looked at “${deck.title}”`
          : `Looked at ${targets.length === all.length ? `all ${all.length} slides` : `slide${targets.length === 1 ? "" : "s"} ${slideRange(targets.map((t) => t.n))}`} of “${deck.title}”`,
      displays: [deckDisplay(deck, targets.map((t) => t.slide.id))],
    }
  },
}

export const deckRestoreInput = z.object({
  deck: deckId,
  version: z.number().int().min(1).describe("The version to go back to (deck_view with history lists them)"),
})

export const deckRestoreTool: JackTool<z.infer<typeof deckRestoreInput>> = {
  name: "deck_restore",
  description: "Undo: bring back an earlier version of a deck as its newest version. Nothing is lost; the versions after it stay in the history.",
  input: deckRestoreInput,
  design: true,
  writes: true,
  async run(input, ctx) {
    const change = await restoreDeckVersion(input.deck, input.version, { userId: ctx.actor.userId, messageId: ctx.messageId ?? null })
    if (!change.ok) return fail(change.error, "Version not restored")
    const deck = change.deck
    if (!change.changed) return { forModel: `${header(deck)}\n\nThe deck already matches version ${input.version}.`, label: `“${deck.title}” already matches version ${input.version}` }
    return {
      forModel: `${header(deck)}\n\nRestored version ${input.version} as version ${deck.version}.`,
      label: `Restored version ${input.version} of “${deck.title}”`,
      displays: [deckDisplay(deck)],
    }
  },
}

export const deckScreenshotInput = z.object({
  page: z.string().trim().min(1).max(200).describe('A public page of the club site, as a path: "/", "/events", "/lone-star-cup", "/gallery", "/apply", "/drivers", "/news", "/sponsors"…'),
  device: z.enum(["desktop", "phone"]).optional().describe("desktop (1440 wide, the default) or phone (390 wide at 2x)"),
  fullPage: z.boolean().optional().describe("The whole page, up to 4 screens tall, instead of just the first screen"),
})

export const deckScreenshotTool: JackTool<z.infer<typeof deckScreenshotInput>> = {
  name: "deck_screenshot",
  description:
    "Take a screenshot of one of the club site's public pages, as a signed-out visitor sees it, to put on a slide (a feature, the events page, the apply page). Shows you the screenshot and returns its image URL. Frame it on the slide (object-fit: cover with object-position: top, or contain); a phone shot sits well in a rounded rectangle.",
  input: deckScreenshotInput,
  design: true,
  timeoutMs: 60_000,
  async run(input) {
    if (!isScreenshotPath(input.page)) {
      return fail(`${input.page} isn't a public page of the site. Use a path like "/", "/events", "/lone-star-cup", "/gallery", "/apply", "/drivers", "/news" or "/sponsors".`, "Screenshot not taken")
    }
    const store = jackFileStore()
    if (store.kind === "none") return fail("Screenshots need Jack's private file store, which isn't connected yet. Tell the officers an admin needs to connect it.", "Screenshot not taken")
    const device = input.device ?? "desktop"
    const shot = await screenshotSite(input.page, { device, fullPage: input.fullPage })
    const name = `shot-${createHash("sha256").update(shot.png).digest("hex").slice(0, 20)}.png`
    await store.put(`${ASSET_FILES}/${name}`, shot.png, "image/png")
    const url = `https://jack.assets/files/${name}`
    const { width } = SCREENSHOT_DEVICES[device]
    return {
      forModel: `Screenshot of ${input.page} (${device}, ${width} CSS px wide): ${shot.width}×${shot.height} px. Use it on a slide as <img src="${url}">.`,
      images: [{ caption: `${input.page} on ${device}:`, mediaType: "image/jpeg", data: shot.preview.toString("base64") }],
      label: `Took a screenshot of ${input.page}${device === "phone" ? " on a phone" : ""}`,
    }
  },
}

/** The deck tools, in the order they're registered (part of the cached prompt) */
export const DECK_TOOLS = [
  deckGuideTool,
  deckAssetsTool,
  deckCreateTool,
  deckWriteTool,
  deckEditTool,
  deckArrangeTool,
  deckViewTool,
  deckRenderTool,
  deckRestoreTool,
  deckScreenshotTool,
]
