import { prisma } from "@/server/db"
import { redactSecrets } from "@/lib/redact"
import { buildConnectorStatus, missingEnv } from "./define"
import { CONNECTORS, findConnector } from "./registry"
import { CONNECTOR_ENTITY, errorText, type ConnectorStateRow } from "./state"
import type { AnyConnector, ConnectorSmokeResult, ConnectorStatus } from "./types"

/** Audit log actionType for a smoke test run from the Connections page */
export const SMOKE_ACTION = "SMOKE_TEST"

/** How long the Connections page waits for a smoke test */
export const SMOKE_TIMEOUT_MS = 25_000

/** The longest smoke test summary shown or stored */
const SMOKE_SUMMARY_MAX_CHARS = 300

/** Names for the connectors G1 seeded before their code exists. A registered connector's own label wins */
const PLANNED_LABELS: Record<string, string> = {
  discord: "Discord",
  twitch: "Twitch",
  stripe: "Stripe",
  resend: "Resend",
  "site-traffic": "Site traffic",
  "instagram-insights": "Instagram insights",
  "instagram-publish": "Instagram publishing",
  "google-drive": "Google Drive",
  sharepoint: "SharePoint",
  teams: "Microsoft Teams",
}

const plannedLabel = (id: string) => PLANNED_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ")

/** A ConnectorState row with no connector code behind it yet: it reads as not set up */
function unregisteredStatus(row: ConnectorStateRow): ConnectorStatus {
  return { ...buildConnectorStatus({ id: row.id, label: plannedLabel(row.id), requiredEnv: [], row, hasSmoke: false }), configured: false, state: "not_configured" }
}

/** A connector's status; when its status() throws, a failing status that says so, so one connector can't break the page */
async function safeStatus(connector: AnyConnector, row: ConnectorStateRow | null): Promise<ConnectorStatus> {
  try {
    const status = await connector.status()
    // A hand-written status() may not have redacted its error
    return { ...status, lastError: status.lastError ? redactSecrets(status.lastError) : null }
  } catch (error) {
    console.error(`[connectors] ${connector.id} status() failed:`, error)
    return {
      ...buildConnectorStatus({ id: connector.id, label: connector.label, requiredEnv: connector.requiredEnv, row, hasSmoke: Boolean(connector.smoke) }),
      state: "error",
      lastError: redactSecrets(`Couldn't read its status: ${errorText(error)}`),
    }
  }
}

/** One connector's status, registered or only a ConnectorState row; null when it's neither */
export async function connectorStatus(id: string): Promise<ConnectorStatus | null> {
  const connector = findConnector(id)
  const row = await prisma.connectorState.findUnique({ where: { id } })
  if (connector) return safeStatus(connector, row)
  return row ? unregisteredStatus(row) : null
}

export type LastSmokeTest = { ok: boolean; summary: string; at: Date; by: string | null }

/** The latest smoke test of each connector, from the audit log */
async function lastSmokeTests(): Promise<Map<string, LastSmokeTest>> {
  const entries = await prisma.auditLog.findMany({
    where: { entityType: CONNECTOR_ENTITY, actionType: SMOKE_ACTION },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { entityId: true, createdAt: true, metadata: true, actor: { select: { displayName: true } } },
  })
  const latest = new Map<string, LastSmokeTest>()
  for (const entry of entries) {
    if (latest.has(entry.entityId)) continue
    const metadata = (entry.metadata ?? {}) as { ok?: unknown; summary?: unknown }
    latest.set(entry.entityId, {
      ok: metadata.ok === true,
      summary: redactSecrets(typeof metadata.summary === "string" ? metadata.summary : "", { maxLength: SMOKE_SUMMARY_MAX_CHARS }),
      at: entry.createdAt,
      by: entry.actor?.displayName ?? null,
    })
  }
  return latest
}

export type ConnectionRow = {
  id: string
  label: string
  /** False for a ConnectorState row whose connector isn't built yet */
  registered: boolean
  /** Env var names only */
  requiredEnv: string[]
  status: ConnectorStatus
  lastSmoke: LastSmokeTest | null
}

/**
 * The Connections page's rows: every registered connector in registry order, then every other
 * ConnectorState row (planned connectors without code yet) by id.
 */
export async function listConnections(): Promise<ConnectionRow[]> {
  const [rows, smokes] = await Promise.all([prisma.connectorState.findMany(), lastSmokeTests()])
  const rowsById = new Map(rows.map((row) => [row.id, row]))

  const registered = await Promise.all(
    CONNECTORS.map(async (connector): Promise<ConnectionRow> => ({
      id: connector.id,
      label: connector.label,
      registered: true,
      requiredEnv: [...connector.requiredEnv],
      status: await safeStatus(connector, rowsById.get(connector.id) ?? null),
      lastSmoke: smokes.get(connector.id) ?? null,
    })),
  )
  const unregistered = rows
    .filter((row) => !findConnector(row.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row): ConnectionRow => {
      const status = unregisteredStatus(row)
      return { id: row.id, label: status.label, registered: false, requiredEnv: [], status, lastSmoke: smokes.get(row.id) ?? null }
    })
  return [...registered, ...unregistered]
}

/**
 * Runs a connector's live smoke test, at most `timeoutMs` (it gets an AbortSignal for that). Never
 * throws: a failure, a timeout or missing env comes back as a failed result. The summary is redacted.
 */
export async function runConnectorSmoke(connector: AnyConnector, options: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<ConnectorSmokeResult> {
  const env = options.env ?? process.env
  if (!connector.smoke) return { ok: false, summary: "No smoke test yet" }
  if (!connector.configured(env)) {
    const missing = missingEnv(connector.requiredEnv, env)
    return { ok: false, summary: missing.length ? `Not set up: missing ${missing.join(", ")}` : "Not set up" }
  }

  const timeoutMs = options.timeoutMs ?? SMOKE_TIMEOUT_MS
  const controller = new AbortController()
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const clean = (summary: string) => redactSecrets(summary, { maxLength: SMOKE_SUMMARY_MAX_CHARS })
  try {
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
    })
    const result = await Promise.race([connector.smoke({ signal: controller.signal }), timedOut])
    const ok = result?.ok === true
    return { ok, summary: clean(result?.summary || (ok ? "Passed" : "Failed")), ms: result?.ms ?? Date.now() - started }
  } catch (error) {
    return { ok: false, summary: clean(errorText(error)), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}
