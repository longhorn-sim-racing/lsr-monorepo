import { cache } from "react";
import { prisma } from "@/server/db";

export const getAllProducts = cache(async () => {
  return prisma.product.findMany({
    include: { league: { select: { name: true, slug: true } } },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });
});

export const getProductById = cache(async (id: string) => {
  return prisma.product.findUnique({
    where: { id },
    include: { league: { select: { name: true, slug: true } } },
  });
});

export type AdminProduct = Awaited<ReturnType<typeof getAllProducts>>[number];
