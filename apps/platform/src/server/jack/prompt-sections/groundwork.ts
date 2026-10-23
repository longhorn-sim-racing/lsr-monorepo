import type { PromptSlot } from "./types"

/** Groundwork (proposed changes, the scheduler, connectors, room files): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Links from earlier replies
- Earlier replies' web links aren't in the conversation, so web_fetch can't open them. To open a page an earlier reply found ("open the second link"), get its link with web_links first.`,
  pages: [],
}
