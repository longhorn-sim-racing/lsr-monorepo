import { serviceBaseUrl } from "../base-url"
import type { ConnectorEnv } from "../types"

/**
 * Twitch's HTTP APIs (#188, design §12.2; research/twitch.md): Helix for the channel's streams, videos
 * and followers, and the OAuth server for tokens. Plain fetch, both base URLs from serviceBaseUrl(), so
 * JACK_FAKES points them at the fake (`fake/handlers.ts`, mounted at /twitch). Tokens are passed in per
 * call; `tokens.ts` keeps them. Errors carry the status, the path and Twitch's own message, never a token.
 */

export const TWITCH_HELIX_URL = "https://api.twitch.tv/helix"
export const TWITCH_AUTH_URL = "https://id.twitch.tv/oauth2"

/** The one scope the club account grants: the follower total (and stream.online then costs nothing) */
export const TWITCH_SCOPES = ["moderator:read:followers"] as const

/** The longest any one call may take, even when the caller passes its own signal */
export const TWITCH_TIMEOUT_MS = 15_000

export class TwitchApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail?: string,
    /** Epoch ms when a 429's rate limit resets (Ratelimit-Reset) */
    readonly retryAt?: number,
  ) {
    super(`Twitch answered ${status} on ${path}${detail ? `: ${detail}` : ""}`)
    this.name = "TwitchApiError"
  }
}

export const isUnauthorized = (error: unknown) => error instanceof TwitchApiError && error.status === 401

export type TwitchCredentials = { clientId: string; clientSecret: string }

/** What /oauth2/token answers */
export type TwitchTokenGrant = { access_token: string; expires_in: number; refresh_token?: string; scope?: string[]; token_type: string }

/** What /oauth2/validate answers for a live token (login and user_id are null for an app token) */
export type TwitchTokenInfo = { client_id: string; login: string | null; scopes: string[] | null; user_id: string | null; expires_in: number }

type Params = Record<string, string | number | readonly string[] | undefined>

/** Twitch's error body is `{ error, status, message }`; its message is short and never holds a token */
async function errorDetail(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null
  return typeof body?.message === "string" && body.message ? body.message.slice(0, 200) : undefined
}

export function twitchApi(credentials: TwitchCredentials, env: ConnectorEnv = process.env) {
  const helixBase = serviceBaseUrl("twitch", TWITCH_HELIX_URL, env)
  const authBase = serviceBaseUrl("twitch", TWITCH_AUTH_URL, env)

  function send(url: string, init: RequestInit, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(TWITCH_TIMEOUT_MS)
    return fetch(url, { ...init, cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  }

  async function fail(response: Response, path: string): Promise<never> {
    const reset = Number(response.headers.get("ratelimit-reset"))
    throw new TwitchApiError(response.status, path, await errorDetail(response), response.status === 429 && reset > 0 ? reset * 1000 : undefined)
  }

  /**
   * One Helix call with an app or user token. Multi-value params repeat (`id=1&id=2`), as Helix wants.
   * A 503 is retried once, as Twitch's guide says; a 429 throws with when the limit resets.
   */
  async function helix<T>(path: string, options: { token: string; params?: Params; method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
    const url = new URL(`${helixBase}${path}`)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value === undefined) continue
      for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(one))
    }
    const headers = new Headers({ authorization: `Bearer ${options.token}`, "client-id": credentials.clientId })
    if (options.body !== undefined) headers.set("content-type", "application/json")
    const init: RequestInit = { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }
    let response = await send(url.toString(), init, options.signal)
    if (response.status === 503) response = await send(url.toString(), init, options.signal)
    if (!response.ok) return fail(response, path)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /** A form POST to the OAuth server; the secret and tokens go in the body, never the URL */
  async function oauthPost<T>(path: string, form: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const response = await send(`${authBase}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }, signal)
    if (!response.ok) return fail(response, `/oauth2${path}`)
    const text = await response.text()
    return (text ? JSON.parse(text) : {}) as T
  }

  const client = { client_id: credentials.clientId, client_secret: credentials.clientSecret }

  return {
    clientId: credentials.clientId,
    helix,
    /** An app access token (client credentials). It can't be refreshed: mint another on a 401 or near expiry */
    mintAppToken: (signal?: AbortSignal) => oauthPost<TwitchTokenGrant>("/token", { ...client, grant_type: "client_credentials" }, signal),
    /** Swaps the club account's authorization code for its first access and refresh tokens */
    exchangeCode: (code: string, redirectUri: string, signal?: AbortSignal) =>
      oauthPost<TwitchTokenGrant>("/token", { ...client, code, grant_type: "authorization_code", redirect_uri: redirectUri }, signal),
    /** A new user access token. The refresh token may rotate, so store the one that comes back */
    refreshUserToken: (refreshToken: string, signal?: AbortSignal) => oauthPost<TwitchTokenGrant>("/token", { ...client, grant_type: "refresh_token", refresh_token: refreshToken }, signal),
    /** What Twitch knows about a token, or null when it's no longer valid (401) */
    async validate(token: string, signal?: AbortSignal): Promise<TwitchTokenInfo | null> {
      const response = await send(`${authBase}/validate`, { headers: { authorization: `OAuth ${token}` } }, signal)
      if (response.status === 401) return null
      if (!response.ok) return fail(response, "/oauth2/validate")
      return (await response.json()) as TwitchTokenInfo
    },
    /** Revokes a token; one Twitch no longer knows counts as revoked */
    async revoke(token: string, signal?: AbortSignal): Promise<void> {
      await oauthPost("/revoke", { client_id: credentials.clientId, token }, signal).catch((error: unknown) => {
        if (!(error instanceof TwitchApiError && error.status === 400)) throw error
      })
    },
    /** Where an admin's browser goes to grant the club account's scope. force_verify shows which Twitch account is signed in, so a personal one isn't granted by mistake */
    authorizeUrl({ redirectUri, state }: { redirectUri: string; state: string }): string {
      const url = new URL(`${authBase}/authorize`)
      url.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: redirectUri, response_type: "code", scope: TWITCH_SCOPES.join(" "), state, force_verify: "true" }).toString()
      return url.toString()
    },
  }
}

export type TwitchApi = ReturnType<typeof twitchApi>

/** "3h21m4s" (Get Videos' duration, which isn't ISO 8601 whatever the docs say) in seconds; 0 when it can't be read */
export function parseTwitchDuration(text: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim())
  if (!match || !text.trim()) return 0
  const [, h = "0", m = "0", s = "0"] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}
