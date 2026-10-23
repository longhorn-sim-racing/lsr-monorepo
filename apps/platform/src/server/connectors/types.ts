/**
 * Outside services (#188, design §12): Discord, Twitch, Stripe, Resend, site traffic, Instagram,
 * Google Drive, Microsoft Graph, Supabase Storage. Each one implements `Connector` and is registered in
 * `registry/<track>.ts`; Jack's tools, the sync jobs and the admin pages all reach the service through
 * it. G2 builds the shared pieces (ConnectorState reads, the HTTP fakes, the Connections page).
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
  /** Every required env var (and setting) is present */
  configured: boolean
  /** The env vars that are missing, by name only, never values */
  missingEnv: string[]
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

/** One outside service. `C` is its client: a real HTTP client, pointed at the local fake when `<SERVICE>_BASE_URL` says so */
export type Connector<C> = {
  /** Stable, the ConnectorState row id: "discord" */
  id: string
  /** e.g. "Discord" */
  label: string
  /** Env var names it needs, e.g. ["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"] */
  requiredEnv: string[]
  /** Whether everything it needs is set. Pure: reads only the env it's given (and no network) */
  configured(env: ConnectorEnv): boolean
  /** Whether an admin switched it on (ConnectorState.enabled, off when there's no row) */
  enabled(): Promise<boolean>
  /** A ready client, or null when it isn't configured or is switched off, so callers say "not connected" */
  client(): Promise<C | null>
  /** A live check against the real service, run on demand from the Connections page or a script; works while switched off, never runs in tests */
  smoke?(): Promise<ConnectorSmokeResult>
  status(): Promise<ConnectorStatus>
}

/** Lets a list hold connectors with different clients */
export type AnyConnector = Connector<any> // eslint-disable-line @typescript-eslint/no-explicit-any
