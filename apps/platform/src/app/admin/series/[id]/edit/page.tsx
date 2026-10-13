import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getSeries } from "@/server/queries/series"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { SeriesForm } from "@/components/admin/series-form"

export const metadata: Metadata = { title: "Edit series" }

export default async function EditSeriesPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const series = await getSeries(id)

  if (!series) notFound()

  return (
    <>
      <PageHeader title={series.title} description="Edit series" back={{ href: "/admin/series", label: "Series" }} />
      <SeriesForm series={series} />
    </>
  )
}
