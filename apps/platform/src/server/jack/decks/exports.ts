import { strToU8, zipSync } from "fflate"
import { PDFDocument } from "pdf-lib"
import { JACK_DECK_SIZES } from "@/lib/jack/decks"
import { RENDER_VERSION } from "./document"
import { getRenderFile } from "./renders"
import type { DeckView } from "./service"
import { jackFileStore } from "./storage"

/**
 * A whole deck as one download (#177):
 * - pdf: one page per slide at the canvas size, each the full-size render as a JPEG;
 * - pptx: one slide per slide, each the same picture, with the speaker notes (imports into Google
 *   Slides or PowerPoint; the slides aren't editable as text);
 * - zip: every slide's full-size PNG, numbered, plus the notes.
 * The PDF and PPTX use JPEGs: a slide with a photo is a few hundred KB instead of a couple of MB.
 * Built once per deck version and kept in the file store, since a version never changes.
 */

export type DeckExportFormat = "pdf" | "pptx" | "zip"

export const EXPORT_TYPES: Record<DeckExportFormat, { contentType: string; ext: string }> = {
  pdf: { contentType: "application/pdf", ext: "pdf" },
  pptx: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  zip: { contentType: "application/zip", ext: "zip" },
}

export function exportFileName(deck: Pick<DeckView, "title" | "version">, format: DeckExportFormat): string {
  const slug = deck.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "deck"
  return `${slug}-v${deck.version}.${EXPORT_TYPES[format].ext}`
}

/** Where a version's export is kept. The file name is what a signed link downloads as */
export function exportPath(deck: Pick<DeckView, "id" | "title" | "version">, format: DeckExportFormat): string {
  return `jack/exports/${deck.id}/r${RENDER_VERSION}/${exportFileName(deck, format)}`
}

/** The export for a deck version: from the store, or built (and stored) now */
export async function getDeckExport(deck: DeckView, format: DeckExportFormat): Promise<{ pathname: string; body: Buffer; stored: boolean }> {
  const store = jackFileStore()
  const pathname = exportPath(deck, format)
  // A store that can't be read (a missing bucket fails loudly) doesn't stop the download either
  const stored = await store.get(pathname).catch((error) => {
    console.error(`[jack] Couldn't read export ${pathname} from the store:`, error)
    return null
  })
  if (stored) return { pathname, body: stored, stored: true }
  const { body, transient } = await buildDeckExport(deck, format)
  // An export with a slide that may render better next time isn't kept. Nor does a store that can't be
  // written to stop the download
  const kept = !transient && store.kind !== "none" && (await store.put(pathname, body, EXPORT_TYPES[format].contentType).then(() => true, (error) => {
    console.error(`[jack] Couldn't keep export ${pathname}:`, error)
    return false
  }))
  return { pathname, body, stored: kept }
}

export async function buildDeckExport(deck: DeckView, format: DeckExportFormat): Promise<{ body: Buffer; transient: boolean }> {
  const slides = deck.content.slides
  if (!slides.length) throw new Error("This deck has no slides yet.")
  const source = (html: string) => ({ size: deck.size, css: deck.content.css, html, roomId: deck.roomId })

  if (format === "zip") {
    const renders = await Promise.all(slides.map((slide) => getRenderFile(source(slide.html), "png")))
    const pngs = renders.map((r) => r.body)
    const files: Record<string, Uint8Array> = {}
    pngs.forEach((png, i) => {
      files[`${String(i + 1).padStart(2, "0")}.png`] = new Uint8Array(png)
    })
    const notes = slides.map((slide, i) => (slide.notes ? `Slide ${i + 1}\n${slide.notes}\n` : "")).filter(Boolean)
    if (notes.length) files["notes.txt"] = strToU8(notes.join("\n"))
    // PNGs are compressed already
    return { body: Buffer.from(zipSync(files, { level: 0 })), transient: renders.some((r) => r.transient) }
  }

  const jpgRenders = await Promise.all(slides.map((slide) => getRenderFile(source(slide.html), "jpg")))
  const jpgs = jpgRenders.map((r) => r.body)
  const transient = jpgRenders.some((r) => r.transient)
  const { width, height } = JACK_DECK_SIZES[deck.size]

  if (format === "pdf") {
    const pdf = await PDFDocument.create()
    pdf.setTitle(deck.title)
    pdf.setCreator("Jack, Longhorn Sim Racing")
    // Half a point per pixel: a 16:9 page comes out 13.3 x 7.5 in, like a widescreen slide
    const pageWidth = width / 2
    const pageHeight = height / 2
    for (const jpg of jpgs) {
      const image = await pdf.embedJpg(jpg)
      pdf.addPage([pageWidth, pageHeight]).drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight })
    }
    return { body: Buffer.from(await pdf.save()), transient }
  }

  const { default: PptxGenJS } = await import("pptxgenjs")
  // 16:9 decks use PowerPoint's widescreen size (13.33 × 7.5 in); the others keep their pixel ratio at 144 px per inch
  const inches = deck.size === "slides" ? { width: 13.333, height: 7.5 } : { width: width / 144, height: height / 144 }
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: "JACK", width: inches.width, height: inches.height })
  pptx.layout = "JACK"
  pptx.title = deck.title
  pptx.author = "Longhorn Sim Racing"
  slides.forEach((slide, i) => {
    const page = pptx.addSlide()
    page.addImage({ data: `image/jpeg;base64,${jpgs[i].toString("base64")}`, x: 0, y: 0, w: inches.width, h: inches.height })
    if (slide.notes) page.addNotes(slide.notes)
  })
  const out = await pptx.write({ outputType: "nodebuffer" })
  return { body: Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer), transient }
}
