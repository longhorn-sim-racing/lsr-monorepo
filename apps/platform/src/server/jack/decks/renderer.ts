import { existsSync } from "node:fs"
import type { Browser, HTTPRequest, Page } from "puppeteer-core"
import { JACK_DECK_SIZES, type JackDeckSizeKey } from "@/lib/jack/decks"
import { ASSET_ORIGIN, JACK_ASSET_HOST, slideDocument, type SlideSource } from "./document"
import { inspectSlide, INSPECT_KIT_FONTS } from "./inspect"
import { MIN_TEXT_PX } from "./kit-css"

/**
 * Renders slides to images in headless Chromium (#177).
 *
 * - On Vercel it's @sparticuz/chromium (a Chromium built for serverless functions); locally, the
 *   machine's Chrome or Edge, or JACK_CHROME_PATH.
 * - One browser per function instance, kept between renders; each slide gets its own context and page.
 * - JavaScript is off for the page. Every request goes through `routeRequest`: the public site, club
 *   photos on Cloudinary and Google Fonts load; QR codes and private images (jack.assets) are answered
 *   here; everything else, and any navigation, is blocked. No file:// access.
 * - Each render makes the full-size PNG (and a JPEG of it for the downloads), a JPEG preview at most
 *   1280 px on its long side (what Jack looks at, and what the deck page shows), a small JPEG
 *   thumbnail, and a list of problems
 *   (inspect.ts) plus anything that didn't load.
 */

export type RenderedSlide = {
  png: Buffer
  /** Full size as a JPEG, for the PDF and PPTX downloads (a fraction of the PNG's size) */
  jpg: Buffer
  view: Buffer
  thumb: Buffer
  issues: string[]
  ms: number
}

/** Long side of the preview Jack sees (a 1920×1080 slide becomes 1280×720, about 1,200 image tokens) */
export const VIEW_LONG_SIDE = 1280
/** Long side of the room's thumbnails */
export const THUMB_LONG_SIDE = 480

/** Slides rendering at once per function instance */
const MAX_PAGES = 3
/** One slide's whole render: load, fonts, checks and screenshots */
const RENDER_TIMEOUT_MS = 45_000
/**
 * Waiting for the page's images. The first time a photo is asked for at slide size, the site's image
 * optimizer can take a while; past this the render goes ahead with what loaded and says so
 */
const LOAD_TIMEOUT_MS = 20_000
const FONTS_TIMEOUT_MS = 6_000

/** Answers a jack.assets request: a QR code, or a stored private image. Null means not found */
export type AssetResolver = (url: URL) => Promise<{ body: Buffer; contentType: string } | null>

export type RequestRoute =
  | { action: "continue"; url?: string }
  | { action: "asset" }
  | { action: "block"; reason: string }

const ASSET_HOST = new URL(ASSET_ORIGIN).host
/** The site's public images go through its image optimizer, so a 6 MB original arrives as a ~300 KB WebP */
const OPTIMIZABLE = /^\/images\/.+\.(jpe?g|png|webp|avif)$/i

/** What happens to one request a slide makes. Pure, so it's tested directly */
export function routeRequest(rawUrl: string, options: { navigation: boolean }): RequestRoute {
  if (rawUrl.startsWith("data:")) return { action: "continue" }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { action: "block", reason: "not a valid URL" }
  }
  if (options.navigation) return { action: "block", reason: "slides can't navigate" }
  if (url.protocol !== "https:") return { action: "block", reason: "only https URLs load" }
  if (url.username || url.password || (url.port && url.port !== "443")) return { action: "block", reason: "URLs with logins or ports don't load" }
  if (url.host === JACK_ASSET_HOST) return { action: "asset" }
  if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") return { action: "continue" }
  if (url.host === "res.cloudinary.com") return { action: "continue" }
  if (url.host === ASSET_HOST) {
    if (OPTIMIZABLE.test(url.pathname) && !url.search) {
      return { action: "continue", url: `${ASSET_ORIGIN}/_next/image?url=${encodeURIComponent(url.pathname)}&w=2048&q=75` }
    }
    return { action: "continue" }
  }
  return { action: "block", reason: "slides can only load the club site's images, club photos on Cloudinary and Google Fonts" }
}

let browserPromise: Promise<Browser> | null = null

async function launchBrowser(): Promise<Browser> {
  const puppeteer = (await import("puppeteer-core")).default
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chromium = (await import("@sparticuz/chromium")).default
    chromium.setGraphicsMode = false
    return puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      executablePath: await chromium.executablePath(),
      headless: "shell",
      defaultViewport: null,
      protocolTimeout: RENDER_TIMEOUT_MS,
    })
  }
  const executablePath = localChromePath()
  if (!executablePath) {
    throw new Error("No Chrome or Edge found to render slides. Install Chrome, or set JACK_CHROME_PATH to a Chrome or Chromium executable.")
  }
  return puppeteer.launch({ executablePath, headless: true, defaultViewport: null, protocolTimeout: RENDER_TIMEOUT_MS })
}

function localChromePath(): string | null {
  const configured = process.env.JACK_CHROME_PATH?.trim()
  if (configured) return configured
  const candidates =
    process.platform === "win32"
      ? [
          `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  return candidates.find((path) => path && existsSync(path)) ?? null
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null)
    if (browser?.connected) return browser
    browserPromise = null
  }
  const launching = launchBrowser()
  browserPromise = launching
  launching.catch(() => {
    if (browserPromise === launching) browserPromise = null
  })
  return launching
}

/** A tiny semaphore: at most MAX_PAGES slides render at once */
let active = 0
const queue: (() => void)[] = []
async function withPageSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_PAGES) await new Promise<void>((resolve) => queue.push(resolve))
  active++
  try {
    return await work()
  } finally {
    active--
    queue.shift()?.()
  }
}

/** Long side scaled to at most `longSide` (never up) */
export function scaleFor(size: JackDeckSizeKey, longSide: number): number {
  const { width, height } = JACK_DECK_SIZES[size]
  return Math.min(1, longSide / Math.max(width, height))
}

export async function renderSlide(source: SlideSource, options: { assets?: AssetResolver; signal?: AbortSignal } = {}): Promise<RenderedSlide> {
  const started = Date.now()
  return withSlidePage(source, options, async (page, network) => {
    const { width, height } = JACK_DECK_SIZES[source.size]
    const issues = await page.evaluate(inspectSlide, { width, height, minFont: MIN_TEXT_PX[source.size], kitFonts: INSPECT_KIT_FONTS })
    const png = Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } }))
    const jpg = Buffer.from(await page.screenshot({ type: "jpeg", quality: 90, clip: { x: 0, y: 0, width, height } }))
    const view = Buffer.from(await page.screenshot({ type: "jpeg", quality: 85, clip: { x: 0, y: 0, width, height, scale: scaleFor(source.size, VIEW_LONG_SIDE) } }))
    const thumb = Buffer.from(await page.screenshot({ type: "jpeg", quality: 78, clip: { x: 0, y: 0, width, height, scale: scaleFor(source.size, THUMB_LONG_SIDE) } }))
    return { png, jpg, view, thumb, issues: [...issues, ...network], ms: Date.now() - started }
  })
}

/**
 * Loads a slide on its own page (fonts ready, every request filtered) and hands the page to `work`,
 * with the list of what didn't load. One slot of MAX_PAGES; the whole thing times out at RENDER_TIMEOUT_MS
 */
async function withSlidePage<T>(
  source: SlideSource,
  options: { assets?: AssetResolver; signal?: AbortSignal },
  work: (page: Page, network: string[]) => Promise<T>
): Promise<T> {
  return withPageSlot(async () => {
    const browser = await getBrowser()
    // Each slide gets its own context (its own window). Pages sharing one go to the background when
    // another is closed, and a background page's next screenshot waits for a frame that never comes
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => void page.close().catch(() => {})
    options.signal?.addEventListener("abort", stop, { once: true })
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`rendering took over ${RENDER_TIMEOUT_MS / 1000} s`)), RENDER_TIMEOUT_MS)
      })
      const run = async () => work(page, await loadSlide(page, source, options))
      return await Promise.race([run(), timeout])
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", stop)
      await page.close().catch(() => {})
      await context.close().catch(() => {})
    }
  })
}

async function loadSlide(page: Page, source: SlideSource, options: { assets?: AssetResolver }): Promise<string[]> {
  const { width, height } = JACK_DECK_SIZES[source.size]
  const network: string[] = []
  const note = (line: string) => {
    if (network.length < 6 && !network.includes(line)) network.push(line)
  }

  await page.setJavaScriptEnabled(false)
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  await page.setRequestInterception(true)
  page.on("request", (request) => void handleRequest(request, options.assets, note))
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "failed"
    if (!reason.includes("BLOCKED_BY_CLIENT")) note(`Couldn't load ${shortUrl(request.url())} (${reason}).`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) note(`Couldn't load ${shortUrl(response.url())} (HTTP ${response.status()}).`)
  })

  try {
    await page.setContent(slideDocument(source), { waitUntil: "load", timeout: LOAD_TIMEOUT_MS })
  } catch (error) {
    if (!(error instanceof Error && error.name === "TimeoutError")) throw error
    note(`Some images were still loading after ${LOAD_TIMEOUT_MS / 1000} s, so this render may be missing them. Render it again.`)
  }
  // Bundlers can wrap functions in a __name() helper that doesn't exist inside the page
  await page.evaluate("globalThis.__name = (f) => f")
  await Promise.race([page.evaluate(() => document.fonts.ready.then(() => true)), new Promise((resolve) => setTimeout(resolve, FONTS_TIMEOUT_MS))])
  return network
}

async function handleRequest(request: HTTPRequest, assets: AssetResolver | undefined, note: (line: string) => void) {
  if (request.isInterceptResolutionHandled()) return
  const url = request.url()
  const isNavigation = request.isNavigationRequest() && !url.startsWith("data:") && url !== "about:blank"
  const route = routeRequest(url, { navigation: isNavigation })
  try {
    if (route.action === "continue") return await request.continue(route.url ? { url: route.url } : undefined)
    if (route.action === "block") {
      note(`Blocked ${shortUrl(url)}: ${route.reason}.`)
      return await request.abort("blockedbyclient")
    }
    const found = assets ? await assets(new URL(url)).catch(() => null) : null
    if (!found) {
      note(`Couldn't load ${shortUrl(url)} (not found).`)
      return await request.respond({ status: 404, contentType: "text/plain", body: "not found" })
    }
    return await request.respond({ status: 200, contentType: found.contentType, body: found.body, headers: { "cache-control": "no-store" } })
  } catch {
    // The page closed (a timeout or a cancel) while this request was in flight
  }
}

function shortUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 119)}…` : url
}

/** The public pages Jack may screenshot (path prefixes); never the admin console, sign-in or anyone's account */
const PUBLIC_PAGES = ["/about", "/apply", "/drivers", "/events", "/gallery", "/lone-star-cup", "/news", "/privacy", "/terms", "/sponsors", "/shop"]

export function isScreenshotPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || /[\s\\]/.test(path)) return false
  const pathname = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/"
  return pathname === "/" || PUBLIC_PAGES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export const SCREENSHOT_DEVICES = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
} as const

/**
 * A screenshot of one of the club site's public pages, as a signed-out visitor sees it, for a slide
 * (#177). Unlike a slide, the page is the club's own site, so its JavaScript runs; the browser stays
 * on the site (other navigation is blocked) and only fetches with GET. `fullPage` captures the whole
 * scroll height, up to 4 screens.
 */
export async function screenshotSite(
  path: string,
  options: { device: keyof typeof SCREENSHOT_DEVICES; fullPage?: boolean }
): Promise<{ png: Buffer; preview: Buffer; width: number; height: number }> {
  if (!isScreenshotPath(path)) throw new Error(`${path} isn't one of the site's public pages`)
  const device = SCREENSHOT_DEVICES[options.device]
  return withPageSlot(async () => {
    const browser = await getBrowser()
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = async () => {
        await page.setViewport(device)
        if (device.isMobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
        await page.setRequestInterception(true)
        const origin = new URL(ASSET_ORIGIN).origin
        page.on("request", (request) => {
          if (request.isInterceptResolutionHandled()) return
          const url = request.url()
          const offSite = request.isNavigationRequest() && request.frame() === page.mainFrame() && !url.startsWith(`${origin}/`)
          const allowed = !offSite && request.method() === "GET" && (url.startsWith("https://") || url.startsWith("data:") || url.startsWith("blob:"))
          void (allowed ? request.continue() : request.abort("blockedbyclient")).catch(() => {})
        })
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle2", timeout: 25_000 }).catch((error: unknown) => {
          if (!(error instanceof Error && error.name === "TimeoutError")) throw error
        })
        // Let entrance animations finish
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        const height = options.fullPage ? Math.min(await page.evaluate(() => document.documentElement.scrollHeight), device.height * 4) : device.height
        const clip = { x: 0, y: 0, width: device.width, height }
        const png = Buffer.from(await page.screenshot({ type: "png", clip, captureBeyondViewport: true }))
        // What Jack looks at: at most 1280 px on the long side, like a slide preview
        // (the device pixel ratio multiplies on top of the clip's scale)
        const scale = Math.min(1, VIEW_LONG_SIDE / (Math.max(device.width, height) * device.deviceScaleFactor))
        const preview = Buffer.from(await page.screenshot({ type: "jpeg", quality: 82, clip: { ...clip, scale }, captureBeyondViewport: true }))
        return { png, preview, width: device.width * device.deviceScaleFactor, height: height * device.deviceScaleFactor }
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the screenshot took over 45 s")), RENDER_TIMEOUT_MS)
      })
      return await Promise.race([work(), timeout])
    } finally {
      clearTimeout(timer)
      await page.close().catch(() => {})
      await context.close().catch(() => {})
    }
  })
}

/** Closes the browser (scripts and tests; a function instance just keeps it) */
export async function closeRenderer(): Promise<void> {
  const pending = browserPromise
  browserPromise = null
  const browser = await pending?.catch(() => null)
  await browser?.close().catch(() => {})
}
