import { randomBytes, randomUUID } from "node:crypto"
import { strToU8 } from "fflate"
import type { FakeContext, FakeRoute, FakeService } from "../../fakes/types"
import { GRAPH_SCOPE } from "../graph"
import { GRAPH_FAKE, sharePointFixtures, teamsFixtures, type FakeGraphItem, type FakeGraphMessage } from "./fixtures"

/**
 * The Microsoft Graph fake, mounted at /microsoft-graph (research/microsoft-graph.md §7), for SharePoint
 * and Teams:
 * - sign-in: `POST /{tenant}/oauth2/v2.0/token` (client credentials; a wrong secret is AADSTS7000215);
 * - SharePoint: the site and drive, `root/delta` (next and delta links on the fake's host, `deleted`
 *   facets, `token=latest`, a switch for 410 resync with a Location), item GETs with
 *   `parentReference.path`, and `/content` answering 302 to a one-time `/dl/...` link that refuses a
 *   token; drive search is 403, as under Sites.Selected;
 * - Teams: a channel, its messages (`$top` ≤ 50, `$expand=replies`), single messages and replies, and
 *   messages delta (roots only), as chatMessage shapes (HTML bodies, a system event, a deleted message);
 * - subscriptions: create (with the validation call to our endpoints, the lifetime rules and 409 on a
 *   duplicate), list, renew, delete, reauthorize.
 * Test hooks under /_fake: change the data, emit notifications, expire tokens, and `config` for page
 * sizes, revoked grants (403 accessDenied), 410 resync, throttling (429 Retry-After) and 1 rps pacing.
 */

const MAX_SUBSCRIPTION_MINUTES = 4320

type Subscription = {
  id: string
  resource: string
  changeType: string
  notificationUrl: string
  lifecycleNotificationUrl?: string
  clientState?: string
  expirationDateTime: string
}

type Config = {
  pageSize: number
  repliesPageSize: number
  sitesGranted: boolean
  rscInstalled: boolean
  /** The next delta call with a token answers 410 */
  resync: boolean
  throttle: { count: number; retryAfter: number }
  validateEndpoints: boolean
  enforcePacing: boolean
}

const graphError = (status: number, code: string, message: string, headers?: HeadersInit) =>
  Response.json({ error: { code, message, innerError: { date: new Date().toISOString(), "request-id": "fixture-request" } } }, { status, headers })

const accessDenied = () => graphError(403, "accessDenied", "Either scp or roles claim need to be present in the token.")

export const microsoftGraphFake: FakeService = {
  id: "microsoft-graph",
  create(): FakeRoute[] {
    const items = new Map(sharePointFixtures().map((item) => [item.id, item]))
    const messages = new Map(teamsFixtures().map((m) => [m.id, m]))
    const subscriptions = new Map<string, Subscription>()
    const bytesCache = new Map<string, Uint8Array>()
    const downloads = new Map<string, { itemId: string; expiresAt: number }>()
    const tokens = new Set<string>()
    /** SharePoint's change log (item ids); a delta token is a position in it */
    const driveLog: string[] = []
    /** Each channel's change log (root message ids) */
    const channelLogs = new Map<string, string[]>()
    const lastChannelCall = new Map<string, number>()
    const config: Config = {
      pageSize: 200,
      repliesPageSize: 200,
      sitesGranted: true,
      rscInstalled: true,
      resync: false,
      throttle: { count: 0, retryAfter: 2 },
      validateEndpoints: true,
      enforcePacing: false,
    }
    let nextToken = 1

    const bytesOf = async (item: FakeGraphItem) => {
      if (!item.bytes) return new Uint8Array()
      let bytes = bytesCache.get(item.id)
      if (!bytes) {
        bytes = await item.bytes()
        bytesCache.set(item.id, bytes)
      }
      return bytes
    }
    const pathOf = (item: FakeGraphItem): string => {
      const names: string[] = []
      for (let current = item.parentId ? items.get(item.parentId) : undefined; current && !current.root; current = current.parentId ? items.get(current.parentId) : undefined) names.unshift(current.name)
      return names.map(encodeURIComponent).join("/")
    }
    const now = () => new Date().toISOString()

    async function itemResource(item: FakeGraphItem, { withPath = false } = {}) {
      const parent = item.parentId ? items.get(item.parentId) : undefined
      const folderPath = parent ? (parent.root ? "" : `/${[pathOf(parent), encodeURIComponent(parent.name)].filter(Boolean).join("/")}`) : null
      const base = {
        id: item.id,
        name: item.name,
        eTag: `"{${item.id}},${item.version}"`,
        cTag: `"c:{${item.id}},${item.version}"`,
        lastModifiedDateTime: item.lastModified,
        webUrl: `https://fixture.sharepoint.com/sites/lsr/Shared%20Documents/${[pathOf(item), encodeURIComponent(item.name)].filter(Boolean).join("/")}`,
        ...(item.parentId ? { parentReference: { driveType: "documentLibrary", driveId: GRAPH_FAKE.driveId, id: item.parentId, ...(withPath && folderPath !== null ? { path: `/drives/${GRAPH_FAKE.driveId}/root:${folderPath}` } : {}) } } : {}),
      }
      if (item.deleted) return { id: item.id, ...(item.parentId ? { parentReference: { driveId: GRAPH_FAKE.driveId, id: item.parentId } } : {}), deleted: { state: "deleted" } }
      if (item.root) return { ...base, root: {}, folder: { childCount: [...items.values()].filter((i) => i.parentId === item.id && !i.deleted).length } }
      if (item.folder) return { ...base, folder: { childCount: [...items.values()].filter((i) => i.parentId === item.id && !i.deleted).length } }
      return { ...base, size: (await bytesOf(item)).length, file: { mimeType: item.mimeType ?? "application/octet-stream" } }
    }

    function messageResource(m: FakeGraphMessage) {
      return {
        id: m.id,
        replyToId: m.replyToId,
        etag: m.lastModifiedAt,
        messageType: m.messageType,
        createdDateTime: m.createdAt,
        lastModifiedDateTime: m.lastModifiedAt,
        lastEditedDateTime: m.editedAt ?? null,
        deletedDateTime: m.deletedAt ?? null,
        subject: null,
        webUrl: `https://teams.microsoft.com/l/message/${encodeURIComponent(m.channelId)}/${m.id}?groupId=${GRAPH_FAKE.teamId}`,
        from: m.author ? (m.author.app ? { application: { id: m.author.id, displayName: m.author.name, applicationIdentityType: "bot" }, user: null } : { application: null, user: { id: m.author.id, displayName: m.author.name, userIdentityType: "aadUser" } }) : null,
        body: { contentType: "html", content: m.deletedAt ? "" : m.html },
        channelIdentity: { teamId: GRAPH_FAKE.teamId, channelId: m.channelId },
        attachments: [],
        mentions: m.html.includes("<at") ? [{ id: 0, mentionText: "Fixture Officer A", mentioned: { user: { id: "aad-fixture-a", displayName: "Fixture Officer A" } } }] : [],
        reactions: [],
      }
    }

    const rootsOf = (channelId: string) => [...messages.values()].filter((m) => m.channelId === channelId && !m.replyToId)
    const repliesOf = (rootId: string) => [...messages.values()].filter((m) => m.replyToId === rootId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    /** Roots sorted by the last change in their chain, newest first (Graph's order) */
    const chainTime = (root: FakeGraphMessage) => [root, ...repliesOf(root.id)].reduce((latest, m) => (m.lastModifiedAt > latest ? m.lastModifiedAt : latest), root.lastModifiedAt)
    const logChannel = (channelId: string, rootId: string) => {
      const log = channelLogs.get(channelId) ?? []
      log.push(rootId)
      channelLogs.set(channelId, log)
    }

    function gate(request: Request, kind: "sites" | "teams" | "any", channelId?: string): Response | null {
      const header = request.headers.get("authorization") ?? ""
      if (!header.startsWith("Bearer ") || !tokens.has(header.slice(7))) return graphError(401, "InvalidAuthenticationToken", "Access token is empty or invalid.")
      if (config.throttle.count > 0) {
        config.throttle.count--
        return graphError(429, "TooManyRequests", "Too many requests.", { "retry-after": String(config.throttle.retryAfter) })
      }
      if (kind === "sites" && !config.sitesGranted) return accessDenied()
      if (kind === "teams" && !config.rscInstalled) return accessDenied()
      if (channelId && config.enforcePacing) {
        const last = lastChannelCall.get(channelId) ?? 0
        if (Date.now() - last < 1000) return graphError(429, "TooManyRequests", "Throttled: 1 request per second per channel.", { "retry-after": "1" })
        lastChannelCall.set(channelId, Date.now())
      }
      return null
    }

    const topOf = (url: URL, fallback: number) => {
      const top = Number(url.searchParams.get("$top") ?? fallback)
      return Number.isInteger(top) && top > 0 ? top : fallback
    }
    const knownChannel = (teamId: string, channelId: string) => teamId === GRAPH_FAKE.teamId && Object.values(GRAPH_FAKE.channels).includes(channelId)
    const channelBase = (ctx: FakeContext, channelId: string) => `${ctx.baseUrl}/v1.0/teams/${GRAPH_FAKE.teamId}/channels/${encodeURIComponent(channelId)}`

    async function validate(url: string): Promise<boolean> {
      const token = randomBytes(12).toString("base64url")
      try {
        const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}validationToken=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(10_000) })
        return response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("text/plain") && (await response.text()) === token
      } catch {
        return false
      }
    }

    function expiryProblem(value: unknown): { expiration: string } | { error: Response } {
      const at = typeof value === "string" ? Date.parse(value) : NaN
      if (!Number.isFinite(at)) return { error: graphError(400, "InvalidRequest", "expirationDateTime is required") }
      const minutes = (at - Date.now()) / 60_000
      if (minutes > MAX_SUBSCRIPTION_MINUTES + 1) return { error: graphError(400, "InvalidRequest", `Subscription expiration can only be ${MAX_SUBSCRIPTION_MINUTES} minutes in the future.`) }
      // Graph bumps anything under 45 minutes to 45
      return { expiration: new Date(Math.max(at, Date.now() + 45 * 60_000)).toISOString() }
    }

    return [
      {
        method: "POST",
        path: "/:tenant/oauth2/v2.0/token",
        async handle(request, { params }) {
          const form = new URLSearchParams(await request.text())
          if (params.tenant !== GRAPH_FAKE.tenantId) return Response.json({ error: "invalid_request", error_description: `AADSTS90002: Tenant '${params.tenant}' not found.`, error_codes: [90002] }, { status: 400 })
          if (form.get("grant_type") !== "client_credentials") return Response.json({ error: "unsupported_grant_type", error_description: "AADSTS70003: The app requested an unsupported grant type." }, { status: 400 })
          if (form.get("client_id") !== GRAPH_FAKE.clientId || form.get("client_secret") !== GRAPH_FAKE.clientSecret) {
            return Response.json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value.\r\nTrace ID: fixture", error_codes: [7000215] }, { status: 401 })
          }
          if (form.get("scope") !== GRAPH_SCOPE) return Response.json({ error: "invalid_scope", error_description: "AADSTS1002012: The provided value for scope is not valid." }, { status: 400 })
          const accessToken = `fixture.graph.${nextToken++}`
          tokens.add(accessToken)
          return Response.json({ token_type: "Bearer", expires_in: 3599, ext_expires_in: 3599, access_token: accessToken })
        },
      },

      // ---- SharePoint ----
      {
        method: "GET",
        path: "/v1.0/sites/:siteId",
        handle(request, { params }) {
          return gate(request, "sites") ?? (params.siteId === GRAPH_FAKE.siteId ? Response.json({ id: GRAPH_FAKE.siteId, displayName: "LSR (fixture)", webUrl: "https://fixture.sharepoint.com/sites/lsr" }) : graphError(404, "itemNotFound", "Requested site could not be found"))
        },
      },
      {
        method: "GET",
        path: "/v1.0/drives/:driveId",
        handle(request, { params }) {
          return gate(request, "sites") ?? (params.driveId === GRAPH_FAKE.driveId ? Response.json({ id: GRAPH_FAKE.driveId, driveType: "documentLibrary", name: "Documents", webUrl: "https://fixture.sharepoint.com/sites/lsr/Shared%20Documents" }) : graphError(404, "itemNotFound", "The resource could not be found."))
        },
      },
      {
        method: "GET",
        path: "/v1.0/drives/:driveId/root/:op",
        async handle(request, { params, baseUrl }) {
          const blocked = gate(request, "sites")
          if (blocked) return blocked
          if (params.driveId !== GRAPH_FAKE.driveId) return graphError(404, "itemNotFound", "The resource could not be found.")
          // Sites.Selected can't search a drive
          if (params.op.startsWith("search(")) return graphError(403, "accessDenied", "This method doesn't support the Sites.Selected application permission.")
          if (params.op !== "delta") return graphError(400, "BadRequest", `Unsupported segment ${params.op}`)
          const url = new URL(request.url)
          const deltaUrl = `${baseUrl}/v1.0/drives/${encodeURIComponent(GRAPH_FAKE.driveId)}/root/delta`
          const token = url.searchParams.get("token")
          const skip = Number(url.searchParams.get("$skiptoken") ?? "0")
          if (token === "latest") return Response.json({ value: [], "@odata.deltaLink": `${deltaUrl}?token=${driveLog.length}` })
          if (token !== null && config.resync) {
            config.resync = false
            return graphError(410, "resyncRequired", "Resync required. Replace any local items with the server's version.", { location: deltaUrl })
          }
          let ids: string[]
          if (token === null) ids = [...items.values()].filter((i) => !i.deleted).map((i) => i.id)
          else {
            const from = Number(token)
            if (!Number.isInteger(from) || from < 0 || from > driveLog.length) return graphError(400, "invalidRequest", "Invalid delta token")
            // Last occurrence wins: each changed item once
            ids = [...new Set(driveLog.slice(from).reverse())].reverse()
          }
          const page = ids.slice(skip, skip + config.pageSize)
          const value = await Promise.all(page.map((id) => itemResource(items.get(id)!)))
          const params2 = new URLSearchParams(token !== null ? { token } : {})
          if (skip + config.pageSize < ids.length) {
            params2.set("$skiptoken", String(skip + config.pageSize))
            return Response.json({ value, "@odata.nextLink": `${deltaUrl}?${params2}` })
          }
          return Response.json({ value, "@odata.deltaLink": `${deltaUrl}?token=${driveLog.length}` })
        },
      },
      {
        method: "GET",
        path: "/v1.0/drives/:driveId/items/:itemId",
        async handle(request, { params }) {
          const blocked = gate(request, "sites")
          if (blocked) return blocked
          const item = items.get(params.itemId)
          if (params.driveId !== GRAPH_FAKE.driveId || !item || item.deleted) return graphError(404, "itemNotFound", "The resource could not be found.")
          return Response.json(await itemResource(item, { withPath: true }))
        },
      },
      {
        method: "GET",
        path: "/v1.0/drives/:driveId/items/:itemId/content",
        handle(request, { params, baseUrl }) {
          const blocked = gate(request, "sites")
          if (blocked) return blocked
          const item = items.get(params.itemId)
          if (params.driveId !== GRAPH_FAKE.driveId || !item || item.deleted || item.folder) return graphError(404, "itemNotFound", "The resource could not be found.")
          const token = randomBytes(16).toString("hex")
          downloads.set(token, { itemId: item.id, expiresAt: Date.now() + 120_000 })
          return new Response(null, { status: 302, headers: { location: `${baseUrl}/dl/${token}` } })
        },
      },
      {
        // The pre-signed link: no token wanted (one sent is a bug in the client), used once, expires
        method: "GET",
        path: "/dl/:token",
        async handle(request, { params }) {
          if (request.headers.has("authorization")) return Response.json({ fake: true, error: "A pre-signed download link must be fetched without the Graph token" }, { status: 400 })
          const download = downloads.get(params.token)
          downloads.delete(params.token)
          if (!download || download.expiresAt < Date.now()) return new Response("Link expired", { status: 401 })
          const bytes = await bytesOf(items.get(download.itemId)!)
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "")
          if (range) {
            const start = Number(range[1])
            const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1)
            return new Response(Buffer.from(bytes.subarray(start, end + 1)), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` } })
          }
          return new Response(Buffer.from(bytes), { headers: { "content-length": String(bytes.length) } })
        },
      },

      // ---- Teams ----
      {
        method: "GET",
        path: "/v1.0/teams/:teamId/channels/:channelId",
        handle(request, { params }) {
          const blocked = gate(request, "teams")
          if (blocked) return blocked
          if (!knownChannel(params.teamId, params.channelId)) return graphError(404, "NotFound", "Channel not found")
          const name = params.channelId === GRAPH_FAKE.channels.general ? "General" : "Sponsorship"
          return Response.json({ id: params.channelId, displayName: name, membershipType: "standard" })
        },
      },
      {
        method: "GET",
        path: "/v1.0/teams/:teamId/channels/:channelId/messages",
        handle(request, ctx) {
          const { params } = ctx
          const blocked = gate(request, "teams", params.channelId)
          if (blocked) return blocked
          if (!knownChannel(params.teamId, params.channelId)) return graphError(404, "NotFound", "Channel not found")
          const url = new URL(request.url)
          const top = topOf(url, 20)
          if (top > 50) return graphError(400, "BadRequest", "Invalid page size requested: the maximum is 50")
          const skip = Number(url.searchParams.get("$skiptoken") ?? "0")
          const expand = url.searchParams.get("$expand") === "replies"
          const roots = rootsOf(params.channelId).sort((a, b) => chainTime(b).localeCompare(chainTime(a)))
          const page = roots.slice(skip, skip + top).map((root) => {
            const resource = messageResource(root)
            if (!expand) return resource
            const replies = repliesOf(root.id)
            const shown = replies.slice(0, config.repliesPageSize)
            return {
              ...resource,
              replies: shown.map(messageResource),
              ...(replies.length > shown.length ? { "replies@odata.nextLink": `${channelBase(ctx, params.channelId)}/messages/${root.id}/replies?$top=${config.repliesPageSize}&$skiptoken=${shown.length}` } : {}),
            }
          })
          const next = skip + top < roots.length ? { "@odata.nextLink": `${channelBase(ctx, params.channelId)}/messages?$top=${top}${expand ? "&$expand=replies" : ""}&$skiptoken=${skip + top}` } : {}
          return Response.json({ value: page, ...next })
        },
      },
      {
        method: "GET",
        path: "/v1.0/teams/:teamId/channels/:channelId/messages/delta",
        handle(request, ctx) {
          const { params } = ctx
          const blocked = gate(request, "teams", params.channelId)
          if (blocked) return blocked
          if (!knownChannel(params.teamId, params.channelId)) return graphError(404, "NotFound", "Channel not found")
          const url = new URL(request.url)
          const top = topOf(url, 50)
          if (top > 50) return graphError(400, "BadRequest", "Invalid page size requested: the maximum is 50")
          const log = channelLogs.get(params.channelId) ?? []
          const token = url.searchParams.get("$deltatoken")
          const skip = Number(url.searchParams.get("$skiptoken") ?? "0")
          let ids: string[]
          if (token === null) ids = rootsOf(params.channelId).map((m) => m.id)
          else {
            const from = Number(token)
            if (!Number.isInteger(from) || from < 0 || from > log.length) return graphError(400, "BadRequest", "Invalid delta token")
            ids = [...new Set(log.slice(from).reverse())].reverse()
          }
          const page = ids.slice(skip, skip + top).map((id) => messageResource(messages.get(id)!))
          const deltaBase = `${channelBase(ctx, params.channelId)}/messages/delta`
          if (skip + top < ids.length) return Response.json({ value: page, "@odata.nextLink": `${deltaBase}?${new URLSearchParams({ ...(token !== null ? { $deltatoken: token } : {}), $top: String(top), $skiptoken: String(skip + top) })}` })
          return Response.json({ value: page, "@odata.deltaLink": `${deltaBase}?$deltatoken=${log.length}` })
        },
      },
      {
        method: "GET",
        path: "/v1.0/teams/:teamId/channels/:channelId/messages/:messageId",
        handle(request, { params }) {
          const blocked = gate(request, "teams", params.channelId)
          if (blocked) return blocked
          const message = messages.get(params.messageId)
          if (!knownChannel(params.teamId, params.channelId) || !message || message.channelId !== params.channelId || message.replyToId) return graphError(404, "NotFound", "Message not found")
          return Response.json(messageResource(message))
        },
      },
      {
        method: "GET",
        path: "/v1.0/teams/:teamId/channels/:channelId/messages/:messageId/replies",
        handle(request, ctx) {
          const { params } = ctx
          const blocked = gate(request, "teams", params.channelId)
          if (blocked) return blocked
          const root = messages.get(params.messageId)
          if (!knownChannel(params.teamId, params.channelId) || !root || root.channelId !== params.channelId) return graphError(404, "NotFound", "Message not found")
          const url = new URL(request.url)
          const top = topOf(url, 20)
          if (top > 50) return graphError(400, "BadRequest", "Invalid page size requested: the maximum is 50")
          const skip = Number(url.searchParams.get("$skiptoken") ?? "0")
          const replies = repliesOf(root.id)
          const next = skip + top < replies.length ? { "@odata.nextLink": `${channelBase(ctx, params.channelId)}/messages/${root.id}/replies?$top=${top}&$skiptoken=${skip + top}` } : {}
          return Response.json({ value: replies.slice(skip, skip + top).map(messageResource), ...next })
        },
      },
      {
        method: "GET",
        path: "/v1.0/teams/:teamId/channels/:channelId/messages/:messageId/replies/:replyId",
        handle(request, { params }) {
          const blocked = gate(request, "teams", params.channelId)
          if (blocked) return blocked
          const reply = messages.get(params.replyId)
          if (!knownChannel(params.teamId, params.channelId) || !reply || reply.replyToId !== params.messageId) return graphError(404, "NotFound", "Message not found")
          return Response.json(messageResource(reply))
        },
      },

      // ---- Subscriptions ----
      {
        method: "POST",
        path: "/v1.0/subscriptions",
        async handle(request) {
          const blocked = gate(request, "teams")
          if (blocked) return blocked
          const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
          const { changeType, notificationUrl, lifecycleNotificationUrl, resource, clientState } = body as Record<string, string | undefined>
          if (!changeType || !notificationUrl || !resource) return graphError(400, "InvalidRequest", "changeType, notificationUrl and resource are required")
          if (body.includeResourceData === true) return graphError(400, "InvalidRequest", "includeResourceData needs an encryption certificate")
          if (clientState && clientState.length > 128) return graphError(400, "InvalidRequest", "clientState can't be longer than 128 characters")
          const expiry = expiryProblem(body.expirationDateTime)
          if ("error" in expiry) return expiry.error
          if (Date.parse(expiry.expiration) - Date.now() > 3_600_000 && !lifecycleNotificationUrl) return graphError(400, "InvalidRequest", "lifecycleNotificationUrl is required for Teams resources when the expiration is more than 1 hour away")
          if ([...subscriptions.values()].some((s) => s.resource === resource && s.changeType === changeType)) return graphError(409, "Conflict", "A subscription for this resource and change type already exists")
          if (config.validateEndpoints) {
            for (const url of [notificationUrl, lifecycleNotificationUrl].filter((u): u is string => !!u)) {
              if (!(await validate(url))) return graphError(400, "ValidationError", "Subscription validation request failed. Notification endpoint must respond with 200 OK to validation request.")
            }
          }
          const subscription: Subscription = { id: randomUUID(), resource, changeType, notificationUrl, lifecycleNotificationUrl, clientState, expirationDateTime: expiry.expiration }
          subscriptions.set(subscription.id, subscription)
          return Response.json({ ...subscription, clientState: clientState ?? null }, { status: 201 })
        },
      },
      {
        method: "GET",
        path: "/v1.0/subscriptions",
        handle(request) {
          return gate(request, "any") ?? Response.json({ value: [...subscriptions.values()].map((s) => ({ ...s, clientState: null })) })
        },
      },
      {
        method: "PATCH",
        path: "/v1.0/subscriptions/:id",
        async handle(request, { params }) {
          const blocked = gate(request, "teams")
          if (blocked) return blocked
          const subscription = subscriptions.get(params.id)
          if (!subscription) return graphError(404, "ResourceNotFound", "The object was not found.")
          const expiry = expiryProblem(((await request.json().catch(() => ({}))) as Record<string, unknown>).expirationDateTime)
          if ("error" in expiry) return expiry.error
          subscription.expirationDateTime = expiry.expiration
          return Response.json({ ...subscription, clientState: null })
        },
      },
      {
        method: "DELETE",
        path: "/v1.0/subscriptions/:id",
        handle(request, { params }) {
          const blocked = gate(request, "any")
          if (blocked) return blocked
          if (!subscriptions.delete(params.id)) return graphError(404, "ResourceNotFound", "The object was not found.")
          return new Response(null, { status: 204 })
        },
      },
      {
        method: "POST",
        path: "/v1.0/subscriptions/:id/reauthorize",
        handle(request, { params }) {
          return gate(request, "teams") ?? (subscriptions.has(params.id) ? new Response(null, { status: 204 }) : graphError(404, "ResourceNotFound", "The object was not found."))
        },
      },

      // ---- Test hooks ----
      {
        method: "POST",
        path: "/_fake/mutate",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as Record<string, string | undefined>
          const time = now()
          switch (body.op) {
            case "post":
            case "reply": {
              const channelId = body.channelId ?? GRAPH_FAKE.channels.general
              const id = body.id ?? String(Date.now() + messages.size)
              const replyToId = body.op === "reply" ? (body.messageId ?? null) : null
              messages.set(id, { id, channelId, replyToId, author: { id: "aad-fixture-a", name: body.author ?? "Fixture Officer A" }, html: body.text ?? "", messageType: "message", createdAt: time, lastModifiedAt: time })
              logChannel(channelId, replyToId ?? id)
              return Response.json({ ok: true, id })
            }
            case "edit":
            case "delete": {
              const target = messages.get(body.replyId ?? body.messageId ?? "")
              if (!target) return Response.json({ fake: true, error: "No such message" }, { status: 404 })
              if (body.op === "edit") {
                target.html = body.text ?? ""
                target.editedAt = time
              } else target.deletedAt = time
              target.lastModifiedAt = time
              logChannel(target.channelId, target.replyToId ?? target.id)
              return Response.json({ ok: true })
            }
            case "upload": {
              const id = body.id ?? `sp-${Date.now()}`
              const existing = items.get(id)
              const text = body.text ?? ""
              items.set(id, { id, name: body.name ?? existing?.name ?? "Untitled.txt", parentId: body.parentId ?? existing?.parentId ?? "sp-root", mimeType: body.mimeType ?? existing?.mimeType ?? "text/plain", bytes: async () => strToU8(text), version: (existing?.version ?? 0) + 1, lastModified: time })
              bytesCache.delete(id)
              driveLog.push(id)
              return Response.json({ ok: true, id })
            }
            case "rename-item":
            case "move-item":
            case "delete-item": {
              const item = items.get(body.id ?? "")
              if (!item) return Response.json({ fake: true, error: "No such item" }, { status: 404 })
              if (body.op === "rename-item") item.name = body.name ?? item.name
              if (body.op === "move-item") item.parentId = body.parentId ?? item.parentId
              if (body.op === "delete-item") {
                for (const one of [item, ...[...items.values()].filter((i) => i.parentId === item.id)]) {
                  one.deleted = true
                  driveLog.push(one.id)
                }
              } else {
                item.version++
                item.lastModified = time
                driveLog.push(item.id)
              }
              return Response.json({ ok: true })
            }
            default:
              return Response.json({ fake: true, error: `Unknown op ${body.op}` }, { status: 400 })
          }
        },
      },
      {
        // Test hook: sends a change notification (or a lifecycle event) to a subscription's endpoint, as Graph would
        method: "POST",
        path: "/_fake/emit",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { subscriptionId?: string; changeType?: string; channelId?: string; messageId?: string; replyId?: string; clientState?: string; lifecycleEvent?: string }
          const subscription = body.subscriptionId ? subscriptions.get(body.subscriptionId) : [...subscriptions.values()][0]
          if (!subscription) return Response.json({ fake: true, error: "No such subscription" }, { status: 404 })
          const clientState = body.clientState ?? subscription.clientState
          const channelId = /channels\/([^/]+)\/messages/.exec(subscription.resource)?.[1] ?? body.channelId ?? ""
          let target = subscription.notificationUrl
          let payload: unknown
          if (body.lifecycleEvent) {
            target = subscription.lifecycleNotificationUrl ?? subscription.notificationUrl
            payload = { value: [{ subscriptionId: subscription.id, subscriptionExpirationDateTime: subscription.expirationDateTime, tenantId: GRAPH_FAKE.tenantId, clientState, lifecycleEvent: body.lifecycleEvent }] }
          } else {
            const resource = `teams('${GRAPH_FAKE.teamId}')/channels('${channelId}')/messages('${body.messageId}')${body.replyId ? `/replies('${body.replyId}')` : ""}`
            payload = {
              value: [{ subscriptionId: subscription.id, changeType: body.changeType ?? "created", clientState, tenantId: GRAPH_FAKE.tenantId, subscriptionExpirationDateTime: subscription.expirationDateTime, resource, resourceData: { id: body.replyId ?? body.messageId, "@odata.type": "#Microsoft.Graph.chatMessage", "@odata.id": resource } }],
            }
          }
          const started = Date.now()
          try {
            const response = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) })
            const ms = Date.now() - started
            return Response.json({ status: response.status, ms, slow: ms > 3000 })
          } catch (error) {
            return Response.json({ status: 0, error: error instanceof Error ? error.message : String(error) })
          }
        },
      },
      {
        method: "POST",
        path: "/_fake/expire-tokens",
        handle() {
          tokens.clear()
          return Response.json({ ok: true })
        },
      },
      {
        method: "POST",
        path: "/_fake/config",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as Partial<Config>
          Object.assign(config, body)
          return Response.json({ ok: true, config })
        },
      },
    ]
  },
}
