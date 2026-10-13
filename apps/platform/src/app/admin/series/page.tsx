import type { Metadata } from "next"
import Link from "next/link"
import { Plus } from "lucide-react"
import { getAllSeries } from "@/server/queries/series"
import { requireOfficerPage } from "@/server/auth/guards"
import { Button, PageHeader } from "@/components/admin/kit"
import { SeriesConsole } from "@/components/admin/series-console"

export const metadata: Metadata = { title: "Series" }

export default async function SeriesAdminPage() {
  await requireOfficerPage()
  const series = await getAllSeries()

  return (
    <>
      <PageHeader
        title="Series"
        description="Groups of events and seasons, like the Lone Star Cup."
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/series/new">
              <Plus aria-hidden />
              New series
            </Link>
          </Button>
        }
      />
      <SeriesConsole
        series={series.map((s) => ({
          id: s.id,
          title: s.title,
          slug: s.slug,
          visibility: s.visibility,
          events: s._count.events,
          seasons: s._count.seasons,
        }))}
      />
    </>
  )
}
