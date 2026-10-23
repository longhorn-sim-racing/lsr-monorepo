import { joinSlots, type SlotTrack } from "@/lib/slots"
import { KINDS as automationKinds } from "./kinds/automation"
import { KINDS as changesKinds } from "./kinds/changes"
import { KINDS as clubDataKinds } from "./kinds/club-data"
import { KINDS as decksRoomsKinds } from "./kinds/decks-rooms"
import { KINDS as discordPostKinds } from "./kinds/discord-post"
import { KINDS as discordReadKinds } from "./kinds/discord-read"
import { KINDS as documentsKinds } from "./kinds/documents"
import { KINDS as groundworkKinds } from "./kinds/groundwork"
import { KINDS as memoryKinds } from "./kinds/memory"
import { KINDS as sourcesAKinds } from "./kinds/sources-a"
import { KINDS as sourcesBKinds } from "./kinds/sources-b"
import { KINDS as sponsorsMeetingsKinds } from "./kinds/sponsors-meetings"
import type { AnyProposalKind, ProposeToolName } from "./types"

/**
 * Every proposal kind, joined from the tracks' slot files in SLOT_TRACKS order. Loading this module
 * throws if two slots register the same kind. Tracks add to their own slot files, never here.
 *
 * Kind files must not import this module (that's an import cycle, and joinSlots throws on it). The
 * import targets have their own registry, `./import-targets`, for the import.rows kind to use.
 */

const KIND_SLOTS = {
  groundwork: groundworkKinds,
  "club-data": clubDataKinds,
  memory: memoryKinds,
  changes: changesKinds,
  "sources-a": sourcesAKinds,
  "sources-b": sourcesBKinds,
  documents: documentsKinds,
  "discord-read": discordReadKinds,
  "discord-post": discordPostKinds,
  "decks-rooms": decksRoomsKinds,
  "sponsors-meetings": sponsorsMeetingsKinds,
  automation: automationKinds,
} satisfies Record<SlotTrack, AnyProposalKind[]>

export const PROPOSAL_KINDS: AnyProposalKind[] = joinSlots("proposal kind", KIND_SLOTS, (kind) => kind.kind)

/** The kind a saved proposal names; undefined when the running code doesn't know it (it can't be applied) */
export function findProposalKind(kind: string): AnyProposalKind | undefined {
  return PROPOSAL_KINDS.find((k) => k.kind === kind)
}

/** The kinds a propose_* tool offers, in registry order: it builds its input schema and description from these */
export function kindsForTool(tool: ProposeToolName): AnyProposalKind[] {
  return PROPOSAL_KINDS.filter((k) => k.tool === tool)
}
