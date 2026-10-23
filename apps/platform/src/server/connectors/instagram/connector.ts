import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE, chicagoDay } from "@/lib/dates"
import { readInstagramAccess } from "@/server/services/instagram.service"
import { defineConnector } from "../define"
import type { ConnectorEnv } from "../types"
import { instagramGraph } from "./graph"
import { instagramInsights, type InstagramInsightsApi } from "./insights"

/**
 * Instagram insights (#188, design §12.6): daily account totals and each post's numbers, read with the
 * token the feed sync already keeps in SystemSetting "instagram" (Admin → Instagram). That token needs
 * `instagram_business_manage_insights` as well as `instagram_business_basic`: generate it again with
 * both and paste it (docs/jack-2/tracks/sources-b.md). It stays read-only; publishing gets its own
 * token and connector (`instagram-publish`). The feed sync keeps refreshing the token weekly; nothing
 * here writes it.
 */

export const INSTAGRAM_INSIGHTS_ID = "instagram-insights"

export type InstagramInsightsClient = InstagramInsightsApi & {
  /** The professional account id (IG_ID) saved when the token was pasted, or null to read it from /me */
  userId: string | null
  username: string | null
}

/** A client for the stored token, or null when none is stored */
export async function instagramInsightsClient(env: ConnectorEnv = process.env): Promise<InstagramInsightsClient | null> {
  const access = await readInstagramAccess()
  if (!access) return null
  return { ...instagramInsights(instagramGraph(access.token, env)), userId: access.userId, username: access.username }
}

export const instagramInsightsConnector = defineConnector<InstagramInsightsClient | null>({
  id: INSTAGRAM_INSIGHTS_ID,
  label: "Instagram insights",
  requiredEnv: [],
  async missingSettings() {
    return (await readInstagramAccess()) ? [] : ["instagram"]
  },
  createClient: (env) => instagramInsightsClient(env),
  // Works while switched off. The insights call is what proves the token has the insights permission
  async smoke({ signal } = {}) {
    const client = await instagramInsightsClient()
    if (!client) return { ok: false, summary: "No Instagram token is saved: paste one in Admin → Instagram." }
    const profile = await client.profile(signal)
    const yesterday = new Date(chicagoDay(new Date()).getTime() - 86_400_000)
    const day = await client.accountDay(client.userId ?? profile.userId, yesterday, signal)
    return { ok: true, summary: `Read @${profile.username}: ${profile.followers} followers; yesterday's reach ${day.reach ?? "not in yet"}` }
  },
  async details() {
    const access = await readInstagramAccess()
    if (!access) return [{ label: "Token", value: "None saved: paste one in Admin → Instagram (with the insights permission)" }]
    const expires = access.tokenExpiresAt ? formatInTimeZone(new Date(access.tokenExpiresAt), DEFAULT_TIMEZONE, "MMM d") : null
    return [
      { label: "Account", value: access.username ? `@${access.username}` : "Unknown" },
      { label: "Token", value: `The feed sync's (Admin → Instagram), renewed weekly${expires ? `; runs out ${expires} if renewing stops` : ""}` },
    ]
  },
})
