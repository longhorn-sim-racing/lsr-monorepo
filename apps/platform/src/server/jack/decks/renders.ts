import QRCode from "qrcode"
import type { JackRenderKind } from "@/lib/jack/decks"
import { JACK_ASSET_HOST, renderKey, type SlideSource } from "./document"
import { renderSlide, type AssetResolver } from "./renderer"
import { jackFileStore } from "./storage"

/**
 * Cached slide renders (#177). A render is named by its content (document.ts renderKey), so it never
 * goes stale: change a slide and it gets a new name; undo the change and the old render is found
 * again. Each render keeps its PNG, preview, thumbnail and problem list in the file store.
 */

const RENDERS = "jack/renders"
/** Private images Jack placed (site screenshots), served to the renderer at https://jack.assets/files/<name> */
export const ASSET_FILES = "jack/assets"

const FILES: Record<JackRenderKind, { name: string; type: string }> = {
  png: { name: "full.png", type: "image/png" },
  view: { name: "view.jpg", type: "image/jpeg" },
  thumb: { name: "thumb.jpg", type: "image/jpeg" },
}

export function renderContentType(kind: JackRenderKind) {
  return FILES[kind].type
}

export type SlideRenderResult = {
  key: string
  issues: string[]
  /** The preview, when asked for */
  view?: Buffer
  /** Whether it came from the store rather than a fresh render */
  cached: boolean
  ms: number
}

type RenderMeta = { issues: string[]; ms: number; renderedAt: string }

/** Renders in progress in this instance, by key, so two callers wanting the same slide share one render */
const inFlight = new Map<string, Promise<{ issues: string[]; ms: number; files: Record<JackRenderKind, Buffer> }>>()

/**
 * Makes sure a slide's render exists, rendering it if the store doesn't have it, and returns its
 * problems (and its preview with `withView`).
 */
export async function ensureRender(source: SlideSource, options: { withView?: boolean; signal?: AbortSignal } = {}): Promise<SlideRenderResult> {
  const key = renderKey(source)
  const store = jackFileStore()
  if (store.kind !== "none") {
    const metaFile = await store.get(`${RENDERS}/${key}/meta.json`)
    if (metaFile) {
      const meta = JSON.parse(metaFile.toString("utf8")) as RenderMeta
      const view = options.withView ? await store.get(`${RENDERS}/${key}/${FILES.view.name}`) : undefined
      if (!options.withView || view) return { key, issues: meta.issues, view: view ?? undefined, cached: true, ms: 0 }
    }
  }
  const made = await renderOnce(key, source, options.signal)
  return { key, issues: made.issues, view: options.withView ? made.files.view : undefined, cached: false, ms: made.ms }
}

/** One of a slide's render files, rendering the slide first if needed */
export async function getRenderFile(source: SlideSource, kind: JackRenderKind): Promise<{ key: string; body: Buffer }> {
  const key = renderKey(source)
  const store = jackFileStore()
  const stored = await store.get(`${RENDERS}/${key}/${FILES[kind].name}`)
  if (stored) return { key, body: stored }
  const made = await renderOnce(key, source)
  return { key, body: made.files[kind] }
}

function renderOnce(key: string, source: SlideSource, signal?: AbortSignal) {
  const running = inFlight.get(key)
  if (running) return running
  const work = (async () => {
    const rendered = await renderSlide(source, { assets: resolveJackAsset, signal })
    const files: Record<JackRenderKind, Buffer> = { png: rendered.png, view: rendered.view, thumb: rendered.thumb }
    const store = jackFileStore()
    if (store.kind !== "none") {
      const meta: RenderMeta = { issues: rendered.issues, ms: rendered.ms, renderedAt: new Date().toISOString() }
      // The images first, then meta.json, which is what marks the render complete
      await Promise.all((Object.keys(FILES) as JackRenderKind[]).map((kind) => store.put(`${RENDERS}/${key}/${FILES[kind].name}`, files[kind], FILES[kind].type)))
      await store.put(`${RENDERS}/${key}/meta.json`, Buffer.from(JSON.stringify(meta)), "application/json")
    }
    return { issues: rendered.issues, ms: rendered.ms, files }
  })()
  inFlight.set(key, work)
  work.finally(() => inFlight.delete(key)).catch(() => {})
  return work
}

const MAX_QR_TEXT = 600
const HEX = /^[0-9a-f]{6}$/i

/**
 * Answers https://jack.assets/… for the renderer:
 * - `/qr?text=<url or text>` (optional `dark` and `light`, hex without #): a QR code PNG;
 * - `/files/<name>`: a private image from the file store, like a site screenshot.
 */
export const resolveJackAsset: AssetResolver = async (url) => {
  if (url.host !== JACK_ASSET_HOST) return null
  if (url.pathname === "/qr") {
    const text = url.searchParams.get("text") ?? ""
    if (!text || text.length > MAX_QR_TEXT) return null
    const dark = url.searchParams.get("dark") ?? ""
    const light = url.searchParams.get("light") ?? ""
    const body = await QRCode.toBuffer(text, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 720,
      color: { dark: HEX.test(dark) ? `#${dark}` : "#0B0B0B", light: HEX.test(light) ? `#${light}` : "#FFFFFF" },
    })
    return { body, contentType: "image/png" }
  }
  const file = /^\/files\/([a-z0-9][a-z0-9-]{0,80}\.(png|jpg))$/.exec(url.pathname)
  if (file) {
    const body = await jackFileStore().get(`${ASSET_FILES}/${file[1]}`)
    return body ? { body, contentType: file[2] === "png" ? "image/png" : "image/jpeg" } : null
  }
  return null
}
