import { describe, expect, it } from "vitest";
import {
  draftPatchSchema,
  genericQuestions,
  parseAnswers,
  questionsForTrack,
  tracks,
  type GenericQuestion,
} from "@/schemas/recruiting.schema";
import {
  answersPayload,
  buildSteps,
  emptyFormState,
  formStateFromSaved,
  nextStepKey,
  parseGradYear,
  patchForStep,
  prevStepKey,
  questionsForStep,
  resolveStep,
  stepCompletion,
  teamLabel,
  toSnapshot,
  validateLinks,
  type FormState,
  type StepKey,
} from "./steps";

const ACCOUNT_EMAIL = "ada@account.test";
const firstTeam = tracks[0].key;
const secondTeam = tracks[1].key;

/** A valid answer for any question, whatever its type, so tests don't depend on the placeholder content. */
function validAnswer(q: GenericQuestion): unknown {
  switch (q.type) {
    case "short_text":
    case "long_text":
      return "A real answer";
    case "single_choice":
      return q.options[0];
    case "multi_choice":
      return [q.options[0]];
    case "link":
      return "https://example.com/work";
    case "scale":
      return q.min;
    case "yes_no":
      return true;
  }
}
const answerAll = (qs: readonly GenericQuestion[]) => Object.fromEntries(qs.map((q) => [q.id, validAnswer(q)]));

/** A complete application for the given teams. */
function completeState(teams: string[] = [firstTeam]): FormState {
  return {
    profile: { fullName: "Ada Lovelace", eid: "al123", gradYear: "2028", major: "Math" },
    genericAnswers: answerAll(genericQuestions),
    teams,
    trackAnswers: Object.fromEntries(teams.map((t) => [t, answerAll(questionsForTrack(t))])),
    resumeUrl: "https://example.com/resume.pdf",
  };
}

describe("buildSteps", () => {
  it("is four pages with no teams chosen: there are no general questions to ask", () => {
    expect(buildSteps([]).map((s) => s.key)).toEqual(["about", "teams", "links", "review"]);
  });

  it("adds a General questions page only when there are general questions", () => {
    expect(buildSteps([], true).map((s) => s.key)).toEqual(["about", "general", "teams", "links", "review"]);
    expect(buildSteps([], false).map((s) => s.key)).toEqual(["about", "teams", "links", "review"]);
  });

  it("adds one page per chosen team, between choosing and the resume", () => {
    const keys = buildSteps([firstTeam, secondTeam]).map((s) => s.key);
    expect(keys).toEqual(["about", "teams", `team:${firstTeam}`, `team:${secondTeam}`, "links", "review"]);
  });

  it("orders team pages as the teams are listed on the form, not in click order", () => {
    const keys = buildSteps([secondTeam, firstTeam]).map((s) => s.key);
    expect(keys.indexOf(`team:${firstTeam}`)).toBeLessThan(keys.indexOf(`team:${secondTeam}`));
  });

  it("ignores a team that isn't on the form", () => {
    expect(buildSteps(["not-a-team"]).map((s) => s.key)).toEqual(["about", "teams", "links", "review"]);
  });

  it("labels team pages with the team's name", () => {
    expect(buildSteps([firstTeam]).find((s) => s.key === `team:${firstTeam}`)?.label).toBe(tracks[0].label);
  });
});

describe("moving between pages", () => {
  const steps = buildSteps([firstTeam]);

  it("reopens at the saved page when it still exists", () => {
    expect(resolveStep("links", steps)).toBe("links");
    expect(resolveStep(`team:${firstTeam}`, steps)).toBe(`team:${firstTeam}`);
  });

  it("falls back to the first page for a missing, empty or stale step", () => {
    expect(resolveStep(null, steps)).toBe("about");
    expect(resolveStep(undefined, steps)).toBe("about");
    expect(resolveStep("nonsense", steps)).toBe("about");
    // the team was un-chosen after this step was saved
    expect(resolveStep(`team:${secondTeam}`, steps)).toBe("about");
  });

  it("steps forward and back, and stops at the ends", () => {
    expect(nextStepKey(steps, "about")).toBe("teams");
    expect(nextStepKey(steps, "review")).toBeNull();
    expect(prevStepKey(steps, "teams")).toBe("about");
    expect(prevStepKey(steps, "about")).toBeNull();
    expect(nextStepKey(steps, "team:gone" as StepKey)).toBeNull();
  });

  it("knows which questions a page asks", () => {
    expect(questionsForStep("general")).toBe(genericQuestions);
    expect(questionsForStep(`team:${firstTeam}`)).toEqual(questionsForTrack(firstTeam));
    expect(questionsForStep("about")).toEqual([]);
    expect(questionsForStep("review")).toEqual([]);
  });

  it("falls back to the key for a team that was removed from the form", () => {
    expect(teamLabel(firstTeam)).toBe(tracks[0].label);
    expect(teamLabel("retired")).toBe("retired");
  });
});

describe("parseGradYear", () => {
  it.each([
    ["2028", 2028],
    [" 2028 ", 2028],
    ["", null],
    ["   ", null],
    ["28", "invalid"],
    ["20288", "invalid"],
    ["abcd", "invalid"],
    ["1999", "invalid"],
    ["2101", "invalid"],
    ["2028.5", "invalid"],
  ])("%j -> %j", (input, expected) => {
    expect(parseGradYear(input)).toBe(expected);
  });
});

describe("answersPayload", () => {
  it("has an entry for every question, so a cleared answer is sent as null instead of being left behind", () => {
    const payload = answersPayload(genericQuestions, {});
    expect(Object.keys(payload)).toEqual(genericQuestions.map((q) => q.id));
    expect(Object.values(payload).every((v) => v === null)).toBe(true);
  });

  it("keeps real answers, including false, and nulls blanks", () => {
    const qs: GenericQuestion[] = [
      { id: "a", type: "short_text", label: "A", required: false },
      { id: "b", type: "yes_no", label: "B", required: false },
      { id: "c", type: "multi_choice", label: "C", options: ["x", "y"], required: false },
      { id: "d", type: "long_text", label: "D", required: false },
    ];
    expect(answersPayload(qs, { a: "hi", b: false, c: [], d: "   " })).toEqual({ a: "hi", b: false, c: null, d: null });
  });
});

describe("patchForStep: about you", () => {
  it("trims, drops blank fields, and turns the year into a number", () => {
    const state = { ...emptyFormState(), profile: { fullName: "  Ada  ", eid: "", gradYear: "2028", major: " Math " } };
    expect(patchForStep("about", state)).toEqual({ ok: true, patch: { step: "about", profile: { fullName: "Ada", major: "Math", gradYear: 2028 } } });
  });

  it("refuses an impossible year or over-long text, naming the field", () => {
    const bad = patchForStep("about", { ...emptyFormState(), profile: { fullName: "x".repeat(121), eid: "e".repeat(17), gradYear: "next year", major: "m".repeat(121) } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["profile.eid", "profile.fullName", "profile.gradYear", "profile.major"]);
  });

  it("allows saving an empty page (it's a draft)", () => {
    expect(patchForStep("about", emptyFormState())).toEqual({ ok: true, patch: { step: "about", profile: {} } });
  });
});

describe("patchForStep: questions", () => {
  it("sends the general answers for every question", () => {
    const state = completeState();
    const result = patchForStep("general", state);
    expect(result.ok && Object.keys(result.patch.genericAnswers as object)).toEqual(genericQuestions.map((q) => q.id));
  });

  it("sends a team's answers under that team only", () => {
    const state = completeState([firstTeam, secondTeam]);
    const result = patchForStep(`team:${firstTeam}`, state);
    expect(result.ok && Object.keys(result.patch.trackAnswers as object)).toEqual([firstTeam]);
  });

  it("refuses a page for a team that isn't chosen", () => {
    expect(patchForStep(`team:${secondTeam}`, completeState([firstTeam])).ok).toBe(false);
  });

  it("choosing teams and reviewing only record where the applicant is", () => {
    expect(patchForStep("teams", emptyFormState())).toEqual({ ok: true, patch: { step: "teams" } });
    expect(patchForStep("review", emptyFormState())).toEqual({ ok: true, patch: { step: "review" } });
  });
});

describe("links", () => {
  const withLinks = (resumeUrl: string) => ({ ...emptyFormState(), resumeUrl });

  it("accepts a clean resume link", () => {
    expect(validateLinks(withLinks("https://example.com/r.pdf"))).toEqual({});
  });

  it("allows a blank resume while drafting", () => {
    expect(validateLinks(withLinks(""))).toEqual({});
  });

  it.each([
    ["http link", "http://example.com/r.pdf"],
    ["no scheme", "example.com/r.pdf"],
    ["javascript:", "javascript:alert(1)"],
    ["credentials", "https://user:pw@example.com"],
    ["a space", "https://example.com/my resume.pdf"],
  ])("rejects a resume link with %s", (_name, url) => {
    expect(validateLinks(withLinks(url))).toHaveProperty("resumeUrl");
  });

  it("saves the trimmed resume link, and nothing else (there are no portfolio links)", () => {
    const state = withLinks("  https://example.com/r.pdf ");
    expect(patchForStep("links", state)).toEqual({ ok: true, patch: { step: "links", resumeUrl: "https://example.com/r.pdf" } });
  });

  it("won't save a bad link", () => {
    expect(patchForStep("links", withLinks("http://nope.test")).ok).toBe(false);
  });
});

describe("what the form sends is what the server accepts", () => {
  const steps = buildSteps([firstTeam, secondTeam]).map((s) => s.key);

  it.each(steps)("the %s page's payload passes the server's draft schema", (step) => {
    const result = patchForStep(step, completeState([firstTeam, secondTeam]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(draftPatchSchema.safeParse(result.patch).success).toBe(true);
  });

  it("an empty application's payloads pass too (nothing typed yet)", () => {
    for (const step of ["about", "general", "teams", "links", "review"] as StepKey[]) {
      const result = patchForStep(step, emptyFormState());
      expect(result.ok).toBe(true);
      if (result.ok) expect(draftPatchSchema.safeParse(result.patch).success).toBe(true);
    }
  });

  it("the answers it sends pass the server's per-question draft check", () => {
    const state = completeState([firstTeam]);
    const general = patchForStep("general", state);
    expect(general.ok).toBe(true);
    if (general.ok) {
      const parsed = parseAnswers(genericQuestions, general.patch.genericAnswers, "draft");
      expect(parsed.errors).toEqual({});
    }
    const team = patchForStep(`team:${firstTeam}`, state);
    expect(team.ok).toBe(true);
    if (team.ok) expect(parseAnswers(questionsForTrack(firstTeam), (team.patch.trackAnswers as Record<string, unknown>)[firstTeam], "draft").errors).toEqual({});
  });

  it("cleared answers are accepted too (null clears)", () => {
    const state = { ...completeState([firstTeam]), genericAnswers: {} };
    const result = patchForStep("general", state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(draftPatchSchema.safeParse(result.patch).success).toBe(true);
      expect(parseAnswers(genericQuestions, result.patch.genericAnswers, "draft").errors).toEqual({});
    }
  });
});

describe("completeness per page", () => {
  it("a finished application is complete on every page", () => {
    const { byStep, complete } = stepCompletion(completeState([firstTeam, secondTeam]), ACCOUNT_EMAIL);
    expect(complete).toBe(true);
    for (const step of buildSteps([firstTeam, secondTeam])) expect(byStep[step.key]?.complete, step.key).toBe(true);
  });

  it("an empty application is incomplete everywhere that asks for something, with reasons", () => {
    const { byStep, complete } = stepCompletion(emptyFormState(), ACCOUNT_EMAIL);
    expect(complete).toBe(false);
    for (const key of ["about", "teams", "links", "review"]) expect(byStep[key].complete, key).toBe(false);
    expect(byStep.teams.problems.join(" ")).toMatch(/at least one team/i);
    expect(byStep.links.problems.join(" ")).toMatch(/resume/i);
  });

  it("names the page that is missing something and leaves the others alone", () => {
    const state = completeState([firstTeam, secondTeam]);
    const required = genericQuestions.find((q) => q.required);
    if (!required) return; // the general set has no required question
    state.genericAnswers = { ...state.genericAnswers, [required.id]: "" };
    const { byStep, complete } = stepCompletion(state, ACCOUNT_EMAIL);
    expect(complete).toBe(false);
    expect(byStep.general.complete).toBe(false);
    expect(byStep.general.problems[0]).toMatch(/^Missing: /);
    expect(byStep.about.complete).toBe(true);
    expect(byStep.links.complete).toBe(true);
    expect(byStep.review.complete).toBe(false);
  });

  it("is all-or-nothing across teams: one unfinished team page blocks the review", () => {
    const state = completeState([firstTeam, secondTeam]);
    const requiredIn = (team: string) => questionsForTrack(team).find((q) => q.required);
    const teamWithRequired = [firstTeam, secondTeam].find((t) => requiredIn(t));
    if (!teamWithRequired) return; // no team has a required question
    state.trackAnswers[teamWithRequired] = {};
    const { byStep, complete } = stepCompletion(state, ACCOUNT_EMAIL);
    expect(complete).toBe(false);
    expect(byStep[`team:${teamWithRequired}`].complete).toBe(false);
    expect(byStep.review.complete).toBe(false);
  });

  it("only reports team pages for teams that are chosen", () => {
    const { byStep } = stepCompletion(completeState([firstTeam]), ACCOUNT_EMAIL);
    expect(byStep).toHaveProperty(`team:${firstTeam}`);
    expect(byStep).not.toHaveProperty(`team:${secondTeam}`);
  });

  it("treats a bad year or an http resume link as unfinished", () => {
    const badYear = { ...completeState(), profile: { ...completeState().profile, gradYear: "soon" } };
    expect(stepCompletion(badYear, ACCOUNT_EMAIL).byStep.about.complete).toBe(false);
    const http = { ...completeState(), resumeUrl: "http://example.com/r.pdf" };
    expect(stepCompletion(http, ACCOUNT_EMAIL).byStep.links.complete).toBe(false);
  });

  it("builds the snapshot the server's completeness check reads", () => {
    const snap = toSnapshot(completeState([firstTeam]), ACCOUNT_EMAIL);
    expect(snap).toMatchObject({ fullName: "Ada Lovelace", email: ACCOUNT_EMAIL, gradYear: 2028, resumeUrl: "https://example.com/resume.pdf" });
    expect(snap.tracks.map((t) => t.track)).toEqual([firstTeam]);
    expect(toSnapshot(emptyFormState(), ACCOUNT_EMAIL)).toMatchObject({ gradYear: null, resumeUrl: null, tracks: [] });
  });
});

describe("formStateFromSaved", () => {
  it("restores a saved draft into form state", () => {
    const state = formStateFromSaved({
      profile: { fullName: "A", eid: "abc1", gradYear: 2028, major: "CS" },
      resumeUrl: "https://example.com/r",
      genericAnswers: { a: "b" },
      tracks: [{ track: "media", answers: { q: "x" } }, { track: "team-b", answers: null }],
    });
    expect(state.profile.gradYear).toBe("2028");
    expect(state.teams).toEqual(["media", "team-b"]);
    expect(state.trackAnswers).toEqual({ "media": { q: "x" }, "team-b": {} });
  });

  it("turns an empty draft into empty strings", () => {
    const state = formStateFromSaved({ profile: { fullName: null, eid: null, gradYear: null, major: null }, resumeUrl: null, genericAnswers: null, tracks: [] });
    expect(state).toEqual(emptyFormState());
  });
});
