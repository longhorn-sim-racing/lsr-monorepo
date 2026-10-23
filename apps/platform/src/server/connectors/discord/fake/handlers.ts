import { createHash, randomBytes } from "node:crypto"
import type { FakeRoute, FakeService } from "../../fakes/types"
import { APP_FLAG, CHANNEL_TYPE, THREAD_PARENT_TYPES, THREAD_TYPES, type DiscordChannel, type DiscordMember, type DiscordMessage, type DiscordPoll } from "../types"
import { buildFakeServer, FAKE_DISCORD, fakeSnowflake } from "./data"

/**
 * Discord's REST API and OAuth, faked (research §7), mounted at /discord: "https://discord.com/api/v10"
 * becomes "http://127.0.0.1:3999/discord/api/v10" and the authorize page "/discord/oauth2/authorize".
 * It reproduces what the client depends on:
 * - shapes: snowflake strings, "+00:00" timestamps, members with `user` nested, search's nested lists;
 * - paging: messages newest first with exclusive before/after/around (400 for two), limit 1 to 100
 *   (default 50); members in user id order after `after` (default 1, at most 1000);
 * - intents: without Message Content, blank content and attachments, no poll (except the bot's own
 *   messages) and search answers 403; without Server Members, the member list answers 403 50001;
 * - the hidden channel: not in the channel list, 403 50001 on its history; a deleted channel or thread,
 *   404 10003; archived threads of a channel that can't have threads (voice, stage), 400 50024;
 * - search: 202 with code 110000 on the first call (or every call, with the hook), limit at most 25,
 *   offset at most 9975;
 * - rate limits: X-RateLimit-* headers on every answer, and a forced 429 with retry_after;
 * - OAuth: an authorize page that redirects with code, state and iss; a token endpoint that takes only
 *   form bodies and checks the PKCE verifier; /users/@me; revoke.
 *
 * Test hooks under /_fake: intents, rate-limit, search, polls, oauth, messages, channels, members, state.
 */

const API = "/api/v10"
const ISSUER = "https://discord.com"

type Channel = DiscordChannel & { hidden?: boolean }
type ForcedLimit = { times: number; retryAfter: number; global: boolean; scope: string; path?: string }

const error = (status: number, code: number, message: string, headers?: HeadersInit) => Response.json({ message, code }, { status, headers })
/** A channel as Discord sends it (the fake's own flag left off) */
function shown(channel: Channel, guildId: string): DiscordChannel {
  const copy: Channel = { ...channel, guild_id: guildId }
  delete copy.hidden
  return copy
}
const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00")
const byId = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
const after = (id: string, than: string) => BigInt(id) > BigInt(than)
const before = (id: string, than: string) => BigInt(id) < BigInt(than)

/** The bucket a route shares, as a stable hash of its template (ids out) */
function bucketOf(method: string, path: string): string {
  const template = path.replace(/\d{5,}/g, ":id")
  return createHash("sha256").update(`${method} ${template}`).digest("hex").slice(0, 16)
}

function clamp(value: string | null, fallback: number, min: number, max: number): number {
  const n = value === null ? fallback : Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback
}

export const discordFake: FakeService = {
  id: "discord",
  create() {
    const server = buildFakeServer()
    const intents = { messageContent: true, guildMembers: true }
    const forced: ForcedLimit[] = []
    const oauth = {
      deny: false,
      userId: server.oauthUserId,
      codes: new Map<string, { challenge: string; redirectUri: string; userId: string }>(),
      tokens: new Map<string, string>(),
    }
    let searchReady = false
    let searchStuck = false
    let hidePollResults = false
    let clock = 0

    const channel = (id: string) => server.channels.find((c) => c.id === id)
    const member = (userId: string) => server.members.find((m) => m.user.id === userId)
    const isBot = (request: Request) => request.headers.get("authorization") === `Bot ${FAKE_DISCORD.botToken}`
    const unauthorized = () => error(401, 0, "401: Unauthorized")

    /** A message as the bot sees it: without the Message Content intent, blank (the bot's own messages excepted) */
    function view(message: DiscordMessage): DiscordMessage {
      const shown: DiscordMessage = { ...message }
      if (hidePollResults && message.poll && !message.poll.results?.is_finalized) {
        shown.poll = { ...message.poll }
        delete shown.poll.results
      }
      if (intents.messageContent || message.author.id === server.bot.id) return shown
      delete shown.poll
      return { ...shown, content: "", attachments: [] }
    }

    /** Every API answer goes through here: the rate-limit headers, or a forced 429 */
    function api(handle: (request: Request, params: Record<string, string>) => Response | Promise<Response>, auth: "bot" | "none" = "bot") {
      return async (request: Request, ctx: { params: Record<string, string>; path: string }) => {
        const limit = forced.find((f) => f.times > 0 && (!f.path || ctx.path.includes(f.path)))
        const bucket = bucketOf(request.method, ctx.path)
        if (limit) {
          limit.times--
          return Response.json(
            { message: "You are being rate limited.", retry_after: limit.retryAfter, global: limit.global },
            {
              status: 429,
              headers: {
                "retry-after": String(Math.ceil(limit.retryAfter)),
                "x-ratelimit-scope": limit.scope,
                ...(limit.global ? { "x-ratelimit-global": "true" } : { "x-ratelimit-bucket": bucket, "x-ratelimit-limit": "5", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": String(limit.retryAfter) }),
              },
            },
          )
        }
        if (auth === "bot" && !isBot(request)) return unauthorized()
        const response = await handle(request, ctx.params)
        const headers = new Headers(response.headers)
        headers.set("x-ratelimit-bucket", bucket)
        headers.set("x-ratelimit-limit", "50")
        headers.set("x-ratelimit-remaining", "49")
        headers.set("x-ratelimit-reset-after", "1.000")
        headers.set("x-ratelimit-reset", String(Math.ceil(Date.now() / 1000) + 1))
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
      }
    }

    /** A channel the bot can read, or the error Discord gives */
    function readable(id: string): Channel | Response {
      const found = channel(id)
      if (!found) return error(404, 10003, "Unknown Channel")
      if (found.hidden) return error(403, 50001, "Missing Access")
      return found
    }

    function listMessages(request: Request, { channelId }: Record<string, string>) {
      const found = readable(channelId)
      if (found instanceof Response) return found
      if (found.type === CHANNEL_TYPE.category || found.type === CHANNEL_TYPE.forum || found.type === CHANNEL_TYPE.media) return error(400, 50024, "Cannot execute action on this channel type")
      const url = new URL(request.url)
      const cursors = ["before", "after", "around"].filter((k) => url.searchParams.has(k))
      if (cursors.length > 1) return error(400, 50035, "Invalid Form Body")
      const limit = clamp(url.searchParams.get("limit"), 50, 1, 100)
      const all = server.messages.get(channelId) ?? []
      let page: DiscordMessage[]
      const at = (key: string) => url.searchParams.get(key)!
      if (cursors[0] === "after") page = all.filter((m) => after(m.id, at("after"))).slice(0, limit)
      else if (cursors[0] === "before") page = all.filter((m) => before(m.id, at("before"))).slice(-limit)
      else if (cursors[0] === "around") {
        const older = all.filter((m) => before(m.id, at("around")))
        const rest = all.filter((m) => !before(m.id, at("around")))
        const half = Math.floor(limit / 2)
        page = [...older.slice(-half), ...rest.slice(0, limit - Math.min(half, older.length))]
      } else page = all.slice(-limit)
      return Response.json([...page].reverse().map(view))
    }

    function search(request: Request) {
      if (!intents.messageContent) return error(403, 50001, "Missing Access")
      if (!searchReady || searchStuck) {
        searchReady = true
        return Response.json({ message: "Index not yet available. Try again later", code: 110000, documents_indexed: 0, retry_after: 0 }, { status: 202 })
      }
      const url = new URL(request.url)
      const limit = Number(url.searchParams.get("limit") ?? 25)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isInteger(offset) || offset < 0 || offset > 9975) return error(400, 50035, "Invalid Form Body")
      const words = (url.searchParams.get("content") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/^["']+|["']+$/g, ""))
        .filter(Boolean)
      const channelIds = url.searchParams.getAll("channel_id")
      const scored: { message: DiscordMessage; score: number }[] = []
      for (const [channelId, list] of server.messages) {
        const where = channel(channelId)
        if (!where || where.hidden || (channelIds.length && !channelIds.includes(channelId))) continue
        for (const message of list) {
          const text = message.content.toLowerCase()
          if (!words.length || !words.every((w) => text.includes(w))) continue
          scored.push({ message, score: words.reduce((sum, w) => sum + text.split(w).length - 1, 0) })
        }
      }
      const desc = url.searchParams.get("sort_order") !== "asc"
      if (url.searchParams.get("sort_by") === "timestamp") scored.sort((a, b) => (desc ? -1 : 1) * byId(a.message, b.message))
      else scored.sort((a, b) => b.score - a.score || -byId(a.message, b.message))
      const page = scored.slice(offset, offset + limit)
      return Response.json({ total_results: scored.length, doing_deep_historical_index: false, messages: page.map((s) => [view(s.message)]), threads: [] })
    }

    /** Form bodies only (JSON is rejected, as Discord does), and the app's own client credentials */
    async function oauthForm(request: Request): Promise<URLSearchParams | Response> {
      if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return Response.json({ error: "invalid_request", error_description: "Content-Type must be application/x-www-form-urlencoded" }, { status: 400 })
      const form = new URLSearchParams(await request.text())
      const basic = request.headers.get("authorization")?.match(/^Basic (.+)$/)?.[1]
      const [id, secret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [form.get("client_id"), form.get("client_secret")]
      if (id !== FAKE_DISCORD.clientId || secret !== FAKE_DISCORD.clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 })
      return form
    }

    const routes: FakeRoute[] = [
      // OAuth: the page a member's browser opens. It approves at once (or denies, with the hook)
      {
        method: "GET",
        path: "/oauth2/authorize",
        handle(request) {
          const url = new URL(request.url)
          const q = (key: string) => url.searchParams.get(key) ?? ""
          let redirect: URL
          try {
            redirect = new URL(q("redirect_uri"))
          } catch {
            return new Response("Invalid OAuth2 redirect_uri", { status: 400 })
          }
          if (q("client_id") !== FAKE_DISCORD.clientId || q("response_type") !== "code" || !q("scope").split(" ").includes("identify") || q("code_challenge_method") !== "S256" || !q("code_challenge")) {
            return new Response("Invalid OAuth2 request", { status: 400 })
          }
          if (oauth.deny) {
            redirect.searchParams.set("error", "access_denied")
            redirect.searchParams.set("error_description", "The resource owner or authorization server denied the request")
          } else {
            const code = randomBytes(15).toString("base64url")
            oauth.codes.set(code, { challenge: q("code_challenge"), redirectUri: q("redirect_uri"), userId: oauth.userId })
            redirect.searchParams.set("code", code)
          }
          if (q("state")) redirect.searchParams.set("state", q("state"))
          redirect.searchParams.set("iss", ISSUER)
          return new Response(null, { status: 302, headers: { location: redirect.toString() } })
        },
      },
      {
        method: "POST",
        path: `${API}/oauth2/token`,
        async handle(request) {
          const form = await oauthForm(request)
          if (form instanceof Response) return form
          const grant = oauth.codes.get(form.get("code") ?? "")
          if (form.get("grant_type") !== "authorization_code" || !grant || grant.redirectUri !== form.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 })
          oauth.codes.delete(form.get("code")!)
          const verifier = form.get("code_verifier") ?? ""
          if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return Response.json({ error: "invalid_grant", error_description: "Invalid code_verifier" }, { status: 400 })
          const token = randomBytes(24).toString("base64url")
          oauth.tokens.set(token, grant.userId)
          return Response.json({ access_token: token, token_type: "Bearer", expires_in: 604800, refresh_token: randomBytes(24).toString("base64url"), scope: "identify" })
        },
      },
      {
        method: "POST",
        path: `${API}/oauth2/token/revoke`,
        async handle(request) {
          const form = await oauthForm(request)
          if (form instanceof Response) return form
          oauth.tokens.delete(form.get("token") ?? "")
          return Response.json({})
        },
      },
      {
        method: "GET",
        path: `${API}/users/@me`,
        handle: api((request) => {
          if (isBot(request)) return Response.json(server.bot)
          const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1]
          const userId = bearer ? oauth.tokens.get(bearer) : undefined
          const user = userId ? (member(userId)?.user ?? { id: userId, username: "fake.user", global_name: "Fake User" }) : null
          return user ? Response.json({ ...user, avatar: null, discriminator: "0" }) : unauthorized()
        }, "none"),
      },
      {
        method: "GET",
        path: `${API}/applications/@me`,
        handle: api(() =>
          Response.json({
            id: FAKE_DISCORD.clientId,
            name: "LSR Bot (fake)",
            flags: (intents.messageContent ? APP_FLAG.messageContentLimited : 0) | (intents.guildMembers ? APP_FLAG.guildMembersLimited : 0),
          }),
        ),
      },
      {
        method: "GET",
        path: `${API}/guilds/:guildId`,
        handle: api((request, { guildId }) => {
          if (guildId !== server.guild.id) return error(404, 10004, "Unknown Guild")
          return Response.json({ ...server.guild, approximate_member_count: server.members.length, approximate_presence_count: Math.floor(server.members.length / 3) })
        }),
      },
      {
        method: "GET",
        path: `${API}/guilds/:guildId/channels`,
        handle: api((request, { guildId }) => {
          if (guildId !== server.guild.id) return error(404, 10004, "Unknown Guild")
          return Response.json(server.channels.filter((c) => !c.hidden && !THREAD_TYPES.includes(c.type)).map((c) => shown(c, guildId)))
        }),
      },
      {
        method: "GET",
        path: `${API}/guilds/:guildId/threads/active`,
        handle: api((request, { guildId }) => {
          if (guildId !== server.guild.id) return error(404, 10004, "Unknown Guild")
          return Response.json({ threads: server.channels.filter((c) => THREAD_TYPES.includes(c.type) && !c.thread_metadata?.archived).map((c) => shown(c, guildId)), members: [] })
        }),
      },
      {
        method: "GET",
        path: `${API}/channels/:channelId/threads/archived/public`,
        handle: api((request, { channelId }) => {
          const found = readable(channelId)
          if (found instanceof Response) return found
          if (!THREAD_PARENT_TYPES.includes(found.type)) return error(400, 50024, "Cannot execute action on this channel type")
          const url = new URL(request.url)
          const beforeAt = url.searchParams.has("before") ? Date.parse(url.searchParams.get("before")!) : Infinity
          const limit = clamp(url.searchParams.get("limit"), 50, 2, 100)
          const archived = server.channels
            .filter((c) => c.parent_id === channelId && c.thread_metadata?.archived && Date.parse(c.thread_metadata.archive_timestamp) < beforeAt)
            .sort((a, b) => Date.parse(b.thread_metadata!.archive_timestamp) - Date.parse(a.thread_metadata!.archive_timestamp))
          return Response.json({ threads: archived.slice(0, limit).map((c) => shown(c, server.guild.id)), members: [], has_more: archived.length > limit })
        }),
      },
      {
        method: "GET",
        path: `${API}/channels/:channelId`,
        handle: api((request, { channelId }) => {
          const found = readable(channelId)
          if (found instanceof Response) return found
          return Response.json(shown(found, server.guild.id))
        }),
      },
      { method: "GET", path: `${API}/channels/:channelId/messages`, handle: api(listMessages) },
      {
        method: "GET",
        path: `${API}/channels/:channelId/messages/:messageId`,
        handle: api((request, { channelId, messageId }) => {
          const found = readable(channelId)
          if (found instanceof Response) return found
          const message = server.messages.get(channelId)?.find((m) => m.id === messageId)
          return message ? Response.json(view(message)) : error(404, 10008, "Unknown Message")
        }),
      },
      {
        method: "GET",
        path: `${API}/guilds/:guildId/members`,
        handle: api((request, { guildId }) => {
          if (guildId !== server.guild.id) return error(404, 10004, "Unknown Guild")
          if (!intents.guildMembers) return error(403, 50001, "Missing Access")
          const url = new URL(request.url)
          const limit = clamp(url.searchParams.get("limit"), 1, 1, 1000)
          const from = url.searchParams.get("after") ?? "0"
          return Response.json(server.members.filter((m) => after(m.user.id, from)).slice(0, limit))
        }),
      },
      { method: "GET", path: `${API}/guilds/:guildId/messages/search`, handle: api((request, { guildId }) => (guildId === server.guild.id ? search(request) : error(404, 10004, "Unknown Guild"))) },

      // Test hooks
      {
        method: "POST",
        path: "/_fake/intents",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { messageContent?: boolean; guildMembers?: boolean }
          if (typeof body.messageContent === "boolean") intents.messageContent = body.messageContent
          if (typeof body.guildMembers === "boolean") intents.guildMembers = body.guildMembers
          return Response.json(intents)
        },
      },
      {
        method: "POST",
        path: "/_fake/rate-limit",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as Partial<ForcedLimit>
          forced.push({ times: body.times ?? 1, retryAfter: body.retryAfter ?? 0.05, global: body.global ?? false, scope: body.scope ?? (body.global ? "global" : "user"), path: body.path })
          return Response.json({ ok: true })
        },
      },
      {
        method: "POST",
        path: "/_fake/search",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { ready?: boolean; stuck?: boolean }
          searchReady = body.ready ?? true
          searchStuck = body.stuck ?? false
          return Response.json({ ready: searchReady, stuck: searchStuck })
        },
      },
      {
        method: "POST",
        path: "/_fake/polls",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { hideResults?: boolean; finalize?: boolean; counts?: number[] }
          if (typeof body.hideResults === "boolean") hidePollResults = body.hideResults
          if (body.finalize || body.counts) {
            for (const list of server.messages.values())
              for (const message of list) {
                if (!message.poll || message.poll.results?.is_finalized) continue
                const counts = body.counts ?? message.poll.results?.answer_counts.map((c) => c.count) ?? []
                message.poll.results = { is_finalized: Boolean(body.finalize), answer_counts: counts.map((count, i) => ({ id: i + 1, count })).filter((c) => c.count > 0) }
              }
          }
          return Response.json({ hideResults: hidePollResults })
        },
      },
      {
        method: "POST",
        path: "/_fake/oauth",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { userId?: string; deny?: boolean }
          if (typeof body.deny === "boolean") oauth.deny = body.deny
          if (typeof body.userId === "string") oauth.userId = body.userId
          return Response.json({ deny: oauth.deny, userId: oauth.userId, liveTokens: oauth.tokens.size })
        },
      },
      {
        method: "POST",
        path: "/_fake/messages",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { channelId?: string; content?: string; authorId?: string; poll?: DiscordPoll }
          const list = body.channelId ? server.messages.get(body.channelId) : undefined
          if (!list) return error(404, 10003, "Unknown Channel")
          const author = (body.authorId && member(body.authorId)?.user) || server.members.find((m) => !m.user.bot)!.user
          // Now, never ahead of the clock (as Discord stamps them); the increment keeps ids made in one millisecond apart
          const at = Date.now()
          clock++
          const message: DiscordMessage = {
            id: fakeSnowflake(at, clock),
            channel_id: body.channelId!,
            type: 0,
            timestamp: iso(at),
            edited_timestamp: null,
            author,
            content: body.content ?? "",
            attachments: [],
            ...(body.poll ? { poll: body.poll } : {}),
          }
          list.push(message)
          return Response.json(message, { status: 201 })
        },
      },
      {
        method: "PATCH",
        path: "/_fake/messages/:channelId/:messageId",
        async handle(request, { params }) {
          const message = server.messages.get(params.channelId)?.find((m) => m.id === params.messageId)
          if (!message) return error(404, 10008, "Unknown Message")
          const body = (await request.json().catch(() => ({}))) as { content?: string }
          message.content = body.content ?? message.content
          message.edited_timestamp = iso(Date.now())
          return Response.json(message)
        },
      },
      {
        method: "DELETE",
        path: "/_fake/messages/:channelId/:messageId",
        handle(request, { params }) {
          const list = server.messages.get(params.channelId)
          const at = list?.findIndex((m) => m.id === params.messageId) ?? -1
          if (!list || at < 0) return error(404, 10008, "Unknown Message")
          list.splice(at, 1)
          return new Response(null, { status: 204 })
        },
      },
      {
        // A channel or thread deleted in Discord (a member deleting their forum post, say): gone with its messages, and a channel's threads with it
        method: "DELETE",
        path: "/_fake/channels/:channelId",
        handle(request, { params }) {
          const gone = server.channels.filter((c) => c.id === params.channelId || c.parent_id === params.channelId).map((c) => c.id)
          if (!gone.length) return error(404, 10003, "Unknown Channel")
          server.channels = server.channels.filter((c) => !gone.includes(c.id))
          for (const id of gone) server.messages.delete(id)
          return new Response(null, { status: 204 })
        },
      },
      {
        method: "POST",
        path: "/_fake/members",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { username?: string }
          // Now, never ahead of the clock (as Discord stamps them); the increment keeps ids made in one millisecond apart
          const at = Date.now()
          clock++
          const joined: DiscordMember = { user: { id: fakeSnowflake(at, clock), username: body.username ?? `new.member${clock}`, global_name: null }, nick: null, roles: [], joined_at: iso(at) }
          server.members.push(joined)
          server.members.sort((a, b) => byId(a.user, b.user))
          return Response.json(joined, { status: 201 })
        },
      },
      {
        method: "DELETE",
        path: "/_fake/members/:userId",
        handle(request, { params }) {
          const at = server.members.findIndex((m) => m.user.id === params.userId)
          if (at < 0) return error(404, 10007, "Unknown Member")
          server.members.splice(at, 1)
          return new Response(null, { status: 204 })
        },
      },
      {
        method: "GET",
        path: "/_fake/state",
        handle: () =>
          Response.json({
            guild: server.guild,
            channels: server.channels.map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id ?? null, hidden: Boolean(c.hidden), messages: server.messages.get(c.id)?.length ?? 0 })),
            members: server.members.length,
            intents,
            oauthUserId: oauth.userId,
          }),
      },
    ]
    return routes
  },
}
