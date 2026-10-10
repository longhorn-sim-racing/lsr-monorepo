import { Prisma, type TrackStatus } from "@prisma/client";
import { prisma } from "@/server/db";

type Db = Prisma.TransactionClient | typeof prisma;

/** Read queries for recruiting. Rules (who may see or change what) live in recruiting.service.ts. */

export function findActiveCycle(db: Db = prisma) {
  return db.recruitingCycle.findFirst({ where: { isActive: true } });
}

export function findCycleById(id: string, db: Db = prisma) {
  return db.recruitingCycle.findUnique({ where: { id } });
}

/** One person's application in one round, with its team rows. */
export function findApplicationByUser(userId: string, cycleId: string, db: Db = prisma) {
  return db.application.findUnique({
    where: { cycleId_userId: { cycleId, userId } },
    include: { tracks: { orderBy: { createdAt: "asc" } } },
  });
}

export function findTrackConfigs(cycleId: string, db: Db = prisma) {
  return db.recruitingTrackConfig.findMany({ where: { cycleId } });
}

export type TrackListFilters = {
  cycleId: string;
  track?: string;
  status?: TrackStatus;
  autoSubmitted?: boolean;
  /** Matches the applicant's name or email, case-insensitively. */
  q?: string;
  take?: number;
  skip?: number;
};

/**
 * Officer list: one row per team an applicant chose. Drafts never appear, because only
 * rows whose Application is SUBMITTED are selected.
 */
export async function listSubmittedTracks(filters: TrackListFilters, db: Db = prisma) {
  const { cycleId, track, status, autoSubmitted, q } = filters;
  const take = Math.min(Math.max(filters.take ?? 50, 1), 200);
  const skip = Math.max(filters.skip ?? 0, 0);
  const search = q?.trim();

  const where: Prisma.ApplicationTrackWhereInput = {
    ...(track ? { track } : {}),
    ...(status ? { status } : {}),
    application: {
      cycleId,
      state: "SUBMITTED",
      ...(autoSubmitted === undefined ? {} : { autoSubmitted }),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
  };

  const [rows, total] = await Promise.all([
    db.applicationTrack.findMany({
      where,
      orderBy: [{ application: { submittedAt: "asc" } }, { track: "asc" }],
      take,
      skip,
      select: {
        id: true,
        track: true,
        status: true,
        decidedAt: true,
        application: {
          select: {
            id: true,
            userId: true,
            fullName: true,
            email: true,
            gradYear: true,
            major: true,
            submittedAt: true,
            autoSubmitted: true,
          },
        },
        reviews: { select: { score: true } },
      },
    }),
    db.applicationTrack.count({ where }),
  ]);

  return {
    total,
    rows: rows.map((r) => {
      const scores = r.reviews.map((x) => x.score).filter((s): s is number => s !== null);
      return {
        id: r.id,
        track: r.track,
        status: r.status,
        decidedAt: r.decidedAt,
        application: r.application,
        reviewCount: r.reviews.length,
        averageScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      };
    }),
  };
}

/** Counts of submitted team applications per team and status (the admin dashboard header). */
export async function countSubmittedTracks(cycleId: string, db: Db = prisma) {
  const groups = await db.applicationTrack.groupBy({
    by: ["track", "status"],
    where: { application: { cycleId, state: "SUBMITTED" } },
    _count: { _all: true },
  });
  return groups.map((g) => ({ track: g.track, status: g.status, count: g._count._all }));
}

/**
 * Officer detail for one submitted application. Returns null for a draft or a missing
 * id, so a draft can never be opened by guessing its id. The applicant is selected
 * narrowly (no full User row).
 */
export function findSubmittedApplicationDetail(applicationId: string, db: Db = prisma) {
  return db.application.findFirst({
    where: { id: applicationId, state: "SUBMITTED" },
    include: {
      user: { select: { id: true, displayName: true, handle: true } },
      tracks: {
        orderBy: { createdAt: "asc" },
        include: {
          reviews: {
            orderBy: { createdAt: "asc" },
            include: { reviewer: { select: { id: true, displayName: true } } },
          },
          emails: {
            orderBy: { createdAt: "asc" },
            select: { id: true, template: true, subject: true, status: true, error: true, sentAt: true, createdAt: true },
          },
          decidedBy: { select: { id: true, displayName: true } },
        },
      },
      // Application-level mail (e.g. the confirmation)
      emails: {
        where: { applicationTrackId: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, template: true, subject: true, status: true, error: true, sentAt: true, createdAt: true },
      },
    },
  });
}
