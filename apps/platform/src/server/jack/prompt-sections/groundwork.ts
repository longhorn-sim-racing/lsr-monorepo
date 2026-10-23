import type { PromptSlot } from "./types"

/** Groundwork (proposed changes, the scheduler, connectors, room files): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: "",
  pages: [
    "Proposals: every change proposed in the rooms and its status (pending, applied, discarded, stale or failed), pending first.",
    "Connections: the club's outside services (Discord, Twitch, Stripe, Google Drive and others): whether each is set up and switched on, and its last sync or error. Only admins can switch one on or off.",
    "Scheduled jobs: the jobs that run on a schedule (syncs, reminders, clean-ups), their runs and errors. Only admins can switch a job on or off or run it now.",
  ],
}
