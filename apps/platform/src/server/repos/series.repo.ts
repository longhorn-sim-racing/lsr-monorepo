// src/server/repos/series.repo.ts
import { prisma } from '@/server/db';
import { Prisma } from '@prisma/client';

export async function listAllSeries() {
  return prisma.eventSeries.findMany({
    orderBy: { title: 'asc' },
    include: {
      _count: {
        select: {
          seasons: true,
          events: true,
        },
      },
    },
  });
}

export async function getSeriesById(id: string) {
  return prisma.eventSeries.findUnique({
    where: { id },
  });
}

export async function createSeries(data: Prisma.EventSeriesCreateInput) {
  return prisma.eventSeries.create({ data });
}

export async function updateSeries(id: string, data: Prisma.EventSeriesUpdateInput) {
  return prisma.eventSeries.update({ where: { id }, data });
}

export async function deleteSeries(id: string) {
  return prisma.eventSeries.delete({ where: { id } });
}
