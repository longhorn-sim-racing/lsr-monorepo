import { getSiteUrl } from "@/lib/site-url"
import { prisma } from "@/server/db"
import { defineConnector, missingEnv } from "../define"
import type { ConnectorEnv } from "../types"
import { discordClient, type DiscordClient, type DiscordClientOptions } from "./client"
import type { DiscordApp } from "./oauth"
import { APP_FLAG } from "./types"

/**
 * The `discord` connector (design §12.1): the club server's bot, for the activity sync and live search,
 * and the app's OAuth credentials, for members linking their account. Off until an admin switches it on
 * after its smoke test; while it's off nothing here calls Discord (search, the tools and linking all say
 * it isn't connected, and the jobs skip).
 */

export const DISCORD_CONNECTOR = "discord"

/** The bot token, the server, and the app's OAuth client (the Application ID and its secret) */
export const DISCORD_ENV = ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"]

export const DISCORD_OFF = "Discord isn't connected."

/** Where Discord sends a member back after they approve linking. Registered as a redirect URI in the Developer Portal */
export function discordRedirectUri(env: ConnectorEnv = process.env): string {
  return env.DISCORD_OAUTH_REDIRECT_URI?.trim() || `${getSiteUrl()}/api/discord/oauth/callback`
}

/** The app's OAuth credentials, or null when they aren't set */
export function discordApp(env: ConnectorEnv = process.env): DiscordApp | null {
  const clientId = env.DISCORD_CLIENT_ID?.trim()
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** A bot client straight from env, whether or not the connector is on (smoke tests, the eval's seeder); `budget` tightens its timeout, rate-limit waits and retries */
export function discordClientFromEnv(env: ConnectorEnv = process.env, budget: Pick<DiscordClientOptions, "timeoutMs" | "maxWaitMs" | "maxRetries"> = {}): DiscordClient {
  return discordClient({ token: env.DISCORD_BOT_TOKEN?.trim() ?? "", guildId: env.DISCORD_GUILD_ID?.trim() ?? "", env, ...budget })
}

/** Which privileged intents the app has switched on, from its flags (research §3 H1) */
export function discordIntents(flags: number | undefined): { messageContent: boolean; guildMembers: boolean } {
  const f = flags ?? 0
  return {
    messageContent: Boolean(f & (APP_FLAG.messageContent | APP_FLAG.messageContentLimited)),
    guildMembers: Boolean(f & (APP_FLAG.guildMembers | APP_FLAG.guildMembersLimited)),
  }
}

export const discordConnector = defineConnector<DiscordClient>({
  id: DISCORD_CONNECTOR,
  label: "Discord",
  requiredEnv: DISCORD_ENV,
  createClient: (env) => discordClientFromEnv(env),
  // Works while switched off: builds its own client
  async smoke({ signal } = {}) {
    const missing = missingEnv(DISCORD_ENV)
    if (missing.length) return { ok: false, summary: `Missing ${missing.join(", ")}` }
    const client = discordClientFromEnv()
    const [app, guild, channels] = await Promise.all([client.application(signal), client.guild(signal), client.channels(signal)])
    const intents = discordIntents(app.flags)
    const off = [!intents.messageContent && "Message Content", !intents.guildMembers && "Server Members"].filter(Boolean)
    const read = `Read ${guild.name}: ${guild.approximate_member_count ?? "?"} members, ${channels.length} channels`
    if (off.length) return { ok: false, summary: `${read}, but the ${off.join(" and ")} ${off.length === 1 ? "intent is" : "intents are"} off (Developer Portal → Bot → Privileged Gateway Intents)` }
    return { ok: true, summary: `${read}; Message Content and Server Members intents on` }
  },
  async details() {
    const [synced, linked] = await Promise.all([
      prisma.discordChannel.count({ where: { synced: true, parentId: null } }),
      prisma.user.count({ where: { discordUserId: { not: null } } }),
    ])
    return [
      { label: "Synced channels", value: synced ? `${synced} (opted in on Community → Discord)` : "None yet (opt channels in on Community → Discord)" },
      { label: "Linked members", value: String(linked) },
      { label: "Linking redirect", value: discordRedirectUri() },
    ]
  },
})
