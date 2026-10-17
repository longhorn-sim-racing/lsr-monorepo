import { describe, expect, it } from "vitest";
import type { TrackStatus } from "@prisma/client";
import { expiredDraftCopy, teamStatusCopy } from "./status-copy";

const ALL: TrackStatus[] = ["SUBMITTED", "IN_REVIEW", "INTERVIEW", "ACCEPTED", "REJECTED"];
const opts = { interviewRequired: true, hasBookingUrl: false };

describe("teamStatusCopy", () => {
  it.each(ALL)("%s has a headline, an explanation, and a tone", (status) => {
    const copy = teamStatusCopy(status, opts);
    expect(copy.headline.length).toBeGreaterThan(0);
    expect(copy.detail.length).toBeGreaterThan(0);
    expect(["neutral", "progress", "good", "bad"]).toContain(copy.tone);
  });

  it("points an interview invitation at the booking button when there is one, and at email when there isn't", () => {
    expect(teamStatusCopy("INTERVIEW", { interviewRequired: true, hasBookingUrl: true }).detail).toMatch(/button/i);
    const noLink = teamStatusCopy("INTERVIEW", { interviewRequired: true, hasBookingUrl: false }).detail;
    expect(noLink).toMatch(/email/i);
    expect(noLink).not.toMatch(/button/i);
  });

  it("is gentle about a rejection and never says 'rejected' or promises anything", () => {
    const copy = teamStatusCopy("REJECTED", opts);
    expect(copy.headline).toBe("Not moving forward");
    expect(`${copy.headline} ${copy.detail}`).not.toMatch(/reject/i);
    expect(copy.tone).toBe("bad");
  });

  it("uses distinct headlines so the statuses can't be confused", () => {
    expect(new Set(ALL.map((s) => teamStatusCopy(s, opts).headline)).size).toBe(ALL.length);
  });
});

describe("expiredDraftCopy", () => {
  it("tells a complete draft it is being submitted for them", () => {
    expect(expiredDraftCopy(true).headline).toMatch(/being submitted/i);
  });

  it("tells an unfinished draft honestly that officers never saw it", () => {
    const copy = expiredDraftCopy(false);
    expect(copy.headline).toMatch(/not submitted/i);
    expect(copy.detail).toMatch(/officers have not seen it/i);
  });
});
