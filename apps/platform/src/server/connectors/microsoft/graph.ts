import { fakesEnabledFor, fakesOrigin, serviceBaseUrl } from "../base-url"
import { readCapped, sleep } from "../documents/bytes"
import type { ConnectorEnv } from "../types"

/**
 * A Microsoft Graph client for SharePoint and Teams (design §12.8; research/microsoft-graph.md), app-only
 * with client credentials in UT's tenant. Plain fetch against serviceBaseUrl("microsoft-graph", …) for
 * both the sign-in endpoint and Graph, so JACK_FAKES points both at the one fake.
 *
 * - The token is kept for the client's life (one job run, one webhook's work) and fetched again on a 401.
 * - 429, 503 and 504 are retried after Graph's Retry-After (or a short back-off).
 * - Next-page and delta links are absolute; they're followed only when they point at this Graph base,
 *   so the token never goes anywhere else.
 * - File downloads answer 302 to a pre-signed link, which is fetched without the token and never kept.
 * Errors carry the status, Graph's error code and the path, never the token or the secret.
 */

export const GRAPH_URL = "https://graph.microsoft.com/v1.0"
export const LOGIN_URL = "https://login.microsoftonline.com"
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default"
export const GRAPH_TIMEOUT_MS = 20_000
export const GRAPH_TRANSFER_TIMEOUT_MS = 60_000
/** Tries per call, the first included */
const MAX_ATTEMPTS = 4
const MAX_BACKOFF_MS = 30_000
/** Client-credentials tokens last about an hour; one is replaced 5 minutes early */
const REFRESH_MARGIN_MS = 5 * 60_000

export type GraphCredentials = { tenantId: string; clientId: string; clientSecret: string }

/** MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET; null when any is missing */
export function graphCredentialsFromEnv(env: ConnectorEnv = process.env): GraphCredentials | null {
  const tenantId = env.MS_TENANT_ID?.trim()
  const clientId = env.MS_CLIENT_ID?.trim()
  const clientSecret = env.MS_CLIENT_SECRET?.trim()
  return tenantId && clientId && clientSecret ? { tenantId, clientId, clientSecret } : null
}

export class GraphAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    description = "",
  ) {
    // Microsoft's descriptions start with the AADSTS code and a sentence, then trace ids
    const first = description.split(/\r?\n|Trace ID/)[0].trim().slice(0, 200)
    super(`Microsoft sign-in failed (${status} ${code}${first ? `: ${first}` : ""})`)
    this.name = "GraphAuthError"
  }
}

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly path: string,
    /** A 410 delta resync's Location: where to start enumerating again */
    readonly location: string | null = null,
  ) {
    super(`Microsoft Graph answered ${status}${code ? ` (${code})` : ""} on ${path}`)
    this.name = "GraphApiError"
  }
}

async function errorCode(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).slice(0, 16_384)
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; innerError?: { code?: unknown } } }
    const code = body.error?.innerError?.code ?? body.error?.code
    return typeof code === "string" ? code.slice(0, 80) : ""
  } catch {
    return ""
  }
}

export type GraphClientOptions = {
  env?: ConnectorEnv
  /** The first back-off when Graph gives no Retry-After; it doubles on each retry (tests pass 0) */
  retryDelayMs?: number
}

export type GraphPage<T> = { value: T[]; nextLink: string | null; deltaLink: string | null }

export function graphClient(credentials: GraphCredentials, { env = process.env, retryDelayMs = 1_000 }: GraphClientOptions = {}) {
  const base = serviceBaseUrl("microsoft-graph", GRAPH_URL, env)
  const login = serviceBaseUrl("microsoft-graph", LOGIN_URL, env)
  let token: { value: string; expiresAt: number } | null = null
  let pending: Promise<string> | null = null

  async function signIn(signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(GRAPH_TIMEOUT_MS)
    const response = await fetch(`${login}/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret, scope: GRAPH_SCOPE }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | null
    if (!response.ok || typeof body?.access_token !== "string") {
      throw new GraphAuthError(response.status, typeof body?.error === "string" ? body.error : "no_token", typeof body?.error_description === "string" ? body.error_description : "")
    }
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3599
    token = { value: body.access_token, expiresAt: Date.now() + seconds * 1000 }
    return token.value
  }

  async function accessToken(signal?: AbortSignal): Promise<string> {
    if (token && token.expiresAt - REFRESH_MARGIN_MS > Date.now()) return token.value
    pending ??= signIn(signal).finally(() => {
      pending = null
    })
    return pending
  }

  /** A path under the Graph base, or an absolute link Graph gave (next page, delta) that points at it */
  function urlFor(pathOrUrl: string): string {
    if (!/^https?:\/\//i.test(pathOrUrl)) return `${base}${pathOrUrl}`
    if (!pathOrUrl.startsWith(`${base}/`)) throw new Error("Refusing to follow a Graph link that points somewhere else")
    return pathOrUrl
  }

  const pathOf = (url: string) => new URL(url).pathname.replace(/^\/microsoft-graph/, "")

  async function request(method: string, pathOrUrl: string, { body, signal, timeoutMs = GRAPH_TIMEOUT_MS, headers, redirect }: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string>; redirect?: RequestRedirect } = {}): Promise<Response> {
    const url = urlFor(pathOrUrl)
    let signedInAgain = false
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${await accessToken(signal)}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (response.ok || (redirect === "manual" && response.status >= 300 && response.status < 400)) return response
      if (response.status === 401 && !signedInAgain) {
        await response.body?.cancel().catch(() => {})
        token = null
        signedInAgain = true
        continue
      }
      if ((response.status === 429 || response.status === 503 || response.status === 504) && attempt < MAX_ATTEMPTS) {
        await response.body?.cancel().catch(() => {})
        const after = Number(response.headers.get("retry-after"))
        const wait = Number.isFinite(after) && after >= 0 && response.headers.has("retry-after") ? after * 1000 : retryDelayMs * 2 ** (attempt - 1)
        await sleep(Math.min(wait, MAX_BACKOFF_MS), signal)
        continue
      }
      throw new GraphApiError(response.status, await errorCode(response), pathOf(url), response.headers.get("location"))
    }
  }

  async function json<T>(method: string, pathOrUrl: string, options: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
    const response = await request(method, pathOrUrl, options)
    if (response.status === 204) return null as T
    const text = await response.text()
    return (text ? JSON.parse(text) : null) as T
  }

  /** Where a pre-signed download link may go: https anywhere (SharePoint's own hosts), or the fakes server when fakes are on */
  function downloadAllowed(link: string): boolean {
    try {
      const url = new URL(link)
      if (url.protocol === "https:") return true
      return fakesEnabledFor("microsoft-graph", env) && url.origin === fakesOrigin(env)
    } catch {
      return false
    }
  }

  return {
    get: <T>(pathOrUrl: string, options: { signal?: AbortSignal; headers?: Record<string, string> } = {}) => json<T>("GET", pathOrUrl, options),
    post: <T>(path: string, body: unknown, signal?: AbortSignal) => json<T>("POST", path, { body, signal }),
    patch: <T>(path: string, body: unknown, signal?: AbortSignal) => json<T>("PATCH", path, { body, signal }),
    async delete(path: string, signal?: AbortSignal): Promise<void> {
      await request("DELETE", path, { signal })
    },

    /** One page of a list or delta: its items, and the link to the next page or (on the last page of a delta) the delta link */
    async page<T>(pathOrUrl: string, { signal, headers }: { signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<GraphPage<T>> {
      const body = await json<{ value?: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>("GET", pathOrUrl, { signal, headers })
      return { value: body?.value ?? [], nextLink: body?.["@odata.nextLink"] ?? null, deltaLink: body?.["@odata.deltaLink"] ?? null }
    },

    /**
     * A drive item's bytes; null when it's over `maxBytes`. Graph answers 302 to a short-lived pre-signed
     * link, fetched here without the token; the link itself is never stored or logged
     */
    async download(driveId: string, itemId: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer | null> {
      const path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`
      const response = await request("GET", path, { signal, timeoutMs: GRAPH_TRANSFER_TIMEOUT_MS, redirect: "manual" })
      if (response.status < 300) return readCapped(response, maxBytes)
      const link = response.headers.get("location")
      if (!link || !downloadAllowed(link)) throw new GraphApiError(response.status, "badDownloadLink", path)
      const timeout = AbortSignal.timeout(GRAPH_TRANSFER_TIMEOUT_MS)
      const file = await fetch(link, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if (!file.ok) {
        await file.body?.cancel().catch(() => {})
        throw new GraphApiError(file.status, "downloadFailed", path)
      }
      return readCapped(file, maxBytes)
    },
  }
}

export type GraphClient = ReturnType<typeof graphClient>
