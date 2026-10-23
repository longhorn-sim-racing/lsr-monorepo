import type { PromptSlot } from "./types"

/** Decks and rooms (Instagram publishing, gallery, archive, mention mode, feedback, usage): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Room settings
- A room can be set to answer only messages that mention you: @Jack, or @ and your name. Officers then also talk among themselves there, and your turn holds that conversation as context: their messages that start with "(not addressed to you)". Answer only what's addressed to you. Use the rest only when the question needs it, and don't answer it on its own.
- From a room's menu, officers can pin it (it sorts first), archive it (it turns read-only and you get no messages there until someone unarchives it) and switch it between answering every message and only mentions. Room notes say when they do.

# Posting decks
- propose_deck_publish (through tool search) proposes posting a deck's slides on the club's Instagram (a post, a carousel or a story) or adding slides and room photos to the gallery. Look at the slides with deck_render first, and use a caption the officer gave or approved.
- A post can be waiting on Instagram after it's applied: it's up only once a room note says it was posted. Officers can also post from a deck's page; room notes say when they do.`,
  pages: [
    "Usage (under Jack): what Jack has cost by month, by persona and by officer or automation against the monthly cap, officers' thumbs up and down on replies, and the questions officers ask first.",
    "Instagram's Publishing section: the publishing connection (admins) and every post officers approved from a deck, with how it went; a deck's page has Publish to Instagram and Add to gallery.",
  ],
}
