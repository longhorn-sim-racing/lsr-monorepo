import type { PromptSlot } from "./types"

/** Groundwork (proposed changes, the scheduler, connectors, room files): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: "",
  pages: ["Scheduled jobs: the syncs and clean-ups that run on a schedule, their recent runs and errors, and whether the scheduler is ticking. Admins switch a job on or off, change its schedule or run it now."],
}
