import type { PromptSlot } from "./types"

/** Groundwork (proposed changes, the scheduler, connectors, room files): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: "",
  pages: [
    "Connections: the outside services (Discord, Twitch, Stripe and the rest), whether each is set up and switched on, and its last sync and error. Only admins switch one on or off or run its smoke test.",
  ],
}
