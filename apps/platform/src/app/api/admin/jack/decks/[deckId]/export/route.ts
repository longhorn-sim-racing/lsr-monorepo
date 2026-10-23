import { NextResponse, type NextRequest } from "next/server"
import { requireOfficer } from "@/server/auth/guards"
import { EXPORT_TYPES, exportFileName, getDeckExport, type DeckExportFormat } from "@/server/jack/decks/exports"
import { getDeck } from "@/server/jack/decks/service"
import { jackFileStore } from "@/server/jack/decks/storage"

/**
 * A Jack deck as one download (#177), for officers only: `format` pdf, pptx or zip (the slides'
 * PNGs); `v` the deck version (the current one if left out). Built once per version and kept.
 * Anything bigger than a function response can carry goes out as a short-lived signed link.
 */

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f-]{36}$/i
const MAX_INLINE_BYTES = 4_000_000

export async function GET(req: NextRequest, { params }: { params: Promise<{ deckId: string }> }) {
  try {
    await requireOfficer()
  } catch {
    return NextResponse.json({ error: "Officers only" }, { status: 403 })
  }

  const { deckId } = await params
  const search = req.nextUrl.searchParams
  const format = search.get("format") as DeckExportFormat
  const version = search.get("v") ? Number(search.get("v")) : undefined
  if (!UUID.test(deckId) || !(format in EXPORT_TYPES) || (version !== undefined && (!Number.isInteger(version) || version < 1))) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 })
  }

  const deck = await getDeck(deckId, version)
  if (!deck) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!deck.content.slides.length) return NextResponse.json({ error: "This deck has no slides yet" }, { status: 409 })

  let file: { pathname: string; body: Buffer; stored: boolean }
  try {
    file = await getDeckExport(deck, format)
  } catch (error) {
    console.error(`[jack] Couldn't export deck ${deckId} as ${format}:`, error)
    return NextResponse.json({ error: "Couldn't build that download" }, { status: 500 })
  }

  if (file.body.length > MAX_INLINE_BYTES && file.stored) {
    const signed = await jackFileStore().signedUrl(file.pathname, 10 * 60_000).catch(() => null)
    if (signed) return NextResponse.redirect(signed, { status: 302, headers: { "cache-control": "no-store" } })
  }
  return new NextResponse(new Uint8Array(file.body), {
    headers: {
      "content-type": EXPORT_TYPES[format].contentType,
      "content-disposition": `attachment; filename="${exportFileName(deck, format)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  })
}
