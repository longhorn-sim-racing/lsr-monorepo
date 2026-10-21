import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  application: { findMany: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
const repo = vi.hoisted(() => ({
  findCycleById: vi.fn(),
  findActiveCycle: vi.fn(),
  findApplicationByUser: vi.fn(),
  findLatestSubmittedApplicationByUser: vi.fn(),
  findTrackConfigs: vi.fn(),
}));
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }));

vi.mock("@/server/db", () => ({ prisma: db }));
vi.mock("@/server/audit/log", () => audit);
vi.mock("@/server/repos/application.repo", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/repos/application.repo")>()), ...repo }));

import { addNoInterviewTeam } from "@/lib/recruiting/test-teams";
import { questionsForTrack, tracks } from "@/schemas/recruiting.schema";
import { getApplicantStatus, sweepCycle } from "./recruiting.service";

// A team with nothing required, so the draft below counts as complete
addNoInterviewTeam();
const easyTeam = tracks.find((t) => questionsForTrack(t.key).every((q) => !q.required))!.key;

const CLOSES = new Date("2026-10-17T04:59:00Z");
const NOW = new Date("2026-10-17T05:30:00Z");

/** A draft that is complete enough to pass the sweep's pre-check without taking a lock */
const draft = (id: string) => ({
  id,
  userId: `user-${id}`,
  state: "DRAFT",
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  eid: "al123",
  gradYear: 2028,
  major: "Math",
  resumeUrl: "https://example.com/r.pdf",
  genericAnswers: {},
  tracks: [{ id: `t-${id}`, track: easyTeam, answers: {} }],
});

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      $executeRaw: db.$executeRaw,
      application: { findUnique: vi.fn().mockResolvedValue(draft("a1")), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      applicationTrack: { updateMany: vi.fn() },
    }),
  );
  db.$executeRaw.mockResolvedValue(1);
});

describe("sweepCycle", () => {
  it("does nothing before the deadline", async () => {
    repo.findCycleById.mockResolvedValue({ id: "c1", closesAt: CLOSES, opensAt: new Date("2026-10-01T00:00:00Z") });
    const result = await sweepCycle("c1", new Date("2026-10-10T00:00:00Z"));
    expect(result.ran).toBe(false);
    expect(db.application.findMany).not.toHaveBeenCalled();
  });

  it("stops without finalizing anything when the deadline was extended after the round was first read", async () => {
    const opensAt = new Date("2026-10-01T00:00:00Z");
    // First read (top of the sweep): closed. Second read (inside the draft's transaction): extended.
    repo.findCycleById
      .mockResolvedValueOnce({ id: "c1", opensAt, closesAt: CLOSES })
      .mockResolvedValueOnce({ id: "c1", opensAt, closesAt: new Date("2026-10-24T04:59:00Z") });
    db.application.findMany.mockResolvedValue([draft("a1"), draft("a2")]);

    const result = await sweepCycle("c1", NOW);

    expect(result).toMatchObject({ ran: true, reopened: true, submitted: 0 });
    expect(db.$transaction).toHaveBeenCalledTimes(1); // it stopped at the first draft
    // the round row is share-locked before the deadline is read again
    expect(db.$executeRaw).toHaveBeenCalled();
  });
});

describe("getApplicantStatus", () => {
  const opensAt = new Date("2026-10-01T00:00:00Z");
  const cycle = (id: string, closesAt: Date) => ({ id, name: `Round ${id}`, slug: id, opensAt, closesAt });
  const app = (cycleId: string) => ({
    id: `app-${cycleId}`,
    cycleId,
    state: "SUBMITTED",
    submittedAt: new Date("2026-10-10T00:00:00Z"),
    autoSubmitted: false,
    draftStep: null,
    fullName: "Ada",
    email: "ada@example.com",
    eid: "al1",
    gradYear: 2028,
    major: "Math",
    resumeUrl: null,
    genericAnswers: {},
    tracks: [],
  });

  beforeEach(() => {
    repo.findTrackConfigs.mockResolvedValue([]);
  });

  it("shows the application in the active round when there is one", async () => {
    repo.findActiveCycle.mockResolvedValue(cycle("r2", new Date("2027-03-01T00:00:00Z")));
    repo.findApplicationByUser.mockResolvedValue(app("r2"));
    const view = await getApplicantStatus("u1", NOW);
    expect(view.application?.id).toBe("app-r2");
    expect(repo.findLatestSubmittedApplicationByUser).not.toHaveBeenCalled();
  });

  it("falls back to the latest submitted application once their round is no longer the active one", async () => {
    repo.findActiveCycle.mockResolvedValue(cycle("r2", new Date("2027-03-01T00:00:00Z"))); // a newer round they didn't apply to
    repo.findApplicationByUser.mockResolvedValue(null);
    repo.findLatestSubmittedApplicationByUser.mockResolvedValue(app("r1"));
    repo.findCycleById.mockResolvedValue(cycle("r1", CLOSES));
    const view = await getApplicantStatus("u1", NOW);
    expect(view.application?.id).toBe("app-r1");
    expect(view.round?.id).toBe("r1");
  });

  it("falls back when no round is active at all", async () => {
    repo.findActiveCycle.mockResolvedValue(null);
    repo.findLatestSubmittedApplicationByUser.mockResolvedValue(app("r1"));
    repo.findCycleById.mockResolvedValue(cycle("r1", CLOSES));
    expect((await getApplicantStatus("u1", NOW)).application?.id).toBe("app-r1");
  });

  it("has nothing to show for someone who never applied", async () => {
    repo.findActiveCycle.mockResolvedValue(cycle("r2", new Date("2027-03-01T00:00:00Z")));
    repo.findApplicationByUser.mockResolvedValue(null);
    repo.findLatestSubmittedApplicationByUser.mockResolvedValue(null);
    expect((await getApplicantStatus("u1", NOW)).application).toBeNull();
  });

  it("only offers a booking link that is a clean https URL", async () => {
    const withTrack = (url: string) => ({
      ...app("r1"),
      tracks: [{ track: tracks.find((t) => t.interviewRequired)!.key, status: "INTERVIEW", answers: {} }],
      _url: url,
    });
    repo.findActiveCycle.mockResolvedValue(cycle("r1", CLOSES));
    for (const [url, expected] of [["https://calendar.app.google/x", "https://calendar.app.google/x"], ["javascript:alert(1)", null], ["http://calendar.example.com/x", null]] as const) {
      repo.findApplicationByUser.mockResolvedValue(withTrack(url));
      repo.findTrackConfigs.mockResolvedValue([{ track: tracks.find((t) => t.interviewRequired)!.key, schedulingUrl: url }]);
      expect((await getApplicantStatus("u1", NOW)).application?.tracks[0].bookingUrl).toBe(expected);
    }
  });
});
