import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the automation track's tables */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: `Recurring questions and the weekly digest
- "RecurringQuestion" is a question asked on a schedule in a room (roomId), as its owner (createdById: who set it up, or last changed its title, question, room or persona), answered by persona 'jack' or 'stand'. Its schedule, on/off and next run are on its ScheduledJob (scheduledJobId; key 'recurring:<id>', enabled, schedule, nextRunAt). pausedReason is set when a run paused it itself (its owner isn't an officer any more, its room was archived); lastRunAt is when it last asked.
- Each run posts a room note (JackMessage kind 'system', scheduled true, jobKey 'recurring:<id>', authorUserId the owner); the reply that answered it is the note's answeredById. The weekly digest's notes have jobKey 'digest.weekly' (scheduled true when Jack was asked to sum it up). Their replies are automation spend, capped apart from officers' each month.
- The digest's settings are its ScheduledJob's config (key 'digest.weekly'): roomId, summary, discordChannelId, teams, configuredById.`,
  tableNotes: {
    RecurringQuestion: "A question Jack is asked on a schedule; its schedule and on/off are on its ScheduledJob.",
    JackMessage: "jobKey: the scheduled job that posted a room note ('recurring:<id>', 'digest.weekly').",
  },
}
