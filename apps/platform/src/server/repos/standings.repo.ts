import { prisma } from '@/server/db';
import { pickRacingNumberStyle } from '@/lib/racing-number';
import { publicUserSelect } from '@/lib/public-user';

const seasonStandingsInclude = {
    entries: {
        include: {
            user: { select: publicUserSelect },
        },
        orderBy: [
            { rank: 'asc' as const }, // Prefer explicit rank
            { totalPoints: 'desc' as const } // Fallback
        ]
    }
};

/**
 * Standings for a season, from the per-season Entry totals that "recompute standings"
 * writes. Accepts the season's slug or, failing that, its event series' slug (they
 * match for the LSC).
 */
export async function getStandings(slug: string) {
  const season =
      (await prisma.season.findUnique({ where: { slug }, include: seasonStandingsInclude })) ??
      (await prisma.season.findFirst({
          where: { series: { slug } },
          orderBy: { year: 'desc' },
          include: seasonStandingsInclude,
      }));

  if (!season) return [];

  return season.entries.map(entry => ({
      driver: {
          id: entry.user?.id || "",
          name: entry.user?.displayName || "Unknown",
          handle: entry.user?.handle || "",
          avatarUrl: entry.user?.avatarUrl,
          ...pickRacingNumberStyle(entry.user),
      },
      points: entry.totalPoints,
      wins: entry.wins,
      podiums: entry.podiums,
      starts: entry.starts,
      car: entry.carDisplay || "Unknown",
      incidents: (entry.totalCuts || 0) + (entry.totalCollisions || 0),
      bestFinish: entry.bestFinish,
      rank: entry.rank,
      positionsGained: entry.totalPositionsGained
  }));
}
