import { joinSlots } from "@/lib/slots"
import { SOURCES as clubDataSources } from "./slots/club-data"
import { SOURCES as discordReadSources } from "./slots/discord-read"
import type { SearchReader, SearchSource } from "./types"

/**
 * Every search source, joined from the tracks' slot files in SLOT_TRACKS order (design §2.2). The
 * `search` and `read` tools build their inputs from this list, so a track adds a source (and the
 * types `read` opens for it) in its own slot file. Loading this module throws if two slots register
 * the same source key, or two sources the same reader type.
 */

const SOURCE_SLOTS = {
  "club-data": clubDataSources,
  "discord-read": discordReadSources,
}

export const SEARCH_SOURCES: SearchSource[] = joinSlots("search source", SOURCE_SLOTS, (source) => source.key)

export const SEARCH_READERS: SearchReader[] = SEARCH_SOURCES.flatMap((source) => source.readers)

for (const [i, reader] of SEARCH_READERS.entries()) {
  if (SEARCH_READERS.findIndex((other) => other.type === reader.type) !== i) throw new Error(`Duplicate read type "${reader.type}": two search sources register it`)
}

export function findSearchSource(key: string): SearchSource | undefined {
  return SEARCH_SOURCES.find((source) => source.key === key)
}

export function findReader(type: string): SearchReader | undefined {
  return SEARCH_READERS.find((reader) => reader.type === type)
}
