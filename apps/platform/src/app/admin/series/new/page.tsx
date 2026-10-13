import type { Metadata } from "next"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { SeriesForm } from "@/components/admin/series-form"

export const metadata: Metadata = { title: "New series" }

export default async function NewSeriesPage() {
  await requireOfficerPage()
  return (
    <>
      <PageHeader title="New series" back={{ href: "/admin/series", label: "Series" }} />
      <SeriesForm />
    </>
  )
}
