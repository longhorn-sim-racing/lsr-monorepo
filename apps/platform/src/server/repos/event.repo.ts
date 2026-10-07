// src/server/repos/event.repo.ts
import { prisma } from '@/server/db';

export async function listAllEvents() {
  const now = new Date();
  return prisma.event.findMany({
    where: {
      OR: [
        { status: { in: ['PUBLISHED', 'CANCELLED', 'POSTPONED', 'IN_PROGRESS', 'COMPLETED'] } },
        { status: 'SCHEDULED', publishedAt: { lte: now } }
      ]
    },
    orderBy: { startsAtUtc: 'asc' },
    include: {
      venue: true,
      series: true,
    },
  });
}

export async function listAllEventsForAdmin() {
  return prisma.event.findMany({
    orderBy: { startsAtUtc: 'asc' },
    include: {
      venue: true,
      series: true,
    },
  });
}

export async function listLiveEvents() {
  const now = new Date();
  return prisma.event.findMany({
    where: {
      startsAtUtc: { lte: now },
      endsAtUtc: { gte: now },
      OR: [
        { status: { in: ['PUBLISHED', 'IN_PROGRESS'] } },
        { status: 'SCHEDULED', publishedAt: { lte: now } }
      ]
    },
  });
}

export async function getAllEventSeries() {
  return prisma.eventSeries.findMany({
    orderBy: { title: 'asc' },
  });
}

export async function getEventBySlug(slug: string) {
  return prisma.event.findUnique({
    where: { slug },
    include: {
      venue: true,
      series: true,
      eligibility: true,
      registrations: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
    },
  });
}

export async function getEventById(id: string) {
  return prisma.event.findUnique({
    where: { id },
  });
}
