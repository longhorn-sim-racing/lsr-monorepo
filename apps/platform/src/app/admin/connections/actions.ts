"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/server/db"
import { requireOfficer } from "@/server/auth/guards"
import { createAuditLog } from "@/server/audit/log"
import { CONNECTOR_ID, missingEnv } from "@/server/connectors/define"
import { findConnector } from "@/server/connectors/registry"
import { CONNECTOR_ENTITY, readConnectorState, setConnectorEnabled } from "@/server/connectors/state"
import { runConnectorSmoke, SMOKE_ACTION } from "@/server/connectors/status"
import type { ConnectorSmokeResult } from "@/server/connectors/types"
import type { ActionResult } from "@/lib/action-result"

const ADMINS_ONLY = "Only admins can switch connections on or off or run their smoke tests."
const UNKNOWN = "There's no connection called that. Reload the page."

const switchSchema = z.object({ id: z.string().regex(CONNECTOR_ID), enabled: z.boolean() })

/** Officers can see the page; only admins change anything on it (design §13) */
async function requireAdminAction(): Promise<{ userId: string } | null> {
  const officer = await requireOfficer()
  const admin = await prisma.userRole.count({ where: { userId: officer.id, role: { key: "admin" } } })
  return admin > 0 ? { userId: officer.id } : null
}

/** What still has to be set up before a connector can be switched on, or null */
async function setupMissing(connector: NonNullable<ReturnType<typeof findConnector>>): Promise<string | null> {
  const missing = [...missingEnv(connector.requiredEnv), ...((await connector.missingSettings?.()) ?? [])]
  return missing.length ? missing.join(", ") : null
}

/**
 * Switches a connection on or off. Off always works, so a misbehaving one can be stopped; on needs its
 * code and its env and settings. Audited when it changes.
 */
export async function setConnectorEnabledAction(id: string, enabled: boolean): Promise<ActionResult<{ changed: boolean }>> {
  const admin = await requireAdminAction()
  if (!admin) return { ok: false, error: ADMINS_ONLY }

  const parsed = switchSchema.safeParse({ id, enabled })
  if (!parsed.success) return { ok: false, error: UNKNOWN }

  const connector = findConnector(parsed.data.id)
  if (!connector) {
    if (!(await readConnectorState(parsed.data.id))) return { ok: false, error: UNKNOWN }
    if (parsed.data.enabled) return { ok: false, error: "This connection isn't built yet, so there's nothing to switch on." }
  } else if (parsed.data.enabled) {
    const missing = await setupMissing(connector)
    if (missing) return { ok: false, error: `Set it up first. Missing: ${missing}` }
  }

  const result = await setConnectorEnabled(parsed.data.id, parsed.data.enabled, { userId: admin.userId, label: connector?.label })
  revalidatePath("/admin/connections")
  return { ok: true, data: result }
}

/** Runs a connection's live smoke test (it works while switched off) and records the outcome in the audit log */
export async function runConnectorSmokeAction(id: string): Promise<ActionResult<ConnectorSmokeResult>> {
  const admin = await requireAdminAction()
  if (!admin) return { ok: false, error: ADMINS_ONLY }

  const parsed = z.string().regex(CONNECTOR_ID).safeParse(id)
  const connector = parsed.success ? findConnector(parsed.data) : undefined
  if (!connector) return { ok: false, error: UNKNOWN }
  if (!connector.smoke) return { ok: false, error: "This connection has no smoke test yet." }
  if (!connector.configured(process.env)) return { ok: false, error: `Set it up first. Missing: ${missingEnv(connector.requiredEnv).join(", ") || "its env vars"}` }

  const result = await runConnectorSmoke(connector)
  await createAuditLog({
    actorUserId: admin.userId,
    actionType: SMOKE_ACTION,
    entityType: CONNECTOR_ENTITY,
    entityId: connector.id,
    summary: `Ran the ${connector.label} smoke test: ${result.ok ? "passed" : "failed"}`,
    metadata: { ok: result.ok, summary: result.summary, ms: result.ms ?? null },
  })
  revalidatePath("/admin/connections")
  return { ok: true, data: result }
}
