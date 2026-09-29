"use server";

import { requireOfficer } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { revalidateDriverList, revalidateSeriesPages } from "@/server/cache/revalidate-public";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createAuditLog } from "@/server/audit/log";

const seasonSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  year: z.coerce.number().int().min(2000),
  seriesId: z.string().optional(),
  startAt: z.string().optional().transform(val => val ? new Date(val) : null),
  endAt: z.string().optional().transform(val => val ? new Date(val) : null),
  pointsRule: z.string().optional(),
});

export async function createSeason(formData: FormData) {
  const user = await requireOfficer();

  const data = seasonSchema.parse({
      name: formData.get("name"),
      slug: formData.get("slug"),
      year: formData.get("year"),
      seriesId: formData.get("seriesId") || undefined,
      startAt: formData.get("startAt"),
      endAt: formData.get("endAt"),
      pointsRule: formData.get("pointsRule"),
  });

  const season = await prisma.season.create({
    data: {
      name: data.name,
      slug: data.slug,
      year: data.year,
      seriesId: data.seriesId,
      startAt: data.startAt,
      endAt: data.endAt,
      pointsRule: data.pointsRule ? { system: data.pointsRule } : undefined,
      leagueId: null,
    },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "CREATE",
    entityType: "SEASON",
    entityId: season.id,
    summary: `Created season: ${season.name}`,
    after: data,
  });

  revalidatePath("/admin/seasons");
  revalidateSeriesPages(season.slug);
  redirect("/admin/seasons");
}

export async function updateSeason(id: string, formData: FormData) {
    const user = await requireOfficer();

    const data = seasonSchema.parse({
        name: formData.get("name"),
        slug: formData.get("slug"),
        year: formData.get("year"),
        seriesId: formData.get("seriesId") || undefined,
        startAt: formData.get("startAt"),
        endAt: formData.get("endAt"),
        pointsRule: formData.get("pointsRule"),
    });

    const prev = await prisma.season.findUnique({ where: { id }, select: { slug: true } });

    await prisma.season.update({
        where: { id },
        data: {
            name: data.name,
            slug: data.slug,
            year: data.year,
            seriesId: data.seriesId,
            startAt: data.startAt,
            endAt: data.endAt,
            pointsRule: data.pointsRule ? { system: data.pointsRule } : undefined,
        },
    });

    await createAuditLog({
        actorUserId: user.id,
        actionType: "UPDATE",
        entityType: "SEASON",
        entityId: id,
        summary: `Updated season: ${data.name}`,
        after: data,
    });

    revalidatePath("/admin/seasons");
    revalidateSeriesPages(data.slug);
    if (prev && prev.slug !== data.slug) revalidateSeriesPages(prev.slug);
    redirect("/admin/seasons");
}

export async function deleteSeason(id: string) {
    const user = await requireOfficer();

    const prev = await prisma.season.findUnique({ where: { id }, select: { slug: true } });

    await prisma.season.delete({ where: { id } });

    await createAuditLog({
        actorUserId: user.id,
        actionType: "DELETE",
        entityType: "SEASON",
        entityId: id,
        summary: `Deleted season ${id}`,
    });

    revalidatePath("/admin/seasons");
    if (prev) revalidateSeriesPages(prev.slug);
}

export async function recomputeStandings(seasonId: string) {
    const user = await requireOfficer();

    const season = await prisma.season.findUnique({
        where: { id: seasonId },
    });
    if (!season) throw new Error("Season not found");
    if (!season.seriesId) throw new Error("Season must have a Series assigned to recompute");

    // 1. Fetch Events in Season Range with Results (include QUALIFYING for positions gained)
    const events = await prisma.event.findMany({
        where: {
            seriesId: season.seriesId,
            startsAtUtc: {
                gte: season.startAt || undefined,
                lte: season.endAt || undefined
            }
        },
        include: {
            ingestedSessions: {
                where: { sessionType: { in: ["RACE", "QUALIFYING"] } },
                include: {
                    results: {
                        include: {
                            participant: {
                                include: { carMapping: true }
                            }
                        }
                    }
                }
            }
        }
    });

    // 2. Aggregate Data
    type DriverStats = {
        userId: string;
        totalPoints: number;
        starts: number;
        wins: number;
        podiums: number;
        top5: number;
        top10: number;
        bestFinish: number;
        dnfs: number;
        finishes: number[];
        lastCarDisplay: string | null;
        totalCuts: number;
        totalCollisions: number;
        totalPositionsGained: number;
    }
    const statsMap = new Map<string, DriverStats>();

    for (const event of events) {
        // Build qualifying position map for this event
        const qualiSession = event.ingestedSessions.find(s => s.sessionType === "QUALIFYING");
        const qualiPosByGuid = new Map<string, number>();
        if (qualiSession) {
            for (const result of qualiSession.results) {
                qualiPosByGuid.set(result.participant.driverGuid, result.position);
            }
        }

        for (const session of event.ingestedSessions) {
            if (session.sessionType !== "RACE") continue;
            for (const result of session.results) {
                const userId = result.participant.userId;
                if (!userId) continue;

                const current = statsMap.get(userId) || {
                    userId,
                    totalPoints: 0,
                    starts: 0,
                    wins: 0,
                    podiums: 0,
                    top5: 0,
                    top10: 0,
                    bestFinish: 9999,
                    dnfs: 0,
                    finishes: [],
                    lastCarDisplay: null,
                    totalCuts: 0,
                    totalCollisions: 0,
                    totalPositionsGained: 0,
                };

                // Car
                const carDisplay = result.participant.carMapping?.displayName || result.participant.carName;
                current.lastCarDisplay = carDisplay;

                // Points
                current.totalPoints += (result.points || 0);
                current.starts += 1;

                // Incidents
                current.totalCuts += (result.totalCuts || 0);
                current.totalCollisions += (result.collisionCount || 0);

                // Positions gained
                const qualiPos = qualiPosByGuid.get(result.participant.driverGuid);
                if (qualiPos !== undefined) {
                    current.totalPositionsGained += (qualiPos - result.position);
                }

                // Position stats
                if (result.status === "FINISHED" || result.status === "DNF" || result.status === "DSQ") {
                    const pos = result.position;
                    current.finishes.push(pos);

                    if (pos === 1) current.wins++;
                    if (pos <= 3) current.podiums++;
                    if (pos <= 5) current.top5++;
                    if (pos <= 10) current.top10++;
                    if (pos < current.bestFinish) current.bestFinish = pos;
                }

                if (result.status === "DNF") current.dnfs++;

                statsMap.set(userId, current);
            }
        }
    }

    // 3. Update Entries
    await prisma.$transaction(async (tx) => {
        const allStats = Array.from(statsMap.values()).sort((a, b) => b.totalPoints - a.totalPoints);

        let rank = 1;
        for (const stat of allStats) {
            const avg = stat.finishes.length > 0
                ? stat.finishes.reduce((a, b) => a + b, 0) / stat.finishes.length
                : 0;

            const existingEntry = await tx.entry.findFirst({
                where: { seasonId, userId: stat.userId }
            });

            if (existingEntry) {
                await tx.entry.update({
                    where: { id: existingEntry.id },
                    data: {
                        totalPoints: stat.totalPoints,
                        starts: stat.starts,
                        wins: stat.wins,
                        podiums: stat.podiums,
                        top5: stat.top5,
                        top10: stat.top10,
                        bestFinish: stat.bestFinish === 9999 ? null : stat.bestFinish,
                        averageFinish: avg,
                        dnfs: stat.dnfs,
                        rank: rank++,
                        carDisplay: stat.lastCarDisplay,
                        totalCuts: stat.totalCuts,
                        totalCollisions: stat.totalCollisions,
                        totalPositionsGained: stat.totalPositionsGained,
                    }
                });
            } else {
                await tx.entry.create({
                    data: {
                        seasonId,
                        userId: stat.userId,
                        classId: null,
                        isEligiblePoints: true,
                        totalPoints: stat.totalPoints,
                        starts: stat.starts,
                        wins: stat.wins,
                        podiums: stat.podiums,
                        top5: stat.top5,
                        top10: stat.top10,
                        bestFinish: stat.bestFinish === 9999 ? null : stat.bestFinish,
                        averageFinish: avg,
                        dnfs: stat.dnfs,
                        rank: rank++,
                        carDisplay: stat.lastCarDisplay,
                        totalCuts: stat.totalCuts,
                        totalCollisions: stat.totalCollisions,
                        totalPositionsGained: stat.totalPositionsGained,
                    }
                });
            }
        }
    });

    await createAuditLog({
        actorUserId: user.id,
        actionType: "UPDATE",
        entityType: "SEASON",
        entityId: seasonId,
        summary: `Recomputed standings for season ${season.name}`,
    });

    revalidatePath(`/admin/seasons`);
    revalidateDriverList();
    revalidateSeriesPages(season.slug);
}
