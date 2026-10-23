import { CANONICAL_SITE_URL } from "@/lib/site-url"
import { serviceBaseUrl } from "../base-url"
import type { ConnectorEnv } from "../types"
import { discordRateLimiter, discordRoute, type DiscordRateLimiter, type DiscordRoute } from "./rate-limit"
import type {
  DiscordApplication,
  DiscordChannel,
  DiscordGuild,
  DiscordMember,
  DiscordMessage,
  DiscordSearchParams,
  DiscordSearchResponse,
  DiscordThreadList,
  DiscordUser,
} from "./types"

/**
 * The club's Discord bot over REST (design §12.1, research/discord.md): no gateway. Every request carries
 * the bot token and Discord's User-Agent, has a timeout (kept when the caller passes a signal too), waits
 * out per-route rate limits and retries a 429 after its `retry_after`. A 401 is never retried: the client
 * stops calling Discord altogether, since every 401, 403 and 429 counts toward Discord's invalid-request
 * ban. Errors carry the status, Discord's code and the route with ids as placeholders, never the token.
 *
 * Reading (this track) uses the typed methods; posting (discord-post) builds on `request`.
 */

export const DISCORD_API_URL = "https://discord.com/api/v10"

/** Discord asks for this shape (research §3: requests without a valid User-Agent may be blocked) */
export const DISCORD_USER_AGENT = `DiscordBot (${CANONICAL_SITE_URL}, 1.0)`

/** The longest one request may take */
export const DISCORD_TIMEOUT_MS = 15_000

/** The longest the client waits out a rate limit before giving up on the call (the caller's signal can stop it sooner) */
export const DISCORD_MAX_WAIT_MS = 15_000

/** How many times a 429 (and a GET's 5xx) is retried */
const MAX_RETRIES = 3

/** Discord's JSON error codes worth naming (research §3) */
export const DISCORD_ERROR = {
  unknownChannel: 10003,
  unknownGuild: 10004,
  unknownMember: 10007,
  unknownMessage: 10008,
  missingAccess: 50001,
  missingPermissions: 50013,
  indexNotReady: 110000,
} as const

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    /** Discord's JSON error code (50001 Missing Access), when it sent one */
    readonly code: number | null,
    /** "GET /channels/:id/messages" */
    readonly route: string,
    detail?: string,
  ) {
    super(`Discord answered ${status}${code ? ` (code ${code}${detail ? ` ${detail}` : ""})` : detail ? ` (${detail})` : ""} on ${route}`)
    this.name = "DiscordApiError"
  }
}

/** A rate limit longer than the client waits; the next run picks up from here */
export class DiscordRateLimitError extends DiscordApiError {
  constructor(
    route: string,
    readonly retryAfterMs: number,
  ) {
    super(429, null, route, `rate limited for ${Math.ceil(retryAfterMs / 1000)} s`)
    this.name = "DiscordRateLimitError"
  }
}

type QueryValue = string | number | boolean | undefined | null | readonly (string | number)[]

export type DiscordRequestOptions = {
  query?: Record<string, QueryValue>
  /** Sent as JSON */
  body?: unknown
  signal?: AbortSignal
  /** Shown in the server's audit log (X-Audit-Log-Reason), for writes */
  auditReason?: string
}

export type DiscordResponse<T> = { status: number; data: T; headers: Headers }

export type DiscordClientOptions = {
  token: string
  guildId: string
  env?: ConnectorEnv
  timeoutMs?: number
  /** The longest a rate limit is waited out before the call fails with DiscordRateLimitError */
  maxWaitMs?: number
  limiter?: DiscordRateLimiter
}

/** Waits `ms`, or rejects with the signal's reason when it aborts first */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Repeats a key for each value of a list (`?channel_id=1&channel_id=2`), as Discord reads arrays */
export function queryString(query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item))
    else params.append(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ""
}

async function errorBody(response: Response): Promise<{ code: number | null; message: string | undefined; retryAfter: number | undefined; global: boolean }> {
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown; retry_after?: unknown; global?: unknown } | null
  return {
    code: typeof body?.code === "number" && body.code > 0 ? body.code : null,
    // Discord's messages are fixed strings ("Missing Access"); capped all the same
    message: typeof body?.message === "string" ? body.message.slice(0, 120) : undefined,
    retryAfter: typeof body?.retry_after === "number" ? body.retry_after : undefined,
    global: body?.global === true,
  }
}

/** The bot's REST access: one request at a time through the shared rate limiter */
export function discordRest(options: Omit<DiscordClientOptions, "guildId">) {
  const base = serviceBaseUrl("discord", DISCORD_API_URL, options.env)
  const timeoutMs = options.timeoutMs ?? DISCORD_TIMEOUT_MS
  const maxWaitMs = options.maxWaitMs ?? DISCORD_MAX_WAIT_MS
  const limiter = options.limiter ?? discordRateLimiter
  let unauthorized: DiscordApiError | null = null

  async function waitFor(route: DiscordRoute, ms: number, signal?: AbortSignal) {
    if (ms <= 0) return
    if (ms > maxWaitMs) throw new DiscordRateLimitError(route.route, ms)
    await sleep(ms, signal)
  }

  async function request<T>(method: string, path: string, { query, body, signal, auditReason }: DiscordRequestOptions = {}): Promise<DiscordResponse<T>> {
    if (unauthorized) throw unauthorized
    const route = discordRoute(method, path)
    for (let attempt = 0; ; attempt++) {
      await waitFor(route, limiter.delay(route), signal)
      signal?.throwIfAborted()

      const headers = new Headers({ authorization: `Bot ${options.token}`, "user-agent": DISCORD_USER_AGENT })
      if (body !== undefined) headers.set("content-type", "application/json")
      if (auditReason) headers.set("x-audit-log-reason", encodeURIComponent(auditReason.slice(0, 512)))
      const timeout = AbortSignal.timeout(timeoutMs)
      const response = await fetch(`${base}${path}${queryString(query)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      limiter.update(route, response.headers)

      if (response.status === 429) {
        const info = await errorBody(response)
        const header = Number(response.headers.get("retry-after"))
        const retryAfterMs = Math.ceil((info.retryAfter ?? (Number.isFinite(header) ? header : 1)) * 1000)
        const global = info.global || response.headers.get("x-ratelimit-global") === "true"
        limiter.limited(route, retryAfterMs, global)
        if (attempt >= MAX_RETRIES || retryAfterMs > maxWaitMs) throw new DiscordRateLimitError(route.route, retryAfterMs)
        continue
      }
      if (response.status === 401) {
        const info = await errorBody(response)
        unauthorized = new DiscordApiError(401, info.code, route.route, "the bot token was rejected")
        throw unauthorized
      }
      if (response.status >= 500 && method === "GET" && attempt < MAX_RETRIES - 1) {
        await sleep(500 * (attempt + 1), signal)
        continue
      }
      if (!response.ok) {
        const info = await errorBody(response)
        throw new DiscordApiError(response.status, info.code, route.route, info.message)
      }
      if (response.status === 204) return { status: 204, data: null as T, headers: response.headers }
      const data = (await response.json().catch(() => {
        throw new DiscordApiError(response.status, null, route.route, "the answer wasn't JSON")
      })) as T
      return { status: response.status, data, headers: response.headers }
    }
  }

  return {
    request,
    async get<T>(path: string, options: Omit<DiscordRequestOptions, "body"> = {}): Promise<T> {
      return (await request<T>("GET", path, options)).data
    },
  }
}

export type DiscordRest = ReturnType<typeof discordRest>

export type MessagePage = { after?: string; before?: string; around?: string; limit?: number }

/** How long search waits for Discord to finish indexing (a 202) before saying so, in total */
const SEARCH_INDEX_WAIT_MS = 4_000

/** Search Guild Messages' answer: results, or Discord still building its index (a 202) */
export type DiscordSearchResult = { status: "ok"; total: number; messages: DiscordMessage[] } | { status: "indexing" }

/** The club server's bot: reading channels, messages, members and search (research §3 R1 to R6, H1) */
export function discordClient(options: DiscordClientOptions) {
  const rest = discordRest(options)
  const guild = encodeURIComponent(options.guildId)
  const id = (value: string) => encodeURIComponent(value)

  return {
    guildId: options.guildId,
    rest,
    /** The application and its flags (which privileged intents are on) */
    application: (signal?: AbortSignal) => rest.get<DiscordApplication>("/applications/@me", { signal }),
    /** The bot's own user */
    botUser: (signal?: AbortSignal) => rest.get<DiscordUser>("/users/@me", { signal }),
    guild: (signal?: AbortSignal) => rest.get<DiscordGuild>(`/guilds/${guild}`, { query: { with_counts: true }, signal }),
    /** Every channel the bot can see (no threads; from 2026-11-16 hidden channels are left out) */
    channels: (signal?: AbortSignal) => rest.get<DiscordChannel[]>(`/guilds/${guild}/channels`, { signal }),
    channel: (channelId: string, signal?: AbortSignal) => rest.get<DiscordChannel>(`/channels/${id(channelId)}`, { signal }),
    /** Active threads in the whole server */
    activeThreads: (signal?: AbortSignal) => rest.get<DiscordThreadList>(`/guilds/${guild}/threads/active`, { signal }),
    /** A channel's public archived threads, newest archived first, before an ISO time */
    archivedThreads: (channelId: string, page: { before?: string; limit?: number } = {}, signal?: AbortSignal) =>
      rest.get<DiscordThreadList>(`/channels/${id(channelId)}/threads/archived/public`, { query: { before: page.before, limit: page.limit }, signal }),
    /** A page of a channel's history, newest first (Discord's order). At most one of after, before and around */
    messages: (channelId: string, page: MessagePage = {}, signal?: AbortSignal) =>
      rest.get<DiscordMessage[]>(`/channels/${id(channelId)}/messages`, { query: { after: page.after, before: page.before, around: page.around, limit: page.limit }, signal }),
    message: (channelId: string, messageId: string, signal?: AbortSignal) => rest.get<DiscordMessage>(`/channels/${id(channelId)}/messages/${id(messageId)}`, { signal }),
    /** A page of the member list in user id order (needs the Server Members intent) */
    members: (page: { after?: string; limit?: number } = {}, signal?: AbortSignal) =>
      rest.get<DiscordMember[]>(`/guilds/${guild}/members`, { query: { after: page.after, limit: page.limit ?? 1000 }, signal }),
    /**
     * Search Guild Messages (needs the Message Content intent). A 202 means Discord is still indexing:
     * it's retried after its `retry_after` for a few seconds, then reported as `indexing`
     */
    async search(params: DiscordSearchParams, signal?: AbortSignal): Promise<DiscordSearchResult> {
      const query = {
        content: params.content.slice(0, 1024),
        channel_id: params.channelIds.slice(0, 500),
        limit: Math.min(Math.max(params.limit ?? 25, 1), 25),
        offset: params.offset,
        sort_by: params.sortBy,
        sort_order: params.sortOrder,
      }
      const giveUpAt = Date.now() + SEARCH_INDEX_WAIT_MS
      for (;;) {
        const response = await rest.request<DiscordSearchResponse & { code?: number; retry_after?: number }>("GET", `/guilds/${guild}/messages/search`, { query, signal })
        if (response.status !== 202) return { status: "ok", total: response.data.total_results ?? 0, messages: (response.data.messages ?? []).flat() }
        const wait = Math.max(500, Math.ceil((response.data.retry_after ?? 0) * 1000))
        if (Date.now() + wait > giveUpAt) return { status: "indexing" }
        await sleep(wait, signal)
      }
    },
  }
}

export type DiscordClient = ReturnType<typeof discordClient>
