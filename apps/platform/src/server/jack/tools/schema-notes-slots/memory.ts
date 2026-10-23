import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the memory track's tables */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Knowledge base
- "KnowledgeEntry" is one piece of club knowledge (a decision, a how-to, a policy, who does what): title, body (markdown) and tags. sourceType: MANUAL = an officer wrote it on the Knowledge page, JACK = you saved it in a room, SEED = loaded from reviewed seed files. archivedAt set = archived (leave those out unless asked).
- Not reviewed = reviewedAt is null and a version with via 'jack' exists: you saved or changed it and no officer has checked it since. Age = now minus (reviewedAt, else sourceDate, else updatedAt).
- "KnowledgeEntryVersion" holds every saved state of an entry, newest last by createdAt; via is admin, jack or seed. The newest version's id is what a knowledge update passes as baseVersionId.
- Officer profiles are columns on "User": department (executive, business, community, competition, media or technology: the About page's teams), isBoard (holds a board seat) and workingOn (what they say they work on, in their own words).`,
  tableNotes: {
    User: "department, isBoard and workingOn are an officer's profile (set by officers only).",
    KnowledgeEntry: "Club knowledge entries. provenance (Jack's saves) records the room, the reply, the tools used before saving, and noteIds: your room notes about it.",
    KnowledgeEntryVersion: "Every saved state of a knowledge entry; editedById and roomId say who and where.",
  },
}
