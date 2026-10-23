import { formatDistanceToNow } from "date-fns"
import { defineConnector } from "../define"
import type { ConnectorEnv } from "../types"
import { isUnauthorized, parseTwitchDuration, TWITCH_SCOPES, twitchApi, type TwitchApi } from "./client"
import { readTwitchSettings, settingsTwitchTokens, TwitchReconnectError, twitchAccountView, type TwitchTokenSource } from "./tokens"

/**
 * The Twitch connector (#188, design §12.2): the club channel's live status, past broadcasts (VODs) and
 * follower total, read with the club's own Twitch app. Public calls use the app token; the follower
 * total uses the club account's grant (`moderator:read:followers`), which an admin connects once on
 * Content → Streams. Webhooks (/api/webhooks/twitch) and the jobs in `sync.ts` write what it reads into
 * TwitchStream, TwitchViewerSample and TwitchChannelDaily; Jack and the pages read those tables.
 */

export const TWITCH_CONNECTOR_ID = "twitch"

export const TWITCH_ENV = ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_BROADCASTER_ID", "TWITCH_EVENTSUB_SECRET"]

export type TwitchLiveStream = { id: string; title: string; gameName: string | null; viewers: number; startedAt: Date }

export type TwitchVideo = { id: string; streamId: string | null; title: string; createdAt: Date; seconds: number; views: number; url: string }

type HelixStream = { id: string; user_id: string; type: string; title: string; game_name?: string; viewer_count: number; started_at: string }
type HelixVideo = { id: string; stream_id: string | null; title: string; created_at: string; duration: string; view_count: number; url: string; type: string }
type Page<T> = { data: T[]; pagination?: { cursor?: string } }

/**
 * The club channel through Helix, with tokens from `tokens` (SystemSetting "twitch" by default). A call
 * Twitch answers 401 gets a fresh token (minted, or refreshed for the club account) and runs once more.
 */
export function twitchClient(env: ConnectorEnv = process.env, tokens: TwitchTokenSource = settingsTwitchTokens) {
  const api = twitchApi({ clientId: env.TWITCH_CLIENT_ID ?? "", clientSecret: env.TWITCH_CLIENT_SECRET ?? "" }, env)
  const broadcasterId = env.TWITCH_BROADCASTER_ID ?? ""

  async function withToken<T>(which: "app" | "user", call: (token: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const get = (failed?: string) => (which === "app" ? tokens.app(api, { failed, signal }) : tokens.user(api, { failed, signal }))
    const token = await get()
    try {
      return await call(token)
    } catch (error) {
      if (!isUnauthorized(error)) throw error
      return call(await get(token))
    }
  }
  const app = <T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal) => withToken("app", (token) => api.helix<T>(path, { token, params, signal }), signal)

  return {
    api,
    broadcasterId,

    /** The channel's account, or null when TWITCH_BROADCASTER_ID names nobody */
    async user(signal?: AbortSignal): Promise<{ id: string; login: string; displayName: string } | null> {
      const { data } = await app<Page<{ id: string; login: string; display_name: string }>>("/users", { id: broadcasterId }, signal)
      const found = data[0]
      return found ? { id: found.id, login: found.login, displayName: found.display_name } : null
    },

    /** The live stream, or null while offline. Get Streams lags and can flap, so one null isn't proof the stream ended */
    async liveStream(signal?: AbortSignal): Promise<TwitchLiveStream | null> {
      const { data } = await app<Page<HelixStream>>("/streams", { user_id: broadcasterId }, signal)
      const stream = data.find((s) => s.user_id === broadcasterId && s.type === "live")
      if (!stream) return null
      return { id: stream.id, title: stream.title ?? "", gameName: stream.game_name || null, viewers: Math.max(0, Number(stream.viewer_count) || 0), startedAt: new Date(stream.started_at) }
    },

    /** The channel's current title and category; answers while offline too */
    async channel(signal?: AbortSignal): Promise<{ title: string; gameName: string | null } | null> {
      const { data } = await app<Page<{ title: string; game_name?: string }>>("/channels", { broadcaster_id: broadcasterId }, signal)
      return data[0] ? { title: data[0].title ?? "", gameName: data[0].game_name || null } : null
    },

    /** Past broadcasts, newest first, up to `max` (100 a page). Twitch deletes them after a while, which is why the daily job keeps their numbers */
    async archiveVideos({ max = 100, signal }: { max?: number; signal?: AbortSignal } = {}): Promise<TwitchVideo[]> {
      const videos: TwitchVideo[] = []
      let after: string | undefined
      do {
        const page = await app<Page<HelixVideo>>("/videos", { user_id: broadcasterId, type: "archive", sort: "time", first: Math.min(100, max - videos.length), after }, signal)
        for (const v of page.data) {
          videos.push({ id: v.id, streamId: v.stream_id || null, title: v.title ?? "", createdAt: new Date(v.created_at), seconds: parseTwitchDuration(v.duration ?? ""), views: Math.max(0, Number(v.view_count) || 0), url: v.url })
        }
        after = page.data.length ? page.pagination?.cursor : undefined
      } while (after && videos.length < max)
      return videos
    },

    /** The follower total, with the club account's token (only `total` is kept: the list names other people) */
    async followerTotal(signal?: AbortSignal): Promise<number> {
      const page = await withToken("user", (token) => api.helix<{ total: number }>("/channels/followers", { token, params: { broadcaster_id: broadcasterId, first: 1 }, signal }), signal)
      return Math.max(0, Number(page.total) || 0)
    },

    /**
     * Twitch's hourly validation of the club account's token (it audits apps that skip it). A token it
     * no longer accepts is refreshed once; a refresh it refuses marks the account for reconnecting
     */
    async checkClubAccount(signal?: AbortSignal): Promise<{ login: string; scopes: string[]; expiresIn: number }> {
      let token = await tokens.user(api, { signal })
      let info = await api.validate(token, signal)
      if (!info) {
        token = await tokens.user(api, { failed: token, signal })
        info = await api.validate(token, signal)
      }
      if (!info) throw new TwitchReconnectError("Twitch doesn't accept the club account's token, even just after refreshing it.")
      if (info.user_id !== broadcasterId) throw new TwitchReconnectError(`The connected Twitch account isn't the club channel (TWITCH_BROADCASTER_ID); connect the club account again on Content → Streams.`)
      const missing = TWITCH_SCOPES.filter((scope) => !(info.scopes ?? []).includes(scope))
      if (missing.length) throw new TwitchReconnectError(`The club account's grant lacks ${missing.join(", ")}; connect it again on Content → Streams.`)
      await tokens.validated?.(new Date())
      return { login: info.login ?? "", scopes: info.scopes ?? [], expiresIn: info.expires_in }
    },

    /** Validates the cached app token (a new one is minted when Twitch no longer accepts it) */
    async checkAppToken(signal?: AbortSignal): Promise<void> {
      const token = await tokens.app(api, { signal })
      if (!(await api.validate(token, signal))) await tokens.app(api, { failed: token, signal })
    },
  }
}

export type TwitchClient = ReturnType<typeof twitchClient>

/** The connector's own api, for the connect flow and the setup script (they run before the connector is switched on) */
export function twitchAppApi(env: ConnectorEnv = process.env): TwitchApi {
  return twitchApi({ clientId: env.TWITCH_CLIENT_ID ?? "", clientSecret: env.TWITCH_CLIENT_SECRET ?? "" }, env)
}

const ago = (iso: string | null) => (iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : null)

export const twitchConnector = defineConnector<TwitchClient>({
  id: TWITCH_CONNECTOR_ID,
  label: "Twitch",
  requiredEnv: TWITCH_ENV,
  // The club account's grant: without it there's no follower total, so the connector isn't set up yet
  async missingSettings() {
    return (await readTwitchSettings()).user ? [] : ["twitch"]
  },
  createClient: (env) => twitchClient(env),
  // Works while switched off: builds its own client instead of calling client()
  async smoke({ signal } = {}) {
    const client = twitchClient(process.env)
    const user = await client.user(signal)
    if (!user) return { ok: false, summary: `Twitch has no user with the id in TWITCH_BROADCASTER_ID (${client.broadcasterId}).` }
    const live = await client.liveStream(signal)
    const account = twitchAccountView(await readTwitchSettings())
    let club = "the club account isn't connected yet (Content → Streams)"
    if (account.connected) {
      const checked = await client.checkClubAccount(signal)
      const total = await client.followerTotal(signal)
      club = `club account @${checked.login} OK, ${total} followers`
    }
    return { ok: true, summary: `Read @${user.login}, ${live ? `live now with ${live.viewers} viewers` : "offline"}; ${club}` }
  },
  async details() {
    const account = twitchAccountView(await readTwitchSettings())
    if (account.reconnect) return [{ label: "Club account", value: `Needs connecting again (Content → Streams): ${account.reconnect.reason}` }]
    if (!account.connected) return [{ label: "Club account", value: "Not connected: an admin connects it on Content → Streams" }]
    const checked = ago(account.validatedAt)
    return [{ label: "Club account", value: `@${account.login}${checked ? `, checked ${checked}` : ""}` }]
  },
})
