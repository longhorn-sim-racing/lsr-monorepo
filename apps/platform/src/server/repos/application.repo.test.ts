import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ prisma: {} }));

import { findSubmittedApplicationDetail, listSubmittedTracks, listSubmittedTracksForExport } from "./application.repo";

const OFFICER = "officer-1";

function trackRow(userId: string) {
  return {
    id: `track-${userId}`,
    track: "media",
    status: "IN_REVIEW",
    decidedAt: null,
    answers: {},
    reviews: [{ score: 5 }, { score: 3 }, { score: null }],
    application: {
      id: `app-${userId}`,
      userId,
      fullName: "Someone",
      eid: "ab1",
      gradYear: 2028,
      major: "CS",
      submittedAt: new Date("2026-10-20T00:00:00Z"),
      autoSubmitted: false,
      resumeUrl: null,
      genericAnswers: {},
      user: { email: `${userId}@test.dev` },
    },
  };
}

function fakeDb(rows: ReturnType<typeof trackRow>[]) {
  return {
    applicationTrack: { findMany: vi.fn().mockResolvedValue(rows), count: vi.fn().mockResolvedValue(rows.length) },
    application: { findFirst: vi.fn() },
  };
}

describe("listSubmittedTracks", () => {
  it("breaks ties on the id, so paging can't repeat or skip applicants who share a submit time", async () => {
    const db = fakeDb([]);
    await listSubmittedTracks({ cycleId: "c1", viewerId: null }, db as never);
    expect(db.applicationTrack.findMany.mock.calls[0][0].orderBy).toEqual([
      { application: { submittedAt: "asc" } },
      { track: "asc" },
      { id: "asc" },
    ]);
  });

  it("leaves the viewer's own reviews and scores out, and keeps everyone else's", async () => {
    const db = fakeDb([trackRow(OFFICER), trackRow("someone-else")]);
    const { rows } = await listSubmittedTracks({ cycleId: "c1", viewerId: OFFICER }, db as never);
    expect(rows[0]).toMatchObject({ reviewCount: 0, averageScore: null });
    expect(rows[1]).toMatchObject({ reviewCount: 3, averageScore: 4 });
  });

  it("shows reviews when no viewer is given", async () => {
    const db = fakeDb([trackRow(OFFICER)]);
    const { rows } = await listSubmittedTracks({ cycleId: "c1", viewerId: null }, db as never);
    expect(rows[0].reviewCount).toBe(3);
  });
});

describe("listSubmittedTracksForExport", () => {
  it("leaves the exporting officer's own scores out of the file", async () => {
    const db = fakeDb([trackRow(OFFICER), trackRow("someone-else")]);
    const rows = await listSubmittedTracksForExport({ cycleId: "c1", viewerId: OFFICER }, db as never);
    expect(rows[0]).toMatchObject({ reviewCount: 0, averageScore: null });
    expect(rows[1]).toMatchObject({ reviewCount: 3, averageScore: 4 });
    expect(db.applicationTrack.findMany.mock.calls[0][0].orderBy.at(-1)).toEqual({ id: "asc" });
  });
});

describe("findSubmittedApplicationDetail", () => {
  const detail = (userId: string) => ({
    id: "app-1",
    userId,
    tracks: [{ id: "t1", reviews: [{ id: "r1", score: 4, notes: "strong", reviewer: { id: "o2", displayName: "Other" } }], emails: [] }],
    emails: [],
  });

  it("hides what colleagues wrote from the applicant who is also an officer", async () => {
    const db = fakeDb([]);
    db.application.findFirst.mockResolvedValue(detail(OFFICER));
    const app = await findSubmittedApplicationDetail("app-1", OFFICER, db as never);
    expect(app?.tracks[0].reviews).toEqual([]);
  });

  it("shows the reviews to any other officer", async () => {
    const db = fakeDb([]);
    db.application.findFirst.mockResolvedValue(detail("applicant"));
    const app = await findSubmittedApplicationDetail("app-1", OFFICER, db as never);
    expect(app?.tracks[0].reviews).toHaveLength(1);
  });

  it("returns null for a draft or unknown id", async () => {
    const db = fakeDb([]);
    db.application.findFirst.mockResolvedValue(null);
    expect(await findSubmittedApplicationDetail("nope", OFFICER, db as never)).toBeNull();
  });
});
