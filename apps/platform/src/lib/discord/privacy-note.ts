import { CANONICAL_SITE_URL } from "@/lib/site-url"
import { CONTACT_EMAIL } from "@/lib/socials"

/**
 * The server privacy note (design §12.1 "Privacy and terms"; discord-read wrote the text, in
 * docs/jack-2/tracks/discord-read.md), with the synced channels as Discord channel links. Posted through a
 * discord.post proposal (Announcements → "Copy for Jack", pasted into a room) or an officer's own post;
 * nothing posts it by itself.
 */
export function privacyNoteText(channelIds: readonly string[]): string {
  const channels = channelIds.length ? channelIds.map((id) => `<#${id}>`).join(" ") : "(no channels sync yet)"
  return [
    "**How the LSR website uses this server**",
    `The club's bot keeps activity counts for these channels: ${channels}. For each message it records who posted it and when, how long it is and whether it has attachments, never what it says. It also keeps the titles of public threads and forum posts in these channels. For polls it keeps the question, answers and vote totals, never who voted. The officers' pages and Jack are set up to show totals only (messages per channel and day, how many people were active, members over time), not anything about one person.`,
    "When an officer asks Jack, the club's assistant, a question, Jack can search these channels and read the conversation around a match. Those messages go to Anthropic (Claude) to answer the question; we don't keep them, but Jack's answer, which may summarize or quote them, is kept in the officers' workspace.",
    "You can link your Discord account on your profile at longhornsimracing.org (it shares only your user ID and username).",
    `Records are deleted after 12 months. To have your data deleted, email ${CONTACT_EMAIL} with "Discord Deletion Request" and your username. Full details: ${CANONICAL_SITE_URL}/privacy#discord`,
  ].join("\n\n")
}

/** What an officer pastes into a Jack room to have the note proposed as a post in #channel */
export function privacyNoteRequest(text: string, channel: string): string {
  return `Propose a Discord post in #${channel} with exactly this text, no ping (it's the server privacy note from Community → Announcements):\n\n${text}`
}
