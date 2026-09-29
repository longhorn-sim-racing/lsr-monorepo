import { prisma } from '@/server/db';
import { pickRacingNumberStyle, type RacingNumberStyle } from '@/lib/racing-number';

export async function getStandings(slug: string) {
  // 1. Try finding a Season by slug
  const season = await prisma.season.findUnique({
      where: { slug },
      include: {
          entries: {
              include: { 
                  user: true, 
              },
              orderBy: [
                  { rank: 'asc' }, // Prefer explicit rank
                  { totalPoints: 'desc' } // Fallback
              ]
          }
      }
  });

  if (season) {
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

  // Legacy fallback
  const results = await prisma.result.findMany({
    where: {
      session: {
        round: {
          event: {
            series: {
              slug: slug,
            },
          },
        },
        kind: 'race',
      },
    },
    include: {
      entry: {
        include: {
          user: true,
          car: true,
        },
      },
    },
  });

  const driverStats = new Map<string, {
    driver: { id: string, name: string, handle: string, avatarUrl?: string | null } & RacingNumberStyle;
    points: number;
    wins: number;
    podiums: number;
    starts: number;
    car: string | undefined;
    incidents: number;
    bestFinish: number | null;
    rank: number | null;
  }>();

  for (const result of results) {
    if (!result.entry || !result.entry.user) {
      continue;
    }

    const userId = result.entry.user.id;
    const driverName = result.entry.user.displayName;
    const driverHandle = result.entry.user.handle;
    const driverAvatar = result.entry.user.avatarUrl;
    const carName = result.entry.car?.name;

    if (!driverStats.has(userId)) {
      driverStats.set(userId, {
        driver: { id: userId, name: driverName, handle: driverHandle, avatarUrl: driverAvatar, ...pickRacingNumberStyle(result.entry.user) },
        points: 0,
        wins: 0,
        podiums: 0,
        starts: 0,
        car: carName,
        incidents: 0,
        bestFinish: null,
        rank: null
      });
    }

    const stats = driverStats.get(userId)!;

    stats.points += result.points ?? 0;
    stats.starts += 1;
    // Legacy doesn't track incidents

    if (result.position === 1) {
      stats.wins += 1;
    }
    if (result.position && result.position <= 3) {
      stats.podiums += 1;
    }
    if (result.position && (stats.bestFinish === null || result.position < stats.bestFinish)) {
        stats.bestFinish = result.position;
    }
  }

  const standings = Array.from(driverStats.values());

  standings.sort((a, b) => {
    if (b.points !== a.points) {
      return b.points - a.points;
    }
    if (b.wins !== a.wins) {
      return b.wins - a.wins;
    }
    return b.podiums - a.podiums;
  });

  // Assign calculated rank
  standings.forEach((s, index) => {
      s.rank = index + 1;
  });

  return standings;
}

export async function getStandingsForSeason(_seasonId: string) {
  // TODO: Implement the logic to fetch and calculate standings for a season.
  return [];
}