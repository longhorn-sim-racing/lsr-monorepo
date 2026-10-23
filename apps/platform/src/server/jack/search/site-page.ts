import { getSiteUrl } from "@/lib/site-url"
import { htmlTitle, htmlToText } from "./html-text"

/**
 * `read` on one of the club site's public pages (design §7.1): the page as a signed-out visitor gets
 * it, fetched from this site with no cookies, as text. Only site paths are allowed, never the admin
 * console, the API, accounts or sign-in, and a redirect is followed only to another allowed path on
 * the same site.
 */

/** Paths `read` never fetches, even though they're on the site */
const BLOCKED_PREFIXES = ["/admin", "/api", "/account", "/auth", "/_next"]

/** The longest path it takes, in characters */
const PATH_MAX = 300
/** The most of a page it reads, in bytes */
export const PAGE_MAX_BYTES = 2_000_000
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

/** Stands in for the site while checking where a path really goes */
const CHECK_ORIGIN = "https://site.invalid"

export type SitePath = { ok: true; path: string } | { ok: false; error: string }

/**
 * Checks a path before anything fetches it, and returns it in the form the site will see it. It must
 * be a path on this site (`^\/(?![/\\])`), with no spaces, control characters or backslashes, no
 * encoded slashes or dots that would change where it goes, and not under a blocked prefix once
 * resolved ("/events/../admin" is /admin).
 */
export function sitePagePath(raw: string): SitePath {
  const path = raw.trim()
  const notPublic = { ok: false as const, error: `${path || "That"} isn't one of the site's public pages. Give a path on the club site, like /lone-star-cup or /events.` }
  if (!/^\/(?![/\\])/.test(path) || path.length > PATH_MAX) return notPublic
  for (const char of path) {
    const code = char.charCodeAt(0)
    if (code <= 0x20 || code === 0x7f || char === "\\") return notPublic
  }
  let resolved: URL
  try {
    resolved = new URL(path, CHECK_ORIGIN)
  } catch {
    return notPublic
  }
  if (resolved.origin !== CHECK_ORIGIN || resolved.pathname.startsWith("//")) return notPublic
  // %2F, %5C and %2E would be read as "/", "\" and "." by the router after this check
  if (/%(2f|5c|2e)/i.test(resolved.pathname)) return notPublic
  let decoded: string
  try {
    decoded = decodeURIComponent(resolved.pathname).toLowerCase()
  } catch {
    return notPublic
  }
  if (BLOCKED_PREFIXES.some((prefix) => decoded === prefix || decoded.startsWith(`${prefix}/`))) {
    return { ok: false, error: `${path} isn't readable: the admin console, the API, accounts and sign-in pages are off-limits.` }
  }
  return { ok: true, path: resolved.pathname + resolved.search }
}

export type SitePage = { ok: true; path: string; title: string | null; text: string } | { ok: false; error: string }

type Fetcher = typeof fetch

/** Reads at most `max` bytes of a response body; null when it's longer */
async function readCapped(response: Response, max: number): Promise<string | null> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * Fetches a public page of the site and returns its text. `fetcher` and `siteUrl` are for tests; the
 * site URL is this deployment's (NEXT_PUBLIC_SITE_URL, the canonical address in production).
 */
export async function readSitePage(
  rawPath: string,
  { signal, fetcher = fetch, siteUrl = getSiteUrl() }: { signal?: AbortSignal; fetcher?: Fetcher; siteUrl?: string } = {},
): Promise<SitePage> {
  const checked = sitePagePath(rawPath)
  if (!checked.ok) return checked
  const origin = new URL(siteUrl).origin
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout

  let path = checked.path
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response
    try {
      response = await fetcher(`${origin}${path}`, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "LSR-Jack/2 (site read)" },
        signal: abort,
      })
    } catch (error) {
      return { ok: false, error: timeout.aborted ? `${path} took too long to load.` : `Couldn't load ${path}: ${error instanceof Error ? error.message : "network error"}.` }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      await response.body?.cancel().catch(() => {})
      if (!location) return { ok: false, error: `${path} redirected nowhere.` }
      let next: URL
      try {
        next = new URL(location, `${origin}${path}`)
      } catch {
        return { ok: false, error: `${path} redirected somewhere unreadable.` }
      }
      if (next.origin !== origin) return { ok: false, error: `${path} redirects off the site, so it wasn't read.` }
      const again = sitePagePath(next.pathname + next.search)
      if (!again.ok) return { ok: false, error: `${path} redirects to ${next.pathname}, which isn't a public page (it may need signing in).` }
      path = again.path
      continue
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { ok: false, error: response.status === 404 ? `There's no page at ${path}.` : `${path} answered ${response.status}.` }
    }
    const type = response.headers.get("content-type") ?? ""
    if (!/^text\/(html|plain)\b/i.test(type)) {
      await response.body?.cancel().catch(() => {})
      return { ok: false, error: `${path} isn't a page (${type.split(";")[0] || "unknown type"}).` }
    }
    const body = await readCapped(response, PAGE_MAX_BYTES)
    if (body === null) return { ok: false, error: `${path} is too large to read.` }
    const html = /^text\/html/i.test(type)
    return { ok: true, path, title: html ? htmlTitle(body) : null, text: html ? htmlToText(body) : body.trim() }
  }
  return { ok: false, error: `${checked.path} redirects too many times.` }
}
