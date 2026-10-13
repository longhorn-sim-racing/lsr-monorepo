import type { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { ToolsConsole } from "@/components/admin/tools-console"
import { getLeorgeGawrenceEnforcementUnitStatus } from "./actions"

export const dynamic = "force-dynamic"

export const metadata: Metadata = { title: "Tools" }

export default async function AdminToolsPage() {
  await requireOfficerPage()
  const leorgeEnabled = await getLeorgeGawrenceEnforcementUnitStatus()

  return (
    <>
      <PageHeader title="Tools" description="Feature flags and odd jobs that don't have a page of their own." />
      <ToolsConsole leorgeEnabled={leorgeEnabled} />
    </>
  )
}
