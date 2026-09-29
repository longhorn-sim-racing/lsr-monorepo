import { prisma } from "@/server/db";

export async function getAllSeasons() {
  return prisma.season.findMany({
    orderBy: { startAt: "desc" },
    include: {
      series: true,
    },
  });
}

export async function getSeasonSlugOptions() {
  return prisma.season.findMany({
    select: { slug: true, name: true, year: true },
    orderBy: [{ year: "desc" }, { name: "asc" }],
  });
}

export async function getSeasonById(id: string) {
  return prisma.season.findUnique({
    where: { id },
    include: {
      series: true,
    },
  });
}
