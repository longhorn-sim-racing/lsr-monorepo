import { joinSlots, type SlotTrack } from "@/lib/slots"
import { IMPORT_TARGETS as automationTargets } from "./import-targets/automation"
import { IMPORT_TARGETS as changesTargets } from "./import-targets/changes"
import { IMPORT_TARGETS as clubDataTargets } from "./import-targets/club-data"
import { IMPORT_TARGETS as decksRoomsTargets } from "./import-targets/decks-rooms"
import { IMPORT_TARGETS as discordPostTargets } from "./import-targets/discord-post"
import { IMPORT_TARGETS as discordReadTargets } from "./import-targets/discord-read"
import { IMPORT_TARGETS as documentsTargets } from "./import-targets/documents"
import { IMPORT_TARGETS as groundworkTargets } from "./import-targets/groundwork"
import { IMPORT_TARGETS as memoryTargets } from "./import-targets/memory"
import { IMPORT_TARGETS as sourcesATargets } from "./import-targets/sources-a"
import { IMPORT_TARGETS as sourcesBTargets } from "./import-targets/sources-b"
import { IMPORT_TARGETS as sponsorsMeetingsTargets } from "./import-targets/sponsors-meetings"
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
import type { AnyImportTarget, AnyProposalKind } from "./types"

/**
 * Every proposal kind and import target, joined from the tracks' slot files in SLOT_TRACKS order.
 * Loading this module throws if two slots register the same key. Tracks add to their own slot files,
 * never here.
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

export const PROPOSAL_KINDS: AnyProposalKind[] = joinSlots("proposal kind", KIND_SLOTS, (kind) => kind.kind)

export const IMPORT_TARGETS: AnyImportTarget[] = joinSlots("import target", TARGET_SLOTS, (target) => target.target)

/** The kind a saved proposal names; undefined when the running code doesn't know it (it can't be applied) */
export function findProposalKind(kind: string): AnyProposalKind | undefined {
  return PROPOSAL_KINDS.find((k) => k.kind === kind)
}

export function findImportTarget(target: string): AnyImportTarget | undefined {
  return IMPORT_TARGETS.find((t) => t.target === target)
}
