import { Prisma, type LeagueApplicationSource } from "@prisma/client";
import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import type { LeagueApplicationInput } from "@/schemas/league-application.schema";

type Db = Prisma.TransactionClient | typeof prisma;

const activeAt = (now: Date) => ({
  validFrom: { lte: now },
  OR: [{ validTo: null }, { validTo: { gte: now } }],
});

/**
 * The season a league entry is for: the nearest season that hasn't ended
 * (seasons with no endAt come last, then newest year). Null between seasons,
 * which closes entry.
 */
export async function getOpenLeagueSeason(leagueId: string, now = new Date(), db: Db = prisma) {
  return db.season.findFirst({
    where: { leagueId, OR: [{ endAt: null }, { endAt: { gte: now } }] },
    orderBy: [{ endAt: { sort: "asc", nulls: "last" } }, { year: "desc" }],
  });
}

/** The user's league_access entitlement that's in force right now, if any. */
export async function getActiveLeagueEntry(userId: string, leagueId: string, now = new Date(), db: Db = prisma) {
  return db.entitlement.findFirst({
    where: { userId, kind: "league_access", leagueId, ...activeAt(now) },
  });
}

export async function getLeagueApplication(userId: string, seasonId: string) {
  return prisma.leagueApplication.findUnique({
    where: { userId_seasonId: { userId, seasonId } },
  });
}

/**
 * Creates or updates a driver's entry form for a season. A UT EID is saved to
 * the driver's profile, since it isn't season-specific.
 */
export async function saveLeagueApplication(params: {
  userId: string;
  seasonId: string;
  input: LeagueApplicationInput;
  actorUserId: string;
  source?: LeagueApplicationSource;
}) {
  const { userId, seasonId, input, actorUserId, source = "SITE" } = params;
  const data = {
    discordUsername: input.discordUsername,
    experience: input.experience,
    equipment: input.equipment,
    canCommit: input.canCommit,
    school: input.utStudent ? null : input.school ?? null,
    notes: input.notes ?? null,
  };

  const { application, created } = await prisma.$transaction(async (tx) => {
    if (input.utStudent && input.eid) {
      const owner = await tx.user.findUnique({ where: { eid: input.eid }, select: { id: true } });
      if (owner && owner.id !== userId) {
        throw new Error("That UT EID is already on another account.");
      }
      await tx.user.update({ where: { id: userId }, data: { eid: input.eid } });
    }

    const existing = await tx.leagueApplication.findUnique({
      where: { userId_seasonId: { userId, seasonId } },
      select: { id: true },
    });
    const application = await tx.leagueApplication.upsert({
      where: { userId_seasonId: { userId, seasonId } },
      create: {
        userId,
        seasonId,
        ...data,
        source,
        createdById: source === "SITE" ? null : actorUserId,
      },
      update: data,
    });
    return { application, created: !existing };
  });

  await createAuditLog({
    actorUserId,
    actionType: created ? "LEAGUE_APPLICATION_CREATED" : "LEAGUE_APPLICATION_UPDATED",
    entityType: "LeagueApplication",
    entityId: application.id,
    targetUserId: userId,
    summary: `${created ? "Submitted" : "Updated"} league entry form`,
    after: application,
    metadata: { seasonId, source },
  });

  return application;
}

/**
 * Enters a driver without a Stripe payment (paid another way, comped, or
 * backfilled). Runs to the end of the league's open season, like a paid entry.
 */
export async function grantManualLeagueEntry(params: {
  userId: string;
  leagueId: string;
  actorUserId: string;
  note?: string;
}) {
  const { userId, leagueId, actorUserId, note } = params;
  const now = new Date();

  const entitlement = await prisma.$transaction(async (tx) => {
    const season = await getOpenLeagueSeason(leagueId, now, tx);
    if (!season) throw new Error("This league has no open season to enter.");
    if (await getActiveLeagueEntry(userId, leagueId, now, tx)) {
      throw new Error("This driver is already entered.");
    }
    return tx.entitlement.create({
      data: {
        userId,
        kind: "league_access",
        leagueId,
        scope: "season",
        validFrom: now,
        validTo: season.endAt ?? new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
        meta: { seasonSlug: season.slug, source: "manual", grantedById: actorUserId, note: note ?? null },
      },
    });
  });

  await createAuditLog({
    actorUserId,
    actionType: "LEAGUE_ENTRY_GRANTED",
    entityType: "Entitlement",
    entityId: entitlement.id,
    targetUserId: userId,
    summary: "Entered driver manually (no Stripe payment)",
    after: entitlement,
  });

  return entitlement;
}

/** Ends a manual entry. Paid entries are ended by refunding them in Stripe. */
export async function revokeManualLeagueEntry(entitlementId: string, actorUserId: string) {
  const now = new Date();
  const before = await prisma.entitlement.findUnique({ where: { id: entitlementId } });
  if (!before || before.kind !== "league_access") throw new Error("Entry not found.");
  if (before.sourcePaymentId) {
    throw new Error("This entry was paid through Stripe. Refund it in Stripe to end it.");
  }

  const after = await prisma.entitlement.update({
    where: { id: entitlementId },
    data: { validTo: now },
  });

  await createAuditLog({
    actorUserId,
    actionType: "LEAGUE_ENTRY_REVOKED",
    entityType: "Entitlement",
    entityId: entitlementId,
    targetUserId: before.userId,
    summary: "Ended manual league entry",
    before,
    after,
  });
}

const entrantUserSelect = {
  id: true,
  handle: true,
  displayName: true,
  email: true,
  eid: true,
  racingNumber: true,
  racingNumberColor: true,
  racingNumberFont: true,
  racingNumberItalic: true,
  racingNumberBorder: true,
} satisfies Prisma.UserSelect;

export type EntryStatus = "paid" | "manual" | "ended" | "none";

/**
 * Everyone who filled out the entry form for a season or holds an entry for
 * it, one row per driver.
 */
export async function listSeasonEntrants(seasonId: string) {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { id: true, slug: true, name: true, leagueId: true },
  });
  if (!season) return null;

  const [applications, entitlements] = await Promise.all([
    prisma.leagueApplication.findMany({
      where: { seasonId },
      include: { user: { select: entrantUserSelect } },
      orderBy: { createdAt: "asc" },
    }),
    season.leagueId
      ? prisma.entitlement.findMany({
          where: {
            kind: "league_access",
            leagueId: season.leagueId,
            meta: { path: ["seasonSlug"], equals: season.slug },
          },
          include: {
            user: { select: entrantUserSelect },
            payment: { select: { id: true, amountCents: true, paidAt: true, metadata: true, providerRef: true } },
          },
          orderBy: { validFrom: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const now = new Date();
  const isActive = (e: (typeof entitlements)[number]) =>
    e.validFrom <= now && (e.validTo === null || e.validTo >= now);

  const rows = new Map<
    string,
    {
      user: Prisma.UserGetPayload<{ select: typeof entrantUserSelect }>;
      application: (typeof applications)[number] | null;
      entry: (typeof entitlements)[number] | null;
    }
  >();
  for (const a of applications) rows.set(a.userId, { user: a.user, application: a, entry: null });
  for (const e of entitlements) {
    const row = rows.get(e.userId) ?? { user: e.user, application: null, entry: null };
    // Prefer the entry that's in force; otherwise keep the latest one.
    if (!row.entry || (isActive(e) && !isActive(row.entry)) || (!isActive(row.entry) && e.validFrom > row.entry.validFrom)) {
      row.entry = e;
    }
    rows.set(e.userId, row);
  }

  const entrants = Array.from(rows.values()).map((row) => {
    let status: EntryStatus = "none";
    if (row.entry) status = !isActive(row.entry) ? "ended" : row.entry.sourcePaymentId ? "paid" : "manual";
    return { ...row, status };
  });

  return { season, entrants };
}

export type SeasonEntrant = NonNullable<Awaited<ReturnType<typeof listSeasonEntrants>>>["entrants"][number];
