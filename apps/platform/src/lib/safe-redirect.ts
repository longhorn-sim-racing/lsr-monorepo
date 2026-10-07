/**
 * A `next` / return-to value is only followed when it's a path on this site. Anything
 * else (`https://…`, `//evil.com`, `/\evil.com`, `@evil.com`) would send a freshly
 * signed-in user to another site, so it falls back instead.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
