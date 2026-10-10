import { describe, expect, it } from "vitest";
import {
  FORM_VERSION,
  PLACEHOLDER_CONTENT,
  checkCompleteness,
  draftPatchSchema,
  genericQuestions,
  getTrack,
  httpsUrl,
  isSafeHttpsUrl,
  isTrackKey,
  parseAnswers,
  questionsForTrack,
  tracks,
  validateContent,
  type DraftSnapshot,
  type GenericQuestion,
  type RecruitingContent,
} from "./recruiting.schema";

// Importing the module already ran validateContent() on the shipped content, so a bad edit to the
// tracks or questions fails every test in this file at import time.

type Loose = Record<string, unknown>;
const q = (id: string, extra: Loose = {}) => ({ id, type: "short_text", label: "L", required: false, ...extra });
function content(overrides: Loose = {}): RecruitingContent {
  return {
    tracks: [{ key: "alpha", label: "Alpha", blurb: "", interviewRequired: true }],
    genericQuestions: [],
    trackQuestions: { alpha: [q("a_one")] },
    ...overrides,
  } as unknown as RecruitingContent;
}
const withTrackQuestions = (qs: Loose[]) => content({ trackQuestions: { alpha: qs } });

describe("validateContent", () => {
  it("accepts the shipped content", () => {
    expect(() => validateContent({ tracks, genericQuestions, trackQuestions: Object.fromEntries(tracks.map((t) => [t.key, questionsForTrack(t.key)])) })).not.toThrow();
  });

  it("allows exactly 5 questions and rejects 6", () => {
    const five = [1, 2, 3, 4, 5].map((n) => q(`a_${n}`));
    expect(() => validateContent(withTrackQuestions(five))).not.toThrow();
    expect(() => validateContent(withTrackQuestions([...five, q("a_6")]))).toThrow(/maximum is 5/);
  });

  it.each([
    ["a file question", q("a_f", { type: "file" })],
    ["a scale question", q("a_s", { type: "scale", min: 1, max: 5 })],
    ["a yes/no question", q("a_y", { type: "yes_no" })],
  ])("rejects %s from a team lead", (_name, question) => {
    expect(() => validateContent(withTrackQuestions([question]))).toThrow(/not allowed/);
  });

  it("allows scale and yes/no in the general set", () => {
    const c = content({ genericQuestions: [q("g_s", { type: "scale", min: 1, max: 5 }), q("g_y", { type: "yes_no" })] });
    expect(() => validateContent(c)).not.toThrow();
  });

  it.each([
    ["1 option", q("a_c", { type: "single_choice", options: ["only one"] }), /2 to 8 options/],
    ["9 options", q("a_c", { type: "multi_choice", options: Array.from({ length: 9 }, (_, i) => `o${i}`) }), /2 to 8 options/],
    ["a 101-character option", q("a_c", { type: "single_choice", options: ["ok", "x".repeat(101)] }), /each option/],
    ["duplicate options", q("a_c", { type: "single_choice", options: ["same", "same"] }), /unique/],
    ["a missing required flag", q("a_r", { required: undefined }), /required/],
    ["a bad id", q("Bad-Id"), /id must match/],
    ["a blank label", q("a_l", { label: "   " }), /label must be/],
  ])("rejects %s", (_name, question, message) => {
    expect(() => validateContent(withTrackQuestions([question]))).toThrow(message);
  });

  it("rejects an id reused across lists", () => {
    expect(() => validateContent(content({ genericQuestions: [q("dup")], trackQuestions: { alpha: [q("dup")] } }))).toThrow(/already used/);
  });

  it("rejects questions for an unknown team, and a team with no entry", () => {
    expect(() => validateContent(content({ trackQuestions: { alpha: [], ghost: [] } }))).toThrow(/no such track/);
    expect(() => validateContent(content({ trackQuestions: {} }))).toThrow(/no entry in trackQuestions/);
  });

  it("rejects a duplicate team key and a bad scale", () => {
    const dup = { key: "alpha", label: "Alpha", blurb: "", interviewRequired: true };
    expect(() => validateContent(content({ tracks: [dup, dup], trackQuestions: { alpha: [] } }))).toThrow(/duplicate key/);
    expect(() => validateContent(content({ genericQuestions: [q("g_s", { type: "scale", min: 5, max: 1 })] }))).toThrow(/min < max/);
  });

  it("reports every problem at once", () => {
    const bad = [1, 2, 3, 4, 5, 6].map((n) => q(`A-${n}`, { type: "file" }));
    const message = (() => {
      try {
        validateContent(withTrackQuestions(bad));
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    expect(message.split("\n").length - 1).toBeGreaterThanOrEqual(3);
  });
});

describe("links", () => {
  it.each([
    ["https://example.com/me.pdf", true],
    ["https://drive.google.com/file/d/abc/view?usp=sharing", true],
    ["http://example.com", false],
    ["//evil.com", false],
    ["javascript:alert(1)", false],
    ["https://user:pw@example.com", false],
    ["https://exa mple.com", false],
    ["https://example.com/\nx", false],
    ["https://localhost", false],
    ["ftp://example.com", false],
    ["not a url", false],
    ["", false],
  ])("isSafeHttpsUrl(%j) is %s", (url, expected) => {
    expect(isSafeHttpsUrl(url)).toBe(expected);
  });

  it("rejects links over 2000 characters", () => {
    expect(httpsUrl.safeParse("https://example.com/" + "a".repeat(2000)).success).toBe(false);
  });
});

describe("parseAnswers", () => {
  const sample: GenericQuestion[] = [
    { id: "txt", type: "short_text", label: "Short", required: true },
    { id: "long", type: "long_text", label: "Long", required: false },
    { id: "one", type: "single_choice", label: "One", options: ["A", "B"], required: true },
    { id: "many", type: "multi_choice", label: "Many", options: ["X", "Y", "Z"], required: false },
    { id: "lnk", type: "link", label: "Link", required: false },
    { id: "rate", type: "scale", label: "Rate", min: 1, max: 5, required: false },
    { id: "flag", type: "yes_no", label: "Flag", required: true },
  ];
  const errorsFor = (answers: unknown) => parseAnswers(sample, answers, "draft").errors;

  it("accepts empty answers in draft mode and reports required ones in submit mode", () => {
    const draft = parseAnswers(sample, {}, "draft");
    expect(draft.errors).toEqual({});
    expect(draft.missing).toEqual([]);
    expect(parseAnswers(sample, {}, "submit").missing).toEqual(["txt", "one", "flag"]);
  });

  it("trims text and treats false as an answer", () => {
    const r = parseAnswers(sample, { txt: "  hello  ", one: "A", flag: false, many: ["X", "Z"], rate: 3, lnk: "https://example.com" }, "submit");
    expect(r.errors).toEqual({});
    expect(r.missing).toEqual([]);
    expect(r.value.txt).toBe("hello");
    expect(r.value.flag).toBe(false);
  });

  it("treats whitespace-only text and empty selections as unanswered", () => {
    expect(parseAnswers(sample, { txt: "   ", one: "A", flag: true }, "submit").missing).toContain("txt");
    expect(parseAnswers(sample, { many: [] }, "submit").missing).not.toContain("many");
  });

  it("enforces text lengths at exactly 200 and 1500", () => {
    expect(errorsFor({ txt: "x".repeat(201) })).toHaveProperty("txt");
    expect(errorsFor({ txt: "x".repeat(200) })).not.toHaveProperty("txt");
    expect(errorsFor({ long: "x".repeat(1501) })).toHaveProperty("long");
    expect(errorsFor({ long: "x".repeat(1500) })).not.toHaveProperty("long");
  });

  it.each([
    ["an unknown question id", { zzz: "x" }, "zzz"],
    ["an unlisted single choice", { one: "C" }, "one"],
    ["an unlisted multi choice", { many: ["X", "Q"] }, "many"],
    ["duplicate multi choices", { many: ["X", "X"] }, "many"],
    ["an http link", { lnk: "http://example.com" }, "lnk"],
    ["a scale of 6", { rate: 6 }, "rate"],
    ["a scale of 0", { rate: 0 }, "rate"],
    ["a fractional scale", { rate: 2.5 }, "rate"],
    ["a scale sent as text (no silent coercion)", { rate: "3" }, "rate"],
    ["a yes/no sent as text", { flag: "yes" }, "flag"],
  ])("rejects %s", (_name, answers, key) => {
    expect(errorsFor(answers)).toHaveProperty(key);
  });

  it("requires an object, and treats null as empty", () => {
    expect(errorsFor(["x"])).toHaveProperty("_");
    expect(errorsFor(null)).toEqual({});
  });

  it("does not treat prototype keys specially", () => {
    expect(errorsFor(JSON.parse('{"constructor":"x","__proto__":"y"}'))).toHaveProperty("constructor");
  });
});

describe("draftPatchSchema", () => {
  const links = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `L${i}`, url: "https://example.com" }));

  it("accepts an empty patch and a partial profile", () => {
    expect(draftPatchSchema.safeParse({}).success).toBe(true);
    expect(draftPatchSchema.safeParse({ profile: { major: "CS" } }).success).toBe(true);
  });

  it("rejects fields a client must never set", () => {
    expect(draftPatchSchema.safeParse({ state: "SUBMITTED" }).success).toBe(false);
    expect(draftPatchSchema.safeParse({ userId: "x" }).success).toBe(false);
  });

  it("allows a blank resume link in a draft but not an http one", () => {
    expect(draftPatchSchema.safeParse({ resumeUrl: "" }).success).toBe(true);
    expect(draftPatchSchema.safeParse({ resumeUrl: "http://x.com/a" }).success).toBe(false);
  });

  it("allows 5 portfolio links and rejects 6", () => {
    expect(draftPatchSchema.safeParse({ portfolioLinks: links(5) }).success).toBe(true);
    expect(draftPatchSchema.safeParse({ portfolioLinks: links(6) }).success).toBe(false);
  });

  it("rejects an impossible graduation year", () => {
    expect(draftPatchSchema.safeParse({ profile: { gradYear: 1850 } }).success).toBe(false);
  });
});

describe("checkCompleteness", () => {
  const profile = { fullName: "Ada Lovelace", email: "ada@example.com", eid: "al123", gradYear: 2028, major: "Math" };
  const generic = { why_join: "Because.", sim_experience: 3 };
  const resume = "https://example.com/r.pdf";
  const draft = (over: Partial<DraftSnapshot> = {}): DraftSnapshot => ({
    ...profile,
    genericAnswers: generic,
    resumeUrl: resume,
    portfolioLinks: [],
    tracks: [{ track: "team-b", answers: {} }],
    ...over,
  });
  const incompleteKeys = (d: DraftSnapshot) => checkCompleteness(d).sections.filter((s) => !s.complete).map((s) => s.key);

  it("flags every section of an empty draft", () => {
    const report = checkCompleteness({ tracks: [] });
    expect(report.complete).toBe(false);
    expect(incompleteKeys({ tracks: [] })).toEqual(expect.arrayContaining(["profile", "general", "tracks", "links"]));
  });

  it("accepts a complete single-team draft", () => {
    expect(checkCompleteness(draft()).complete).toBe(true);
    expect(checkCompleteness(draft()).sections).toHaveLength(5);
  });

  it("accepts three complete teams", () => {
    const d = draft({
      tracks: [
        { track: "team-a", answers: { a_experience: "x" } },
        { track: "team-b", answers: {} },
        { track: "team-c", answers: { c_motivation: "x", c_hours: "4 to 6", c_link: "https://example.com" } },
      ],
    });
    expect(checkCompleteness(d).complete).toBe(true);
  });

  it("is all-or-nothing across teams: one incomplete team blocks everything", () => {
    const d = draft({ tracks: [{ track: "team-b", answers: {} }, { track: "team-a", answers: {} }] });
    expect(checkCompleteness(d).complete).toBe(false);
    expect(incompleteKeys(d)).toEqual(["track:team-a"]);
    expect(checkCompleteness(d).sections.find((s) => s.key === "track:team-a")?.problems[0]).toMatch(/^Missing: /);
  });

  it.each([
    ["an unknown team", { tracks: [{ track: "nope", answers: {} }] }],
    ["the same team twice", { tracks: [{ track: "team-b", answers: {} }, { track: "team-b", answers: {} }] }],
    ["an http resume link", { resumeUrl: "http://example.com/r.pdf" }],
    ["a missing graduation year", { gradYear: null }],
    ["an invalid email", { email: "not-an-email" }],
  ] as [string, Partial<DraftSnapshot>][])("blocks completion for %s", (_name, over) => {
    expect(checkCompleteness(draft(over)).complete).toBe(false);
  });
});

describe("lookups and shipped content", () => {
  it("knows real team keys and rejects junk", () => {
    expect(isTrackKey("team-a")).toBe(true);
    expect(isTrackKey("nope")).toBe(false);
    expect(isTrackKey(5)).toBe(false);
    expect(isTrackKey("__proto__")).toBe(false);
    expect(getTrack("team-a")?.interviewRequired).toBe(true);
    expect(getTrack("team-b")?.interviewRequired).toBe(false);
  });

  it("returns no questions for an unknown team", () => {
    expect(questionsForTrack("nope")).toEqual([]);
  });

  it("never exceeds 5 questions for any team", () => {
    for (const t of tracks) expect(questionsForTrack(t.key).length).toBeLessThanOrEqual(5);
  });

  it("keeps the launch gates visible: placeholder content must be replaced before launch", () => {
    // When the real teams are in, set PLACEHOLDER_CONTENT to false and update this expectation.
    expect(PLACEHOLDER_CONTENT).toBe(true);
    expect(FORM_VERSION).toBe(1);
  });
});
