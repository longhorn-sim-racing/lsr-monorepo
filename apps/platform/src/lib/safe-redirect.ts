/**
 * A `next` / return-to value is only followed when it's a path on this site. Anything
 * else (`https://…`, `//evil.com`, `/\evil.com`, `@evil.com`) would send a freshly
 * signed-in user to another site, so it falls back instead. Backslashes and control
 * characters are refused anywhere: URL parsing drops tabs and newlines, so `/\t/evil.com`
 * would otherwise become `//evil.com` in the browser.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(next)) {
    return fallback;
  }
  return next;
}
