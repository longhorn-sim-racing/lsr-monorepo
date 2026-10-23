import { byOrder, joinSlots, type SlotTrack } from "@/lib/slots"
import { CARDS as automationCards } from "./automation"
import { CARDS as changesCards } from "./changes"
import { CARDS as clubDataCards } from "./club-data"
import { CARDS as decksRoomsCards } from "./decks-rooms"
import { CARDS as discordPostCards } from "./discord-post"
import { CARDS as discordReadCards } from "./discord-read"
import { CARDS as documentsCards } from "./documents"
import { CARDS as groundworkCards } from "./groundwork"
import { CARDS as memoryCards } from "./memory"
import { CARDS as sourcesACards } from "./sources-a"
import { CARDS as sourcesBCards } from "./sources-b"
import { CARDS as sponsorsMeetingsCards } from "./sponsors-meetings"
import type { OverviewCard } from "./types"

export type { OverviewCard } from "./types"

/**
 * Every Overview card, joined from the tracks' slot files and sorted by `order` (ties keep track
 * order). Loading this module throws if two slots register the same id. Tracks add to their own slot
 * files, never here.
 */

const CARD_SLOTS = {
  groundwork: groundworkCards,
  "club-data": clubDataCards,
  memory: memoryCards,
  changes: changesCards,
  "sources-a": sourcesACards,
  "sources-b": sourcesBCards,
  documents: documentsCards,
  "discord-read": discordReadCards,
  "discord-post": discordPostCards,
  "decks-rooms": decksRoomsCards,
  "sponsors-meetings": sponsorsMeetingsCards,
  automation: automationCards,
} satisfies Record<SlotTrack, OverviewCard[]>

export const OVERVIEW_CARDS: OverviewCard[] = byOrder(joinSlots("Overview card", CARD_SLOTS, (card) => card.id))
