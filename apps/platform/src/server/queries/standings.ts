import { cache } from 'react';
import { getStandings as getStandingsFromRepo } from '@/server/repos/standings.repo';
import { prisma } from '@/server/db';

export const getStandings = cache(async (seriesSlug: string) => {
  return await getStandingsFromRepo(seriesSlug);
});

export type PointsProgression = {
  rounds: string[];
  drivers: {
    name: string;
    data: number[]; // cumulative points, one per round
  }[];
};

export const getPointsProgression = cache(async (seriesSlug: string): Promise<PointsProgression | null> => {
  const season = await prisma.season.findUnique({ where: { slug: seriesSlug } });
  if (!season?.seriesId) return null;

  const events = await prisma.event.findMany({
    where: {
      seriesId: season.seriesId,
      startsAtUtc: {
        gte: season.startAt || undefined,
        lte: season.endAt || undefined,
      },
    },
    orderBy: { startsAtUtc: 'asc' },
    include: {
      ingestedSessions: {
        where: { sessionType: 'RACE' },
        include: {
          results: {
            include: {
              participant: true,
            },
          },
        },
      },
    },
  });

  if (events.length === 0) return null;

  // Build per-driver, per-event points
  const driverTotals = new Map<string, { name: string; perRound: number[] }>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const roundPoints = new Map<string, number>();

    for (const session of event.ingestedSessions) {
      for (const result of session.results) {
        const userId = result.participant.userId;
        if (!userId) continue;
        roundPoints.set(userId, (roundPoints.get(userId) || 0) + (result.points || 0));

        if (!driverTotals.has(userId)) {
          driverTotals.set(userId, {
            name: result.participant.displayName,
            perRound: new Array(events.length).fill(0),
          });
        }
      }
    }

    for (const [userId, pts] of roundPoints) {
      const driver = driverTotals.get(userId)!;
      driver.perRound[i] = pts;
    }
  }

  // Compute cumulative and sort by total
  const drivers = Array.from(driverTotals.values())
    .map((d) => {
      let cumulative = 0;
      const data = d.perRound.map((pts) => {
        cumulative += pts;
        return cumulative;
      });
      return { name: d.name, data, total: cumulative };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
    .map(({ name, data }) => ({ name, data }));

  const rounds = events.map((e, i) => `R${i + 1}`);

  return { rounds, drivers };
});
