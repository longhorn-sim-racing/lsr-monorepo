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

/**
 * Checks a URL from a tool before a part links it: site paths ("/admin/events", never "//host") stay
 * in the app; http(s) links get their host. Anything else (javascript:, data:, mailto:, garbage) is
 * null, and the part shows the text without a link
 */
export function partLink(url: string): PartLink | null {
  const href = safeHref(url.trim())
  if (!href) return null
  if (href.startsWith("/")) return { href, internal: true }
  const host = linkHost(href)
  return host ? { href, internal: false, host } : null
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
