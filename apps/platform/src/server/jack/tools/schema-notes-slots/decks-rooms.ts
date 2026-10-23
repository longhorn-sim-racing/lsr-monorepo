import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the decks-rooms track's tables */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Rooms, ratings and cost
- A room with archivedAt set is archived: read-only and out of the rooms list. pinnedAt set = pinned to the top of the list. answerMode 'mention' = it answers only officer messages that mention @Jack (or the room's persona); 'always' = every message.
- In a mention-mode room, an officer message that didn't mention Jack has expectsAnswer false: conversation among officers. The next reply to a mention takes it as context, so its answeredById points at that reply too.
- "JackFeedback" is an officer's thumbs up or down on one reply (messageId is the reply; one per officer per reply). note is optional; createdAt is when the rating was last set. A 'down' with a note is an eval candidate on the Usage page.
- A reply's cost is on its own JackMessage row (kind 'assistant', costUsd); Stand naming rooms is in JackUsage (job 'name_room'). A month's spend is both, counted by Central Time month. A reply is for the officer whose message started it: the newest message it answered (a scheduled note means a recurring question, no officer).`,
  tableNotes: {
    JackRoom: "archivedAt (archived, read-only), pinnedAt (pinned) and answerMode ('always' or 'mention') are the room's settings.",
    JackMessage: "expectsAnswer false = an officer message in a mention-mode room that didn't mention Jack.",
    JackFeedback: "Officers' thumbs up or down on replies, with an optional note.",
  },
}
