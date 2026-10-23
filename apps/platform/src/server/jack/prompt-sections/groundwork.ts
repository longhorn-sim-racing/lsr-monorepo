import type { PromptSlot } from "./types"

/** Groundwork (proposed changes, the scheduler, connectors, room files): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Links from earlier replies
- web_fetch can't open a link from an earlier reply, even one written in its text. To open a page an earlier reply found ("open the second link"), get its link with web_links first.
- web_links is the one tool whose links you may web_fetch: they came from your own earlier searches and fetches.`,
  pages: [
    "Connections: the outside services (Discord, Twitch, Stripe and the rest), whether each is set up and switched on, and its last sync and error. Only admins switch one on or off or run its smoke test.",
    "Scheduled jobs: the syncs and clean-ups that run on a schedule, their recent runs and errors, and whether the scheduler is ticking. Admins switch a job on or off, change its schedule or run it now.",
    "Proposals (under Jack): every change you proposed and what came of it; officers apply or discard each one on its card in the room.",
  ],
}
