import type { PromptSlot } from "./types"

/** Memory (the knowledge base and officer profiles): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: "",
  pages: [
    "Knowledge: the club's knowledge entries, written by officers or saved by you: edit them, see their history, mark them reviewed, and archive or delete them.",
  ],
}
