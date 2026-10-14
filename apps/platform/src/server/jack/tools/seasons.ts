import type { League, Season } from "@prisma/client"
import { prisma } from "@/server/db"
import { getOpenLeagueSeason } from "@/server/services/league-entry.service"

export const DEFAULT_LEAGUE = "lone-star-cup"

/**
 * The season a league question is about: the one asked for by slug, or else the open season (the one
 * entry is for right now), or else the league's latest season. Errors list what exists.
 */
export async function resolveLeagueSeason(
  leagueSlug: string,
  seasonSlug: string | undefined,
  now = new Date(),
): Promise<{ ok: true; league: League; season: Season; open: boolean; seasons: string[] } | { ok: false; error: string }> {
  const league = await prisma.league.findUnique({ where: { slug: leagueSlug } })
  if (!league) {
    const leagues = await prisma.league.findMany({ select: { slug: true } })
    return { ok: false, error: `No league "${leagueSlug}". Leagues: ${leagues.map((l) => l.slug).join(", ") || "none"}.` }
  }
  const all = await prisma.season.findMany({
    where: { leagueId: league.id },
    orderBy: [{ endAt: { sort: "desc", nulls: "last" } }, { year: "desc" }],
  })
  const openSeason = await getOpenLeagueSeason(league.id, now)
  const season = seasonSlug ? all.find((s) => s.slug === seasonSlug.trim()) : (openSeason ?? all[0])
  if (!season) {
    return {
      ok: false,
      error: seasonSlug
        ? `No ${league.name} season "${seasonSlug}". Seasons: ${all.map((s) => s.slug).join(", ") || "none"}.`
        : `${league.name} has no seasons yet.`,
    }
  }
  return { ok: true, league, season, open: openSeason?.id === season.id, seasons: all.map((s) => s.slug) }
}
