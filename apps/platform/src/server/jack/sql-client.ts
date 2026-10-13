import { PrismaClient } from "@prisma/client"

/**
 * A Prisma client that connects as `jack_readonly` (JACK_DATABASE_URL), for the SQL Jack writes
 * himself (#161). Separate from the app's client on purpose: the database role is what keeps his
 * queries read-only and away from secrets, whatever the prompt says.
 *
 * Created on first use, once per server instance. Null when JACK_DATABASE_URL isn't set.
 */

declare global {
  var jackSqlClient: { url: string; client: PrismaClient } | undefined
}

/** Small pool (a few officers share it) and short waits, unless the URL already says otherwise */
export function withPoolDefaults(url: string): string {
  const params: [string, string][] = [
    ["connection_limit", "2"],
    ["pool_timeout", "10"],
    ["connect_timeout", "10"],
  ]
  let result = url
  for (const [key, value] of params) {
    if (new RegExp(`[?&]${key}=`).test(result)) continue
    result += `${result.includes("?") ? "&" : "?"}${key}=${value}`
  }
  return result
}

export function getJackSqlClient(): PrismaClient | null {
  const url = process.env.JACK_DATABASE_URL?.trim()
  if (!url) return null
  if (globalThis.jackSqlClient?.url === url) return globalThis.jackSqlClient.client
  const client = new PrismaClient({ datasourceUrl: withPoolDefaults(url), log: [], errorFormat: "minimal" })
  globalThis.jackSqlClient = { url, client }
  return client
}

export const JACK_SQL_MISSING =
  "Jack's read-only database connection isn't set up (JACK_DATABASE_URL is missing), so queries can't run here. Tell the officers an admin needs to set it; the typed tools still work."
