import { joinSlots, type SlotTrack } from "@/lib/slots"
import { FAKES as automationFakes } from "./slots/automation"
import { FAKES as changesFakes } from "./slots/changes"
import { FAKES as clubDataFakes } from "./slots/club-data"
import { FAKES as decksRoomsFakes } from "./slots/decks-rooms"
import { FAKES as discordPostFakes } from "./slots/discord-post"
import { FAKES as discordReadFakes } from "./slots/discord-read"
import { FAKES as documentsFakes } from "./slots/documents"
import { FAKES as groundworkFakes } from "./slots/groundwork"
import { FAKES as memoryFakes } from "./slots/memory"
import { FAKES as sourcesAFakes } from "./slots/sources-a"
import { FAKES as sourcesBFakes } from "./slots/sources-b"
import { FAKES as sponsorsMeetingsFakes } from "./slots/sponsors-meetings"
import type { FakeService } from "./types"

/**
 * Every service's HTTP fake, joined from the tracks' slot files in SLOT_TRACKS order. The fakes server
 * (`pnpm jack:fakes`) mounts them all, and mountFakes() does by default. Loading this module throws if
 * two slots register the same id. Only scripts and tests import it; the app never does.
 */

const FAKE_SLOTS = {
  groundwork: groundworkFakes,
  "club-data": clubDataFakes,
  memory: memoryFakes,
  changes: changesFakes,
  "sources-a": sourcesAFakes,
  "sources-b": sourcesBFakes,
  documents: documentsFakes,
  "discord-read": discordReadFakes,
  "discord-post": discordPostFakes,
  "decks-rooms": decksRoomsFakes,
  "sponsors-meetings": sponsorsMeetingsFakes,
  automation: automationFakes,
} satisfies Record<SlotTrack, FakeService[]>

export const FAKE_SERVICES: FakeService[] = joinSlots("fake service", FAKE_SLOTS, (service) => service.id)

export function findFakeService(id: string): FakeService | undefined {
  return FAKE_SERVICES.find((service) => service.id === id)
}
