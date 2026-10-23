import { imageInfo, isJpeg } from "../../cloudinary/fake/image-size"
import { FakeNetworkError, type FakeRoute } from "../../fakes/types"

/**
 * Publishing in the Instagram fake (research/instagram.md §3d to §3g and §7), for the instagram-publish
 * connector (T9b). handlers.ts wires it into the fake's one catch-all; it needs a token with
 * instagram_business_content_publish (code 10 otherwise).
 * - POST /<IG_ID>/media makes a container: a single image (`image_url`, `caption`, `alt_text`), a carousel
 *   item (`is_carousel_item`), a carousel (`media_type` CAROUSEL, `children`: 2 to 20 unused, finished
 *   items) or a story (`media_type` STORIES). It really fetches `image_url`, as Instagram does: an
 *   unreachable or non-ASCII link is 9004/2207052, not a JPEG 36001/2207005, over 8 MB 36000/2207004, a
 *   feed image outside 4:5 to 1.91:1 36003/2207009; a caption over 2,200 characters, 30 hashtags or 20
 *   @-tags 36004/2207010. At most 400 containers a rolling day.
 * - GET /<container id>?fields=status_code,status: IN_PROGRESS for the first `processingReads` reads
 *   (default 1), then FINISHED; EXPIRED 24 hours after it was made; ERROR when a test asked for it.
 * - POST /<IG_ID>/media_publish { creation_id }: not finished (or in error) 9007/2207027, unknown or
 *   expired 24/2207008, over the day's quota 9/2207042, published already code 100 (Meta doesn't
 *   document it). It makes a post (/me/media lists posts and carousels, not stories) and the container
 *   reads PUBLISHED.
 * - GET /<media id> answers a post published here (permalink, timestamp, caption, media_type).
 * - GET /<IG_ID>/content_publishing_limit: quota_usage over the last 24 hours against quota_total
 *   (default 50).
 * - Test hooks, POST /_fake/publish: { processingReads: N }, { errorNext: N } (the next N containers
 *   end in ERROR), { quotaTotal: N }, { quotaUsage: N } (that many posts already today), { dropPublish:
 *   N } (the next N media_publish calls publish, then the connection drops, as a timeout would), {
 *   publishError: { code, subcode, message } } (the next media_publish fails with it), { expire: [ids] };
 *   GET /_fake/publish shows the containers and posts.
 */

type Kind = "IMAGE" | "CAROUSEL_ITEM" | "CAROUSEL" | "STORIES"
type StatusCode = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED"

type Container = {
  id: string
  kind: Kind
  imageUrl: string | null
  caption: string
  children: string[]
  aiGenerated: boolean
  altText: string | null
  createdAt: number
  reads: number
  processingReads: number
  error: boolean
  expired: boolean
  usedBy: string | null
  mediaId: string | null
}

/** What the rest of the Instagram fake gives this part */
export type PublishingHost = {
  userId: string
  username: string
  graphError(message: string, code: number, subcode?: number, type?: string): Response
  /** Lists a post on /me/media */
  addPost(post: { id: string; media_type: "IMAGE" | "CAROUSEL_ALBUM"; caption: string; timestamp: number; children?: string[] }): void
}

const DAY = 86_400_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const CONTAINERS_PER_DAY = 400
export const PUBLISH_SCOPE = "instagram_business_content_publish"

export function publishingFake(host: PublishingHost) {
  const containers = new Map<string, Container>()
  const media = new Map<string, { id: string; kind: "IMAGE" | "CAROUSEL_ALBUM" | "STORY"; caption: string; timestamp: number; container: string }>()
  /** When each post was published, for the rolling quota */
  const published: number[] = []
  let quotaTotal = 50
  let processingReads = 1
  let errorNext = 0
  let dropPublish = 0
  let publishError: { code: number; subcode?: number; message?: string } | null = null
  let next = 0
  let nextMedia = 0

  const { graphError } = host
  const containerId = () => `178${String(++next).padStart(14, "0")}`
  const mediaId = () => `18099${String(++nextMedia).padStart(12, "0")}`
  const quotaUsage = () => published.filter((at) => at > Date.now() - DAY).length
  /** Whether the container being made is one a test asked to end in ERROR */
  function takeError(): boolean {
    if (errorNext <= 0) return false
    errorNext--
    return true
  }

  function statusOf(c: Container): StatusCode {
    if (c.mediaId) return "PUBLISHED"
    if (c.expired || Date.now() - c.createdAt > DAY) return "EXPIRED"
    if (c.reads <= c.processingReads) return "IN_PROGRESS"
    return c.error ? "ERROR" : "FINISHED"
  }

  /** Reading the status moves processing along, as time would */
  function readStatus(c: Container): StatusCode {
    const status = statusOf(c)
    c.reads++
    return status
  }

  async function body(request: Request, url: URL): Promise<Record<string, unknown>> {
    const fromQuery = Object.fromEntries(url.searchParams.entries())
    delete fromQuery.access_token
    const type = request.headers.get("content-type") ?? ""
    if (type.includes("application/json")) return { ...fromQuery, ...(((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>) }
    if (type.includes("form")) return { ...fromQuery, ...Object.fromEntries((await request.formData().catch(() => new FormData())).entries()) }
    return fromQuery
  }

  /** Fetches the image the way Instagram does: the error Instagram would give, or null when it's fine */
  async function checkImage(imageUrl: string, feed: boolean): Promise<Response | null> {
    if (!/^[\x20-\x7e]+$/.test(imageUrl)) return graphError("Media download has failed. The media URI doesn't meet our requirements (only US ASCII characters).", 9004, 2207052)
    const response = await fetch(imageUrl).catch(() => null)
    if (!response?.ok) return graphError("Media download has failed. The media URI doesn't meet our requirements.", 9004, 2207052)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > MAX_IMAGE_BYTES) return graphError("The image size is too large.", 36000, 2207004)
    if (!isJpeg(bytes)) return graphError("The image format is not supported. Only JPEG is supported.", 36001, 2207005)
    const info = imageInfo(bytes)
    if (!info) return graphError("The image could not be read.", 36001, 2207005)
    const ratio = info.width / info.height
    if (feed && (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005)) return graphError(`The aspect ratio is not supported (${info.width}x${info.height}).`, 36003, 2207009)
    return null
  }

  function checkCaption(caption: string): Response | null {
    const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0
    const tags = caption.match(/(^|[^\w])@[\w.]+/g)?.length ?? 0
    if (caption.length > 2_200 || hashtags > 30 || tags > 20) return graphError("The caption is too long or has too many hashtags or tags.", 36004, 2207010)
    return null
  }

  async function createContainer(request: Request, url: URL): Promise<Response> {
    const input = await body(request, url)
    const madeToday = [...containers.values()].filter((c) => c.createdAt > Date.now() - DAY).length
    if (madeToday >= CONTAINERS_PER_DAY) return graphError("You've made the most media containers allowed in 24 hours.", 9, 2207042)
    const caption = typeof input.caption === "string" ? input.caption : ""
    const truthy = (value: unknown) => value === true || value === "true"
    const mediaType = typeof input.media_type === "string" ? input.media_type : null
    const base = { caption, aiGenerated: truthy(input.is_ai_generated), altText: typeof input.alt_text === "string" ? input.alt_text : null, createdAt: Date.now(), reads: 0, processingReads, error: false, expired: false, usedBy: null, mediaId: null }

    if (mediaType === "CAROUSEL") {
      const children = String(input.children ?? "").split(",").map((id) => id.trim()).filter(Boolean)
      if (children.length < 2 || children.length > 20) return graphError("A carousel needs 2 to 20 items.", 100, 2207028)
      for (const id of children) {
        const child = containers.get(id)
        if (!child || child.kind !== "CAROUSEL_ITEM") return graphError(`(#100) ${id} isn't a carousel item container.`, 100)
        if (child.usedBy) return graphError(`(#100) The carousel item ${id} is already in another carousel.`, 100)
        if (statusOf(child) !== "FINISHED") return graphError(`(#100) The carousel item ${id} isn't ready (${statusOf(child)}).`, 100)
      }
      const problem = checkCaption(caption)
      if (problem) return problem
      const id = containerId()
      for (const child of children) containers.get(child)!.usedBy = id
      containers.set(id, { ...base, id, kind: "CAROUSEL", imageUrl: null, children, error: takeError() })
      return Response.json({ id })
    }

    const imageUrl = typeof input.image_url === "string" ? input.image_url : ""
    if (!imageUrl) return graphError("(#100) The parameter image_url is required.", 100)
    const kind: Kind = mediaType === "STORIES" ? "STORIES" : truthy(input.is_carousel_item) ? "CAROUSEL_ITEM" : "IMAGE"
    if (mediaType && mediaType !== "STORIES" && mediaType !== "IMAGE") return graphError(`(#100) media_type ${mediaType} isn't supported here.`, 100)
    if (kind !== "IMAGE" && caption) return graphError(kind === "STORIES" ? "(#100) Stories don't take a caption." : "(#100) Carousel items don't take a caption.", 100)
    const problem = (await checkImage(imageUrl, kind !== "STORIES")) ?? checkCaption(caption)
    if (problem) return problem
    const id = containerId()
    containers.set(id, { ...base, id, kind, imageUrl, children: [], error: takeError() })
    return Response.json({ id })
  }

  async function publish(request: Request, url: URL): Promise<Response> {
    const input = await body(request, url)
    const container = containers.get(String(input.creation_id ?? ""))
    if (!container) return graphError("The media container doesn't exist or has expired.", 24, 2207008)
    if (container.kind === "CAROUSEL_ITEM") return graphError("(#100) Carousel items are published through their carousel.", 100)
    if (publishError) {
      const { code, subcode, message } = publishError
      publishError = null
      return graphError(message ?? "An unexpected error has occurred.", code, subcode)
    }
    const status = statusOf(container)
    if (status === "PUBLISHED") return graphError("(#100) This media has already been published.", 100)
    if (status === "EXPIRED") return graphError("The media container doesn't exist or has expired.", 24, 2207008)
    if (status !== "FINISHED") return graphError("Media ID is not available: the media isn't ready for publishing.", 9007, 2207027)
    if (quotaUsage() >= quotaTotal) return graphError("The account has reached its daily publishing limit.", 9, 2207042)

    const id = mediaId()
    container.mediaId = id
    published.push(Date.now())
    if (container.kind === "STORIES") {
      media.set(id, { id, kind: "STORY", caption: "", timestamp: Date.now(), container: container.id })
    } else {
      const kind = container.kind === "CAROUSEL" ? "CAROUSEL_ALBUM" : "IMAGE"
      media.set(id, { id, kind, caption: container.caption, timestamp: Date.now(), container: container.id })
      host.addPost({ id, media_type: kind, caption: container.caption, timestamp: Date.now(), ...(container.kind === "CAROUSEL" ? { children: container.children.map((_, i) => `${id}${i + 1}`) } : {}) })
    }
    if (dropPublish > 0) {
      dropPublish--
      throw new FakeNetworkError("media_publish: the connection dropped after the post went out")
    }
    return Response.json({ id })
  }

  const knob: FakeRoute = {
    method: "*",
    path: "/_fake/publish",
    async handle(request) {
      if (request.method === "POST") {
        const input = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
        if (typeof input.processingReads === "number") processingReads = input.processingReads
        if (typeof input.errorNext === "number") errorNext = input.errorNext
        if (typeof input.quotaTotal === "number") quotaTotal = input.quotaTotal
        if (typeof input.quotaUsage === "number") for (let i = 0; i < input.quotaUsage; i++) published.push(Date.now())
        if (typeof input.dropPublish === "number") dropPublish = input.dropPublish
        if (input.publishError && typeof input.publishError === "object") publishError = input.publishError as typeof publishError
        if (Array.isArray(input.expire)) for (const id of input.expire) if (containers.has(String(id))) containers.get(String(id))!.expired = true
      }
      return Response.json({
        quota: { used: quotaUsage(), total: quotaTotal },
        containers: [...containers.values()].map((c) => ({ id: c.id, kind: c.kind, status: statusOf(c), caption: c.caption, children: c.children, aiGenerated: c.aiGenerated, altText: c.altText, imageUrl: c.imageUrl })),
        posts: [...media.values()],
      })
    },
  }

  return {
    routes: [knob],
    /** Answers a publishing request, or returns null for the rest of the fake to handle */
    handle(request: Request, url: URL, path: string, scopes: string[]): Promise<Response> | Response | null {
      const own = (id: string) => id === host.userId
      const media_ = /^\/([^/]+)\/(media|media_publish|content_publishing_limit)$/.exec(path)
      if (media_ && own(decodeURIComponent(media_[1])) && !(request.method === "GET" && media_[2] === "media")) {
        if (!scopes.includes(PUBLISH_SCOPE)) return graphError("(#10) Application does not have permission for this action", 10)
        if (media_[2] === "media" && request.method === "POST") return createContainer(request, url)
        if (media_[2] === "media_publish" && request.method === "POST") return publish(request, url)
        if (media_[2] === "content_publishing_limit" && request.method === "GET") {
          return Response.json({ data: [{ quota_usage: quotaUsage(), config: { quota_total: quotaTotal, quota_duration: 86_400 } }] })
        }
        return null
      }
      const one = /^\/(\d+)$/.exec(path)
      if (one && request.method === "GET") {
        const container = containers.get(one[1])
        if (container) {
          if (!scopes.includes(PUBLISH_SCOPE)) return graphError("(#10) Application does not have permission for this action", 10)
          const status = readStatus(container)
          return Response.json({ id: container.id, status_code: status, ...(status === "ERROR" ? { status: "Error: The image couldn't be processed (fake). 2207001" } : {}) })
        }
        const post = media.get(one[1])
        if (post) {
          const shortcode = `FAKEPUB${post.id.slice(-5)}`
          return Response.json({
            id: post.id,
            media_type: post.kind === "STORY" ? "IMAGE" : post.kind,
            media_product_type: post.kind === "STORY" ? "STORY" : "FEED",
            caption: post.caption,
            permalink: post.kind === "STORY" ? `https://www.instagram.com/stories/${host.username}/${post.id}/` : `https://www.instagram.com/p/${shortcode}/`,
            timestamp: new Date(post.timestamp).toISOString().replace(/\.\d{3}Z$/, "+0000"),
          })
        }
      }
      return null
    },
  }
}
