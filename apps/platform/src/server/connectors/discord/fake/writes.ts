import { DISCORD_LIMITS } from "@/lib/discord/text"
import { FakeNetworkError, type FakeRoute } from "../../fakes/types"
import { CHANNEL_TYPE, type DiscordChannel, type DiscordMessage, type DiscordPoll } from "../types"
import type { DiscordEmbed, DiscordPollCreate, DiscordScheduledEvent } from "../write"
import { FAKE_DISCORD, fakeSnowflake, type FakeServer } from "./data"

/**
 * The Discord fake's write routes (discord-post; research §7 "Writes"), mounted with the read routes in
 * handlers.ts:
 * - Create Message with Discord's limits (2000 characters, 10 embeds and 6000 in all, polls of 1 to 10
 *   answers up to 55 characters and 1 to 768 hours; 50006 when empty, 50035 otherwise) and `nonce` +
 *   `enforce_nonce`: the same nonce within NONCE_WINDOW_MS returns the first message instead of posting
 *   again. Posted messages join the channel's history, so reading it back finds them;
 * - expiring the bot's own poll;
 * - roles: the list, a member, and adding or removing a role (403 50013 for a managed role or one at or
 *   above the bot's highest; 10007 unknown member; 10011 unknown role);
 * - external scheduled events: create (EXTERNAL needs channel_id null, a location of 1 to 100
 *   characters and an end time; 30038 past 100 events), list with user_count, read, edit (status only
 *   1→2, 2→3 or 1→4), delete (10070 unknown). Events start and end by the fake's clock.
 *
 * Test hooks under /_fake: `drop` { path?, times?, when? "before" | "after" } makes writes fail like a
 * dropped connection (after: the write happened, the caller never hears back); `fail` { path?, method?,
 * status, code, message?, times? } answers writes with an error; `clock` { advanceMs } moves the fake's
 * clock; `interested` { eventId, count }; `PATCH roles/:roleId`; `GET writes`.
 */

/** How long Discord dedupes a nonce: "the past few minutes" (research §3 W1); the fake keeps 3 */
export const FAKE_NONCE_WINDOW_MS = 3 * 60_000

type Channel = DiscordChannel & { hidden?: boolean }
type Handle = (request: Request, params: Record<string, string>) => Response | Promise<Response>
type Write = { method: string; path: string; body: unknown; at: string }
type Drop = { path?: string; times: number; when: "before" | "after" }
type Failure = { path?: string; method?: string; status: number; code: number; message: string; times: number }

export type FakeWriteHelpers = {
  /** handlers.ts' wrapper: rate-limit headers, a forced 429, and the bot token check */
  api: (handle: Handle) => FakeRoute["handle"]
  /** A channel the bot can see, or the error Discord gives */
  readable: (id: string) => Channel | Response
  error: (status: number, code: number, message: string) => Response
}

const API = "/api/v10"
const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00")
const invalid = (error: FakeWriteHelpers["error"], detail: string) => error(400, 50035, `Invalid Form Body: ${detail}`)

/** What's wrong with a message body against Discord's limits, or null */
function messageProblem(body: { content?: unknown; embeds?: unknown; poll?: unknown; nonce?: unknown }): { code: number; detail: string } | null {
  const content = typeof body.content === "string" ? body.content : ""
  const embeds = Array.isArray(body.embeds) ? (body.embeds as DiscordEmbed[]) : []
  const poll = body.poll as DiscordPollCreate | undefined
  if (body.nonce !== undefined && (typeof body.nonce !== "string" || body.nonce.length > DISCORD_LIMITS.nonce)) return { code: 50035, detail: "nonce" }
  if (!content.trim() && !embeds.length && !poll) return { code: 50006, detail: "Cannot send an empty message" }
  if (content.length > DISCORD_LIMITS.content) return { code: 50035, detail: "content: Must be 2000 or fewer in length." }
  if (embeds.length > DISCORD_LIMITS.embeds) return { code: 50035, detail: "embeds" }
  let total = 0
  for (const embed of embeds) {
    if ((embed.title ?? "").length > DISCORD_LIMITS.embedTitle || (embed.description ?? "").length > DISCORD_LIMITS.embedDescription) return { code: 50035, detail: "embeds.title/description" }
    if ((embed.fields ?? []).length > DISCORD_LIMITS.embedFields) return { code: 50035, detail: "embeds.fields" }
    total += (embed.title ?? "").length + (embed.description ?? "").length + (embed.footer?.text ?? "").length
    for (const field of embed.fields ?? []) {
      if (!field.name || field.name.length > DISCORD_LIMITS.fieldName || !field.value || field.value.length > DISCORD_LIMITS.fieldValue) return { code: 50035, detail: "embeds.fields" }
      total += field.name.length + field.value.length
    }
  }
  if (total > DISCORD_LIMITS.embedTotal) return { code: 50035, detail: "embeds: Embed size exceeds maximum size of 6000" }
  if (poll) {
    const answers = Array.isArray(poll.answers) ? poll.answers : []
    if (!poll.question?.text || poll.question.text.length > DISCORD_LIMITS.pollQuestion) return { code: 50035, detail: "poll.question" }
    if (answers.length < 1 || answers.length > DISCORD_LIMITS.pollAnswers) return { code: 50035, detail: "poll.answers" }
    if (answers.some((a) => !a.poll_media?.text || a.poll_media.text.length > DISCORD_LIMITS.pollAnswer)) return { code: 50035, detail: "poll.answers.poll_media.text" }
    const duration = poll.duration ?? 24
    if (!Number.isInteger(duration) || duration < 1 || duration > DISCORD_LIMITS.pollHours) return { code: 50035, detail: "poll.duration" }
  }
  return null
}

/** What's wrong with an external event's fields, or null (research §3 W3) */
function eventProblem(input: Partial<DiscordScheduledEvent>, creating: boolean): string | null {
  if (creating || input.name !== undefined) if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > 100) return "name"
  if (input.description !== undefined && input.description !== null && (typeof input.description !== "string" || input.description.length > 1000)) return "description"
  if (creating) {
    if (input.entity_type !== 3) return "entity_type"
    if (input.channel_id !== null) return "channel_id: must be null for an external event"
    if (input.privacy_level !== 2) return "privacy_level"
    if (!input.scheduled_end_time) return "scheduled_end_time: required for an external event"
  }
  if (input.entity_metadata !== undefined) {
    const location = input.entity_metadata?.location
    if (typeof location !== "string" || location.length < 1 || location.length > 100) return "entity_metadata.location"
  }
  return null
}

export function fakeWriteRoutes(server: FakeServer, { api, readable, error }: FakeWriteHelpers): FakeRoute[] {
  const nonces = new Map<string, { message: DiscordMessage; at: number }>()
  const writes: Write[] = []
  const drops: Drop[] = []
  const failures: Failure[] = []
  const events = new Map<string, DiscordScheduledEvent>()
  const interested = new Map<string, number>()
  let offsetMs = 0
  let n = 0
  const now = () => Date.now() + offsetMs

  const member = (userId: string) => server.members.find((m) => m.user.id === userId)
  const role = (roleId: string) => server.roles.find((r) => r.id === roleId)
  const botTop = () => {
    const own = member(server.bot.id)?.roles ?? []
    return Math.max(0, ...server.roles.filter((r) => own.includes(r.id)).map((r) => r.position))
  }

  /** Every write goes through here: a forced failure or dropped connection first, then the write, recorded */
  const write =
    (handle: Handle): Handle =>
    async (request, params) => {
      const path = new URL(request.url).pathname
      const matches = (rule: { path?: string; method?: string }) => (!rule.path || path.includes(rule.path)) && (!rule.method || rule.method === request.method)
      const failure = failures.find((f) => f.times > 0 && matches(f))
      if (failure) {
        failure.times--
        return error(failure.status, failure.code, failure.message)
      }
      const drop = drops.find((d) => d.times > 0 && matches(d))
      if (drop?.when === "before") {
        drop.times--
        throw new FakeNetworkError("dropped before the write")
      }
      const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.clone().json().catch(() => undefined)
      const response = await handle(request, params)
      if (response.ok) writes.push({ method: request.method, path: path.replace(/^\/discord/, ""), body, at: new Date(now()).toISOString() })
      if (drop?.when === "after") {
        drop.times--
        throw new FakeNetworkError("dropped after the write")
      }
      return response
    }

  /** An event's status by the fake's clock: external events start and end on their own */
  function current(event: DiscordScheduledEvent): DiscordScheduledEvent {
    const start = Date.parse(event.scheduled_start_time)
    const end = event.scheduled_end_time ? Date.parse(event.scheduled_end_time) : Infinity
    if (event.status === 1 && now() >= start) event.status = 2
    if ((event.status === 1 || event.status === 2) && now() >= end) event.status = 3
    return event
  }
  const withCount = (event: DiscordScheduledEvent) => ({ ...event, user_count: interested.get(event.id) ?? 0 })

  const routes: FakeRoute[] = [
    {
      method: "POST",
      path: `${API}/channels/:channelId/messages`,
      handle: api(
        write(async (request, { channelId }) => {
          const found = readable(channelId)
          if (found instanceof Response) return found
          if (found.type === CHANNEL_TYPE.category || found.type === CHANNEL_TYPE.forum || found.type === CHANNEL_TYPE.media) return error(400, 50008, "Cannot send messages in a non-text channel")
          const body = (await request.json().catch(() => ({}))) as { content?: string; embeds?: DiscordEmbed[]; poll?: DiscordPollCreate; nonce?: string; enforce_nonce?: boolean; allowed_mentions?: unknown }
          const problem = messageProblem(body)
          if (problem) return problem.code === 50006 ? error(400, 50006, problem.detail) : invalid(error, problem.detail)
          if (body.enforce_nonce && body.nonce) {
            const seen = nonces.get(body.nonce)
            if (seen && now() - seen.at < FAKE_NONCE_WINDOW_MS) return Response.json(seen.message)
          }
          const at = now()
          const poll: DiscordPoll | undefined = body.poll
            ? {
                question: { text: body.poll.question.text },
                answers: body.poll.answers.map((a, i) => ({ answer_id: i + 1, poll_media: { text: a.poll_media.text } })),
                expiry: iso(at + (body.poll.duration ?? 24) * 3_600_000),
                allow_multiselect: Boolean(body.poll.allow_multiselect),
                layout_type: 1,
                results: { is_finalized: false, answer_counts: [] },
              }
            : undefined
          const message: DiscordMessage & { embeds?: DiscordEmbed[]; nonce?: string; allowed_mentions?: unknown } = {
            id: fakeSnowflake(at, 2048 + (n++ % 2048)),
            channel_id: channelId,
            type: 0,
            timestamp: iso(at),
            edited_timestamp: null,
            author: server.bot,
            content: body.content ?? "",
            attachments: [],
            embeds: body.embeds ?? [],
            ...(poll ? { poll } : {}),
            ...(body.nonce ? { nonce: body.nonce } : {}),
            allowed_mentions: body.allowed_mentions,
          }
          const list = server.messages.get(channelId) ?? []
          list.push(message)
          server.messages.set(channelId, list)
          if (body.nonce) nonces.set(body.nonce, { message, at })
          return Response.json(message)
        }),
      ),
    },
    {
      method: "POST",
      path: `${API}/channels/:channelId/polls/:messageId/expire`,
      handle: api(
        write((request, { channelId, messageId }) => {
          const found = readable(channelId)
          if (found instanceof Response) return found
          const message = server.messages.get(channelId)?.find((m) => m.id === messageId)
          if (!message) return error(404, 10008, "Unknown Message")
          if (!message.poll) return error(400, 520006, "Cannot expire a non-poll message")
          if (message.author.id !== server.bot.id) return error(403, 50013, "Missing Permissions")
          message.poll.expiry = iso(now())
          message.poll.results = { is_finalized: true, answer_counts: message.poll.results?.answer_counts ?? [] }
          return Response.json(message)
        }),
      ),
    },
    {
      method: "GET",
      path: `${API}/guilds/:guildId/roles`,
      handle: api((request, { guildId }) => (guildId === server.guild.id ? Response.json([...server.roles].sort((a, b) => a.position - b.position)) : error(404, 10004, "Unknown Guild"))),
    },
    {
      method: "GET",
      path: `${API}/guilds/:guildId/members/:userId`,
      handle: api((request, { guildId, userId }) => {
        if (guildId !== server.guild.id) return error(404, 10004, "Unknown Guild")
        const found = member(userId)
        return found ? Response.json(found) : error(404, 10007, "Unknown Member")
      }),
    },
    ...(["PUT", "DELETE"] as const).map(
      (method): FakeRoute => ({
        method,
        path: `${API}/guilds/:guildId/members/:userId/roles/:roleId`,
        handle: api(
          write((request, { guildId, userId, roleId }) => {
            if (guildId !== server.guild.id) return error(404, 10004, "Unknown Guild")
            const found = member(userId)
            if (!found) return error(404, 10007, "Unknown Member")
            const target = role(roleId)
            if (!target || target.id === server.guild.id) return error(404, 10011, "Unknown Role")
            if (target.managed || target.position >= botTop()) return error(403, 50013, "Missing Permissions")
            if (method === "PUT" && !found.roles.includes(roleId)) found.roles = [...found.roles, roleId]
            if (method === "DELETE") found.roles = found.roles.filter((r) => r !== roleId)
            return new Response(null, { status: 204 })
          }),
        ),
      }),
    ),
    {
      method: "GET",
      path: `${API}/guilds/:guildId/scheduled-events`,
      handle: api((request, { guildId }) => {
        if (guildId !== server.guild.id) return error(404, 10004, "Unknown Guild")
        const counts = new URL(request.url).searchParams.get("with_user_count") === "true"
        const listed = [...events.values()].map(current).filter((e) => e.status === 1 || e.status === 2)
        return Response.json(listed.map((e) => (counts ? withCount(e) : e)))
      }),
    },
    {
      method: "POST",
      path: `${API}/guilds/:guildId/scheduled-events`,
      handle: api(
        write(async (request, { guildId }) => {
          if (guildId !== server.guild.id) return error(404, 10004, "Unknown Guild")
          const body = (await request.json().catch(() => ({}))) as Partial<DiscordScheduledEvent>
          const problem = eventProblem(body, true)
          if (problem) return invalid(error, problem)
          if (Date.parse(body.scheduled_end_time!) <= Date.parse(body.scheduled_start_time ?? "")) return invalid(error, "scheduled_end_time: must be after the start")
          if (Date.parse(body.scheduled_start_time ?? "") <= now()) return invalid(error, "scheduled_start_time: Cannot schedule event in the past")
          if ([...events.values()].map(current).filter((e) => e.status === 1 || e.status === 2).length >= 100) return error(400, 30038, "Maximum number of uncompleted guild scheduled events reached (100)")
          const at = now()
          const event: DiscordScheduledEvent = {
            id: fakeSnowflake(at, 3072 + (n++ % 1024)),
            guild_id: guildId,
            channel_id: null,
            creator_id: server.bot.id,
            name: body.name!,
            description: body.description ?? null,
            scheduled_start_time: body.scheduled_start_time!,
            scheduled_end_time: body.scheduled_end_time!,
            privacy_level: 2,
            status: 1,
            entity_type: 3,
            entity_metadata: { location: body.entity_metadata!.location },
          }
          events.set(event.id, event)
          return Response.json(event)
        }),
      ),
    },
    {
      method: "GET",
      path: `${API}/guilds/:guildId/scheduled-events/:eventId`,
      handle: api((request, { guildId, eventId }) => {
        const event = guildId === server.guild.id ? events.get(eventId) : undefined
        if (!event) return error(404, 10070, "Unknown Guild Scheduled Event")
        const counts = new URL(request.url).searchParams.get("with_user_count") === "true"
        return Response.json(counts ? withCount(current(event)) : current(event))
      }),
    },
    {
      method: "PATCH",
      path: `${API}/guilds/:guildId/scheduled-events/:eventId`,
      handle: api(
        write(async (request, { guildId, eventId }) => {
          const event = guildId === server.guild.id ? events.get(eventId) : undefined
          if (!event) return error(404, 10070, "Unknown Guild Scheduled Event")
          current(event)
          const body = (await request.json().catch(() => ({}))) as Partial<DiscordScheduledEvent>
          const problem = eventProblem(body, false)
          if (problem) return invalid(error, problem)
          if (event.status === 3 || event.status === 4) return invalid(error, "status: the event is over")
          if (body.status !== undefined && !((event.status === 1 && (body.status === 2 || body.status === 4)) || (event.status === 2 && body.status === 3))) return invalid(error, "status: not an allowed change")
          Object.assign(event, {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.scheduled_start_time ? { scheduled_start_time: body.scheduled_start_time } : {}),
            ...(body.scheduled_end_time ? { scheduled_end_time: body.scheduled_end_time } : {}),
            ...(body.entity_metadata ? { entity_metadata: { location: body.entity_metadata.location } } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
          })
          return Response.json(event)
        }),
      ),
    },
    {
      method: "DELETE",
      path: `${API}/guilds/:guildId/scheduled-events/:eventId`,
      handle: api(
        write((request, { guildId, eventId }) => {
          if (guildId !== server.guild.id || !events.delete(eventId)) return error(404, 10070, "Unknown Guild Scheduled Event")
          return new Response(null, { status: 204 })
        }),
      ),
    },

    // Test hooks
    {
      method: "POST",
      path: "/_fake/drop",
      async handle(request) {
        const body = (await request.json().catch(() => ({}))) as Partial<Drop>
        drops.push({ path: body.path, times: body.times ?? 1, when: body.when === "before" ? "before" : "after" })
        return Response.json({ ok: true })
      },
    },
    {
      method: "POST",
      path: "/_fake/fail",
      async handle(request) {
        const body = (await request.json().catch(() => ({}))) as Partial<Failure>
        failures.push({ path: body.path, method: body.method, status: body.status ?? 500, code: body.code ?? 0, message: body.message ?? "Internal Server Error", times: body.times ?? 1 })
        return Response.json({ ok: true })
      },
    },
    {
      method: "POST",
      path: "/_fake/clock",
      async handle(request) {
        const body = (await request.json().catch(() => ({}))) as { advanceMs?: number }
        offsetMs += body.advanceMs ?? 0
        return Response.json({ now: new Date(now()).toISOString() })
      },
    },
    {
      method: "POST",
      path: "/_fake/interested",
      async handle(request) {
        const body = (await request.json().catch(() => ({}))) as { eventId?: string; count?: number }
        if (!body.eventId || !events.has(body.eventId)) return error(404, 10070, "Unknown Guild Scheduled Event")
        interested.set(body.eventId, body.count ?? 0)
        return Response.json({ ok: true })
      },
    },
    {
      method: "PATCH",
      path: "/_fake/roles/:roleId",
      async handle(request, { params }) {
        const target = role(params.roleId)
        if (!target) return error(404, 10011, "Unknown Role")
        const body = (await request.json().catch(() => ({}))) as Partial<typeof target>
        Object.assign(target, body, { id: target.id })
        return Response.json(target)
      },
    },
    {
      method: "GET",
      path: "/_fake/writes",
      handle: () =>
        Response.json({
          writes,
          events: [...events.values()].map((e) => withCount(current(e))),
          botMessages: [...server.messages.values()].flat().filter((m) => m.author.id === FAKE_DISCORD.botUserId).length,
        }),
    },
  ]
  return routes
}
