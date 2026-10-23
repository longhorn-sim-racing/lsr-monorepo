import { joinSlots, type SlotTrack } from "@/lib/slots"
import type { AnyImportTarget } from "../types"
import { IMPORT_TARGETS as automationTargets } from "./automation"
import { IMPORT_TARGETS as changesTargets } from "./changes"
import { IMPORT_TARGETS as clubDataTargets } from "./club-data"
import { IMPORT_TARGETS as decksRoomsTargets } from "./decks-rooms"
import { IMPORT_TARGETS as discordPostTargets } from "./discord-post"
import { IMPORT_TARGETS as discordReadTargets } from "./discord-read"
import { IMPORT_TARGETS as documentsTargets } from "./documents"
import { IMPORT_TARGETS as groundworkTargets } from "./groundwork"
import { IMPORT_TARGETS as memoryTargets } from "./memory"
import { IMPORT_TARGETS as sourcesATargets } from "./sources-a"
import { IMPORT_TARGETS as sourcesBTargets } from "./sources-b"
import { IMPORT_TARGETS as sponsorsMeetingsTargets } from "./sponsors-meetings"

/**
 * Every import target, joined from the tracks' slot files in SLOT_TRACKS order. Its own registry,
 * apart from the kinds', so the import.rows kind can import it without an import cycle. Loading this
 * module throws if two slots register the same target. Tracks add to their own slot files, never here,
 * and a target's slot file must not import this module.
 */

const TARGET_SLOTS = {
  groundwork: groundworkTargets,
  "club-data": clubDataTargets,
  memory: memoryTargets,
  changes: changesTargets,
  "sources-a": sourcesATargets,
  "sources-b": sourcesBTargets,
  documents: documentsTargets,
  "discord-read": discordReadTargets,
  "discord-post": discordPostTargets,
  "decks-rooms": decksRoomsTargets,
  "sponsors-meetings": sponsorsMeetingsTargets,
  automation: automationTargets,
} satisfies Record<SlotTrack, AnyImportTarget[]>

export const IMPORT_TARGETS: AnyImportTarget[] = joinSlots("import target", TARGET_SLOTS, (target) => target.target)

export function findImportTarget(target: string): AnyImportTarget | undefined {
  return IMPORT_TARGETS.find((t) => t.target === target)
}
