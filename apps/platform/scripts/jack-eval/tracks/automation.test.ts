import { describe, expect, it, vi } from "vitest";
import type { Answer, EvalContext, GuardContext, Question, ToolPart } from "../shared";

// The tools are imported for real (their input schemas check the dry run's calls); nothing touches a database
vi.mock("@/server/db", () => ({ prisma: {} }));
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }));

import { findJackTool } from "../../../src/server/jack/tools";
import { guardsOf } from "../checks";
import { digestFixture, digestSummaryProblem, QUESTIONS, statedNumbers } from "./automation";

const NOW = new Date("2026-10-26T17:00:00Z");
const OFFICER = { id: "officer-1", displayName: "Dylan", handle: "dylan" };
const NON_ANSWER: Answer = { text: "Here's what I have.", parts: [] };
const byId = (id: string): Question => QUESTIONS.find((q) => q.id === id)!;
const part = (name: string): ToolPart => ({ id: `t-${name}`, name, label: name, status: "done", at: 0, input: {}, displays: [] });

function context(prisma: Record<string, unknown>): GuardContext {
  return { prisma: prisma as unknown as EvalContext["prisma"], now: NOW, persona: "jack", officer: OFFICER, startedAt: NOW, lsc: null, roomId: "jack-eval-auto-room" };
}

describe("the automation track's questions", () => {
  it("are the proposal, a recurring question's run and the digest's summary, the last two asked as scheduled notes", () => {
    expect(QUESTIONS.map((q) => [q.id, q.group, Boolean(q.scheduled)])).toEqual([
      ["propose-recurring-new-accounts", "propose", false],
      ["recurring-run-new-accounts", "everyday", true],
      ["digest-summary-factual", "analysis", true],
    ]);
    for (const question of QUESTIONS) expect(guardsOf(question).length, question.id).toBeGreaterThanOrEqual(1);
  });

  it("make dry-run calls the real tools accept", async () => {
    const truth = await byId("propose-recurring-new-accounts").truth(context({}));
    for (const call of truth!.fakeCalls ?? []) {
      const tool = findJackTool(call.name);
      expect(tool, call.name).toBeDefined();
      expect(tool!.input.safeParse(call.input).success, call.name).toBe(true);
    }
  });

  it("ask the recurring question as its note, with last week's answer before it", async () => {
    const question = byId("recurring-run-new-accounts");
    const ctx = context({});
    expect(typeof question.ask === "function" ? question.ask(ctx) : question.ask).toBe("Recurring question “Weekly new accounts” (set up by Dylan): How many new accounts were made on the site in the last 7 days?");
    expect(await question.before!(ctx)).toEqual([{ ask: expect.stringMatching(/^Recurring question “Weekly new accounts”/), answer: "9 new accounts were made in the last 7 days." }]);
  });

  it("grade the run by the week's new accounts, any fair reading of it", async () => {
    const count = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(3).mockResolvedValueOnce(4);
    const truth = (await byId("recurring-run-new-accounts").truth(context({ user: { count } })))!;
    expect(truth.expected).toBe("4 new accounts (or 3, by whole days or sign-up date)");
    expect(truth.check({ text: "3 new accounts this week, down from 9.", parts: [] })).toBeNull();
    expect(truth.check(NON_ANSWER)).not.toBeNull();
  });

  it("check the proposal asked for Mondays at 9", async () => {
    const guard = guardsOf(byId("propose-recurring-new-accounts"))[1];
    const payload = (schedule: unknown) => ({ jackProposal: { findMany: vi.fn().mockResolvedValue([{ kind: "recurring.upsert", status: "PENDING", payload: { schedule } }]) } });
    expect(await (await guard(context(payload({ every: "week", days: ["mon"], time: "09:00" }))))(NON_ANSWER, [])).toBeNull();
    expect(await (await guard(context(payload({ every: "day", time: "09:00" }))))(NON_ANSWER, [])).toMatch(/not Mondays at 09:00/);
  });
});

describe("the digest summary's check", () => {
  const digest = (() => {
    const question = byId("digest-summary-factual");
    return typeof question.ask === "function" ? question.ask(context({})) : question.ask;
  })();

  it("asks with the made-up week, which names no member", () => {
    expect(digest).toMatch(/^Weekly digest for Mon, Oct 26 \(set up by Dylan\): 9 things need attention → \/admin\n/);
    expect(digest).toContain("Officer A: 3 overdue");
    expect(digest).toMatch(/Jack: sum this up for the officers/);
    expect(digestFixture(NOW).outcomes).toHaveLength(5);
  });

  it("passes a summary that keeps to the digest, budget first", async () => {
    const truth = (await byId("digest-summary-factual").truth(context({})))!;
    expect(truth.fakeCalls).toEqual([]);
    expect(truth.check({ text: truth.fakeAnswer!, parts: [] })).toBeNull();
    expect(truth.check(NON_ANSWER)).not.toBeNull();
  });

  it("fails one that looks things up, adds numbers, links out, runs long, or skips the urgent item", () => {
    const ok = "Jack's budget is at $48.10 of $50. 5 action items are overdue.";
    expect(digestSummaryProblem({ text: ok, parts: [] }, digest)).toBeNull();
    expect(digestSummaryProblem({ text: ok, parts: [part("run_sql")] }, digest)).toMatch(/looked things up \(run_sql\)/);
    expect(digestSummaryProblem({ text: `${ok} 14 members signed up too.`, parts: [] }, digest)).toBe("states numbers the digest doesn't have: 14");
    expect(digestSummaryProblem({ text: `${ok} See https://example.com/x`, parts: [] }, digest)).toBe("links outside the console");
    expect(digestSummaryProblem({ text: `${ok} ${"More words here. ".repeat(60)}`, parts: [] }, digest)).toBe("is longer than a short summary");
    expect(digestSummaryProblem({ text: "5 action items are overdue.", parts: [] }, digest)).toMatch(/urgent item/);
  });

  it("reads the numbers an answer states, leaving dates and times out", () => {
    expect(statedNumbers("On Oct 24 at 9:00 AM, $48.10 of $50 and 1,200 views")).toEqual(["48.10", "50", "1200"]);
  });
});
