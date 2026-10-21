import { trackQuestions, tracks } from "@/schemas/recruiting.schema";

/** Key of the stand-in team added by `addNoInterviewTeam` */
export const NO_INTERVIEW_TEAM = "test-no-interview";

/**
 * Tests only: every shipped team interviews and has required questions, so add one that doesn't (and
 * asks nothing) to the shared lists. Mutates the module's arrays, which vitest isolates per test file.
 */
export function addNoInterviewTeam() {
  const list = tracks as unknown as { key: string; label: string; blurb: string; interviewRequired: boolean }[];
  if (list.some((t) => t.key === NO_INTERVIEW_TEAM)) return;
  list.push({
    key: NO_INTERVIEW_TEAM,
    label: "Test team (no interview)",
    blurb: "A stand-in for tests.",
    interviewRequired: false,
  });
  (trackQuestions as unknown as Record<string, unknown[]>)[NO_INTERVIEW_TEAM] = [];
}
