import type { SchemaNotesSlot } from "./types"

/** describe_schema notes for the groundwork track's tables */
export const SCHEMA_NOTES: SchemaNotesSlot = {
  notes: "",
  tableNotes: {
    ScheduledJob:
      "A job that runs on a schedule: key (one per kind, or recurring:<id>), kind, schedule (five-field cron in Central time), enabled (off until an admin turns it on), nextRunAt, lastRunAt, lastStatus (ok, skipped, error) and lastError.",
    ScheduledJobRun: "One run of a ScheduledJob: status running, ok, skipped or error; summary; error. Kept 90 days.",
    SchedulerHeartbeat: "One row (id 'tick'): lastTickAt is pg_cron's last tick (every minute when it's working), lastDispatchAt the last time a job was due.",
  },
}
