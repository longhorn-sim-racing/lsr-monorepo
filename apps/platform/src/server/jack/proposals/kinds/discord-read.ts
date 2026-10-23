import type { AnyProposalKind } from "../types"

/** Proposal kinds from the discord-read track (design §4.3). The registry joins every track's kinds in a fixed order. Never import ../registry here (an import cycle); targets come from ../import-targets */
export const KINDS: AnyProposalKind[] = []
