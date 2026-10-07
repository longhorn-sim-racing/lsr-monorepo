// src/server/repos/league.repo.ts
import { prisma } from '@/server/db';
import { publicUserSelect } from '@/lib/public-user';

export async function getLeagueBySlug(slug: string) {
  return prisma.league.findUnique({ where: { slug } });
}

export async function getSeasonBySlug(slug: string) {
  return prisma.season.findUnique({ where: { slug } });
}

export async function listSeasonsForLeague(leagueId: string) {
  return prisma.season.findMany({
    where: { leagueId },
    orderBy: { year: 'desc' },
  });
}

export async function listRoundsWithEvents(seasonId: string) {
  return prisma.round.findMany({
    where: { seasonId },
    include: {
      event: true,
    },
    orderBy: { date: 'asc' },
  });
}

export async function listSessionsForRound(roundId: string) {
  return prisma.session.findMany({
    where: { roundId },
    orderBy: { startedAt: 'asc' },
  });
}

export async function listEntriesForSeason(seasonId: string) {
  return prisma.entry.findMany({
    where: { seasonId },
    include: {
      user: { select: publicUserSelect },
      team: true,
      class: true,
    },
  });
}

export async function listResultsForSession(sessionId: string) {
  return prisma.result.findMany({
    where: { sessionId },
    include: {
      entry: {
        include: {
          user: { select: publicUserSelect },
          team: true,
          class: true,
        },
      },
    },
    orderBy: { position: 'asc' },
  });
}
