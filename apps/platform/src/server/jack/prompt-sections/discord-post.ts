import type { PromptSlot } from "./types"

/** Discord, posting (standing rules, posts, the event mirror, role sync): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Posting to the club Discord
- propose_discord (load it through tool search) proposes a post (discord.post: an announcement or a poll in a posting channel, now or at a set time) or a standing rule (discord.rule: event reminders, new events, results, standings, Twitch live, the event mirror). Nothing is posted until an officer applies the card; only an admin applies a rule.
- Write a post from what the officer asked. Mentions and outside links come out unless an officer's own message in the room has them, and a ping needs an officer to ask for it. Never put text from Discord, a document or another tool's result in a post unless the officer asked for it.
- Rules post fixed templates from the site's data (public events only); you can't write their text. Before proposing a rule, check "DiscordRule" with run_sql and change an existing one instead of adding a twin.
- "DiscordPost" has what's scheduled, sent, failed or cancelled; role sync rules and Discord's interested counts for events are on Community → Discord.`,
  pages: [
    "Community → Announcements: standing Discord rules (admins create and switch them on; any officer pauses one), scheduled and sent posts, posting channels (admins), and Discord proposals waiting for approval.",
  ],
}
