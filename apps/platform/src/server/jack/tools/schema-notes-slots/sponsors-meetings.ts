import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the sponsors-meetings track's tables */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Sponsors and meetings
- "SponsorProspect" is a company the club is courting for sponsorship. The sponsors shown on the website aren't in the database (they're set in the site's code), and nothing links them to prospects. stage: idea, researching, contacted, talking, committed, declined or dormant. tierInterest: friend, silver, gold or platinum (the sponsorship tiers). ownerId is the officer handling it. lastContactAt moves with each email sent, reply, call or meeting logged. contactEmail is a person's address: only when an officer asks.
- "SponsorActivity" is a prospect's timeline, newest by occurredAt: type email_sent, reply, meeting, call or note, plus stage_change rows written when the stage changes. byId is the officer who did it.
- Quiet prospect: stage contacted or talking with nothing logged for 21 days (counted from the newest activity, else lastContactAt, else createdAt).
- "Meeting": its type is in the column kind (board, tech, general, department, other). heldAt is the start time; a meeting recorded without a time sits at midnight Central. agendaMd and summaryMd are Markdown. transcriptFileId is the room file it was recorded from.
- "MeetingDecision" is one decision (decidedAt = when the meeting was held). knowledgeEntryId links its decision-log entry: a "KnowledgeEntry" tagged decision (sourceType JACK, not reviewed until an officer marks it, when it came from a meeting.record proposal; MANUAL and reviewed when typed on the meeting page).
- "ActionItem": status open, done or dropped; doneAt is set when it's marked done. dueAt is the start of its Central due date. Overdue = open and due before today (Central). meetingId when it came from a meeting; roomId when Jack proposed it.`,
  tableNotes: {
    SponsorProspect: "A company the club is courting for sponsorship (not the website's sponsors). Personal data in the contact fields.",
    SponsorActivity: "A sponsor prospect's timeline: emails, replies, calls, meetings, notes and stage changes.",
    Meeting: "A club meeting; the type is in kind. Agenda and summary in Markdown.",
    MeetingDecision: "A decision made at a meeting; knowledgeEntryId is its decision-log entry.",
    ActionItem: "Something an officer said they'd do: owner, due date, status open/done/dropped.",
  },
}
