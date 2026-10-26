import { byOrder, joinSlots, type SlotTrack } from "@/lib/slots"
import { CHECKS as automationChecks } from "./checks/automation"
import { CHECKS as changesChecks } from "./checks/changes"
import { CHECKS as clubDataChecks } from "./checks/club-data"
import { CHECKS as decksRoomsChecks } from "./checks/decks-rooms"
import { CHECKS as discordPostChecks } from "./checks/discord-post"
import { CHECKS as discordReadChecks } from "./checks/discord-read"
import { CHECKS as documentsChecks } from "./checks/documents"
import { CHECKS as groundworkChecks } from "./checks/groundwork"
import { CHECKS as memoryChecks } from "./checks/memory"
import { CHECKS as sourcesAChecks } from "./checks/sources-a"
import { CHECKS as sourcesBChecks } from "./checks/sources-b"
import { CHECKS as sponsorsMeetingsChecks } from "./checks/sponsors-meetings"
import type { DigestCheck } from "./types"

/**
 * Every digest check, joined from the tracks' slot files and sorted by `order` (ties keep track
 * order). Loading this module throws if two slots register the same id. Tracks add to their own slot
 * files, never here.
 */

const CHECK_SLOTS = {
  groundwork: groundworkChecks,
  "club-data": clubDataChecks,
  memory: memoryChecks,
  changes: changesChecks,
  "sources-a": sourcesAChecks,
  "sources-b": sourcesBChecks,
  documents: documentsChecks,
  "discord-read": discordReadChecks,
  "discord-post": discordPostChecks,
  "decks-rooms": decksRoomsChecks,
  "sponsors-meetings": sponsorsMeetingsChecks,
  automation: automationChecks,
} satisfies Record<SlotTrack, DigestCheck[]>

export const DIGEST_CHECKS: DigestCheck[] = byOrder(joinSlots("digest check", CHECK_SLOTS, (check) => check.id))

export function findDigestCheck(id: string): DigestCheck | undefined {
  return DIGEST_CHECKS.find((check) => check.id === id)
}
