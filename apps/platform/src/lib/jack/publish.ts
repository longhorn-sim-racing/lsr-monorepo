/**
 * Instagram publishing's plain values (#188, design §12.6), for the server, the deck page's dialogs and
 * the publish history alike. The flow itself is src/server/jack/publish/instagram.ts.
 */

/** What an officer picks: one slide in the feed, 2-20 as one feed post, or one slide as a story */
export type PublishType = "post" | "carousel" | "story"
/** InstagramPublish.mediaType */
export type PublishMediaType = "IMAGE" | "CAROUSEL" | "STORIES"
/** InstagramPublish.status */
export type PublishStatus = "queued" | "containers" | "publishing" | "published" | "failed"

export const MEDIA_TYPE: Record<PublishType, PublishMediaType> = { post: "IMAGE", carousel: "CAROUSEL", story: "STORIES" }
export const TYPE_LABEL: Record<PublishMediaType, string> = { IMAGE: "a post", CAROUSEL: "a carousel", STORIES: "a story" }
/** A carousel takes 2 to 20 images (the reference; one of Meta's error texts still says 10, research §6) */
export const CAROUSEL_MIN = 2
export const CAROUSEL_MAX = 20

/** Rows still on their way to Instagram */
export const ACTIVE_STATUSES: PublishStatus[] = ["queued", "containers", "publishing"]

/** Where the history is: Content → Instagram's Publishing section */
export const PUBLISH_HISTORY = "/admin/instagram#publishing"

export const PUBLISH_STATUS: Record<PublishStatus, { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  queued: { label: "Preparing", tone: "info" },
  containers: { label: "Instagram is processing", tone: "info" },
  publishing: { label: "Posting", tone: "info" },
  published: { label: "Posted", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
}

export function isPublishStatus(value: string): value is PublishStatus {
  return Object.hasOwn(PUBLISH_STATUS, value)
}

/** What fits a deck: the type an officer most likely wants for its size and how many slides it has */
export function defaultPublishType(size: string, slides: number): PublishType {
  if (size === "story") return "story"
  return slides > 1 ? "carousel" : "post"
}
