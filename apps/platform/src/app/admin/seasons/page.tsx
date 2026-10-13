import type { Metadata } from "next"
import Link from "next/link"
import { prisma } from "@/server/db"
import { getAllSeasons } from "@/server/queries/seasons"
import { requireOfficerPage } from "@/server/auth/guards"
import { Button, PageHeader } from "@/components/admin/kit"
import { SeasonsConsole, type SeasonRow } from "@/components/admin/seasons-console"
import { seasonPhase } from "./_components/season-status"

export const metadata: Metadata = { title: "Seasons" }

export default async function SeasonsAdminPage() {
  await requireOfficerPage()
  const [seasons, leagues, counts] = await Promise.all([
    getAllSeasons(),
    prisma.league.findMany({ select: { id: true, name: true } }),
    // How much a delete would take with it, and how big each season's standings are
    prisma.season.findMany({ select: { id: true, _count: { select: { entries: true, applications: true } } } }),
  ])

  const now = new Date()
  const rows: SeasonRow[] = seasons.map((season) => {
    const count = counts.find((c) => c.id === season.id)?._count
    return {
      id: season.id,
      name: season.name,
      slug: season.slug,
      year: season.year,
      startAt: season.startAt,
      endAt: season.endAt,
      seriesTitle: season.series?.title ?? null,
      hasSeries: !!season.seriesId,
      leagueName: leagues.find((league) => league.id === season.leagueId)?.name ?? null,
      entries: count?.entries ?? 0,
      applications: count?.applications ?? 0,
      phase: seasonPhase(season, now),
    }
  })
  const running = rows.filter((row) => row.phase === "running").length

  return (
    <>
      <PageHeader
        title="Seasons"
        description={`${rows.length} ${rows.length === 1 ? "season" : "seasons"}${running ? ` · ${running} running` : ""} · standings come from ingested race results`}
        actions={
          <Button variant="primary" asChild>
            <Link href="/admin/seasons/new">New season</Link>
          </Button>
        }
      />
      <SeasonsConsole seasons={rows} />
    </>
  )
}
