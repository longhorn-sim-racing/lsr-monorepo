/**
 * Jack's test set (#161): about 15 questions officers really ask, each with its right answer worked
 * out from the database when the eval runs, asked through the same reply code the rooms use (the
 * room's system prompt, history format, tools and model loop) on Stand (Haiku 5.5), Jack (Sonnet 5.5)
 * and Lift (Opus 5.5). Prints accuracy, cost and latency per model, to pick the default.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-eval.ts              # all three models
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-eval.ts --only=jack  # one model (jack, lift or stand)
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-eval.ts --dry-run    # plumbing check: fake model, no API calls
 *
 * Options: --as=<email|handle> (the officer asking, who drafts are credited to; default the first
 * officer or admin), --filter=<text> (questions whose id contains it), --verbose (print every answer),
 * --allow-remote=<host> (see below).
 *
 * Reads apps/platform/.env.local and .env (found from this script, not the working directory), without
 * overriding the environment. Needs DATABASE_URL and JACK_DATABASE_URL on the same database, and
 * ANTHROPIC_API_KEY unless --dry-run. It refuses to run unless DATABASE_URL is this machine
 * (127.0.0.1 or localhost), or --allow-remote names its exact host (a copy of real data, never
 * production). A real run costs money (a few dollars for both models), and it doesn't show in Jack's
 * spend meter (only in the Anthropic Console). After every question it deletes any event the reply
 * drafted (DRAFT events only) and the audit entries Jack wrote for this eval since it started. Nothing
 * else is written.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { JackRoomPersonaKey } from "../src/lib/jack/types";
import { checkEvalDatabase, mentionsDollars, mentionsNumber, plain } from "../src/server/jack/eval-support";

/** apps/platform, wherever this is run from: only its env files are read */
const APP_DIR = resolve(__dirname, "..");
for (const file of [".env.local", ".env"]) {
  const path = resolve(APP_DIR, file);
  if (!existsSync(path)) continue;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
// Quiet Prisma's query log
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const TZ = "America/Chicago";
const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DRY_RUN = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");
const ONLY = arg("only");
const FILTER = arg("filter");
const AS = arg("as");
const ALLOW_REMOTE = arg("allow-remote");
/** The room id the eval's tool calls run in; draft_event's audit entries carry it */
const EVAL_ROOM_ID = "jack-eval";

const database = checkEvalDatabase({ DATABASE_URL: process.env.DATABASE_URL, JACK_DATABASE_URL: process.env.JACK_DATABASE_URL }, ALLOW_REMOTE);
if (!database.ok) {
  console.error(database.error);
  process.exit(1);
}
if (!DRY_RUN && !process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error("ANTHROPIC_API_KEY isn't set, so the eval can't ask Claude. Add it, or use --dry-run to check the plumbing with a fake model.");
  process.exit(1);
}
if (ONLY && ONLY !== "jack" && ONLY !== "lift" && ONLY !== "stand") {
  console.error(`--only must be jack, lift or stand (got "${ONLY}").`);
  process.exit(1);
}

type ToolPart = import("../src/lib/jack/parts").JackToolPart;

/** What a reply came back with */
type Answer = { text: string; parts: ToolPart[] };

/** What a right answer looks like. `check` returns null for a pass, or why it failed */
type Expectation = {
  expected: string;
  check: (answer: Answer) => string | null;
  /** For --dry-run: a reply that should pass (no tool calls) */
  fakeAnswer?: string;
  /** Needs a real model to fill in a tool's input; skipped in --dry-run */
  needsModel?: boolean;
  /** A check against the database after the reply (e.g. the draft it made) */
  verify?: () => Promise<string | null>;
};

type Question = {
  id: string;
  ask: string | ((ctx: EvalContext) => string);
  /** The right answer, from the database. Null skips the question (nothing to ask about) */
  truth: (ctx: EvalContext) => Promise<Expectation | null>;
};

type EvalContext = {
  prisma: typeof import("../src/server/db").prisma;
  now: Date;
  persona: JackRoomPersonaKey;
  officer: { id: string; displayName: string };
  startedAt: Date;
  lsc: Awaited<ReturnType<typeof loadLsc>>;
};

// ---------------------------------------------------------------------------
// checks (the matching itself is in src/server/jack/eval-support.ts, with tests)
// ---------------------------------------------------------------------------

const includesAll = (text: string, needles: string[]) => needles.filter((n) => !text.toLowerCase().includes(n.toLowerCase()));

/** A count, which has to sit next to one of `nouns` (word starts) unless it's the only number in the answer */
function number(n: number, what: string, nouns: string[]): Pick<Expectation, "expected" | "check" | "fakeAnswer"> {
  return {
    expected: `${n} ${what}`,
    check: ({ text }) => (mentionsNumber(text, n, nouns) ? null : `doesn't say ${n} ${what}`),
    fakeAnswer: `There are ${n} ${what}.`,
  };
}

/** "Mon, Oct 19" style mentions of an instant's Central Time date, in any of the usual spellings */
function mentionsDate(text: string, at: Date): boolean {
  const t = plain(text);
  return [formatInTimeZone(at, TZ, "MMM d"), formatInTimeZone(at, TZ, "MMMM d"), formatInTimeZone(at, TZ, "M/d")].some((form) =>
    new RegExp(`${form.replace(/\//g, "\\/")}(?!\\d)`, "i").test(t)
  );
}

const PEOPLE = ["people", "person", "member", "officer", "user", "driver", "account", "checkout", "attendee"];

// ---------------------------------------------------------------------------
// ground truth helpers
// ---------------------------------------------------------------------------

async function loadLsc(prisma: EvalContext["prisma"], now: Date) {
  const { getOpenLeagueSeason, listSeasonEntrants } = await import("../src/server/services/league-entry.service");
  const league = await prisma.league.findUnique({ where: { slug: "lone-star-cup" } });
  if (!league) return null;
  const season = await getOpenLeagueSeason(league.id, now);
  if (!season) return null;
  const roster = await listSeasonEntrants(season.id);
  return { league, season, entrants: roster?.entrants ?? [] };
}

function chicagoMonthStart(now: Date): Date {
  return fromZonedTime(`${formatInTimeZone(now, TZ, "yyyy-MM")}-01T00:00:00`, TZ);
}

/** The Friday after today, at 7 PM Central (what "next Friday" means here) */
function nextFriday7pm(now: Date): Date {
  let day = new Date(now.getTime() + 86_400_000);
  while (formatInTimeZone(day, TZ, "EEE") !== "Fri") day = new Date(day.getTime() + 86_400_000);
  return fromZonedTime(`${formatInTimeZone(day, TZ, "yyyy-MM-dd")}T19:00:00`, TZ);
}

/** What a payment was for: its product, or for an event fee (no product) the event in its metadata */
function purchaseKey(payment: { productId: string | null; metadata: unknown }): string {
  if (payment.productId) return `product:${payment.productId}`;
  const eventId = (payment.metadata as Record<string, unknown> | null)?.eventId;
  return `event:${typeof eventId === "string" ? eventId : "unknown"}`;
}

// ---------------------------------------------------------------------------
// the questions
// ---------------------------------------------------------------------------

const QUESTIONS: Question[] = [
  {
    id: "lsc-applications",
    ask: "How many LSC entry forms (applications) are there for the current season?",
    truth: async ({ lsc }) => {
      if (!lsc) return null;
      const count = lsc.entrants.filter((e) => e.application).length;
      return number(count, "applications", ["application", "form", "submission", "entr"]);
    },
  },
  {
    id: "lsc-paid",
    ask: "How many drivers have paid their LSC entry fee this season?",
    truth: async ({ lsc }) => (lsc ? number(lsc.entrants.filter((e) => e.status === "paid").length, "paid entries", ["paid", "driver", "entr", "fee", "people"]) : null),
  },
  {
    id: "lsc-entries",
    ask: "How many LSC entries are active this season, counting both paid ones and ones an officer entered by hand?",
    truth: async ({ lsc }) =>
      lsc ? number(lsc.entrants.filter((e) => e.status === "paid" || e.status === "manual").length, "active entries", ["active", "entr", "driver", "total"]) : null,
  },
  {
    id: "lsc-other-schools",
    ask: "How many of this season's LSC applications came from a school other than UT Austin?",
    truth: async ({ lsc }) =>
      lsc
        ? number(lsc.entrants.filter((e) => e.application && e.application.school).length, "applications from other schools", ["application", "school", "driver", "entr", "form", "other"])
        : null,
  },
  {
    id: "lsc-missing-results",
    ask: "Which LSC rounds this season have already happened but don't have results uploaded yet?",
    truth: async ({ prisma, lsc, now }) => {
      if (!lsc?.season.seriesId) return null;
      // Results are in when a race session has results, as Recompute standings counts them
      const rounds = await prisma.event.findMany({
        where: {
          seriesId: lsc.season.seriesId,
          startsAtUtc: { gte: lsc.season.startAt ?? undefined, lte: lsc.season.endAt ?? undefined, lt: now },
        },
        select: { title: true, _count: { select: { ingestedSessions: { where: { sessionType: "RACE", results: { some: {} } } } } } },
      });
      const missing = rounds.filter((r) => r._count.ingestedSessions === 0).map((r) => r.title);
      if (!missing.length) {
        return {
          expected: "none are missing results",
          check: ({ text }) => (/\b(none|no rounds?|all .*(have|has) results|every)\b/i.test(text) ? null : "doesn't say none are missing"),
          fakeAnswer: "None: every past round has results.",
        };
      }
      return {
        expected: missing.join(", "),
        check: ({ text }) => {
          const left = includesAll(text, missing);
          return left.length ? `doesn't name ${left.join(", ")}` : null;
        },
        fakeAnswer: `Missing results: ${missing.join(", ")}.`,
      };
    },
  },
  {
    id: "unpaid-checkouts",
    ask: "Who started a checkout and never paid? Just tell me how many people, and their names.",
    truth: async ({ prisma }) => {
      // A checkout someone later paid for (the same product, or for an event fee the same event) doesn't count
      const unpaid = await prisma.payment.findMany({
        where: { status: { in: ["pending", "failed"] } },
        select: { userId: true, productId: true, metadata: true, user: { select: { displayName: true } } },
      });
      const paid = await prisma.payment.findMany({ where: { status: "succeeded" }, select: { userId: true, productId: true, metadata: true } });
      const paidKeys = new Set(paid.map((p) => `${p.userId}:${purchaseKey(p)}`));
      const people = new Map<string, string>();
      for (const p of unpaid) if (!paidKeys.has(`${p.userId}:${purchaseKey(p)}`)) people.set(p.userId, p.user.displayName);
      const names = [...people.values()];
      return {
        expected: `${names.length} people${names.length ? `: ${names.join(", ")}` : ""}`,
        check: ({ text }) => {
          if (mentionsNumber(text, names.length, PEOPLE)) return null;
          if (names.length && names.length <= 8 && !includesAll(text, names).length) return null;
          return `doesn't say ${names.length} or name them all`;
        },
        fakeAnswer: `${names.length} people: ${names.join(", ") || "nobody"}.`,
      };
    },
  },
  {
    id: "charges-this-month",
    ask: "How many charges succeeded this month, and how much money did they bring in?",
    truth: async ({ prisma, now }) => {
      const charges = await prisma.payment.findMany({
        where: { status: "succeeded", paidAt: { gte: chicagoMonthStart(now), lte: now } },
        select: { amountCents: true },
      });
      const cents = charges.reduce((sum, c) => sum + c.amountCents, 0);
      return {
        expected: `${charges.length} charges, $${(cents / 100).toFixed(2)}`,
        check: ({ text }) => {
          if (!mentionsNumber(text, charges.length, ["charge", "payment", "transaction", "succeeded", "successful"])) return `doesn't say ${charges.length} charges`;
          if (cents > 0 && !mentionsDollars(text, cents)) return `doesn't say $${(cents / 100).toFixed(2)}`;
          return null;
        },
        fakeAnswer: `${charges.length} charges brought in $${(cents / 100).toFixed(2)}.`,
      };
    },
  },
  {
    id: "user-accounts",
    ask: "How many user accounts are on the site in total?",
    truth: async ({ prisma }) => {
      // Counting deleted accounts or not are both fair readings
      const [all, live] = await Promise.all([prisma.user.count(), prisma.user.count({ where: { status: { not: "deleted" } } })]);
      const nouns = ["account", "user", "member", "total"];
      return {
        expected: `${all} accounts${live !== all ? ` (${live} not deleted)` : ""}`,
        check: ({ text }) => (mentionsNumber(text, all, nouns) || mentionsNumber(text, live, nouns) ? null : `doesn't say ${all} accounts`),
        fakeAnswer: `There are ${all} accounts.`,
      };
    },
  },
  {
    id: "new-accounts",
    ask: "How many accounts were created in the last 30 days?",
    truth: async ({ prisma, now }) => {
      const since = new Date(now.getTime() - 30 * 86_400_000);
      const [created, signedUp] = await Promise.all([
        prisma.user.count({ where: { createdAt: { gte: since } } }),
        prisma.user.count({ where: { signedUpAt: { gte: since } } }),
      ]);
      const nouns = ["account", "user", "member", "signup", "sign-up", "new", "people"];
      return {
        expected: `${created} accounts${signedUp !== created ? ` (or ${signedUp} by sign-up date)` : ""}`,
        check: ({ text }) => (mentionsNumber(text, created, nouns) || mentionsNumber(text, signedUp, nouns) ? null : `doesn't say ${created} accounts`),
        fakeAnswer: `${created} accounts.`,
      };
    },
  },
  {
    id: "officers",
    ask: "Who are the officers right now?",
    truth: async ({ prisma }) => {
      const officers = await prisma.user.findMany({
        where: { roles: { some: { role: { key: { in: ["officer", "admin"] } } } } },
        select: { displayName: true },
      });
      const names = officers.map((o) => o.displayName);
      return {
        expected: `${names.length} officers, no emails: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}`,
        check: ({ text }) => {
          if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) return "shows an email nobody asked for";
          if (names.length > 15) return mentionsNumber(text, names.length, ["officer", "people", "admin"]) ? null : `doesn't say ${names.length} officers`;
          const left = includesAll(text, names);
          return left.length ? `doesn't name ${left.join(", ")}` : null;
        },
        fakeAnswer: `The ${names.length} officers are ${names.join(", ")}.`,
      };
    },
  },
  {
    id: "upcoming-events",
    ask: "What are the next three events on the calendar, with their dates?",
    truth: async ({ prisma, now }) => {
      const events = await prisma.event.findMany({
        where: { startsAtUtc: { gte: now }, status: { notIn: ["DRAFT", "CANCELLED"] } },
        orderBy: { startsAtUtc: "asc" },
        take: 3,
        select: { title: true, startsAtUtc: true },
      });
      if (!events.length) {
        return {
          expected: "nothing upcoming",
          check: ({ text }) => (/\b(no|none|nothing)\b/i.test(text) ? null : "doesn't say there's nothing upcoming"),
          fakeAnswer: "There are no upcoming events.",
        };
      }
      return {
        expected: events.map((e) => `${e.title} (${formatInTimeZone(e.startsAtUtc, TZ, "EEE MMM d, h:mm a")} CT)`).join("; "),
        check: ({ text }) => {
          const left = includesAll(text, events.map((e) => e.title));
          if (left.length) return `doesn't name ${left.join(", ")}`;
          const wrongDates = events.filter((e) => !mentionsDate(text, e.startsAtUtc)).map((e) => e.title);
          return wrongDates.length ? `no Central Time date for ${wrongDates.join(", ")}` : null;
        },
        fakeAnswer: events.map((e) => `${e.title}: ${formatInTimeZone(e.startsAtUtc, TZ, "EEE, MMM d, h:mm a")} CT`).join("\n"),
      };
    },
  },
  {
    id: "gm-1",
    ask: "Is GM 1 on the calendar? When is it?",
    truth: async ({ prisma }) => {
      const gm = await prisma.event.findFirst({
        where: {
          status: { notIn: ["DRAFT", "CANCELLED"] },
          OR: [{ title: { contains: "GM 1", mode: "insensitive" } }, { title: { contains: "General Meeting 1", mode: "insensitive" } }],
        },
        orderBy: { startsAtUtc: "desc" },
        select: { title: true, startsAtUtc: true },
      });
      if (!gm) {
        return {
          expected: "not on the calendar",
          check: ({ text }) => (/\b(no|not|isn't|couldn't find|can't find)\b/i.test(text) ? null : "doesn't say it isn't there"),
          fakeAnswer: "No, GM 1 isn't on the calendar.",
        };
      }
      return {
        expected: `${gm.title}, ${formatInTimeZone(gm.startsAtUtc, TZ, "EEE MMM d, h:mm a")} CT`,
        check: ({ text }) => (mentionsDate(text, gm.startsAtUtc) ? null : `doesn't give ${formatInTimeZone(gm.startsAtUtc, TZ, "MMM d")}`),
        fakeAnswer: `Yes: ${gm.title} is ${formatInTimeZone(gm.startsAtUtc, TZ, "EEE, MMM d, h:mm a")} CT.`,
      };
    },
  },
  {
    id: "last-event-checkins",
    ask: "How many people checked in at the most recent event that had check-ins?",
    truth: async ({ prisma }) => {
      const event = await prisma.event.findFirst({
        where: { attendances: { some: {} } },
        orderBy: { startsAtUtc: "desc" },
        select: { title: true, _count: { select: { attendances: true } } },
      });
      if (!event) return null;
      return { ...number(event._count.attendances, "check-ins", ["check", "people", "person", "attendee", "member"]), expected: `${event._count.attendances} at ${event.title}` };
    },
  },
  {
    id: "top-attendance",
    ask: "Which event since August 1 had the most people check in, and how many?",
    truth: async ({ prisma, now }) => {
      const since = fromZonedTime(`${formatInTimeZone(now, TZ, "yyyy")}-08-01T00:00:00`, TZ);
      const events = await prisma.event.findMany({
        where: { startsAtUtc: { gte: since, lte: now }, attendances: { some: {} } },
        select: { title: true, _count: { select: { attendances: true } } },
      });
      if (!events.length) return null;
      const top = Math.max(...events.map((e) => e._count.attendances));
      const leaders = events.filter((e) => e._count.attendances === top).map((e) => e.title);
      return {
        expected: `${leaders.join(" / ")} with ${top}`,
        check: ({ text }) => {
          if (!mentionsNumber(text, top, ["check", "people", "person", "attendee", "member"])) return `doesn't say ${top} check-ins`;
          return leaders.some((title) => text.toLowerCase().includes(title.toLowerCase())) ? null : `doesn't name ${leaders.join(" or ")}`;
        },
        fakeAnswer: `${leaders[0]}, with ${top} check-ins.`,
      };
    },
  },
  {
    id: "chart-experience",
    ask: "Make a bar chart of this season's LSC applications by sim racing experience level.",
    truth: async ({ lsc }) => {
      if (!lsc) return null;
      const total = lsc.entrants.filter((e) => e.application).length;
      return {
        expected: `a bar chart whose bars add up to ${total}`,
        needsModel: true,
        check: ({ parts }) => {
          const charts = parts.flatMap((p) => p.displays).filter((d): d is Extract<ToolPart["displays"][number], { kind: "chart" }> => d.kind === "chart");
          if (!charts.length) return "made no chart";
          const chart = charts.at(-1)!.chart;
          const sum = chart.rows.reduce((acc, row) => acc + chart.series.reduce((s, series) => s + (Number(row[series.key]) || 0), 0), 0);
          return sum === total ? null : `the chart's bars add up to ${sum}, not ${total}`;
        },
      };
    },
  },
  {
    id: "draft-event",
    ask: ({ persona, startedAt, now }) =>
      `Draft an event called "Jack Eval ${persona} ${startedAt.getTime()}" for Friday ${formatInTimeZone(nextFriday7pm(now), TZ, "MMMM d")} at 7 PM Central, two hours long. Leave it as a draft.`,
    truth: async ({ prisma, persona, startedAt, now }) => {
      const title = `Jack Eval ${persona} ${startedAt.getTime()}`;
      const when = nextFriday7pm(now);
      const created = () => prisma.event.findMany({ where: { title, createdAt: { gte: startedAt } }, select: { id: true, status: true, startsAtUtc: true, endsAtUtc: true } });
      return {
        expected: `a DRAFT event "${title}" on ${formatInTimeZone(when, TZ, "EEE MMM d")} at 7:00 PM CT`,
        needsModel: true,
        // The reply should point to the draft; the database check is `verify`. The cleanup after every
        // question deletes it
        check: ({ parts }) => (parts.some((p) => p.displays.some((d) => d.kind === "event_draft")) ? null : "showed no event draft"),
        verify: async () => {
          const events = await created();
          if (events.length !== 1) return `${events.length} events with that title were created`;
          const [event] = events;
          if (event.status !== "DRAFT") return `it was created as ${event.status}, not DRAFT`;
          if (formatInTimeZone(event.startsAtUtc, TZ, "EEE HH:mm") !== "Fri 19:00") return `it starts ${formatInTimeZone(event.startsAtUtc, TZ, "EEE MMM d h:mm a")} CT`;
          if (event.endsAtUtc.getTime() - event.startsAtUtc.getTime() !== 2 * 3_600_000) return "it isn't two hours long";
          return null;
        },
      };
    },
  },
];

// ---------------------------------------------------------------------------
// running it
// ---------------------------------------------------------------------------

type Result = {
  id: string;
  persona: JackRoomPersonaKey;
  status: "pass" | "fail" | "skip";
  reason?: string;
  expected?: string;
  answer?: string;
  costUsd: number;
  seconds: number;
  toolCalls: number;
};

async function main() {
  const { prisma } = await import("../src/server/db");
  const { buildHistory } = await import("../src/server/jack/history");
  const { runModelReply, anthropicJackClient } = await import("../src/server/jack/model-loop");
  const { JACK_MODELS } = await import("../src/server/jack/models");
  const { buildSystemPrompt } = await import("../src/server/jack/prompt");
  const { JACK_TOOLS } = await import("../src/server/jack/tools");
  const { fakeClaude } = await import("../src/server/jack/fake-claude");
  if (!database.ok) return; // narrowed above; for TypeScript

  const officer = await findOfficer(prisma);
  const personas = (ONLY ? [ONLY] : ["stand", "jack", "lift"]) as JackRoomPersonaKey[];
  const questions = QUESTIONS.filter((q) => !FILTER || q.id.includes(FILTER));
  const startedAt = new Date();

  const rule = "=".repeat(78);
  console.log(rule);
  console.log(
    database.local
      ? `  JACK EVAL on the LOCAL database ${database.host}:${database.port}/${database.database}`
      : `  JACK EVAL on a REMOTE database ${database.host}:${database.port}/${database.database} (allowed by --allow-remote)`
  );
  console.log(
    `  ${DRY_RUN ? "Dry run: fake model, no API calls, nothing spent." : "Real run: calls Claude and costs money (not shown in Jack's spend meter)."} ` +
      "Drafts made here are deleted after each question."
  );
  console.log(rule);
  console.log(`  asking as: ${officer.displayName}   tools: ${JACK_TOOLS.map((t) => t.name).join(", ") || "none yet"}`);
  console.log(`  ${questions.length} questions x ${personas.map((p) => JACK_MODELS[p].model).join(", ")}\n`);

  const results: Result[] = [];
  for (const persona of personas) {
    for (const question of questions) {
      const now = new Date();
      const lsc = await loadLsc(prisma, now);
      const ctx: EvalContext = { prisma, now, persona, officer, startedAt, lsc };
      const ask = typeof question.ask === "function" ? question.ask(ctx) : question.ask;
      const truth = await question.truth(ctx);
      const base = { id: question.id, persona, costUsd: 0, seconds: 0, toolCalls: 0 };
      if (!truth) {
        results.push({ ...base, status: "skip", reason: "no data to ask about" });
        report(results.at(-1)!);
        continue;
      }
      if (DRY_RUN && truth.needsModel) {
        results.push({ ...base, status: "skip", reason: "needs a real model to fill in a tool's input", expected: truth.expected });
        report(results.at(-1)!);
        continue;
      }

      // The same history a room builds for one officer message
      const replyId = "eval-reply";
      const history = buildHistory(
        [
          { id: "eval-ask", kind: "user", persona: null, content: ask, toolCalls: null, status: "done", answeredById: replyId, model: null, createdAt: now, author: { displayName: officer.displayName } },
          { id: replyId, kind: "assistant", persona, content: "", toolCalls: null, status: "streaming", answeredById: null, model: null, createdAt: new Date(now.getTime() + 1), author: null },
        ],
        replyId
      );

      const client = DRY_RUN ? dryRunClient(fakeClaude, JACK_TOOLS, truth.fakeAnswer ?? truth.expected) : anthropicJackClient(process.env.ANTHROPIC_API_KEY!.trim());
      const t0 = Date.now();
      let answer: Answer = { text: "", parts: [] };
      // Every part seen as it streamed, so the cleanup finds a draft even if the reply then throws
      const seenParts = new Map<string, ToolPart>();
      let failure: string | null = null;
      let costUsd = 0;
      let toolCalls = 0;
      try {
        const out = await runModelReply({
          client,
          config: JACK_MODELS[persona],
          system: buildSystemPrompt(persona),
          tools: JACK_TOOLS,
          history,
          ctx: { roomId: EVAL_ROOM_ID, actor: { userId: officer.id, displayName: officer.displayName } },
          onText: () => {},
          onPart: async (part) => {
            seenParts.set(part.id, part);
          },
        });
        answer = { text: out.text, parts: out.parts };
        costUsd = out.usage.costUsd;
        toolCalls = out.toolCalls;
        if (out.status === "error" || out.outcome !== "answered") failure = `ended as ${out.outcome}: ${out.text.slice(-160)}`;
        failure ??= truth.check(answer);
        if (!failure && truth.verify) failure = await truth.verify();
        // A dry run also makes sure the check isn't vacuous: a non-answer has to fail it
        if (!failure && DRY_RUN && truth.check({ text: "Here's what I have.", parts: [] }) === null) failure = "the check passes a non-answer";
      } catch (error) {
        failure = `threw: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        await cleanUp(prisma, [...seenParts.values(), ...answer.parts], startedAt).catch((error) => console.error(`  couldn't clean up after ${question.id}:`, error));
      }
      results.push({
        ...base,
        status: failure ? "fail" : "pass",
        reason: failure ?? undefined,
        expected: truth.expected,
        answer: answer.text,
        costUsd,
        toolCalls,
        seconds: (Date.now() - t0) / 1000,
      });
      report(results.at(-1)!);
    }
  }

  summarize(results, personas, JACK_MODELS);
  await prisma.$disconnect();
}

/**
 * Undoes what a question wrote: any DRAFT event the reply drafted (from its event_draft displays, and
 * from the audit entries Jack wrote for this eval's room since it started, in case a part went
 * missing), then those audit entries.
 */
async function cleanUp(prisma: EvalContext["prisma"], parts: ToolPart[], since: Date) {
  const drafted = new Set(
    parts.flatMap((p) => p.displays).flatMap((d) => (d.kind === "event_draft" ? [d.eventId] : []))
  );
  const audits = await prisma.auditLog.findMany({
    where: {
      createdAt: { gte: since },
      AND: [{ metadata: { path: ["via"], equals: "jack" } }, { metadata: { path: ["roomId"], equals: EVAL_ROOM_ID } }],
    },
    select: { id: true, entityType: true, entityId: true },
  });
  for (const audit of audits) if (audit.entityType === "EVENT") drafted.add(audit.entityId);
  const events = drafted.size
    ? await prisma.event.deleteMany({ where: { id: { in: [...drafted] }, status: "DRAFT", createdAt: { gte: since } } })
    : { count: 0 };
  const entries = audits.length ? await prisma.auditLog.deleteMany({ where: { id: { in: audits.map((a) => a.id) } } }) : { count: 0 };
  if (VERBOSE && (events.count || entries.count)) console.log(`         cleaned up ${events.count} draft event(s), ${entries.count} audit entr${entries.count === 1 ? "y" : "ies"}`);
}

/** The officer the eval asks as: --as, or the first officer or admin */
async function findOfficer(prisma: EvalContext["prisma"]) {
  const who = AS?.toLowerCase();
  const user = who
    ? await prisma.user.findFirst({ where: who.includes("@") ? { email: who } : { OR: [{ handle: who }, { id: AS }] }, select: { id: true, displayName: true } })
    : await prisma.user.findFirst({
        where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } },
        orderBy: { createdAt: "asc" },
        select: { id: true, displayName: true },
      });
  if (!user) {
    console.error(AS ? `No user "${AS}".` : "No officer or admin in this database. Use --as=<email|handle>, or `pnpm set-role` someone first.");
    process.exit(1);
  }
  return user;
}

/**
 * --dry-run's model: calls one tool that takes no input (when there is one), to exercise the tool
 * path, then answers with text the check should pass. Cost comes from the fake's token counts.
 */
function dryRunClient(
  fakeClaude: typeof import("../src/server/jack/fake-claude").fakeClaude,
  tools: import("../src/server/jack/tools/types").AnyJackTool[],
  answer: string
) {
  const noInputTool = tools.find((tool) => tool.input.safeParse({}).success);
  const turns = [...(noInputTool ? [{ text: "Let me look.", tools: [{ name: noInputTool.name, input: {} }] }] : []), { text: answer }];
  return fakeClaude(turns).client;
}

function report(result: Result) {
  const mark = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "skip";
  const stats = result.status === "skip" ? "" : `  $${result.costUsd.toFixed(4)}  ${result.seconds.toFixed(1)} s  ${result.toolCalls} tools`;
  console.log(`  ${result.persona.padEnd(5)} ${mark}  ${result.id.padEnd(22)}${stats}${result.reason ? `  (${result.reason})` : ""}`);
  if (result.status !== "skip" && (VERBOSE || result.status === "fail")) {
    console.log(`         expected: ${result.expected}`);
    console.log(`         answer:   ${(result.answer ?? "").replace(/\s+/g, " ").slice(0, VERBOSE ? 2_000 : 400)}`);
  }
}

function summarize(results: Result[], personas: JackRoomPersonaKey[], models: Record<string, { model: string }>) {
  console.log("\nSummary");
  console.log("  model               accuracy        cost   avg cost   avg time   p90 time");
  for (const persona of personas) {
    const ran = results.filter((r) => r.persona === persona && r.status !== "skip");
    const passed = ran.filter((r) => r.status === "pass").length;
    const cost = ran.reduce((sum, r) => sum + r.costUsd, 0);
    const times = ran.map((r) => r.seconds).sort((a, b) => a - b);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const p90 = times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.9) - 1)] : 0;
    const skipped = results.filter((r) => r.persona === persona && r.status === "skip").length;
    console.log(
      `  ${models[persona].model.padEnd(18)}  ${`${passed}/${ran.length}`.padStart(5)} ${`(${ran.length ? Math.round((passed / ran.length) * 100) : 0}%)`.padStart(6)}  ` +
        `${`$${cost.toFixed(3)}`.padStart(8)}  ${`$${(ran.length ? cost / ran.length : 0).toFixed(4)}`.padStart(9)}  ` +
        `${`${avg.toFixed(1)} s`.padStart(9)}  ${`${p90.toFixed(1)} s`.padStart(9)}${skipped ? `   (${skipped} skipped)` : ""}`
    );
  }
  if (results.some((r) => r.status === "fail")) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
