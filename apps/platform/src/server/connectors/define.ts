import { redactSecrets } from "@/lib/redact"
import { connectorEnabled, readConnectorState, type ConnectorStateRow } from "./state"
import type { Connector, ConnectorEnv, ConnectorStatus } from "./types"

/** A connector's id, its ConnectorState row id: "discord", "site-traffic" */
export const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The env vars that are missing or blank, by name only */
export function missingEnv(requiredEnv: readonly string[], env: ConnectorEnv = process.env): string[] {
  return requiredEnv.filter((name) => !env[name]?.trim())
}

type StatusRow = Pick<ConnectorStateRow, "enabled" | "lastSyncAt" | "lastError" | "lastErrorAt">

/**
 * A connector's status from its env, settings and ConnectorState row. It's failing when its last error
 * is newer than its last sync; "connected" also covers one that's on and hasn't run yet.
 */
export function buildConnectorStatus(input: {
  id: string
  label: string
  requiredEnv: readonly string[]
  env?: ConnectorEnv
  missingSettings?: readonly string[]
  row: StatusRow | null
  hasSmoke: boolean
  details?: { label: string; value: string }[]
}): ConnectorStatus {
  const missing = missingEnv(input.requiredEnv, input.env ?? process.env)
  const settings = [...(input.missingSettings ?? [])]
  const configured = missing.length === 0 && settings.length === 0
  const row = input.row
  const enabled = row?.enabled ?? false
  const failing = Boolean(row?.lastErrorAt && (!row.lastSyncAt || row.lastErrorAt >= row.lastSyncAt))
  return {
    id: input.id,
    label: input.label,
    configured,
    missingEnv: missing,
    missingSettings: settings,
    enabled,
    state: !configured ? "not_configured" : !enabled ? "off" : failing ? "error" : "connected",
    lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
    // Stored redacted; redacted again in case a row was written some other way
    lastError: row?.lastError ? redactSecrets(row.lastError) : null,
    lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
    hasSmoke: input.hasSmoke,
    ...(input.details?.length ? { details: input.details } : {}),
  }
}

export type ConnectorSpec<C> = {
  id: string
  label: string
  requiredEnv: string[]
  /** SystemSetting keys that are missing or incomplete, by name only (see Connector.missingSettings) */
  missingSettings?(): Promise<string[]>
  /** Builds the client, its base URL from serviceBaseUrl(). Called only when the env and settings are there and an admin switched it on */
  createClient(env: ConnectorEnv): C | Promise<C>
  smoke?: Connector<C>["smoke"]
  /** Extra lines for the Connections page, e.g. { label: "Token expires", value: "Nov 3" }. Never a secret */
  details?(): Promise<{ label: string; value: string }[]>
}

/**
 * A Connector from its parts: configured from `requiredEnv`, enabled from ConnectorState (off without a
 * row), a client only when configured and switched on (null otherwise, so callers say "not
 * connected"), and its status for the Connections page.
 */
export function defineConnector<C>(spec: ConnectorSpec<C>): Connector<C> {
  if (!CONNECTOR_ID.test(spec.id)) throw new Error(`Connector "${spec.id}": an id is lowercase letters, digits and dashes`)
  const configured = (env: ConnectorEnv) => missingEnv(spec.requiredEnv, env).length === 0

  return {
    id: spec.id,
    label: spec.label,
    requiredEnv: spec.requiredEnv,
    configured,
    ...(spec.missingSettings && { missingSettings: spec.missingSettings }),
    enabled: () => connectorEnabled(spec.id),
    async client() {
      const env = process.env
      if (!configured(env)) return null
      if (!(await connectorEnabled(spec.id))) return null
      if (spec.missingSettings && (await spec.missingSettings()).length) return null
      return spec.createClient(env)
    },
    ...(spec.smoke && { smoke: spec.smoke }),
    async status() {
      const [row, settings, details] = await Promise.all([readConnectorState(spec.id), spec.missingSettings?.() ?? [], spec.details?.() ?? []])
      return buildConnectorStatus({ id: spec.id, label: spec.label, requiredEnv: spec.requiredEnv, missingSettings: settings, row, hasSmoke: Boolean(spec.smoke), details })
    },
  }
}
