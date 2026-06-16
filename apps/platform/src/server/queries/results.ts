import { prisma } from "@/server/db";
import { cache } from "react";

export async function getIngestedResultsByEventId(eventId: string) {
  return prisma.raceSession.findMany({
    where: {
      eventId,
    },
    include: {
      participants: {
        include: {
          results: true,
        },
      },
      results: {
        include: {
          participant: {
            include: {
              user: true,
              carMapping: true,
            },
          },
        },
        orderBy: {
          position: "asc",
        },
      },
    },
    orderBy: {
      startedAt: "desc",
    },
  });
}

export const getLapDataBySessionId = cache(async (sessionId: string) => {
  return prisma.raceLap.findMany({
    where: { sessionId },
    include: {
      participant: {
        include: { user: true, carMapping: true },
      },
    },
    orderBy: [{ lapNumber: "asc" }, { timestamp: "asc" }],
  });
});
