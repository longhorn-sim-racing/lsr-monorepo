import { joinSlots, type SlotTrack } from "@/lib/slots"
import type { AnyJackTool } from "../types"
import { TOOLS as automationTools } from "./automation"
import { TOOLS as changesTools } from "./changes"
import { TOOLS as clubDataTools } from "./club-data"
import { TOOLS as decksRoomsTools } from "./decks-rooms"
import { TOOLS as discordPostTools } from "./discord-post"
import { TOOLS as discordReadTools } from "./discord-read"
import { TOOLS as documentsTools } from "./documents"
import { TOOLS as groundworkTools } from "./groundwork"
import { TOOLS as memoryTools } from "./memory"
import { TOOLS as sourcesATools } from "./sources-a"
import { TOOLS as sourcesBTools } from "./sources-b"
import { TOOLS as sponsorsMeetingsTools } from "./sponsors-meetings"

/**
 * The tools Jack 2.0's tracks add (#188), joined from their slot files in SLOT_TRACKS order. JACK_TOOLS
 * sends them after today's tools. Loading this module throws if two slots register the same name.
 * Tracks add to their own slot files, never here.
 */

/** Each track's tools, by track: for checks per track (a size budget on each track's tool definitions) */
export const TOOL_SLOTS = {
  groundwork: groundworkTools,
  "club-data": clubDataTools,
  memory: memoryTools,
  changes: changesTools,
  "sources-a": sourcesATools,
  "sources-b": sourcesBTools,
  documents: documentsTools,
  "discord-read": discordReadTools,
  "discord-post": discordPostTools,
  "decks-rooms": decksRoomsTools,
  "sponsors-meetings": sponsorsMeetingsTools,
  automation: automationTools,
} satisfies Record<SlotTrack, AnyJackTool[]>

export const SLOT_TOOLS: AnyJackTool[] = joinSlots("Jack tool", TOOL_SLOTS, (tool) => tool.name)
