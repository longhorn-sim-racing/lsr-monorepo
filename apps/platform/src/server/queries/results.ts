import { prisma } from "@/server/db";
import { cache } from "react";
import { publicUserSelect } from "@/lib/public-user";

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
              user: { select: publicUserSelect },
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
        include: { user: { select: publicUserSelect }, carMapping: true },
      },
    },
    orderBy: [{ lapNumber: "asc" }, { timestamp: "asc" }],
  });
});
