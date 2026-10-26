/**
 * Outside services (#188, design §12): Discord, Twitch, Stripe, Resend, site traffic, Instagram,
 * Google Drive, Microsoft Graph, Supabase Storage. Each one implements `Connector` (usually through
 * defineConnector() in `define.ts`) and is registered in `slots/<track>.ts`; Jack's tools, the sync
 * jobs and the admin pages all reach the service through it. The shared pieces: ConnectorState reads
 * and writes (`state.ts`), statuses and smoke tests (`status.ts`), base URLs and the HTTP fakes
 * (`base-url.ts`, `fakes/`), and the Connections page.
 *
 * Connectors ship switched off. When one is missing env, switched off or failing, its tools say "not
 * connected" and the app keeps working. Credentials stay in env or in revoked SystemSetting keys, and
 * never appear in a status, a log or an error (use redactSecrets()).
 */

/** The environment a connector reads; pass process.env */
export type ConnectorEnv = Readonly<Record<string, string | undefined>>

/** What the Connections page shows for one connector. Plain JSON, so it can go to a client component */
export type ConnectorStatus = {
  id: string
  label: string
  /** Every required env var and setting is present: `missingEnv` and `missingSettings` are both empty */
  configured: boolean
  /** The env vars that are missing, by name only, never values */
  missingEnv: string[]
  /** The SystemSetting keys that are missing or incomplete (e.g. "instagram_publish"), by name only */
  missingSettings: string[]
  /** An admin switched it on (ConnectorState.enabled) */
  enabled: boolean
  /**
   * What the page leads with. connected: configured, on, and the last sync or call worked. off:
   * configured but switched off. not_configured: env or a setting is missing. error: the last sync or
   * call failed (see lastError)
   */
  state: "connected" | "off" | "not_configured" | "error"
  /** ISO timestamps from ConnectorState; null when it never ran */
  lastSyncAt: string | null
  /** Already passed through redactSecrets() */
  lastError: string | null
  lastErrorAt: string | null
  /** Whether the page can offer a live smoke test */
  hasSmoke: boolean
  /** Extra lines, e.g. { label: "Token expires", value: "Nov 3" } or { label: "Storage", value: "120 MB of 1 GB" } */
  details?: { label: string; value: string }[]
}

/** What a live smoke test found */
export type ConnectorSmokeResult = {
  ok: boolean
  /** One line, e.g. "Read 12 channels from the club server" or why it failed (redacted) */
  summary: string
  ms?: number
}

/** What a smoke test gets: `signal` aborts when the Connections page stops waiting (about 25 s) */
export type ConnectorSmokeOptions = { signal?: AbortSignal }

/** One outside service. `C` is its client: a real HTTP client whose base URL comes from serviceBaseUrl(), so JACK_FAKES points it at the local fake */
export type Connector<C> = {
  /** Stable, the ConnectorState row id: "discord" */
  id: string
  /** e.g. "Discord" */
  label: string
  /** Env var names it needs, e.g. ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"] */
  requiredEnv: string[]
  /** Whether the env it needs is set. Pure: reads only the env it's given (no database, no network) */
  configured(env: ConnectorEnv): boolean
  /**
   * For connectors that also keep config in SystemSetting (the Instagram and Twitch tokens, design
   * §3.2): the keys that are missing or incomplete, by name only. Reads the database, never returns
   * values. A connector is configured when `configured(env)` is true and this returns nothing; leave it
   * out when everything is in env
   */
  missingSettings?(): Promise<string[]>
  /** Whether an admin switched it on (ConnectorState.enabled, off when there's no row) */
  enabled(): Promise<boolean>
  /** A ready client, or null when it isn't configured (env or settings) or is switched off, so callers say "not connected" */
  client(): Promise<C | null>
  /** A live check against the real service, run on demand from the Connections page or a script; works while switched off, never runs in tests */
  smoke?(options?: ConnectorSmokeOptions): Promise<ConnectorSmokeResult>
  status(): Promise<ConnectorStatus>
}

/** Lets a list hold connectors with different clients */
export type AnyConnector = Connector<any> // eslint-disable-line @typescript-eslint/no-explicit-any
