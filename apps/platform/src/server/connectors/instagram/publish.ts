import { InstagramGraphError, type InstagramGraph } from "./graph"

/**
 * Publishing calls on the Instagram API with Instagram Login (research/instagram.md §3d to §3g), over
 * the publishing token's own Graph client (`instagramGraph(publishToken)`), never the feed's read token.
 * Containers and media_publish go to the professional account's id (IG_ID, `user_id` from /me), as the
 * docs' examples do. The flow itself (images, containers, waiting, publishing, never twice) is
 * `src/server/jack/publish/instagram.ts`.
 */

/** A container's status_code (§3e) */
export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED"

const STATUSES: ContainerStatus[] = ["IN_PROGRESS", "FINISHED", "PUBLISHED", "ERROR", "EXPIRED"]

/** The fields a container can be made with (§3d); the publish flow builds them */
export type ContainerInput =
  | { kind: "image"; imageUrl: string; caption?: string; altText?: string; aiGenerated?: boolean }
  | { kind: "carousel_item"; imageUrl: string }
  | { kind: "carousel"; children: string[]; caption?: string; aiGenerated?: boolean }
  | { kind: "story"; imageUrl: string; aiGenerated?: boolean }

export type PublishedMedia = { id: string; permalink: string | null; timestamp: string | null; caption: string | null; mediaType: string | null }

/** Meta's publishing errors that mean "try again later" rather than "this won't work" */
const TRANSIENT_CODES = new Set([1, 2, -1, -2, 4, 17, 613, 80002])

/** Not ready to publish yet (9007/2207027): wait and try again */
export const isNotReady = (error: unknown) => error instanceof InstagramGraphError && error.code === 9007
/** The day's publishing limit is used up (9/2207042) */
export const isLimitReached = (error: unknown) => error instanceof InstagramGraphError && error.code === 9
/** An error that may pass by itself (a server error, throttling) or no answer at all (a timeout, a dropped connection) */
export const isTransient = (error: unknown) => !(error instanceof InstagramGraphError) || (error.code !== null && TRANSIENT_CODES.has(error.code)) || error.status >= 500

/** The container fields Meta takes, from our input */
export function containerBody(input: ContainerInput): Record<string, unknown> {
  switch (input.kind) {
    case "image":
      return { image_url: input.imageUrl, ...(input.caption ? { caption: input.caption } : {}), ...(input.altText ? { alt_text: input.altText } : {}), ...(input.aiGenerated ? { is_ai_generated: true } : {}) }
    case "carousel_item":
      return { image_url: input.imageUrl, is_carousel_item: true }
    case "carousel":
      // The AI label goes on the carousel, not its items (§3d)
      return { media_type: "CAROUSEL", children: input.children.join(","), ...(input.caption ? { caption: input.caption } : {}), ...(input.aiGenerated ? { is_ai_generated: true } : {}) }
    case "story":
      return { image_url: input.imageUrl, media_type: "STORIES", ...(input.aiGenerated ? { is_ai_generated: true } : {}) }
  }
}

export function instagramPublisher(graph: InstagramGraph, igUserId: string) {
  return {
    userId: igUserId,

    /** The token's account: proves the token works and says whose it is */
    async account(signal?: AbortSignal): Promise<{ userId: string; username: string; accountType: string | null }> {
      const me = await graph.get<{ user_id?: string; username?: string; account_type?: string }>("/me", { fields: "user_id,username,account_type" }, signal)
      return { userId: me.user_id ?? igUserId, username: me.username ?? "", accountType: me.account_type ?? null }
    },

    /** Posts published through the API in the last 24 hours against the limit (§3g); needs content_publish, so it also proves the permission */
    async quota(signal?: AbortSignal): Promise<{ used: number; total: number }> {
      const body = await graph.get<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(`/${igUserId}/content_publishing_limit`, { fields: "quota_usage,config" }, signal)
      const row = body.data?.[0]
      return { used: row?.quota_usage ?? 0, total: row?.config?.quota_total ?? 50 }
    },

    /** Makes a container; returns its id. Not published yet: it expires after 24 hours unless published */
    async createContainer(input: ContainerInput, signal?: AbortSignal): Promise<string> {
      const { id } = await graph.post<{ id?: string }>(`/${igUserId}/media`, containerBody(input), signal)
      if (!id) throw new Error("Instagram didn't return a container id")
      return id
    },

    /** A container's status, with Meta's detail for ERROR */
    async containerStatus(containerId: string, signal?: AbortSignal): Promise<{ code: ContainerStatus; detail: string | null }> {
      const body = await graph.get<{ status_code?: string; status?: string }>(`/${encodeURIComponent(containerId)}`, { fields: "status_code,status" }, signal)
      const code = STATUSES.find((s) => s === body.status_code)
      if (!code) throw new Error(`Instagram gave an unknown container status (${String(body.status_code).slice(0, 30)})`)
      return { code, detail: body.status ? body.status.slice(0, 300) : null }
    },

    /** Publishes a finished container. Not idempotent: check the container's status before ever calling it again */
    async publish(containerId: string, signal?: AbortSignal): Promise<{ id: string; partial: string | null }> {
      const body = await graph.post<{ id?: string; config_issue?: string; caption_add_on_attachment_status?: string }>(`/${igUserId}/media_publish`, { creation_id: containerId }, signal)
      if (!body.id) throw new Error("Instagram didn't return the post's id")
      // A partial success: the post is live, but the caption or a tag didn't attach (§3f)
      return { id: body.id, partial: body.config_issue ?? body.caption_add_on_attachment_status ?? null }
    },

    /** A published post's link and details */
    async media(mediaId: string, signal?: AbortSignal): Promise<PublishedMedia> {
      const body = await graph.get<{ id: string; permalink?: string; timestamp?: string; caption?: string; media_type?: string }>(`/${encodeURIComponent(mediaId)}`, { fields: "id,permalink,timestamp,caption,media_type" }, signal)
      return { id: body.id, permalink: body.permalink ?? null, timestamp: body.timestamp ?? null, caption: body.caption ?? null, mediaType: body.media_type ?? null }
    },

    /** The newest feed posts (stories aren't listed), to find a post whose publish call never answered */
    async recentMedia(limit = 10, signal?: AbortSignal): Promise<PublishedMedia[]> {
      const body = await graph.get<{ data?: { id: string; permalink?: string; timestamp?: string; caption?: string; media_type?: string }[] }>("/me/media", { fields: "id,permalink,timestamp,caption,media_type", limit }, signal)
      return (body.data ?? []).map((m) => ({ id: m.id, permalink: m.permalink ?? null, timestamp: m.timestamp ?? null, caption: m.caption ?? null, mediaType: m.media_type ?? null }))
    },
  }
}

export type InstagramPublisher = ReturnType<typeof instagramPublisher>
