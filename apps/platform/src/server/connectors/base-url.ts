import type { ConnectorEnv } from "./types"

/**
 * Where each outside service's client sends its requests (design §12). Every client builds its base
 * URL with serviceBaseUrl(), so one env var points it at the local HTTP fakes (`pnpm jack:fakes`) and
 * the real client code runs against them:
 *
 *   JACK_FAKES=all              every service
 *   JACK_FAKES=discord,twitch   only these
 *   JACK_FAKES_URL=…            the fakes server, http://127.0.0.1:3999 by default (loopback only)
 *
 * Fakes are never used on Vercel production, whatever the env says.
 */

/** Where `pnpm jack:fakes` listens unless JACK_FAKES_URL says otherwise */
export const DEFAULT_FAKES_URL = "http://127.0.0.1:3999"

/** A service's name in JACK_FAKES and its path on the fakes server: "discord", "google-drive" */
export const FAKE_SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Whether JACK_FAKES points this service at the fakes: "all", or a comma-separated list of service names. Never on Vercel production */
export function fakesEnabledFor(service: string, env: ConnectorEnv = process.env): boolean {
  if (env.VERCEL_ENV === "production") return false
  const names = (env.JACK_FAKES ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  return names.includes("all") || names.includes(service)
}

/**
 * The fakes server's origin, from JACK_FAKES_URL. It must be plain http on a loopback address: in fake
 * mode a client still sends whatever key is in env, so it may only ever go to this machine.
 */
export function fakesOrigin(env: ConnectorEnv = process.env): string {
  const raw = env.JACK_FAKES_URL?.trim() || DEFAULT_FAKES_URL
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`JACK_FAKES_URL isn't a URL: use one like ${DEFAULT_FAKES_URL}`)
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`JACK_FAKES_URL must be http:// on this machine (127.0.0.1, localhost or [::1]), like ${DEFAULT_FAKES_URL}`)
  }
  return url.origin
}

/**
 * The base URL a service's client uses: `realUrl`, or the same path on the fakes server when JACK_FAKES
 * lists the service. "https://discord.com/api/v10" becomes "http://127.0.0.1:3999/discord/api/v10", so a
 * fake's routes use the real API's paths. A client with its own override env var passes it as `realUrl`
 * (`process.env.INSTAGRAM_GRAPH_URL || "https://graph.instagram.com"`); JACK_FAKES still wins.
 */
export function serviceBaseUrl(service: string, realUrl: string, env: ConnectorEnv = process.env): string {
  if (!FAKE_SERVICE_ID.test(service)) throw new Error(`"${service}" isn't a service name (lowercase letters, digits and dashes)`)
  if (!fakesEnabledFor(service, env)) return realUrl
  const url = new URL(realUrl)
  const keepsSlash = realUrl.split(/[?#]/)[0].endsWith("/")
  const path = url.pathname === "/" && !keepsSlash ? "" : url.pathname
  return `${fakesOrigin(env)}/${service}${path}`
}
