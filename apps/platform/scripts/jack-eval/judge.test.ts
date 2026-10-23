import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { judgeAnswer, judgePair, judgeSystem, judgeTools, pairPrompt, type PairGrade } from "./judge";

const tools = judgeTools(
  [
    { name: "club_members", description: "Lists the club's members. Use it for rosters." },
    { name: "draft_event", description: "Creates a draft event.", writes: true },
    { name: "propose_change", description: "Proposes a change to an event or a page! An officer applies it." },
    { name: "deck_write", description: "Writes slides.", design: true },
    { name: "stripe_overview", description: "Balance and payouts.", deferred: true },
  ],
  ["propose_change", "propose_content"]
);

describe("judgeSystem", () => {
  it("lists every live tool with the first sentence of its description and what kind of tool it is", () => {
    const system = judgeSystem(tools);
    expect(system).toContain("- club_members: Lists the club's members.\n");
    expect(system).not.toContain("Use it for rosters");
    expect(system).toContain("- draft_event (creates drafts): Creates a draft event.");
    expect(system).toContain("- propose_change (proposes a change for an officer to apply): Proposes a change to an event or a page!");
    expect(system).toContain("- stripe_overview (loaded on demand): Balance and payouts.");
    expect(system).toContain("judge the design against the expectation");
  });

  it("names no tool that isn't in the list it's given", () => {
    const system = judgeSystem([{ name: "search", description: "Searches everything." }]);
    for (const name of ["club_members", "run_sql", "describe_schema", "draft_event", "chart", "deck_", "propose_"]) expect(system).not.toContain(name);
    // Without deck tools it doesn't talk about grading slides
    expect(system).not.toContain("slides as they render");
    expect(judgeSystem([])).toContain("(not given; see its instructions)");
  });

  it("tells the judge a proposal isn't a change", () => {
    expect(judgeSystem(tools)).toContain("nothing changes until an officer reviews it and presses Apply");
  });
});

/** A fake Anthropic client: create() returns each message in turn */
function fakeClient(...messages: { stop_reason: string; text?: string; model?: string }[]) {
  const create = vi.fn();
  for (const m of messages) {
    create.mockResolvedValueOnce({
      model: m.model ?? "claude-opus-5-5",
      stop_reason: m.stop_reason,
      content: m.text ? [{ type: "text", text: m.text }] : [],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

const PAIR: PairGrade = { same_facts: true, no_added_background: false, explanation: "The media answer explains why entries dropped, which no tool said." };

describe("judgePair", () => {
  const input = {
    question: "How's the LSC going?",
    answers: [
      { asker: "Dylan (Competition)", answer: "12 entries.", tools: [{ name: "lsc_entries", input: {}, result: '{"entries":12}' }] },
      { asker: "Arav (Media)", answer: "12 entries; fewer because of midterms.", tools: [] },
    ],
    facts: "12 active entries.",
  };

  it("sends both answers with who asked and their tool calls, and reads the structured grade", async () => {
    const { client, create } = fakeClient({ stop_reason: "end_turn", text: JSON.stringify(PAIR) });
    const result = await judgePair(client, input);
    expect(result.grade).toEqual(PAIR);
    const params = create.mock.calls[0][0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config.format.schema.required).toEqual(["same_facts", "no_added_background", "explanation"]);
    const prompt = params.messages[0].content as string;
    expect(prompt).toContain('<answer number="1" asked_by="Dylan (Competition)">');
    expect(prompt).toContain("lsc_entries");
    expect(prompt).toContain("fewer because of midterms");
    expect(prompt).toContain("12 active entries.");
    expect(pairPrompt(input)).toBe(prompt);
  });

  it("falls back to the second judge when the first declines", async () => {
    const { client, create } = fakeClient({ stop_reason: "refusal" }, { stop_reason: "end_turn", text: JSON.stringify(PAIR), model: "claude-fable-5-1" });
    expect((await judgePair(client, input)).model).toBe("claude-fable-5-1");
    expect(create.mock.calls.map((c) => c[0].model)).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
  });
});

describe("judgeAnswer", () => {
  it("uses the system prompt it's given (the run's, from the live tools), before the cached instructions", async () => {
    const grade = { meets_expectation: true, facts_correct: "yes", no_invention: true, clear: true, tool_use: "good", tool_notes: "", tool_gap: "", explanation: "ok" };
    const { client, create } = fakeClient({ stop_reason: "end_turn", text: JSON.stringify(grade) });
    const system = judgeSystem(tools);
    await judgeAnswer(client, { question: "q", expect: "e", tools: [], answer: "a", instructions: "the prompt", system });
    const sent = create.mock.calls[0][0].system as { text: string; cache_control?: unknown }[];
    expect(sent[0].text).toBe(system);
    expect(sent[1]).toMatchObject({ text: "<assistant_instructions>\nthe prompt\n</assistant_instructions>", cache_control: { type: "ephemeral" } });
  });
});
