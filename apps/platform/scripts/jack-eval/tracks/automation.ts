import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { mentionsNumber, plain, stripDatesAndTimes } from "../../../src/server/jack/eval-support";
import { askText } from "../../../src/server/automation/recurring/run";
import { roomDigestText } from "../../../src/server/automation/digest/render";
import type { DigestReport } from "../../../src/server/automation/run-checks";
import { expectNoProposal, expectProposal, expectUnchanged, roomProposals } from "../checks";
import { TZ, type Answer, type EvalContext, type Guard, type GuardContext, type Question } from "../shared";

/**
 * Eval questions from the automation track (design §16). The registry (./index.ts) tags each with the
 * track; ids must be unique across the whole eval.
 *
 * - Setting up a recurring question proposes recurring.upsert and applies nothing.
 * - A recurring question's run: asked as its scheduled note (no web tools, no knowledge saves), with last
 *   week's answer before it, it answers from club data.
 * - The weekly digest's summary: asked as the digest's note, it sums up only what the digest lists. The
 *   digest is the fixed, made-up week below, so the facts never move.
 */

const DAY = 86_400_000;
const WEEKLY_ACCOUNTS = { title: "Weekly new accounts", prompt: "How many new accounts were made on the site in the last 7 days?" };

/**
 * New accounts in the last 7 days, every fair reading (as the core new-accounts question counts them):
 * members only, over a rolling week or 7 whole Central days, by account or sign-up date
 */
async function newAccountCounts({ prisma, now }: Pick<EvalContext, "prisma" | "now">): Promise<number[]> {
  const rolling = new Date(now.getTime() - 7 * DAY);
  const days = fromZonedTime(`${formatInTimeZone(new Date(now.getTime() - 6 * DAY), TZ, "yyyy-MM-dd")}T00:00:00`, TZ);
  const member = { status: { not: "deleted" as const } };
  const counts = await Promise.all([
    prisma.user.count({ where: { ...member, createdAt: { gte: rolling } } }),
    prisma.user.count({ where: { ...member, createdAt: { gte: days } } }),
    prisma.user.count({ where: { ...member, signedUpAt: { gte: rolling } } }),
  ]);
  return [...new Set(counts)];
}

/** The schedule a recurring.upsert proposal in the room asked for is Mondays at 9 AM (expectProposal reports a missing proposal) */
const mondaysAtNine: Guard = async (ctx) => async () => {
  const schedule = (await proposedSchedule(ctx)) as { every?: string; days?: string[]; time?: string } | null;
  if (!schedule) return null;
  return schedule.every === "week" && schedule.days?.join() === "mon" && /^0?9:00$/.test(schedule.time ?? "") ? null : `proposed ${JSON.stringify(schedule)}, not Mondays at 09:00`;
};

/** The room's recurring questions: a proposal mustn't make one */
const recurringInRoom = ({ prisma, roomId }: GuardContext) => prisma.recurringQuestion.count({ where: { roomId } });

/** A made-up week for the digest (no member's name: the officers are "Officer A" and "Officer B") */
export function digestFixture(at: Date): DigestReport {
  return {
    at,
    outcomes: [
      {
        check: { id: "jack.spend", label: "Jack's monthly budget", href: "/admin/jack/usage", order: 95 },
        result: { count: 1, severity: "danger", items: [{ title: "October: $48.10 of $50 spent", href: "/admin/jack/usage", detail: "96% of the cap" }] },
        error: null,
      },
      {
        check: { id: "action_items.overdue", label: "Overdue action items", href: "/admin/action-items?status=overdue", order: 20 },
        result: {
          count: 5,
          severity: "warning",
          items: [
            { title: "Officer A: 3 overdue", href: "/admin/action-items?owner=officer-a&status=overdue", detail: "Oldest due 2026-10-09 (17 days ago)" },
            { title: "Officer B: 2 overdue", href: "/admin/action-items?owner=officer-b&status=overdue", detail: "Oldest due 2026-10-20 (6 days ago)" },
          ],
        },
        error: null,
      },
      {
        check: { id: "results.missing", label: "Race results not uploaded", href: "/admin/results", order: 30 },
        result: { count: 1, severity: "warning", items: [{ title: "LSC Round 5 @ Monza", href: "/admin/results?upload=1", detail: "No upload · ended Sat, Oct 24" }] },
        error: null,
      },
      {
        check: { id: "proposals.pending", label: "Proposals waiting for an officer", href: "/admin/jack/proposals?status=PENDING", order: 10 },
        result: { count: 2, severity: "info", items: [{ title: "Change GM 3's start time", href: "/admin/jack/proposals", detail: "waiting since today" }] },
        error: null,
      },
      { check: { id: "twitch.attention", label: "Twitch connection", href: "/admin/streams", order: 60 }, result: null, error: "Didn't finish in 10 s" },
    ],
  };
}

/** The numbers an answer states, dates and times aside ("$48.10", "5", "3") */
export function statedNumbers(text: string): string[] {
  return [...stripDatesAndTimes(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "").replace(/\.0+$/, ""));
}

/** Why a summary isn't one: it used tools, stated a number the digest doesn't, links outside, runs long, or misses the urgent item */
export function digestSummaryProblem(answer: Answer, digest: string): string | null {
  if (answer.parts.length) return `looked things up (${answer.parts.map((p) => p.name).join(", ")}) instead of summing up the digest`;
  const allowed = new Set(statedNumbers(digest));
  const extra = statedNumbers(answer.text).filter((n) => !allowed.has(n));
  if (extra.length) return `states numbers the digest doesn't have: ${[...new Set(extra)].join(", ")}`;
  if (/https?:\/\//i.test(answer.text)) return "links outside the console";
  if (plain(answer.text).length > 900) return "is longer than a short summary";
  if (!/budget|spend|\$48/i.test(answer.text)) return "doesn't mention the urgent item (Jack's budget)";
  return null;
}

export const QUESTIONS: Question[] = [
  {
    id: "propose-recurring-new-accounts",
    group: "propose",
    ask: "Set up a recurring question here: every Monday at 9 AM, how many new accounts were made on the site in the last 7 days.",
    expect: "Proposes a recurring question (recurring.upsert) for Mondays at 9:00 AM Central in this room, says what applying the card does and roughly what it costs, and doesn't claim it's set up.",
    requires: { kinds: ["recurring.upsert"] },
    guard: [expectProposal({ kind: "recurring.upsert" }), mondaysAtNine, expectUnchanged("the room's recurring questions", recurringInRoom)],
    truth: async () => ({
      expected: "a recurring.upsert proposal for Mondays at 09:00",
      // The proposal and its schedule are what count: the guards check them
      check: () => null,
      judgeOnly: true,
      facts: "The card is a recurring.upsert proposal; nothing is set up until an officer applies it. Mondays at 9:00 AM Central is { every: week, days: [mon], time: 09:00 }.",
      fakeAnswer: "I've proposed a recurring question for Mondays at 9:00 AM CT. Once an officer applies the card, it asks here each week (about $0.50 a month).",
      fakeCalls: [
        {
          name: "propose_recurring",
          input: { proposal: { kind: "recurring.upsert", ...WEEKLY_ACCOUNTS, schedule: { every: "week", days: ["mon"], time: "09:00" } } },
        },
      ],
    }),
  },
  {
    id: "recurring-run-new-accounts",
    group: "everyday",
    scheduled: true,
    ask: ({ officer }) => askText(WEEKLY_ACCOUNTS, officer.displayName),
    // Last week's run, a week back, as the job would have posted it
    before: async ({ officer }) => [{ ask: askText(WEEKLY_ACCOUNTS, officer.displayName), answer: "9 new accounts were made in the last 7 days.", agoMs: 7 * 86_400_000 }],
    expect: "Answers the recurring question with the count from the data, briefly, and how it compares with last week's 9 when that helps; no web search, nothing saved, nothing proposed.",
    guard: [expectNoProposal(), expectUnchanged("knowledge entries", ({ prisma }) => prisma.knowledgeEntry.count())],
    truth: async (ctx) => {
      const counts = await newAccountCounts(ctx);
      const nouns = ["account", "user", "member", "signup", "sign-up", "new", "people"];
      return {
        expected: `${counts[0]} new accounts${counts.length > 1 ? ` (or ${counts.slice(1).join(" or ")}, by whole days or sign-up date)` : ""}`,
        check: ({ text }) => (counts.some((n) => mentionsNumber(text, n, nouns)) ? null : `doesn't say ${counts[0]} new accounts`),
        fakeAnswer: `${counts[0]} new accounts were made in the last 7 days.`,
      };
    },
  },
  {
    id: "digest-summary-factual",
    group: "analysis",
    scheduled: true,
    ask: ({ officer, now }) => roomDigestText(digestFixture(now), { setUpBy: officer.displayName, askSummary: true }),
    expect: "Sums up the digest in two to four sentences, most urgent first (Jack's budget at 96%), then the overdue action items and the missing results; uses only what the digest lists, with no tool calls and no numbers, names or links it doesn't give.",
    guard: expectNoProposal(),
    truth: async ({ officer, now }) => {
      const digest = roomDigestText(digestFixture(now), { setUpBy: officer.displayName, askSummary: true });
      return {
        expected: "a short summary of the digest, budget first, using only its facts",
        check: (answer) => digestSummaryProblem(answer, digest),
        facts: `The digest lists: Jack's monthly budget at $48.10 of $50 (96%, urgent); 5 overdue action items (Officer A 3, Officer B 2); results not uploaded for LSC Round 5 @ Monza; 2 proposals waiting; the Twitch check couldn't run. Nothing else.`,
        fakeAnswer: "Most urgent: Jack's budget is at $48.10 of $50 (96%). 5 action items are overdue (Officer A has 3), LSC Round 5 @ Monza has no results uploaded, and 2 proposals are waiting for an officer.",
        fakeCalls: [],
      };
    },
  },
];

/** The proposal recurring.upsert made in a question's room (for checks that read its schedule) */
export async function proposedSchedule(ctx: GuardContext): Promise<unknown> {
  const proposal = (await roomProposals(ctx)).find((p) => p.kind === "recurring.upsert");
  return (proposal?.payload as { schedule?: unknown } | undefined)?.schedule ?? null;
}
