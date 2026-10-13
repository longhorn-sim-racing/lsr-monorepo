import type { Metadata } from "next"
import { prisma } from "@/server/db"
import { getAllSeries } from "@/server/queries/series"
import { requireOfficerPage } from "@/server/auth/guards"
import { PageHeader } from "@/components/admin/kit"
import { SeasonForm } from "../form"

export const metadata: Metadata = { title: "New season" }

export default async function NewSeasonPage() {
  await requireOfficerPage()
  const [series, leagues] = await Promise.all([
    getAllSeries(),
    prisma.league.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ])

  return (
    <div className="max-w-3xl">
      <PageHeader title="New season" description="A season groups a series' events into one set of standings." back={{ href: "/admin/seasons", label: "Seasons" }} />
      <SeasonForm seriesList={series} leagues={leagues} />
    </div>
  )
}
