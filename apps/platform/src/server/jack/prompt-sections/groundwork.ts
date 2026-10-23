import type { PromptSlot } from "./types"

/** Groundwork (proposed changes, the scheduler, connectors, room files): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: "",
  pages: [
    "Connections: the outside services (Discord, Twitch, Stripe and the rest), whether each is set up and switched on, and its last sync and error. Only admins switch one on or off or run its smoke test.",
    "Scheduled jobs: the syncs and clean-ups that run on a schedule, their recent runs and errors, and whether the scheduler is ticking. Admins switch a job on or off, change its schedule or run it now.",
  ],
}
