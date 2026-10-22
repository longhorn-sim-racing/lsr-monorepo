import { NextResponse } from "next/server"
import { requireOfficer } from "@/server/auth/guards"
import { renderSlide } from "@/server/jack/decks/renderer"
import { resolveJackAsset } from "@/server/jack/decks/renders"
import { jackFileStore } from "@/server/jack/decks/storage"
import { SLIDE_TEMPLATES } from "@/server/jack/decks/templates"

/**
 * Checks that Jack can render slides here (#177): renders the cover template with the real Chromium
 * and says how long it took and what the layout checks found, then writes a small file to the store
 * renders go to and reads it back. Open it in the browser on a preview or after a deploy; `?image=1`
 * shows the render itself. Officers only.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(req: Request) {
  try {
    await requireOfficer()
  } catch {
    return NextResponse.json({ error: "Officers only" }, { status: 403 })
  }

  const template = SLIDE_TEMPLATES.find((t) => t.name === "cover") ?? SLIDE_TEMPLATES[0]
  const started = Date.now()
  try {
    const rendered = await renderSlide({ size: template.size, css: "", html: template.html }, { assets: resolveJackAsset })
    if (new URL(req.url).searchParams.get("image") === "1") {
      return new NextResponse(new Uint8Array(rendered.view), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } })
    }
    const store = await checkStore()
    return NextResponse.json({
      ok: store.ok,
      template: template.name,
      ms: Date.now() - started,
      renderMs: rendered.ms,
      issues: rendered.issues,
      bytes: { png: rendered.png.length, view: rendered.view.length, thumb: rendered.thumb.length },
      store,
      runtime: process.env.VERCEL ? "vercel (@sparticuz/chromium)" : "local Chrome",
    })
  } catch (error) {
    console.error("[jack] Render check failed:", error)
    return NextResponse.json(
      { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error), store: jackFileStore().kind },
      { status: 500 }
    )
  }
}

/** Writes a small file to the render store and reads it back. "none" means no store is connected: renders work but aren't kept */
async function checkStore(): Promise<{ kind: string; ok: boolean; error?: string; note?: string }> {
  const store = jackFileStore()
  if (store.kind === "none") return { kind: store.kind, ok: true, note: "No Blob store is connected, so renders aren't cached and screenshots don't work" }
  const pathname = `jack/check/${Date.now()}.txt`
  const body = Buffer.from(`render check ${new Date().toISOString()}`)
  try {
    await store.put(pathname, body, "text/plain")
    const back = await store.get(pathname)
    return back?.equals(body) ? { kind: store.kind, ok: true } : { kind: store.kind, ok: false, error: "Wrote a file but couldn't read it back" }
  } catch (error) {
    return { kind: store.kind, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
