import { joinSlots, type SlotTrack } from "@/lib/slots"
import { JOBS as automationJobs } from "./jobs/automation"
import { JOBS as changesJobs } from "./jobs/changes"
import { JOBS as clubDataJobs } from "./jobs/club-data"
import { JOBS as decksRoomsJobs } from "./jobs/decks-rooms"
import { JOBS as discordPostJobs } from "./jobs/discord-post"
import { JOBS as discordReadJobs } from "./jobs/discord-read"
import { JOBS as documentsJobs } from "./jobs/documents"
import { JOBS as groundworkJobs } from "./jobs/groundwork"
import { JOBS as memoryJobs } from "./jobs/memory"
import { JOBS as sourcesAJobs } from "./jobs/sources-a"
import { JOBS as sourcesBJobs } from "./jobs/sources-b"
import { JOBS as sponsorsMeetingsJobs } from "./jobs/sponsors-meetings"
import type { JobKind } from "./types"

/**
 * Every scheduled job kind, joined from the tracks' slot files in SLOT_TRACKS order. Loading this
 * module throws if two slots register the same kind. Tracks add to their own slot files, never here.
 */

const JOB_SLOTS = {
  groundwork: groundworkJobs,
  "club-data": clubDataJobs,
  memory: memoryJobs,
  changes: changesJobs,
  "sources-a": sourcesAJobs,
  "sources-b": sourcesBJobs,
  documents: documentsJobs,
  "discord-read": discordReadJobs,
  "discord-post": discordPostJobs,
  "decks-rooms": decksRoomsJobs,
  "sponsors-meetings": sponsorsMeetingsJobs,
  automation: automationJobs,
} satisfies Record<SlotTrack, JobKind[]>

export const JOB_KINDS: JobKind[] = joinSlots("job kind", JOB_SLOTS, (job) => job.kind)

/** The kind a ScheduledJob row names; undefined when the running code doesn't know it (the dispatcher skips it) */
export function findJobKind(kind: string): JobKind | undefined {
  return JOB_KINDS.find((job) => job.kind === kind)
}
