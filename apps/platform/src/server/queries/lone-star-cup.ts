import { prisma } from "@/server/db"
import { publicEventWhere } from "@/lib/events"
import { getStandings } from "@/server/queries/standings"
import { seasonLabel, seasonTerm } from "@/lib/seasons"

/**
 * The current Lone Star Cup season at a glance, for the homepage: how far through it is and
 * who leads. "Current" is the newest public season with an event series, as on /lone-star-cup.
 */
export async function getLoneStarCupSnapshot() {
  const now = new Date()
  const seasons = await prisma.season.findMany({
    where: { visibility: "public", league: { slug: "lone-star-cup" }, seriesId: { not: null } },
    orderBy: [{ startAt: { sort: "desc", nulls: "last" } }, { year: "desc" }],
    select: {
      name: true,
      startAt: true,
      series: { select: { id: true, slug: true, _count: { select: { events: { where: publicEventWhere(now) } } } } },
    },
  })
  const season = seasons[0]
  if (!season?.series) return null

  const [rounds, standings] = await Promise.all([
    prisma.event.findMany({
      where: { ...publicEventWhere(now), seriesId: season.series.id },
      orderBy: { startsAtUtc: "asc" },
      select: { endsAtUtc: true },
    }),
    getStandings(season.series.slug),
  ])
  const nextIndex = rounds.findIndex((round) => round.endsAtUtc > now)

  return {
    label: seasonLabel(season.name),
    term: seasonTerm(season.startAt),
    /** Seasons that have run or are on the calendar, as the LSC page's archive counts them */
    seasons: seasons.filter((s) => (s.series?._count.events ?? 0) > 0).length,
    rounds: rounds.length,
    completed: nextIndex === -1 ? rounds.length : nextIndex,
    leaders: standings.filter((entry) => entry.points > 0).slice(0, 3),
  }
}
