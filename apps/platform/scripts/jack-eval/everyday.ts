/**
 * The everyday questions (#161): what officers really ask, each with its right answer worked out from
 * the database when the eval runs.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { mentionsDollars, mentionsNumber } from "../../src/server/jack/eval-support";
import { chicagoMonthStart, includesAll, mentionsDate, namesEvent, nextFriday7pm, number, PEOPLE, purchaseKey, TZ, type Question, type ToolPart } from "./shared";

export const EVERYDAY: Question[] = [
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
    truth: async ({ lsc }) => {
      if (!lsc) return null;
      const schools = lsc.entrants.flatMap((e) => (e.application?.school ? [e.application.school] : []));
      const n = schools.length;
      const named = [...new Set(schools)];
      return {
        expected: `${n} applications from other schools${named.length ? ` (${named.join(", ")})` : ""}`,
        // The count next to its noun, or anywhere when the answer also names every other school ("2: Clemson and A&M")
        check: ({ text }) =>
          mentionsNumber(text, n, ["application", "school", "driver", "entr", "form", "other"]) || (mentionsNumber(text, n) && includesAll(text, named).length === 0)
            ? null
            : `doesn't say ${n} applications from other schools`,
        fakeAnswer: `${n} applications came from other schools${named.length ? `: ${named.join(", ")}` : ""}.`,
      };
    },
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
          const left = missing.filter((title) => !namesEvent(text, title));
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
          const left = events.filter((e) => !namesEvent(text, e.title)).map((e) => e.title);
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
