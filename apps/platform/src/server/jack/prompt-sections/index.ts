import { PROMPT_SLOT as automation } from "./automation"
import { PROMPT_SLOT as changes } from "./changes"
import { PROMPT_SLOT as clubData } from "./club-data"
import { PROMPT_SLOT as decksRooms } from "./decks-rooms"
import { PROMPT_SLOT as discordPost } from "./discord-post"
import { PROMPT_SLOT as discordRead } from "./discord-read"
import { PROMPT_SLOT as documents } from "./documents"
import { PROMPT_SLOT as groundwork } from "./groundwork"
import { PROMPT_SLOT as memory } from "./memory"
import { PROMPT_SLOT as sourcesA } from "./sources-a"
import { PROMPT_SLOT as sourcesB } from "./sources-b"
import { PROMPT_SLOT as sponsorsMeetings } from "./sponsors-meetings"
import type { PromptSlot } from "./types"

export type { PromptSlot } from "./types"

/**
 * Every track's slot, in a fixed order. The system prompt is a cached prefix, so the order never
 * changes: a new track goes at the end.
 */
export const PROMPT_SLOTS: Readonly<Record<string, PromptSlot>> = {
  groundwork,
  "club-data": clubData,
  memory,
  changes,
  "sources-a": sourcesA,
  "sources-b": sourcesB,
  documents,
  "discord-read": discordRead,
  "discord-post": discordPost,
  "decks-rooms": decksRooms,
  "sponsors-meetings": sponsorsMeetings,
  automation,
}

/** The tracks' sections that have text, in order, each under its own heading */
export function trackSections(slots: readonly PromptSlot[] = Object.values(PROMPT_SLOTS)): string {
  return slots
    .map((slot) => slot.section.trim())
    .filter(Boolean)
    .join("\n\n")
}

/** The tracks' admin pages, in order, as lines for "Where officers make changes" */
export function trackPages(slots: readonly PromptSlot[] = Object.values(PROMPT_SLOTS)): string[] {
  return slots.flatMap((slot) => slot.pages.map((page) => `- ${page.trim()}`))
}
