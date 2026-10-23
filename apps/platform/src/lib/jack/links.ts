import { safeHref } from "./reply-markdown"

/**
 * Links in Jack's parts (#188, design §7.5). Every outside link shows where it goes, read from the URL
 * itself, so a link can't claim to be somewhere it isn't. Pure, so the renderers and the tests share it.
 */

/**
 * Where a web link goes, to show beside it: the hostname without "www." ("discord.com"). Hostnames
 * with non-ASCII letters come back in their xn-- form, so a lookalike domain doesn't pass for the real
 * one. Null for site paths and anything that isn't an http(s) link
 */
export function linkHost(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== "https:" && protocol !== "http:") return null
    return hostname.replace(/^www\./, "") || null
  } catch {
    return null
  }
}

/** A link a part can draw: a page of this site, or a web link with its host */
export type PartLink = { href: string; internal: true } | { href: string; internal: false; host: string }

/** Stands in for this site when resolving a path, to check the path stays on it */
const SITE_ORIGIN = "https://site.invalid"

/**
 * Browsers drop tabs and line breaks from a URL and read a backslash as a slash, so "/\t/evil.example"
 * opens evil.example. A link with any of them (or another control character) isn't drawn as a link
 */
function hasUnsafeCharacters(url: string): boolean {
  for (const char of url) {
    const code = char.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f || char === "\\") return true
  }
  return false
}

/**
 * Checks a URL from a tool before a part links it, and returns it in the form the browser will
 * follow. Site paths stay in the app, and only if they still point at this site once resolved
 * ("/a/..//evil.example" doesn't). http(s) links get their host. Anything else (javascript:, data:,
 * mailto:, control characters, backslashes, garbage) is null, and the part shows the text without a link
 */
export function partLink(url: string): PartLink | null {
  const raw = url.trim()
  if (!raw || hasUnsafeCharacters(raw) || !safeHref(raw)) return null
  try {
    if (raw.startsWith("/")) {
      const resolved = new URL(raw, SITE_ORIGIN)
      const path = resolved.pathname + resolved.search + resolved.hash
      if (resolved.origin !== SITE_ORIGIN || path.startsWith("//")) return null
      return { href: path, internal: true }
    }
    const parsed = new URL(raw)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    const host = parsed.hostname.replace(/^www\./, "")
    return host ? { href: parsed.href, internal: false, host } : null
  } catch {
    return null
  }
}

/** A file size for people: "820 B", "14 KB", "2.4 MB" */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1_000) return `${Math.round(bytes)} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`
  if (bytes < 1_000_000_000) return `${trim(bytes / 1_000_000)} MB`
  return `${trim(bytes / 1_000_000_000)} GB`
}

/** One decimal under 10 ("2.4"), none above ("24") */
function trim(value: number): string {
  return value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value))
}
