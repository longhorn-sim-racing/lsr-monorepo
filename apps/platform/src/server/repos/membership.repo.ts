// src/server/repos/membership.repo.ts
import { prisma } from '@/server/db';

/** Entitlements that are in force right now (open-ended ones have validTo = null). */
export async function getActiveEntitlements(userId: string) {
  const now = new Date();
  return prisma.entitlement.findMany({
    where: {
      userId,
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gte: now } }],
    },
  });
}
