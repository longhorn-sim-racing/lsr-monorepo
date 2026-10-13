import { Metadata } from "next"
import { AuditConsole } from "@/components/admin/audit-console"
import { requireOfficerPage } from "@/server/auth/guards"

export const metadata: Metadata = {
  title: "Audit log",
}

export default async function AuditLogPage() {
  await requireOfficerPage()
  return <AuditConsole />
}
