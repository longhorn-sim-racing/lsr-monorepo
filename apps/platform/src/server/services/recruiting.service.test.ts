import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  application: { findMany: vi.fn() },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
}));
const repo = vi.hoisted(() => ({ findCycleById: vi.fn() }));
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }));

vi.mock("@/server/db", () => ({ prisma: db }));
vi.mock("@/server/audit/log", () => audit);
vi.mock("@/server/repos/application.repo", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/repos/application.repo")>()), ...repo }));

import { questionsForTrack, tracks } from "@/schemas/recruiting.schema";
import { sweepCycle } from "./recruiting.service";

// Whatever team ships with nothing required, so the draft below counts as complete
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
