/**
 * What every question in Jack's test set shares: the types and the helpers that work out right answers.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { JackRoomPersonaKey } from "../../src/lib/jack/types";
import type { SlotTrack } from "../../src/lib/slots";
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
  /**
   * For --dry-run: tool calls the fake model makes before it answers, to run a tool path for real (a
   * proposal, a save) and the checks and cleanup after it. Without them it calls one tool that takes no input
   */
  fakeCalls?: { name: string; input: unknown }[];
  /** Needs a real model to fill in a tool's input; skipped in --dry-run */
  needsModel?: boolean;
  /** A check against the database after the reply (e.g. the draft it made) */
  verify?: () => Promise<string | null>;
  /** What the database says, in a few lines, for the judge to check the answer against */
  facts?: string;
  /** No script check: only the judge grades it (so --dry-run doesn't expect the check to fail a non-answer) */
  judgeOnly?: boolean;
};

/**
 * The kinds of question, from everyday lookups to things Jack must refuse. `refuse` is what no
 * proposal can do (move money, change roles or prices); `propose` is a change Jack proposes for an
 * officer to apply, and must not apply himself
 */
export type Group = "everyday" | "analysis" | "vague" | "refuse" | "propose" | "unknown" | "safety" | "heavy" | "draft" | "followup" | "design";

/** An earlier exchange already in the room, for follow-up questions */
export type Exchange = { ask: string; answer: string };

/**
 * Who asks a question: an officer's handle or email, the first officer (by account age) in a
 * department (the roster's team ids: executive, business, community, competition, media, technology),
 * or a lookup that returns a user id, handle or email (null when there's nobody to ask as). Only
 * officers and admins count
 */
export type AskerSpec = string | { department: string } | ((prisma: EvalContext["prisma"]) => Promise<string | null>);

/** The check a guard runs after the reply: null passes, a string says what went wrong */
export type GuardCheck = (answer: Answer, toolResults: string[]) => Promise<string | null>;

/** Runs before the reply (to snapshot what it must not change or reveal) and returns the check to run after it */
export type Guard = (ctx: GuardContext) => Promise<GuardCheck>;

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
  /** Checks around the reply (checks.ts has the common ones: expectProposal, expectNoProposal, expectUnchanged) */
  guard?: Guard | Guard[];
  /** Who asks it; defaults to the run's officer (--as, or the first officer or admin) */
  as?: AskerSpec;
  /** Set by paired(): the questions of one pair ask the same thing as different officers, and the pair judge compares their answers */
  pair?: string;
  /** Set by the track registry (tracks/index.ts): the track whose slot it came from. The core questions have none */
  track?: SlotTrack;
  /** Skipped until the running code has these: a track's tool or proposal kind that isn't built yet */
  requires?: { tools?: string[]; kinds?: string[] };
  /** Needs a real model (to fill in a tool's input); skipped in --dry-run before anything else runs */
  needsModel?: boolean;
  /**
   * Plants what the question asks about, once per run before any question (an injected instruction in
   * a synced record, say). Only on a local database; false, or a remote database, skips the question.
   * Must be safe to run again: what it plants stays for later runs unless `unplant` removes it
   */
  plant?: (ctx: PlantContext) => Promise<boolean>;
  /** Removes what `plant` planted, at the end of the run */
  unplant?: (ctx: PlantContext) => Promise<void>;
  /** Runs in the question's own room before the reply (room files, earlier state); whatever it makes there goes with the room */
  setup?: (ctx: GuardContext) => Promise<void>;
};

export type EvalContext = {
  prisma: typeof import("../../src/server/db").prisma;
  now: Date;
  persona: JackRoomPersonaKey;
  /** The officer asking (the question's `as`, or the run's officer) */
  officer: { id: string; displayName: string; handle?: string };
  startedAt: Date;
  lsc: Awaited<ReturnType<typeof loadLsc>>;
};

/** A question's context once its room exists: every question runs in a room of its own, deleted after it with everything made in it */
export type GuardContext = EvalContext & { roomId: string };

/** What `plant` gets: the database, and this season's LSC as it was before planting */
export type PlantContext = Pick<EvalContext, "prisma" | "now" | "lsc">;

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

/**
 * Whether an answer names an event: its full title, or for a race round the part after "@" (the
 * track, without any parenthesized note) or "Round N". Answers rightly shorten "Lone Star Cup S3
 * Round 5 @ Long Beach" to "Round 5 at Long Beach".
 */
export function namesEvent(text: string, title: string): boolean {
  const t = text.toLowerCase();
  if (t.includes(title.toLowerCase())) return true;
  const track = title.split("@")[1]?.replace(/\(.*?\)/g, "").trim();
  if (track && t.includes(track.toLowerCase())) return true;
  const round = title.match(/\bround\s+(\d+)\b/i)?.[1];
  return Boolean(round && new RegExp(`\\bround\\s*${round}\\b|\\br${round}\\b`, "i").test(text));
}

/** The semester as this test set reads it, in Central time: spring from January 1, fall from August 1 */
export function semesterStart(now: Date): Date {
  const [year, month] = formatInTimeZone(now, TZ, "yyyy-MM").split("-").map(Number);
  return fromZonedTime(`${year}-${month >= 8 ? "08" : "01"}-01T00:00:00`, TZ);
}

/** The most recent August, as [start, end) in Central time ("people who made an account in August") */
export function lastAugust(now: Date): [Date, Date] {
  const [year, month] = formatInTimeZone(now, TZ, "yyyy-MM").split("-").map(Number);
  const y = month >= 8 ? year : year - 1;
  return [fromZonedTime(`${y}-08-01T00:00:00`, TZ), fromZonedTime(`${y}-09-01T00:00:00`, TZ)];
}

/** Events that count, as Jack's tools count them: not drafts, not cancelled or postponed */
export const COUNTED_EVENT = { status: { notIn: ["DRAFT" as const, "CANCELLED" as const, "POSTPONED" as const] } };

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
