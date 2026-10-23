import { joinSlots, type SlotTrack } from "@/lib/slots"
import { CONNECTORS as automationConnectors } from "./registry/automation"
import { CONNECTORS as changesConnectors } from "./registry/changes"
import { CONNECTORS as clubDataConnectors } from "./registry/club-data"
import { CONNECTORS as decksRoomsConnectors } from "./registry/decks-rooms"
import { CONNECTORS as discordPostConnectors } from "./registry/discord-post"
import { CONNECTORS as discordReadConnectors } from "./registry/discord-read"
import { CONNECTORS as documentsConnectors } from "./registry/documents"
import { CONNECTORS as groundworkConnectors } from "./registry/groundwork"
import { CONNECTORS as memoryConnectors } from "./registry/memory"
import { CONNECTORS as sourcesAConnectors } from "./registry/sources-a"
import { CONNECTORS as sourcesBConnectors } from "./registry/sources-b"
import { CONNECTORS as sponsorsMeetingsConnectors } from "./registry/sponsors-meetings"
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
