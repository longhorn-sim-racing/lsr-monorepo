import { prisma } from "@/server/db";
import { cache } from "react";
import { racingNumberSelect } from "@/lib/racing-number";

// Results render on public pages, so only load what the page shows (no email or EID).
const publicUserSelect = {
  id: true,
  handle: true,
  displayName: true,
  avatarUrl: true,
  ...racingNumberSelect,
} as const;

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
