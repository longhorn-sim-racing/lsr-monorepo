import { createHash } from "node:crypto"
import type { JackDeckSizeKey } from "@/lib/jack/decks"
import { CANONICAL_SITE_URL } from "@/lib/site-url"
import { KIT_CSS } from "./kit-css"

/**
 * The page a slide renders as (#177): the kit stylesheet, the deck's CSS, then the slide's HTML, at
 * the deck's canvas size. Chromium loads it with JavaScript off and only a few hosts reachable
 * (renderer.ts), and officers only ever see the PNG, so the HTML Jack writes never runs in anyone's
 * browser.
 */

/** Bump when the page or the kit changes how a slide looks, so cached renders are made again */
export const RENDER_VERSION = 1

/** Relative URLs in slides (`/images/…`, `/brand/logos/…`) load from the public site */
export const ASSET_ORIGIN = CANONICAL_SITE_URL

/** A made-up host the renderer answers itself: QR codes and private images like site screenshots (renderer.ts) */
export const JACK_ASSET_HOST = "jack.assets"

export const FONTS_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Kanit:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,500;1,600;1,700;1,800;1,900&family=Montserrat:ital,wght@0,400..900;1,400..900&display=block"

/** Hosts a slide may load from, as the page's CSP says (renderer.ts enforces the same list on every request) */
const CSP = [
  "default-src 'none'",
  `img-src data: https://res.cloudinary.com ${ASSET_ORIGIN} https://${JACK_ASSET_HOST}`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  `base-uri ${ASSET_ORIGIN}`,
  "form-action 'none'",
].join("; ")

/**
 * Tags a slide can't use: scripts (JavaScript is off anyway), and anything that would change the page
 * itself (meta refreshes, another base URL, extra stylesheets or fonts, frames and plugins). Removed
 * before rendering; the CSP and the renderer's request filter are the real guard
 */
const STRIPPED_TAGS = /<\s*(script|noscript|iframe|frame|frameset|object|embed|template)\b[\s\S]*?<\s*\/\s*\1\s*>|<\s*\/?\s*(script|meta|base|link|iframe|frame|frameset|object|embed|portal)\b[^>]*>/gi

export function cleanSlideHtml(html: string): string {
  return html.replace(STRIPPED_TAGS, "")
}

/** Keeps the deck's CSS inside its <style> element */
export function cleanCss(css: string): string {
  return css.replace(/<\s*\/\s*style/gi, "<\\/style")
}

export type SlideSource = { size: JackDeckSizeKey; css: string; html: string }

export function slideDocument({ size, css, html }: SlideSource): string {
  return `<!doctype html>
<html lang="en" data-size="${size}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<base href="${ASSET_ORIGIN}/">
<link rel="stylesheet" href="${FONTS_CSS_URL}">
<style>${KIT_CSS}</style>
<style>${cleanCss(css)}</style>
</head>
<body>
${cleanSlideHtml(html)}
</body>
</html>`
}

/**
 * Names a render by what goes into it, so a cached render is reused exactly when the slide, the deck's
 * CSS, the size and the renderer all match (a restored version finds its old renders too)
 */
export function renderKey({ size, css, html }: SlideSource): string {
  return createHash("sha256").update(`v${RENDER_VERSION}\0${size}\0${css}\0${html}`).digest("hex").slice(0, 40)
}
