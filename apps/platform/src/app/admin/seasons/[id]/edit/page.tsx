import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { prisma } from "@/server/db"
import { getAllSeries } from "@/server/queries/series"
import { getSeasonById } from "@/server/queries/seasons"
import { requireOfficerPage } from "@/server/auth/guards"
import { Badge, PageHeader, SplitLayout } from "@/components/admin/kit"
import { SeasonForm } from "../../form"
import { PHASE_LABEL, PHASE_TONE, seasonPhase } from "../../_components/season-status"
import { StandingsPanel } from "../../_components/standings-panel"

export const metadata: Metadata = { title: "Edit season" }

export default async function EditSeasonPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOfficerPage()
  const { id } = await params
  const [season, series, leagues, counts] = await Promise.all([
    getSeasonById(id),
    getAllSeries(),
    prisma.league.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.season.findUnique({ where: { id }, select: { _count: { select: { entries: true, applications: true } } } }),
  ])

  if (!season) notFound()
  const phase = seasonPhase(season)

  return (
    <>
      <PageHeader
        title={season.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>
            {season.series?.title ?? "No series"}
          </span>
        }
        back={{ href: "/admin/seasons", label: "Seasons" }}
      />
      <SplitLayout
        main={<SeasonForm initialData={season} seriesList={series} leagues={leagues} />}
        side={<StandingsPanel season={{ id: season.id, name: season.name, slug: season.slug, seriesId: season.seriesId }} entries={counts?._count.entries ?? 0} applications={counts?._count.applications ?? 0} />}
      />
    </>
  )
}
