// src/server/repos/event.repo.ts
import { prisma } from '@/server/db';
import { publicEventWhere } from '@/lib/events';

export async function listAllEvents() {
  return prisma.event.findMany({
    where: publicEventWhere(),
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
      AND: [
        publicEventWhere(now),
        { status: { in: ['PUBLISHED', 'IN_PROGRESS', 'SCHEDULED'] } },
      ],
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
