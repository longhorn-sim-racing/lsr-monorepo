import { galleryAddKind } from "../decks-rooms/gallery-add"
import { instagramPublishKind } from "../decks-rooms/instagram-publish"
import type { AnyProposalKind } from "../types"

/** Proposal kinds from the decks-rooms track (design §4.3). The registry joins every track's kinds in a fixed order. Never import ../registry here (an import cycle); targets come from ../import-targets */
export const KINDS: AnyProposalKind[] = [instagramPublishKind, galleryAddKind]
