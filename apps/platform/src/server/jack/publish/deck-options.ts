import { fitNote, type DeckPublishOptions } from "@/lib/jack/publish"
import { cloudinaryUploadsConfigured } from "@/server/cloudinary"
import { instagramPublishConnector } from "@/server/connectors/instagram/publish-connector"
import { publishAccount } from "@/server/connectors/instagram/publish-token"
import { prisma } from "@/server/db"
import type { DeckView } from "@/server/jack/decks/service"
import { latestCaptionDraft } from "./caption"

/** Why Instagram publishing can't post right now, in a sentence for the dialog, or null when it can */
function instagramProblem(state: "connected" | "off" | "not_configured" | "error", missingEnv: string[], connected: boolean): string | null {
  if (state === "connected" || state === "error") return null
  if (!connected) return "No publishing token is saved yet: an admin connects it on Content → Instagram, then switches it on."
  if (missingEnv.length) return `This server is missing ${missingEnv.join(", ")} (Cloudinary, which Instagram downloads the slides from).`
  return "It's switched off: an admin runs its smoke test and switches it on."
}

/**
 * What the deck page's Publish and Add to gallery dialogs need (#188, design §13), read without calling
 * Instagram: whether publishing is on, Jack's newest caption draft in the deck's room, how the slides
 * fit Instagram's shapes, and the gallery's albums
 */
export async function deckPublishOptions(deck: Pick<DeckView, "size" | "roomId">): Promise<DeckPublishOptions> {
  const [status, account, captionDraft, albums] = await Promise.all([
    instagramPublishConnector.status(),
    publishAccount(),
    latestCaptionDraft(deck.roomId),
    prisma.galleryAlbum.findMany({ orderBy: [{ date: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], take: 200, select: { id: true, title: true } }),
  ])
  return {
    instagram: { ready: status.state === "connected" || status.state === "error", problem: instagramProblem(status.state, status.missingEnv, account.connected), account: account.username ?? null },
    captionDraft,
    fit: { feed: fitNote(deck.size, "feed"), story: fitNote(deck.size, "story") },
    gallery: { ready: cloudinaryUploadsConfigured(), albums },
  }
}
