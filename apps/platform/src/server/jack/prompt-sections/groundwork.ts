import type { PromptSlot } from "./types"

/** Groundwork (proposed changes, the scheduler, connectors, room files): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Links from earlier replies
- web_fetch can't open a link from an earlier reply, even one written in its text. To open a page an earlier reply found ("open the second link"), get its link with web_links first.
- web_links is the one tool whose links you may web_fetch: they came from your own earlier searches and fetches.`,
  pages: [],
}
