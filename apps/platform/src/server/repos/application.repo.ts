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

/**
 * The user's most recent submitted application in any round. The status page falls back to it
 * once their round is no longer the active one.
 */
export function findLatestSubmittedApplicationByUser(userId: string, db: Db = prisma) {
  return db.application.findFirst({
    where: { userId, state: "SUBMITTED" },
    orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
    include: { tracks: { orderBy: { createdAt: "asc" } } },
  });
}

export function findTrackConfigs(cycleId: string, db: Db = prisma) {
  return db.recruitingTrackConfig.findMany({ where: { cycleId } });
}

/**
 * Free-text search over an applicant: their name, or either email (the copy on the application and
 * their current ACCOUNT email, which is where messages go and can differ if they changed it).
 */
function searchClause(search: string): Prisma.ApplicationWhereInput {
  return {
    OR: [
      { fullName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { user: { email: { contains: search, mode: "insensitive" } } },
    ],
  };
}

export type TrackListFilters = {
  cycleId: string;
  track?: string;
  status?: TrackStatus;
  autoSubmitted?: boolean;
  /**
   * The officer looking. Reviews and scores of their OWN application are left out (rows,
   * counts and averages), so an officer who applies can't read what colleagues wrote about them.
   * Required so no caller can forget it; null only for code with no viewer (scripts).
   */
  viewerId: string | null;
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
  const { cycleId, track, status, autoSubmitted, q, viewerId } = filters;
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
      ...(search ? searchClause(search) : {}),
    },
  };

  const [rows, total] = await Promise.all([
    db.applicationTrack.findMany({
      where,
      orderBy: [{ application: { submittedAt: "asc" } }, { track: "asc" }, { id: "asc" }],
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
            gradYear: true,
            major: true,
            submittedAt: true,
            autoSubmitted: true,
            user: { select: { email: true } },
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
      const reviews = viewerId && r.application.userId === viewerId ? [] : r.reviews;
      const scores = reviews.map((x) => x.score).filter((s): s is number => s !== null);
      return {
        id: r.id,
        track: r.track,
        status: r.status,
        decidedAt: r.decidedAt,
        application: {
          id: r.application.id,
          userId: r.application.userId,
          fullName: r.application.fullName,
          // The ACCOUNT email (where messages go), not the copy made when the application was started
          email: r.application.user.email,
          gradYear: r.application.gradYear,
          major: r.application.major,
          submittedAt: r.application.submittedAt,
          autoSubmitted: r.application.autoSubmitted,
        },
        reviewCount: reviews.length,
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
export async function findSubmittedApplicationDetail(applicationId: string, viewerId: string | null, db: Db = prisma) {
  const app = await db.application.findFirst({
    where: { id: applicationId, state: "SUBMITTED" },
    include: {
      // The ACCOUNT email (where every message goes), not the copy typed on the application
      user: { select: { id: true, displayName: true, handle: true, email: true } },
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
  // An officer who applied can read their own application but not what colleagues wrote about it
  if (app && viewerId && app.userId === viewerId) {
    return { ...app, tracks: app.tracks.map((t) => ({ ...t, reviews: [] })) };
  }
  return app;
}

/**
 * Everything the CSV export needs, one row per submitted team application. Same filters as the
 * officer list but without paging, capped so a runaway filter can't build an enormous file.
 */
export async function listSubmittedTracksForExport(
  filters: Omit<TrackListFilters, "take" | "skip">,
  db: Db = prisma,
) {
  const { cycleId, track, status, autoSubmitted, q, viewerId } = filters;
  const search = q?.trim();
  const rows = await db.applicationTrack.findMany({
    where: {
      ...(track ? { track } : {}),
      ...(status ? { status } : {}),
      application: {
        cycleId,
        state: "SUBMITTED",
        ...(autoSubmitted === undefined ? {} : { autoSubmitted }),
        ...(search ? searchClause(search) : {}),
      },
    },
    orderBy: [{ application: { submittedAt: "asc" } }, { track: "asc" }, { id: "asc" }],
    take: 5000,
    select: {
      track: true,
      status: true,
      answers: true,
      reviews: { select: { score: true } },
      application: {
        select: {
          id: true,
          userId: true,
          fullName: true,
          eid: true,
          gradYear: true,
          major: true,
          submittedAt: true,
          autoSubmitted: true,
          resumeUrl: true,
          genericAnswers: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  return rows.map((r) => {
    const reviews = viewerId && r.application.userId === viewerId ? [] : r.reviews;
    const scores = reviews.map((x) => x.score).filter((s): s is number => s !== null);
    return {
      applicationId: r.application.id,
      email: r.application.user.email,
      fullName: r.application.fullName,
      eid: r.application.eid,
      gradYear: r.application.gradYear,
      major: r.application.major,
      track: r.track,
      status: r.status,
      submittedAt: r.application.submittedAt,
      autoSubmitted: r.application.autoSubmitted,
      reviewCount: reviews.length,
      averageScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      resumeUrl: r.application.resumeUrl,
      genericAnswers: r.application.genericAnswers,
      trackAnswers: r.answers,
    };
  });
}

/** Failed and still-pending recruiting emails for a round (the badge that points officers at the Emails page). */
export function countEmailsNeedingAttention(cycleId: string, db: Db = prisma) {
  return db.applicationEmail.count({ where: { status: { in: ["FAILED", "PENDING"] }, application: { cycleId } } });
}
