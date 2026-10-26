import { discordSource } from "../sources/discord"
import type { SearchSource } from "../types"

/**
 * Discord's search source (discord-read track, design §12.1): a live search through Discord's guild
 * message search, limited to the channels officers opted in. Nothing is stored, so its hits link to
 * Discord and its reader fetches the conversation live too.
 */
export const SOURCES: SearchSource[] = [discordSource]
