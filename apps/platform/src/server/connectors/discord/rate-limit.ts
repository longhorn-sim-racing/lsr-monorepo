/**
 * Discord's rate limits (research §5). Per-route numbers aren't published, so they're read from each
 * response: `X-RateLimit-Bucket` names the bucket a route shares, `-Remaining` and `-Reset-After` say
 * when it frees up. Limits apply per bucket and per top-level resource (the channel, guild or webhook in
 * the path), so that's the key. A 429 says how long to wait (`retry_after`), for one bucket or, when
 * `global`, for everything.
 */

/** One request's route, as Discord counts it: the path with ids as placeholders, and its top-level resource */
export type DiscordRoute = {
  /** "GET /channels/:id/messages"; also what error messages show, so it never holds an id or a token */
  route: string
  /** The channel, guild or webhook id in the path ("" when there's none) */
  major: string
}

const MAJOR_RESOURCES = new Set(["channels", "guilds", "webhooks"])

/** The route of a request: ids (and a webhook's token) become placeholders; the first channel, guild or webhook id is its major parameter */
export function discordRoute(method: string, path: string): DiscordRoute {
  const segments = path.split(/[?#]/)[0].split("/").filter(Boolean)
  let major = ""
  const template = segments.map((segment, i) => {
    const previous = segments[i - 1]
    if (/^\d{5,}$/.test(segment)) {
      if (!major && previous && MAJOR_RESOURCES.has(previous)) major = segment
      return ":id"
    }
    // A webhook's token follows its id, and is a secret: never part of a key or a message
    if (segments[i - 2] === "webhooks" && /^\d{5,}$/.test(previous ?? "")) return ":token"
    return segment
  })
  return { route: `${method.toUpperCase()} /${template.join("/")}`, major }
}

export class DiscordRateLimiter {
  /** A route's bucket, as Discord named it */
  private readonly buckets = new Map<string, string>()
  /** When an exhausted bucket (per major) frees up, epoch ms */
  private readonly blocked = new Map<string, number>()
  private globalUntil = 0

  constructor(private readonly now: () => number = Date.now) {}

  private key(route: DiscordRoute): string {
    return `${this.buckets.get(route.route) ?? route.route}|${route.major}`
  }

  /** How long to wait before sending a request on this route, in ms (0 when it can go now) */
  delay(route: DiscordRoute): number {
    const now = this.now()
    const until = this.blocked.get(this.key(route)) ?? 0
    if (until <= now) this.blocked.delete(this.key(route))
    return Math.max(0, this.globalUntil - now, until - now)
  }

  /** Reads a response's headers: a bucket with nothing left blocks until it resets */
  update(route: DiscordRoute, headers: Headers): void {
    const bucket = headers.get("x-ratelimit-bucket")
    if (bucket) this.buckets.set(route.route, bucket)
    const remaining = headers.get("x-ratelimit-remaining")
    const resetAfter = Number(headers.get("x-ratelimit-reset-after"))
    if (remaining !== null && Number(remaining) <= 0 && Number.isFinite(resetAfter) && resetAfter > 0) {
      this.blocked.set(this.key(route), this.now() + resetAfter * 1000)
    }
  }

  /** After a 429: blocks the route's bucket, or every route when the limit was global */
  limited(route: DiscordRoute, retryAfterMs: number, global: boolean): void {
    const until = this.now() + Math.max(0, retryAfterMs)
    if (global) this.globalUntil = Math.max(this.globalUntil, until)
    else this.blocked.set(this.key(route), Math.max(this.blocked.get(this.key(route)) ?? 0, until))
  }
}

/** One limiter per process, shared by every client: the sync, search and the admin page all use the same bot */
export const discordRateLimiter = new DiscordRateLimiter()
