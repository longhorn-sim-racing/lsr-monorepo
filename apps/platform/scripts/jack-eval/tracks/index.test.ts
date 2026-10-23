import { describe, expect, it } from "vitest";
import { PROPOSE_TOOLS } from "../../../src/server/jack/proposals/types";
import { SLOT_TRACKS } from "../../../src/lib/slots";
import { BEHAVIOR } from "../behavior";
import { DESIGN } from "../design";
import { EVERYDAY } from "../everyday";
import { guardsOf } from "../checks";
import type { Question } from "../shared";
import { QUESTION_SLOTS, questionSet, TRACK_QUESTIONS, trackQuestions } from "./index";

const q = (id: string, extra: Partial<Question> = {}): Question => ({ id, ask: "?", truth: async () => null, ...extra });

describe("the track question slots", () => {
  it("have one slot per track, empty until each track adds its questions", () => {
    expect(Object.keys(QUESTION_SLOTS).sort()).toEqual([...SLOT_TRACKS].sort());
    expect(TRACK_QUESTIONS).toEqual(SLOT_TRACKS.flatMap((track) => QUESTION_SLOTS[track].map((question) => ({ ...question, track }))));
  });

  it("tag each question with its track, in track order", () => {
    const joined = trackQuestions({ automation: [q("digest-weekly")], "club-data": [q("search-knowledge")] });
    expect(joined.map((x) => [x.id, x.track])).toEqual([
      ["search-knowledge", "club-data"],
      ["digest-weekly", "automation"],
    ]);
  });

  it("throw when two tracks use the same id, or a slot isn't loaded (an import cycle)", () => {
    expect(() => trackQuestions({ memory: [q("save-a-fact")], documents: [q("save-a-fact")] })).toThrow('Duplicate eval question "save-a-fact": registered by memory and documents');
    expect(() => trackQuestions({ memory: undefined } as unknown as Parameters<typeof trackQuestions>[0])).toThrow("import cycle");
  });
});

describe("questionSet", () => {
  it("joins the core questions and the tracks', refusing a repeated or unusable id", () => {
    expect(questionSet([q("a")], [q("b", { track: "memory" })]).map((x) => x.id)).toEqual(["a", "b"]);
    expect(() => questionSet([q("lsc-paid")], [q("lsc-paid", { track: "club-data" })])).toThrow('Duplicate eval question "lsc-paid": in the core questions and club-data');
    expect(() => questionSet([q("Bad Id")])).toThrow("lowercase letters");
    expect(() => questionSet([q("a:b")])).toThrow("lowercase letters");
    expect(questionSet([q("paired-x@media")], [])).toHaveLength(1);
  });
});

describe("the core question set (2.0)", () => {
  const core = questionSet([...EVERYDAY, ...BEHAVIOR, ...DESIGN]);
  const byId = new Map(core.map((x) => [x.id, x]));

  it("loads with unique ids", () => {
    expect(byId.size).toBe(core.length);
  });

  it("drops the questions 2.0 makes wrong, and turns can't-send/publish into proposals", () => {
    for (const id of ["unknown-board-meeting", "unknown-instagram-followers", "refuse-email", "refuse-publish"]) expect(byId.has(id), id).toBe(false);
    for (const id of ["propose-email-lsc", "propose-publish-gm1"]) {
      const question = byId.get(id)!;
      expect(question.group).toBe("propose");
      expect(question.requires?.kinds?.length).toBeGreaterThan(0);
      expect(guardsOf(question).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("refusals forbid every propose_* tool and check no proposal was made", () => {
    const refusals = core.filter((x) => x.group === "refuse");
    expect(refusals.map((x) => x.id).sort()).toEqual(["refuse-change-fee", "refuse-delete", "refuse-make-admin", "refuse-refund"]);
    for (const refusal of refusals) {
      for (const tool of ["draft_event", ...PROPOSE_TOOLS]) expect(refusal.forbid, `${refusal.id} forbids ${tool}`).toContain(tool);
      expect(guardsOf(refusal).length, refusal.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("plants the injection case's application and checks the reply didn't act on it", () => {
    const injected = byId.get("safety-injected-text")!;
    expect(injected.plant).toBeTypeOf("function");
    expect(guardsOf(injected)).toHaveLength(1);
  });

  it("pairs one question across two departments", () => {
    const pair = core.filter((x) => x.pair === "paired-lsc-season");
    expect(pair.map((x) => x.id)).toEqual(["paired-lsc-season@competition", "paired-lsc-season@media"]);
    expect(pair.map((x) => x.as)).toEqual([{ department: "competition" }, { department: "media" }]);
  });
});
