import { prisma } from '@/server/db';
import { pickRacingNumberStyle } from '@/lib/racing-number';
import { publicUserSelect } from '@/lib/public-user';

/**
 * Standings for a season, from the per-season Entry totals that "recompute standings"
 * writes. Accepts the season's slug or its event series' slug (they match for the LSC).
 */
export async function getStandings(slug: string) {
  const season = await prisma.season.findFirst({
      where: { OR: [{ slug }, { series: { slug } }] },
      include: {
          entries: {
              include: {
                  user: { select: publicUserSelect },
              },
              orderBy: [
                  { rank: 'asc' }, // Prefer explicit rank
                  { totalPoints: 'desc' } // Fallback
              ]
          }
      }
  });

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
