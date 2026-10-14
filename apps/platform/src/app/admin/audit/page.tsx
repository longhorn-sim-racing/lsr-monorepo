import type { Metadata } from "next"
import { prisma } from "@/server/db"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { AuditConsole, type AuditEntry } from "@/components/admin/audit-console"

export const metadata: Metadata = { title: "Audit log" }

const userSelect = { id: true, displayName: true, handle: true, avatarUrl: true } as const

// The fields the entry drawer shows (the same ones /api/admin/audit-logs sends for each row)
const entrySelect = {
  id: true,
  createdAt: true,
  actionType: true,
  entityType: true,
  entityId: true,
  summary: true,
  before: true,
  after: true,
  metadata: true,
  actor: { select: userSelect },
  targetUser: { select: userSelect },
} as const

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<{ entry?: string | string[] }> }) {
  await requireOfficerPage()
  const { entry } = await searchParams
  const entryId = Array.isArray(entry) ? entry[0] : entry

  // The filter menus list the action and entity types that actually appear in the log
  const [actionTypes, entityTypes, linked] = await Promise.all([
    prisma.auditLog.groupBy({ by: ["actionType"], _count: { _all: true }, orderBy: { actionType: "asc" } }),
    prisma.auditLog.groupBy({ by: ["entityType"], _count: { _all: true }, orderBy: { entityType: "asc" } }),
    // A link like /admin/audit?entry=<id> (the Overview's activity list) opens that entry
    entryId
      ? prisma.auditLog.findUnique({ where: { id: entryId }, select: entrySelect })
      : null,
  ])

  return (
    <>
      <PageHeader title="Audit log" description="Every change officers make, newest first. Times are Central." />
      <AuditConsole
        actionTypes={actionTypes.map((row) => ({ value: row.actionType, count: row._count._all }))}
        entityTypes={entityTypes.map((row) => ({ value: row.entityType, count: row._count._all }))}
        initialEntry={linked satisfies AuditEntry | null}
      />
    </>
  )
}
