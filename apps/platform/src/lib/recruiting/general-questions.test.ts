import { describe, expect, it, vi } from "vitest";

// The shipped content has no general questions (see recruiting.schema.ts), so the code paths that
// handle them would go untested. This file pretends a general set exists, to keep them working
// for the day one is added. (Only the exported list is replaced; the schema's own completeness
// check still sees the real, empty set, so completeness is not covered here.)
vi.mock("@/schemas/recruiting.schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/schemas/recruiting.schema")>()),
  genericQuestions: [
    { id: "why_join", type: "long_text", label: "Why do you want to join?", required: true },
    { id: "sim_experience", type: "scale", label: "How much sim racing experience do you have?", min: 1, max: 5, required: false },
  ],
}));

import { genericQuestions, tracks } from "@/schemas/recruiting.schema";
import { buildExportCsv, type ExportRow } from "./export";
import { buildSteps, emptyFormState, nextStepKey, patchForStep, questionsForStep } from "./steps";

describe("when general questions exist", () => {
  it("the form gets a General questions page between About you and Choose teams", () => {
    expect(buildSteps([]).map((s) => s.key)).toEqual(["about", "general", "teams", "links", "review"]);
    const steps = buildSteps([]);
    expect(nextStepKey(steps, "about")).toBe("general");
    expect(nextStepKey(steps, "general")).toBe("teams");
  });

  it("that page asks, and saves, exactly those questions", () => {
    expect(questionsForStep("general")).toBe(genericQuestions);
    const state = { ...emptyFormState(), genericAnswers: { why_join: "Love racing", sim_experience: 4 } };
    const result = patchForStep("general", state);
    expect(result).toEqual({ ok: true, patch: { step: "general", genericAnswers: { why_join: "Love racing", sim_experience: 4 } } });
  });

  it("a cleared general answer is sent as null so it is cleared on the server", () => {
    const result = patchForStep("general", { ...emptyFormState(), genericAnswers: { why_join: "   " } });
    expect(result.ok && result.patch.genericAnswers).toEqual({ why_join: null, sim_experience: null });
  });

  it("the export gets a column per general question and repeats the answers on each of an applicant's rows", () => {
    const row = (track: string): ExportRow => ({
      applicationId: "app-1",
      email: "ada@account.test",
      fullName: "Ada",
      eid: "al123",
      gradYear: 2028,
      major: "Math",
      track,
      status: "IN_REVIEW",
      submittedAt: new Date("2026-11-15T18:30:00Z"),
      autoSubmitted: false,
      reviewCount: 0,
      averageScore: null,
      resumeUrl: null,
      genericAnswers: { why_join: "=1+1", sim_experience: 4 },
      trackAnswers: {},
    });
    const csv = buildExportCsv([row(tracks[0].key), row(tracks[1].key)], { adminBaseUrl: "https://example.org/" });
    const [header, first, second] = csv.trim().split(/\r?\n/);
    expect(header).toContain("Why do you want to join?");
    expect(header).toContain("How much sim racing experience do you have?");
    // formulas typed by an applicant are neutralized, and both rows carry the same general answers
    expect(first).toContain("'=1+1");
    expect(second).toContain("'=1+1");
  });
});
