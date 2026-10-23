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

/** The club's Cloudinary account (the gallery's photos). Slides may load images from it and no other account */
export function cloudinaryCloudName(): string {
  return process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME?.trim() || "daklxjoxr"
}

/** Where the club's own uploaded images live on Cloudinary. Only this prefix loads; Cloudinary's fetch delivery (which downloads any URL it's given) never does */
export function cloudinaryUploadPrefix(): string {
  return `/${cloudinaryCloudName()}/image/upload/`
}

/** The site's static image folders (apps/platform/public). Nothing else on the site loads from a slide */
export const SITE_IMAGE_FOLDERS = ["/images/", "/brand/", "/sponsors/", "/partners/", "/jack/"]

/** What a slide may load, as the page's CSP says (renderer.ts enforces the same on every request) */
function contentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    `img-src data: https://res.cloudinary.com${cloudinaryUploadPrefix()} ${SITE_IMAGE_FOLDERS.map((folder) => `${ASSET_ORIGIN}${folder}`).join(" ")} https://${JACK_ASSET_HOST}`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    `base-uri ${ASSET_ORIGIN}`,
    "form-action 'none'",
  ].join("; ")
}

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

/**
 * A slide as it renders. `roomId` is the deck's room: photos officers attached there are the only room
 * photos its slides can show (renders.ts checks)
 */
export type SlideSource = { size: JackDeckSizeKey; css: string; html: string; roomId?: string | null }

/** Where a slide loads a photo an officer attached in the deck's room (renders.ts answers it with the photo's model copy) */
export function roomAssetUrl(fileId: string): string {
  return `https://${JACK_ASSET_HOST}/room/${fileId}`
}

export function slideDocument({ size, css, html }: SlideSource): string {
  return `<!doctype html>
<html lang="en" data-size="${size}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">
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
 * CSS, the size and the renderer all match (a restored version finds its old renders too). A deck in a
 * room is named by its room as well, so the same slide in another room's deck never reuses a render
 * showing this room's photos (it renders again, and the photos don't load there). Every slide of such a
 * deck is, not only ones whose text names a room photo: the renderer reads URLs the way a browser does
 * (JACK.ASSETS, /ROOM/, entities and CSS escapes all reach the photo), so the text can't tell
 */
export function renderKey({ size, css, html, roomId }: SlideSource): string {
  const room = roomId ? `\0room:${roomId}` : ""
  return createHash("sha256").update(`v${RENDER_VERSION}\0${size}\0${css}\0${html}${room}`).digest("hex").slice(0, 40)
}
