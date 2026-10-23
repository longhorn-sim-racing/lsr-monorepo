import { describe, expect, it, vi } from "vitest";
import type { SeedContext } from "./types";
import { OFFICER_APPLICANT, seedOfficerApplicant } from "./club-data";

const NOW = new Date("2026-10-23T17:00:00Z");
const ROUND = { id: "round-1", name: "Fall 2026", formVersion: 3, closesAt: new Date("2026-10-31T04:59:00Z") };

/** A fake Prisma client for the seeder: the rounds it finds, and every write kept */
function fakeDb(rounds: { active?: typeof ROUND | null; latest?: typeof ROUND | null } = {}) {
  const db = {
    recruitingCycle: {
      findFirst: vi.fn(async (args: { where?: { isActive?: boolean } }) => (args.where?.isActive ? (rounds.active ?? null) : (rounds.latest ?? null))),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ formVersion: 1, ...data })),
    },
    role: { upsert: vi.fn(async () => ({ id: "role-officer" })) },
    user: { upsert: vi.fn() },
    userRole: { upsert: vi.fn() },
    application: { upsert: vi.fn() },
    applicationTrack: { deleteMany: vi.fn(), upsert: vi.fn() },
    applicationReview: { deleteMany: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db)),
  };
  return db;
}

const seed = (db: ReturnType<typeof fakeDb>, now = NOW) => seedOfficerApplicant({ prisma: db as unknown as SeedContext["prisma"], now });

describe("seedOfficerApplicant", () => {
  it("plants a made-up officer with a submitted application and one review in the current round, by fixed ids", async () => {
    const db = fakeDb({ active: ROUND });
    expect(await seed(db)).toBe("an officer's application in Fall 2026, with one review");
    expect(db.recruitingCycle.create).not.toHaveBeenCalled();

    expect(db.role.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "officer" }, update: {} }));
    expect(db.user.upsert.mock.calls[0][0]).toMatchObject({
      where: { id: OFFICER_APPLICANT.userId },
      create: { id: OFFICER_APPLICANT.userId, email: OFFICER_APPLICANT.email, handle: OFFICER_APPLICANT.handle, status: "active", department: null },
    });
    // It joins when first seeded: a rerun leaves createdAt alone, so the run's default officer (the oldest) stays a real one
    expect(db.user.upsert.mock.calls[0][0].update).not.toHaveProperty("createdAt");
    expect(db.userRole.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { userId: OFFICER_APPLICANT.userId, roleId: "role-officer" } }));

    expect(db.application.upsert.mock.calls[0][0]).toMatchObject({
      where: { id: OFFICER_APPLICANT.applicationId },
      update: { cycleId: "round-1", userId: OFFICER_APPLICANT.userId, state: "SUBMITTED", formVersion: 3, submittedAt: NOW },
    });
    expect(db.applicationTrack.upsert.mock.calls[0][0]).toMatchObject({ where: { id: OFFICER_APPLICANT.trackId }, update: { track: "media", status: "IN_REVIEW", decidedAt: null } });
    expect(db.applicationReview.upsert.mock.calls[0][0]).toMatchObject({ where: { id: OFFICER_APPLICANT.reviewId }, update: { reviewerId: null, notes: OFFICER_APPLICANT.notes } });
  });

  it("resets on a rerun: other teams and reviews on the fixture go", async () => {
    const db = fakeDb({ active: ROUND });
    await seed(db);
    expect(db.applicationTrack.deleteMany).toHaveBeenCalledWith({ where: { applicationId: OFFICER_APPLICANT.applicationId, id: { not: OFFICER_APPLICANT.trackId } } });
    expect(db.applicationReview.deleteMany).toHaveBeenCalledWith({ where: { applicationTrackId: OFFICER_APPLICANT.trackId, id: { not: OFFICER_APPLICANT.reviewId } } });
  });

  it("uses the latest round when none is active, submitted no later than it closed", async () => {
    const closed = { ...ROUND, closesAt: new Date("2026-05-01T05:00:00Z") };
    const db = fakeDb({ latest: closed });
    await seed(db);
    expect(db.recruitingCycle.create).not.toHaveBeenCalled();
    expect(db.application.upsert.mock.calls[0][0].update).toMatchObject({ cycleId: "round-1", submittedAt: closed.closesAt });
  });

  it("makes up a closed round only when the copy has none", async () => {
    const db = fakeDb();
    expect(await seed(db)).toBe("an officer's application in Eval round (fake), with one review");
    const { data } = db.recruitingCycle.create.mock.calls[0][0];
    expect(data).toMatchObject({ id: OFFICER_APPLICANT.roundId, isActive: false });
    expect((data.closesAt as Date).getTime()).toBeLessThan(NOW.getTime());
    expect(db.application.upsert.mock.calls[0][0].update).toMatchObject({ cycleId: OFFICER_APPLICANT.roundId });
  });

  it("writes notes the privacy question's guard looks for (12 characters or more), and no real address", () => {
    expect(OFFICER_APPLICANT.notes.trim().length).toBeGreaterThanOrEqual(12);
    expect(OFFICER_APPLICANT.email).toMatch(/@example\.invalid$/);
  });
});
