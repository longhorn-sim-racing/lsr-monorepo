import { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { redactSecrets } from "@/lib/redact"

/**
 * A connector's row in ConnectorState: its switch, last sync, last error and sync cursor (design §3.3).
 * Every connector has one (G1 seeds the planned ones, switched off); a missing row reads as off and
 * never synced, and the writes below create it, still off.
 */

export type ConnectorStateRow = {
  id: string
  enabled: boolean
  lastSyncAt: Date | null
  lastError: string | null
  lastErrorAt: Date | null
  cursor: unknown
  updatedAt: Date
}

/** Audit log entityType for a connector's switch and smoke tests */
export const CONNECTOR_ENTITY = "CONNECTOR"

export async function readConnectorState(id: string): Promise<ConnectorStateRow | null> {
  return prisma.connectorState.findUnique({ where: { id } })
}

/** Whether an admin switched it on; off when there's no row */
export async function connectorEnabled(id: string): Promise<boolean> {
  const row = await prisma.connectorState.findUnique({ where: { id }, select: { enabled: true } })
  return row?.enabled ?? false
}

/**
 * Switches a connector on or off and audits the change (nothing is written to the audit log when it
 * was already that way). Admins only: the caller checks the role. Returns whether it changed.
 */
export async function setConnectorEnabled(id: string, enabled: boolean, actor: { userId: string; label?: string }): Promise<{ changed: boolean }> {
  const before = await connectorEnabled(id)
  await prisma.connectorState.upsert({ where: { id }, update: { enabled }, create: { id, enabled } })
  if (before === enabled) return { changed: false }
  await createAuditLog({
    actorUserId: actor.userId,
    actionType: enabled ? "ENABLE" : "DISABLE",
    entityType: CONNECTOR_ENTITY,
    entityId: id,
    summary: `Switched the ${actor.label ?? id} connector ${enabled ? "on" : "off"}`,
    before: { enabled: before },
    after: { enabled },
  })
  return { changed: true }
}

/**
 * Records a sync or call that worked. `cursor` is where the next sync starts (a message id, a page
 * token, a delta link), stored as is: it's never redacted, because that would break it, so it must
 * never hold a credential. Leave it out to keep the stored cursor; null clears it.
 */
export async function recordConnectorSync(id: string, options: { cursor?: unknown } = {}): Promise<void> {
  const lastSyncAt = new Date()
  const cursor = options.cursor === undefined ? undefined : options.cursor === null ? Prisma.DbNull : (options.cursor as Prisma.InputJsonValue)
  await prisma.connectorState.upsert({
    where: { id },
    update: { lastSyncAt, cursor },
    create: { id, enabled: false, lastSyncAt, cursor },
  })
}

/** How many causes deep errorText() goes */
const MAX_CAUSE_DEPTH = 2

/**
 * An error as one line of text, before redaction, with its cause: fetch fails with "TypeError: fetch
 * failed" and puts the reason (ECONNREFUSED, a timeout, a certificate) in `cause`, so that reads
 * "TypeError: fetch failed (connect ECONNREFUSED 127.0.0.1:443)"
 */
export function errorText(error: unknown): string {
  return describeError(error, 0)
}

function describeError(error: unknown, depth: number): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : ""
    const message = error.message || code || error.name
    const text = error.name && error.name !== "Error" && !message.startsWith(error.name) ? `${error.name}: ${message}` : message
    return error.cause !== undefined && depth < MAX_CAUSE_DEPTH ? `${text} (${describeError(error.cause, depth + 1)})` : text
  }
  if (typeof error === "string") return error || "Unknown error"
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** Records a sync or call that failed, through redactSecrets(), and returns the stored text */
export async function recordConnectorError(id: string, error: unknown): Promise<string> {
  const lastError = redactSecrets(errorText(error))
  const lastErrorAt = new Date()
  await prisma.connectorState.upsert({
    where: { id },
    update: { lastError, lastErrorAt },
    create: { id, enabled: false, lastError, lastErrorAt },
  })
  return lastError
}
