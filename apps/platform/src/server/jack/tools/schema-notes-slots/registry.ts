import { SLOT_TRACKS, type SlotTrack } from "@/lib/slots"
import { SCHEMA_NOTES as automationNotes } from "./automation"
import { SCHEMA_NOTES as changesNotes } from "./changes"
import { SCHEMA_NOTES as clubDataNotes } from "./club-data"
import { SCHEMA_NOTES as decksRoomsNotes } from "./decks-rooms"
import { SCHEMA_NOTES as discordPostNotes } from "./discord-post"
import { SCHEMA_NOTES as discordReadNotes } from "./discord-read"
import { SCHEMA_NOTES as documentsNotes } from "./documents"
import { SCHEMA_NOTES as groundworkNotes } from "./groundwork"
import { SCHEMA_NOTES as memoryNotes } from "./memory"
import { SCHEMA_NOTES as sourcesANotes } from "./sources-a"
import { SCHEMA_NOTES as sourcesBNotes } from "./sources-b"
import { SCHEMA_NOTES as sponsorsMeetingsNotes } from "./sponsors-meetings"
import type { SchemaNotesSlot } from "./types"

/**
 * The tracks' describe_schema notes, joined in SLOT_TRACKS order. describe_schema adds them after the
 * core notes (../schema-notes.ts); they never go into the system prompt. Tracks add to their own slot
 * files, never here.
 */

const NOTE_SLOTS = {
  groundwork: groundworkNotes,
  "club-data": clubDataNotes,
  memory: memoryNotes,
  changes: changesNotes,
  "sources-a": sourcesANotes,
  "sources-b": sourcesBNotes,
  documents: documentsNotes,
  "discord-read": discordReadNotes,
  "discord-post": discordPostNotes,
  "decks-rooms": decksRoomsNotes,
  "sponsors-meetings": sponsorsMeetingsNotes,
  automation: automationNotes,
} satisfies Record<SlotTrack, SchemaNotesSlot>

/** Table notes from several sources, in order; two notes on one table become one line */
export function mergeTableNotes(...sources: Record<string, string>[]): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const source of sources) {
    for (const [table, note] of Object.entries(source)) {
      const line = note.trim()
      if (line) merged[table] = merged[table] ? `${merged[table]} ${line}` : line
    }
  }
  return merged
}

/** Each track's notes paragraph, empty ones left out */
export const SLOT_SCHEMA_NOTES: string[] = SLOT_TRACKS.map((track) => NOTE_SLOTS[track].notes.trim()).filter(Boolean)

/** Every track's table notes, merged */
export const SLOT_TABLE_NOTES: Record<string, string> = mergeTableNotes(...SLOT_TRACKS.map((track) => NOTE_SLOTS[track].tableNotes))
