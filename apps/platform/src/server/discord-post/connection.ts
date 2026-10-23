import type { DiscordClient } from "@/server/connectors/discord/client"
import { discordClientFromEnv, discordConnector, DISCORD_OFF } from "@/server/connectors/discord/connector"
import { discordWriter, type DiscordWriter } from "@/server/connectors/discord/write"

/**
 * The bot, for posting: the `discord` connector's client (T7) with the write surface on top. Null while
 * Discord is switched off or not set up, so nothing is posted, synced or changed until an admin switches
 * it on (design §1 principle 11).
 */

export type DiscordPosting = { client: DiscordClient; writer: DiscordWriter }

export const NOT_CONNECTED = `${DISCORD_OFF} An admin switches it on from Connections after its smoke test.`

export async function discordPosting(): Promise<DiscordPosting | null> {
  const client = await discordConnector.client()
  return client ? { client, writer: discordWriter(client.rest, client.guildId) } : null
}

/**
 * The same for an admin page or a proposal card that reads Discord live (the server's roles): a tight
 * budget, so a slow or rate-limited Discord never holds up the page. Null while Discord is off
 */
export async function discordPostingForPage(): Promise<DiscordPosting | null> {
  if (!(await discordConnector.client())) return null
  const client = discordClientFromEnv(process.env, { timeoutMs: 6_000, maxWaitMs: 2_000, maxRetries: 1 })
  return { client, writer: discordWriter(client.rest, client.guildId) }
}
