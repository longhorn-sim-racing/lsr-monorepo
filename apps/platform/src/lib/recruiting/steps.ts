import {
  checkCompleteness,
  genericQuestions,
  getTrack,
  isBlank,
  isSafeHttpsUrl,
  questionsForTrack,
  RECRUITING_LIMITS,
  tracks,
  type DraftSnapshot,
  type GenericQuestion,
} from "@/schemas/recruiting.schema";

/**
 * The applicant form as a sequence of pages, and what each page saves. Pure functions (no React,
 * no network) so the exact payload each page sends can be tested against the server's schema.
 *
 *   About you > (General questions, if any) > Choose teams > one page per chosen team > Resume & links > Review
 */

export type StepKey = "about" | "general" | "teams" | `team:${string}` | "links" | "review";
export type Step = { key: StepKey; label: string };

export type FormState = {
  /** Text inputs, so a half-typed year is still a string */
  profile: { fullName: string; eid: string; gradYear: string; major: string };
  genericAnswers: Record<string, unknown>;
  teams: string[];
  trackAnswers: Record<string, Record<string, unknown>>;
  resumeUrl: string;
};

export function emptyFormState(): FormState {
  return {
    profile: { fullName: "", eid: "", gradYear: "", major: "" },
    genericAnswers: {},
    teams: [],
    trackAnswers: {},
    resumeUrl: "",
  };
}

const teamKeyOf = (step: StepKey) => (step.startsWith("team:") ? step.slice(5) : null);

/** The pages for the teams chosen so far, kept in the order teams are listed on the form (not click order). */
export function buildSteps(selectedTeams: readonly string[], hasGeneral: boolean = genericQuestions.length > 0): Step[] {
  const chosen = tracks.filter((t) => selectedTeams.includes(t.key));
  return [
    { key: "about", label: "About you" },
    // Only when there are general questions to ask (today there are none: the profile covers it)
    ...(hasGeneral ? [{ key: "general", label: "General questions" } satisfies Step] : []),
    { key: "teams", label: "Choose teams" },
    ...chosen.map((t): Step => ({ key: `team:${t.key}`, label: t.label })),
    { key: "links", label: "Resume" },
    { key: "review", label: "Review & submit" },
  ];
}

/** Where to open the form: the saved step if it still exists (e.g. its team is still chosen), else the first page. */
export function resolveStep(saved: string | null | undefined, steps: readonly Step[]): StepKey {
  return steps.find((s) => s.key === saved)?.key ?? steps[0].key;
}

export function nextStepKey(steps: readonly Step[], current: StepKey): StepKey | null {
  const i = steps.findIndex((s) => s.key === current);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1].key : null;
}

export function prevStepKey(steps: readonly Step[], current: StepKey): StepKey | null {
  const i = steps.findIndex((s) => s.key === current);
  return i > 0 ? steps[i - 1].key : null;
}

export function questionsForStep(step: StepKey): readonly GenericQuestion[] {
  if (step === "general") return genericQuestions;
  const team = teamKeyOf(step);
  return team ? questionsForTrack(team) : [];
}

/** "2027" -> 2027, "" -> null, anything else -> "invalid" */
export function parseGradYear(text: string): number | null | "invalid" {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d{4}$/.test(t)) return "invalid";
  const n = Number(t);
  return n >= 2000 && n <= 2100 ? n : "invalid";
}

/**
 * Every question gets an entry: its answer, or null when blank. Sending null (not omitting the key)
 * is what lets an applicant clear an answer they changed their mind about.
 */
export function answersPayload(questions: readonly GenericQuestion[], answers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(questions.map((q) => [q.id, isBlank(answers[q.id]) ? null : answers[q.id]]));
}

/** Problems with the resume link that would stop it being saved (keyed like the server's field errors). */
export function validateLinks(state: Pick<FormState, "resumeUrl">): Record<string, string> {
  const errors: Record<string, string> = {};
  const resume = state.resumeUrl.trim();
  if (resume !== "" && (!isSafeHttpsUrl(resume) || resume.length > RECRUITING_LIMITS.urlMax)) {
    errors.resumeUrl = "Enter a full link that starts with https://";
  }
  return errors;
}

export type StepPatch = { ok: true; patch: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/**
 * What "Save and continue" sends for a page, in the shape the server's draft schema accepts
 * (see draftPatchSchema). Pages that can't be saved as typed return the problems instead.
 * `teams` and `review` save nothing here: team choice goes through its own action.
 */
export function patchForStep(step: StepKey, state: FormState): StepPatch {
  switch (step) {
    case "about": {
      const errors: Record<string, string> = {};
      const profile: Record<string, unknown> = {};
      const { fullName, eid, gradYear, major } = state.profile;
      if (fullName.trim()) profile.fullName = fullName.trim();
      if (eid.trim()) profile.eid = eid.trim();
      if (major.trim()) profile.major = major.trim();
      const year = parseGradYear(gradYear);
      if (year === "invalid") errors["profile.gradYear"] = "Enter a four-digit year, like 2028.";
      else if (year !== null) profile.gradYear = year;
      if (fullName.trim().length > 120) errors["profile.fullName"] = "Keep it under 120 characters.";
      if (eid.trim().length > 16) errors["profile.eid"] = "A UT EID is at most 16 characters.";
      if (major.trim().length > 120) errors["profile.major"] = "Keep it under 120 characters.";
      return Object.keys(errors).length ? { ok: false, errors } : { ok: true, patch: { step, profile } };
    }
    case "general":
      return { ok: true, patch: { step, genericAnswers: answersPayload(genericQuestions, state.genericAnswers) } };
    case "links": {
      const errors = validateLinks(state);
      if (Object.keys(errors).length) return { ok: false, errors };
      return { ok: true, patch: { step, resumeUrl: state.resumeUrl.trim() } };
    }
    case "teams":
    case "review":
      return { ok: true, patch: { step } };
    default: {
      const team = teamKeyOf(step);
      if (!team || !state.teams.includes(team)) return { ok: false, errors: { _: "That team isn't part of your application." } };
      return { ok: true, patch: { step, trackAnswers: { [team]: answersPayload(questionsForTrack(team), state.trackAnswers[team] ?? {}) } } };
    }
  }
}

/** The form's state in the shape the completeness check reads (the same check the server runs on Submit). */
export function toSnapshot(state: FormState, accountEmail: string): DraftSnapshot {
  const year = parseGradYear(state.profile.gradYear);
  return {
    fullName: state.profile.fullName,
    email: accountEmail,
    eid: state.profile.eid,
    gradYear: typeof year === "number" ? year : null,
    major: state.profile.major,
    resumeUrl: state.resumeUrl.trim() || null,
    genericAnswers: state.genericAnswers,
    tracks: state.teams.map((team) => ({ track: team, answers: state.trackAnswers[team] ?? {} })),
  };
}

const STEP_OF_SECTION = (sectionKey: string): StepKey | null => {
  if (sectionKey === "profile") return "about";
  if (sectionKey === "general") return "general";
  if (sectionKey === "tracks") return "teams";
  if (sectionKey === "links") return "links";
  return sectionKey.startsWith("track:") ? (`team:${sectionKey.slice(6)}` as StepKey) : null;
};

export type StepCompletion = Record<string, { complete: boolean; problems: string[] }>;

/** For the progress list and the review checklist: which pages are done, and what is missing on the others. */
export function stepCompletion(state: FormState, accountEmail: string): { byStep: StepCompletion; complete: boolean } {
  const report = checkCompleteness(toSnapshot(state, accountEmail));
  const byStep: StepCompletion = {};
  for (const section of report.sections) {
    const step = STEP_OF_SECTION(section.key);
    if (step) byStep[step] = { complete: section.complete, problems: section.problems };
  }
  byStep.review = { complete: report.complete, problems: report.complete ? [] : ["Finish the pages marked above."] };
  return { byStep, complete: report.complete };
}

/** Team label for the nav and headings; falls back to the key for a team removed from the form. */
export const teamLabel = (key: string) => getTrack(key)?.label ?? key;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Turns what the server saved back into form state, so the form reopens where it was left. */
export function formStateFromSaved(saved: {
  profile: { fullName: string | null; eid: string | null; gradYear: number | null; major: string | null };
  resumeUrl: string | null;
  genericAnswers: unknown;
  tracks: Array<{ track: string; answers: unknown }>;
}): FormState {
  return {
    profile: {
      fullName: saved.profile.fullName ?? "",
      eid: saved.profile.eid ?? "",
      gradYear: saved.profile.gradYear === null ? "" : String(saved.profile.gradYear),
      major: saved.profile.major ?? "",
    },
    genericAnswers: asRecord(saved.genericAnswers),
    teams: saved.tracks.map((t) => t.track),
    trackAnswers: Object.fromEntries(saved.tracks.map((t) => [t.track, asRecord(t.answers)])),
    resumeUrl: saved.resumeUrl ?? "",
  };
}
