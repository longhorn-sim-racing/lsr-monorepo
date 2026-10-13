/**
 * What every question in Jack's test set shares: the types and the helpers that work out right answers.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { JackRoomPersonaKey } from "../../src/lib/jack/types";
import { mentionsNumber, plain } from "../../src/server/jack/eval-support";

export const TZ = "America/Chicago";

export type ToolPart = import("../../src/lib/jack/parts").JackToolPart;

/** What a reply came back with */
export type Answer = { text: string; parts: ToolPart[] };

/** What a right answer looks like. `check` returns null for a pass, or why it failed */
export type Expectation = {
  expected: string;
  check: (answer: Answer) => string | null;
  /** For --dry-run: a reply that should pass (no tool calls) */
  fakeAnswer?: string;
  /** Needs a real model to fill in a tool's input; skipped in --dry-run */
  needsModel?: boolean;
  /** A check against the database after the reply (e.g. the draft it made) */
  verify?: () => Promise<string | null>;
  /** What the database says, in a few lines, for the judge to check the answer against */
  facts?: string;
  /** No script check: only the judge grades it (so --dry-run doesn't expect the check to fail a non-answer) */
  judgeOnly?: boolean;
};

/** The kinds of question, from everyday lookups to things Jack must refuse */
export type Group = "everyday" | "analysis" | "vague" | "refuse" | "unknown" | "safety" | "heavy" | "draft" | "followup";

/** An earlier exchange already in the room, for follow-up questions */
export type Exchange = { ask: string; answer: string };

export type Question = {
  id: string;
  /** Defaults to everyday */
  group?: Group;
  ask: string | ((ctx: EvalContext) => string);
  /** The right answer, from the database. Null skips the question (nothing to ask about) */
  truth: (ctx: EvalContext) => Promise<Expectation | null>;
  /** What a good answer does, in a sentence or two: the judge grades against it. Defaults by group */
  expect?: string;
  /** Exchanges already in the room before this question (follow-ups) */
  before?: (ctx: EvalContext) => Promise<Exchange[] | null>;
  /** Tools this question must not call */
  forbid?: string[];
  /**
   * Runs before the reply (to snapshot what it must not change or reveal) and returns the check to run
   * after it: null passes, a string says what went wrong
   */
  guard?: (ctx: EvalContext) => Promise<(answer: Answer, toolResults: string[]) => Promise<string | null>>;
};

export type EvalContext = {
  prisma: typeof import("../../src/server/db").prisma;
  now: Date;
  persona: JackRoomPersonaKey;
  officer: { id: string; displayName: string };
  startedAt: Date;
  lsc: Awaited<ReturnType<typeof loadLsc>>;
};

// ---------------------------------------------------------------------------
// checks (the matching itself is in src/server/jack/eval-support.ts, with tests)
// ---------------------------------------------------------------------------

export const includesAll = (text: string, needles: string[]) => needles.filter((n) => !text.toLowerCase().includes(n.toLowerCase()));

/** A count, which has to sit next to one of `nouns` (word starts) unless it's the only number in the answer */
export function number(n: number, what: string, nouns: string[]): Pick<Expectation, "expected" | "check" | "fakeAnswer"> {
  return {
    expected: `${n} ${what}`,
    check: ({ text }) => (mentionsNumber(text, n, nouns) ? null : `doesn't say ${n} ${what}`),
    fakeAnswer: `There are ${n} ${what}.`,
  };
}

/** "Mon, Oct 19" style mentions of an instant's Central Time date, in any of the usual spellings */
export function mentionsDate(text: string, at: Date): boolean {
  const t = plain(text);
  return [formatInTimeZone(at, TZ, "MMM d"), formatInTimeZone(at, TZ, "MMMM d"), formatInTimeZone(at, TZ, "M/d")].some((form) =>
    new RegExp(`${form.replace(/\//g, "\\/")}(?!\\d)`, "i").test(t)
  );
}

export const PEOPLE = ["people", "person", "member", "officer", "user", "driver", "account", "checkout", "attendee"];

// ---------------------------------------------------------------------------
// ground truth helpers
// ---------------------------------------------------------------------------

export async function loadLsc(prisma: EvalContext["prisma"], now: Date) {
  const { getOpenLeagueSeason, listSeasonEntrants } = await import("../../src/server/services/league-entry.service");
  const league = await prisma.league.findUnique({ where: { slug: "lone-star-cup" } });
  if (!league) return null;
  const season = await getOpenLeagueSeason(league.id, now);
  if (!season) return null;
  const roster = await listSeasonEntrants(season.id);
  return { league, season, entrants: roster?.entrants ?? [] };
}

export function chicagoMonthStart(now: Date): Date {
  return fromZonedTime(`${formatInTimeZone(now, TZ, "yyyy-MM")}-01T00:00:00`, TZ);
}

/** The Friday after today, at 7 PM Central (what "next Friday" means here) */
export function nextFriday7pm(now: Date): Date {
  let day = new Date(now.getTime() + 86_400_000);
  while (formatInTimeZone(day, TZ, "EEE") !== "Fri") day = new Date(day.getTime() + 86_400_000);
  return fromZonedTime(`${formatInTimeZone(day, TZ, "yyyy-MM-dd")}T19:00:00`, TZ);
}

/** What a payment was for: its product, or for an event fee (no product) the event in its metadata */
export function purchaseKey(payment: { productId: string | null; metadata: unknown }): string {
  if (payment.productId) return `product:${payment.productId}`;
  const eventId = (payment.metadata as Record<string, unknown> | null)?.eventId;
  return `event:${typeof eventId === "string" ? eventId : "unknown"}`;
}
