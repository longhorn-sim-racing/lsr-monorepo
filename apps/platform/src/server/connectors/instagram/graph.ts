import { serviceBaseUrl } from "../base-url"
import type { ConnectorEnv } from "../types"

/**
 * The Instagram API with Instagram Login (graph.instagram.com, research/instagram.md), for one token.
 * Each connector builds its own on top: insights (`insights.ts`, the existing read token in SystemSetting
 * "instagram") now, publishing (`instagram-publish`, its own token in SystemSetting "instagram_publish")
 * later, so the read token can never publish. The base URL comes from serviceBaseUrl("instagram", …),
 * so JACK_FAKES (or INSTAGRAM_GRAPH_URL, as for the feed sync) points it at the fake.
 *
 * GETs send the token as `access_token` (as the feed sync does); POSTs send it as a Bearer header with a
 * JSON body (as the publishing guide does). Errors never carry the URL or the token: Meta's error code,
 * subcode and message, and our path.
 */

export const INSTAGRAM_GRAPH_URL = "https://graph.instagram.com"
/** Pinned for every call made here (the feed sync's unversioned calls use the app's default) */
export const INSTAGRAM_API_VERSION = "v26.0"
export const INSTAGRAM_TIMEOUT_MS = 20_000

export class InstagramGraphError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** Meta's error code: 190 token dead, 10 or 200-299 permission missing, 100 bad parameter or metric, 4/17/80002 throttled */
    readonly code: number | null,
    readonly subcode: number | null,
    detail?: string,
  ) {
    super(`Instagram answered ${status}${code !== null ? ` (code ${code}${subcode !== null ? `/${subcode}` : ""})` : ""} on ${path}${detail ? `: ${detail}` : ""}`)
    this.name = "InstagramGraphError"
  }

  /** The token is dead (expired, revoked, a password change): someone pastes a new one */
  get expiredToken() {
    return this.code === 190
  }

  /** The token lacks a permission this call needs */
  get missingPermission() {
    return this.code === 10 || (this.code !== null && this.code >= 200 && this.code <= 299)
  }

  /** Meta is rate limiting the app or the account */
  get throttled() {
    return this.code === 4 || this.code === 17 || this.code === 613 || this.code === 80002
  }
}

type Params = Record<string, string | number | undefined>
type GraphErrorBody = { error?: { message?: string; code?: number; error_subcode?: number } }

export function instagramGraph(token: string, env: ConnectorEnv = process.env) {
  const base = serviceBaseUrl("instagram", env.INSTAGRAM_GRAPH_URL || INSTAGRAM_GRAPH_URL, env).replace(/\/+$/, "")

  /** `path` is the API path alone ("/me"); the query (with the token) never reaches an error */
  async function send<T>(path: string, query: URLSearchParams | null, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(INSTAGRAM_TIMEOUT_MS)
    const url = `${base}/${INSTAGRAM_API_VERSION}${path}${query ? `?${query}` : ""}`
    const response = await fetch(url, { ...init, cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    const body = (await response.json().catch(() => ({}))) as T & GraphErrorBody
    if (!response.ok || body.error) {
      throw new InstagramGraphError(response.status, path, body.error?.code ?? null, body.error?.error_subcode ?? null, body.error?.message?.slice(0, 200))
    }
    return body
  }

  return {
    /** A GET on the pinned version, e.g. get("/me", { fields: "user_id" }) */
    get<T>(path: string, params: Params = {}, signal?: AbortSignal): Promise<T> {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value))
      query.set("access_token", token)
      return send<T>(path, query, {}, signal)
    },
    /** A POST with a JSON body (publishing) */
    post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
      return send<T>(path, null, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }, signal)
    },
  }
}

export type InstagramGraph = ReturnType<typeof instagramGraph>
