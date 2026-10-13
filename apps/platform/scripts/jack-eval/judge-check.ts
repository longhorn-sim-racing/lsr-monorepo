/**
 * Checks the judge before trusting it: one right answer and three wrong ones (empty, "I don't know",
 * a confident wrong number) to the same question. The right one should pass and the rest fail. Four
 * Opus calls, a few cents.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-eval/judge-check.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { judgeAnswer, type JudgeInput } from "./judge";

// apps/platform's env files, like the eval itself (without overriding the environment)
for (const file of [".env.local", ".env"]) {
  const path = resolve(__dirname, "..", "..", file);
  if (!existsSync(path)) continue;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY isn't set.");
  process.exit(1);
}

const base: Omit<JudgeInput, "answer" | "tools"> = {
  question: "How many user accounts are on the site in total?",
  expect: "Gives the right answer (see the facts), says where it came from, and leads with it.",
  facts: "The right answer: 108 user accounts.",
};
const lookup = { name: "club_members", input: { count_only: true }, result: '{"total":108}' };

const cases: { label: string; shouldPass: boolean; input: JudgeInput }[] = [
  { label: "right answer", shouldPass: true, input: { ...base, tools: [lookup], answer: "There are 108 user accounts on the site (club_members)." } },
  { label: "empty", shouldPass: false, input: { ...base, tools: [lookup], answer: "" } },
  { label: "I don't know", shouldPass: false, input: { ...base, tools: [], answer: "I don't know." } },
  { label: "confident and wrong", shouldPass: false, input: { ...base, tools: [lookup], answer: "There are 64 user accounts on the site." } },
];

async function main() {
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  let wrong = 0;
  for (const c of cases) {
    const { grade } = await judgeAnswer(client, c.input);
    const passed = grade.meets_expectation && grade.facts_correct !== "no" && grade.no_invention;
    if (passed !== c.shouldPass) wrong++;
    console.log(`${passed === c.shouldPass ? "ok  " : "BAD "} ${c.label.padEnd(20)} judged ${passed ? "pass" : "fail"}: ${grade.explanation}`);
  }
  console.log(wrong ? `\n${wrong} of ${cases.length} judged the wrong way.` : `\nAll ${cases.length} judged the right way.`);
  if (wrong) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
