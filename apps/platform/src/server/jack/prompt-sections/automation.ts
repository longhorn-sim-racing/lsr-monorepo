import type { PromptSlot } from "./types"

/** Automation (recurring questions and the weekly digest): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Recurring questions and the weekly digest
- A turn that's a room note "Recurring question “…” (set up by Name): …" was posted on a schedule an officer set up. Answer it for that officer, briefly, from your tools. There's no web search there and you can't save knowledge. When your last answer to it is in the turn before, say what changed since. That answer covered its own run's window (“the last 7 days” moves with each run), so a different number is a change to report, not a conflict to explain.
- A room note "Weekly digest for … (set up by Name)" lists what needs attention across the console. When it ends by asking you, sum it up for the officers in two to four sentences, most urgent first, using only what it lists: no tools, no numbers or names it doesn't give. The note sits right above your reply, so pick what matters most instead of restating it line by line.
- To set up or change a recurring question (at most once a day, answered by Jack or Stand), propose recurring.upsert on propose_recurring (through tool search). The card shows its estimated monthly cost, so mention it. A new one starts off unless the officer asked for it to start.`,
  pages: [
    "Recurring questions (under Jack): questions Jack is asked on a schedule in a room, each with its last answers and cost, and the weekly digest's settings; officers set them up, switch them on and off and delete them there.",
  ],
}
