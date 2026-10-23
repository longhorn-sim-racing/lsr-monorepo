import type { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { getCachedSessionUser } from "@/server/auth/cached-session"
import { listConnections } from "@/server/connectors/status"
import { PageHeader } from "@/components/admin/kit"
import { SafeSlot } from "@/components/admin/safe-slot"
import { SchedulerPanel } from "./_panels/scheduler"
import { StoragePanel } from "./_panels/storage"
import { ConnectionsList } from "./connections-client"
import { connectionsSummary, toConnectionView } from "./view"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Connections" }

export default async function AdminConnectionsPage() {
  await requireOfficerPage()
  const [session, connections] = await Promise.all([getCachedSessionUser(), listConnections()])
  const now = new Date()
  const rows = connections.map((row) => toConnectionView(row, now))

  return (
    <>
      <PageHeader title="Connections" description={connectionsSummary(rows)} />
      <div className="mb-4 grid items-start gap-4 md:grid-cols-2">
        <SafeSlot id="scheduler" where="connections" render={SchedulerPanel} />
        <SafeSlot id="storage" where="connections" render={StoragePanel} />
      </div>
      <ConnectionsList rows={rows} isAdmin={session.roles.includes("admin")} />
    </>
  )
}
