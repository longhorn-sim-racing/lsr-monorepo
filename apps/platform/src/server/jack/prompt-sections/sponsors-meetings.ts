import type { PromptSlot } from "./types"

/** Sponsors and meetings (prospects, meetings, decisions, action items, drafts): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: "",
  pages: [
    "Sponsors: sponsor prospects, their stage, and the activity with each.",
    "Meetings: meetings with their agendas, summaries and decisions.",
    "Action items: action items from meetings and rooms, by owner, and whether they're done.",
  ],
}
