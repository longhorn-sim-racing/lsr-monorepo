import { NextResponse, type NextRequest } from "next/server"
import { requireOfficer } from "@/server/auth/guards"
import { jackFileStore } from "@/server/jack/decks/storage"
import { contentDisposition, FILE_VARIANTS, servableFile, type FileVariant } from "@/server/jack/files/serve"

/**
 * A file attached in a Jack room (#188, design §5), for officers only, by id (never by path):
 * `?variant=original` (the default), `model` (the copy Jack looks at) or `thumb` (photos only).
 *
 * Officers' uploads are other people's files, so the response is locked down: nosniff, a sandbox
 * CSP (a file that gets past every check still can't run as a page on our origin), never cached
 * (thumbnails may be: they never change), and downloaded rather than shown, except raster images.
 * A file too big for a function response (4.5 MB on Vercel) is sent as a redirect to a one-minute
 * signed link to the private store.
 */

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_INLINE_BYTES = 4_000_000
const SIGNED_URL_TTL_MS = 60_000

const LOCKED_DOWN = { "x-content-type-options": "nosniff", "content-security-policy": "sandbox" }

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOfficer()
  } catch {
    return NextResponse.json({ error: "Officers only" }, { status: 403, headers: { "cache-control": "no-store" } })
  }

  const { id } = await params
  const variant = (req.nextUrl.searchParams.get("variant") ?? "original") as FileVariant
  if (!UUID.test(id) || !FILE_VARIANTS.includes(variant)) return NextResponse.json({ error: "Bad request" }, { status: 400, headers: { "cache-control": "no-store" } })

  const file = await servableFile(id, variant)
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "no-store" } })

  const store = jackFileStore()
  if (file.size !== null && file.size > MAX_INLINE_BYTES) {
    const signed = await store.signedUrl(file.pathname, SIGNED_URL_TTL_MS, file.inline ? {} : { download: file.filename }).catch(() => null)
    if (signed) return NextResponse.redirect(signed, { status: 302, headers: { "cache-control": "no-store" } })
  }

  const body = await store.get(file.pathname).catch((error) => {
    console.error(`[jack] Couldn't read file ${id} (${variant}) from the store:`, error instanceof Error ? error.message : error)
    return null
  })
  if (!body) return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "no-store" } })

  return new NextResponse(new Uint8Array(body), {
    headers: {
      ...LOCKED_DOWN,
      "content-type": file.contentType,
      "content-length": String(body.length),
      "content-disposition": contentDisposition(file.inline ? "inline" : "attachment", file.filename),
      "cache-control": variant === "thumb" ? "private, max-age=31536000, immutable" : "private, no-store",
    },
  })
}
