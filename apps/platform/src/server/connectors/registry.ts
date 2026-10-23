import { joinSlots, type SlotTrack } from "@/lib/slots"
import { CONNECTORS as automationConnectors } from "./slots/automation"
import { CONNECTORS as changesConnectors } from "./slots/changes"
import { CONNECTORS as clubDataConnectors } from "./slots/club-data"
import { CONNECTORS as decksRoomsConnectors } from "./slots/decks-rooms"
import { CONNECTORS as discordPostConnectors } from "./slots/discord-post"
import { CONNECTORS as discordReadConnectors } from "./slots/discord-read"
import { CONNECTORS as documentsConnectors } from "./slots/documents"
import { CONNECTORS as groundworkConnectors } from "./slots/groundwork"
import { CONNECTORS as memoryConnectors } from "./slots/memory"
import { CONNECTORS as sourcesAConnectors } from "./slots/sources-a"
import { CONNECTORS as sourcesBConnectors } from "./slots/sources-b"
import { CONNECTORS as sponsorsMeetingsConnectors } from "./slots/sponsors-meetings"
import type { AnyConnector } from "./types"

/**
 * Every outside service, joined from the tracks' slot files in SLOT_TRACKS order (the Connections page
 * lists them in this order). Loading this module throws if two slots register the same id. Tracks add
 * to their own slot files, never here.
 */

const CONNECTOR_SLOTS = {
  groundwork: groundworkConnectors,
  "club-data": clubDataConnectors,
  memory: memoryConnectors,
  changes: changesConnectors,
  "sources-a": sourcesAConnectors,
  "sources-b": sourcesBConnectors,
  documents: documentsConnectors,
  "discord-read": discordReadConnectors,
  "discord-post": discordPostConnectors,
  "decks-rooms": decksRoomsConnectors,
  "sponsors-meetings": sponsorsMeetingsConnectors,
  automation: automationConnectors,
} satisfies Record<SlotTrack, AnyConnector[]>

export const CONNECTORS: AnyConnector[] = joinSlots("connector", CONNECTOR_SLOTS, (connector) => connector.id)

export function findConnector(id: string): AnyConnector | undefined {
  return CONNECTORS.find((connector) => connector.id === id)
}
