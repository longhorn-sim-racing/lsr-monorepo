import type { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageForm } from "@/components/admin/page-form"

export const metadata: Metadata = { title: "New page" }

export default async function NewAdminPagePage() {
  await requireOfficerPage()
  return <PageForm id={null} initial={{ title: "", slug: "", visibility: "officers", bodyMd: "" }} />
}
