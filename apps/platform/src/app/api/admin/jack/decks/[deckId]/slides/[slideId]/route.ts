import { NextResponse, type NextRequest } from "next/server"
import type { JackRenderKind } from "@/lib/jack/decks"
import { requireOfficer } from "@/server/auth/guards"
import { getRenderFile, renderContentType } from "@/server/jack/decks/renders"
import { getDeck } from "@/server/jack/decks/service"
import { jackFileStore } from "@/server/jack/decks/storage"

/**
 * One slide of a Jack deck as an image (#177), for officers only: `kind` thumb (small JPEG), view (the
 * 1280 px preview) or png (full size); `v` the deck version (the current one if left out); `download=1`
 * to save it. Renders on a cache miss. A version never changes, so with `v` the browser keeps it.
 *
 * A file too big for a function response (4.5 MB on Vercel; a busy full-size PNG can be) is sent as a
 * redirect to a short-lived signed link to the private store.
 */

export const dynamic = "force-dynamic"

const KINDS: JackRenderKind[] = ["thumb", "view", "png"]
const SLIDE_ID = /^[A-Za-z0-9_-]{4,32}$/
const UUID = /^[0-9a-f-]{36}$/i
const MAX_INLINE_BYTES = 4_000_000

export async function GET(req: NextRequest, { params }: { params: Promise<{ deckId: string; slideId: string }> }) {
  try {
    await requireOfficer()
  } catch {
    return NextResponse.json({ error: "Officers only" }, { status: 403 })
  }

  const { deckId, slideId } = await params
  const search = req.nextUrl.searchParams
  const kind = (search.get("kind") ?? "thumb") as JackRenderKind
  const version = search.get("v") ? Number(search.get("v")) : undefined
  if (!UUID.test(deckId) || !SLIDE_ID.test(slideId) || !KINDS.includes(kind) || (version !== undefined && (!Number.isInteger(version) || version < 1))) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 })
  }

  const deck = await getDeck(deckId, version)
  const index = deck?.content.slides.findIndex((slide) => slide.id === slideId) ?? -1
  if (!deck || index === -1) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const slide = deck.content.slides[index]

  let file: { key: string; body: Buffer; transient: boolean }
  try {
    file = await getRenderFile({ size: deck.size, css: deck.content.css, html: slide.html, roomId: deck.roomId }, kind)
  } catch (error) {
    console.error(`[jack] Couldn't render slide ${slideId} of deck ${deckId}:`, error)
    return NextResponse.json({ error: "Couldn't render this slide" }, { status: 500 })
  }

  const download = search.get("download") === "1"
  const name = `${slugify(deck.title) || "slide"}-${String(index + 1).padStart(2, "0")}.${kind === "png" ? "png" : "jpg"}`
  // (a transient render wasn't stored, so it has no link; it goes out inline and may fail if it's that big)
  if (file.body.length > MAX_INLINE_BYTES && !file.transient) {
    const signed = await jackFileStore().signedUrl(`jack/renders/${file.key}/${kind === "png" ? "full.png" : `${kind}.jpg`}`, 10 * 60_000).catch(() => null)
    if (signed) return NextResponse.redirect(signed, { status: 302, headers: { "cache-control": "no-store" } })
  }
  return new NextResponse(new Uint8Array(file.body), {
    headers: {
      "content-type": renderContentType(kind),
      // A version never changes, so its render can be kept, unless this one may come out better next time
      "cache-control": file.transient ? "no-store" : version ? "private, max-age=31536000, immutable" : "private, no-cache",
      "x-content-type-options": "nosniff",
      ...(download ? { "content-disposition": `attachment; filename="${name}"` } : {}),
    },
  })
}

function slugify(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
}
