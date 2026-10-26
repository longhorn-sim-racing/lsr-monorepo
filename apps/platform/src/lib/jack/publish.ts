import { JACK_DECK_SIZES, type JackDeckSizeKey } from "./decks"

/**
 * Instagram publishing's plain values (#188, design §12.6), for the server, the deck page's dialogs and
 * the publish history alike. The flow itself is src/server/jack/publish/instagram.ts.
 */

/** Feed posts and carousels are 4:5 (the deck "post" size); stories are 9:16 (research §3d, §6) */
export type InstagramShape = "feed" | "story"

export const INSTAGRAM_CANVAS: Record<InstagramShape, { width: number; height: number; label: string }> = {
  feed: { width: 1080, height: 1350, label: "4:5" },
  story: { width: 1080, height: 1920, label: "9:16" },
}

const RATIO: Record<JackDeckSizeKey, string> = { slides: "16:9", post: "4:5", story: "9:16", square: "1:1" }

export const sameRatio = (a: { width: number; height: number }, b: { width: number; height: number }) => Math.abs(a.width / a.height - b.width / b.height) < 0.01

/** How a deck of this size goes on an Instagram shape: null when it fills it, else a sentence about the bars */
export function fitNote(size: JackDeckSizeKey, shape: InstagramShape): string | null {
  const slide = JACK_DECK_SIZES[size]
  const canvas = INSTAGRAM_CANVAS[shape]
  if (sameRatio(slide, canvas)) return null
  const bars = slide.width / slide.height > canvas.width / canvas.height ? "above and below" : "at the sides"
  return `The slides are ${RATIO[size]}, so each sits whole on a ${canvas.label} image with bars ${bars}.`
}

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

/**
 * What an instagram.publish proposal is for (JackProposal.targetId): the deck, the type and the slides.
 * A newer proposal for the same post (a revised caption) replaces an older pending one; two stories of
 * one deck, or a carousel and a story from it, are separate posts and both stay
 */
export function publishTargetId(deckId: string, type: PublishType, slideIds: string[]): string {
  return `${deckId}:${type}:${slideIds.join(",")}`
}

/** A post sent from a deck lately (on its way, or sent in the last day), for the deck page's dialog */
export type DeckRecentPost = { id: string; mediaType: PublishMediaType; version: number | null; slides: number; status: PublishStatus; createdAt: string; permalink: string | null }

/** What the deck page's Publish and Add to gallery dialogs know, from the server (nothing in it is a secret) */
export type DeckPublishOptions = {
  instagram: { ready: boolean; problem: string | null; account: string | null }
  /** This deck's posts on their way or sent in the last day, newest first */
  recent: DeckRecentPost[]
  /** The newest caption Jack drafted in the deck's room, to start from */
  captionDraft: string | null
  /** How the slides go on each Instagram shape, or null when they fill it */
  fit: { feed: string | null; story: string | null }
  gallery: { ready: boolean; albums: { id: string; title: string }[] }
}

/** What fits a deck: the type an officer most likely wants for its size and how many slides it has */
export function defaultPublishType(size: string, slides: number): PublishType {
  if (size === "story") return "story"
  return slides > 1 ? "carousel" : "post"
}
