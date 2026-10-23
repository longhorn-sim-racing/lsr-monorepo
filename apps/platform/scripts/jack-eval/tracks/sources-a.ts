import { mentionsDollars, mentionsNumber } from "../../../src/server/jack/eval-support";
import { includesAll, mentionsDate, type Question } from "../shared";

/**
 * Eval questions from the sources-a track (design §16): Stripe, email delivery and site traffic, each
 * answered from the synced tables (pnpm jack:eval:prepare fills them from the fakes). Every right
 * answer is worked out from the database when the eval runs. The tools only read, so there's nothing
 * for the cleanup to undo. The registry (./index.ts) tags each with the track; ids are unique across the eval
 */

const DAY_MS = 86_400_000;
const RESPOND = ["warning_needs_response", "needs_response"];
const FAILED_TYPES = ["email.bounced", "email.complained", "email.failed", "email.suppressed"];

export const QUESTIONS: Question[] = [
  {
    id: "stripe-balance",
    ask: "What's our Stripe balance right now? How much is available, and how much is still pending?",
    requires: { tools: ["stripe_overview"] },
    truth: async ({ prisma }) => {
      const balance = await prisma.stripeBalanceDaily.findFirst({ orderBy: { date: "desc" } });
      if (!balance) return null;
      const show = (cents: number) => `$${(cents / 100).toFixed(2)}`;
      return {
        expected: `${show(balance.availableCents)} available, ${show(balance.pendingCents)} pending`,
        check: ({ text }) =>
          !mentionsDollars(text, balance.availableCents) ? `doesn't say ${show(balance.availableCents)} available` : !mentionsDollars(text, balance.pendingCents) ? `doesn't say ${show(balance.pendingCents)} pending` : null,
        fakeAnswer: `${show(balance.availableCents)} is available and ${show(balance.pendingCents)} is pending.`,
        fakeCalls: [{ name: "stripe_overview", input: {} }],
        facts: `Stripe balance as of ${balance.date.toISOString().slice(0, 10)}: available ${show(balance.availableCents)}, pending ${show(balance.pendingCents)}.`,
      };
    },
  },
  {
    id: "stripe-failed-payout",
    ask: "Did any Stripe payout to our bank fail in the last two months? If so, how much was it and why did it fail?",
    requires: { tools: ["stripe_overview"] },
    truth: async ({ prisma, now }) => {
      const failed = await prisma.stripePayout.findMany({ where: { status: "failed", createdAt: { gte: new Date(now.getTime() - 60 * DAY_MS) } }, orderBy: { createdAt: "desc" } });
      if (!failed.length) {
        return {
          expected: "no payout failed",
          check: ({ text }) => (/\b(no|none|didn't|did not|haven't|hasn't)\b/i.test(text) ? null : "doesn't say none failed"),
          fakeAnswer: "No payouts failed in the last two months.",
          fakeCalls: [{ name: "stripe_overview", input: { show: "payouts", days: 60 } }],
        };
      }
      const first = failed[0];
      const reason = (first.failureCode ?? "").replace(/_/g, " ");
      return {
        expected: `${failed.length} failed: $${(first.amountCents / 100).toFixed(2)} (${reason || "no reason given"})`,
        check: ({ text }) => {
          if (!mentionsDollars(text, first.amountCents)) return `doesn't give the failed payout's amount, $${(first.amountCents / 100).toFixed(2)}`;
          // "no_account" is the bank account details being wrong; any plain wording of it passes
          if (reason && !/no.?account|account|bank/i.test(text)) return `doesn't give the reason (${reason})`;
          return null;
        },
        fakeAnswer: `Yes: a $${(first.amountCents / 100).toFixed(2)} payout failed (${reason}: the bank account details look wrong).`,
        fakeCalls: [{ name: "stripe_overview", input: { show: "payouts", days: 60 } }],
        facts: failed.map((p) => `Payout ${p.id}: $${(p.amountCents / 100).toFixed(2)}, failed, failure code ${p.failureCode ?? "none"}`).join("\n"),
      };
    },
  },
  {
    id: "stripe-dispute-due",
    ask: "Is there a payment dispute we still need to respond to? By when?",
    requires: { tools: ["stripe_overview"] },
    truth: async ({ prisma }) => {
      const open = await prisma.stripeDispute.findMany({ where: { status: { in: RESPOND } }, orderBy: { evidenceDueBy: "asc" } });
      if (!open.length) {
        return {
          expected: "no dispute needs a response",
          check: ({ text }) => (/\b(no|none|nothing)\b/i.test(text) ? null : "doesn't say none needs a response"),
          fakeAnswer: "No dispute needs a response right now.",
          fakeCalls: [{ name: "stripe_overview", input: { show: "disputes" } }],
        };
      }
      const due = open[0].evidenceDueBy;
      return {
        expected: `${open.length} to respond to; the first is $${(open[0].amountCents / 100).toFixed(2)}${due ? `, due ${due.toISOString().slice(0, 10)}` : ""}`,
        check: ({ text }) => (due && !mentionsDate(text, due) ? "doesn't give the due date" : !mentionsDollars(text, open[0].amountCents) ? "doesn't give the amount" : null),
        fakeAnswer: due ? `Yes: a $${(open[0].amountCents / 100).toFixed(2)} dispute needs a response by ${due.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" })}. Respond in the Stripe dashboard.` : "Yes, one dispute needs a response.",
        fakeCalls: [{ name: "stripe_overview", input: { show: "disputes" } }],
        facts: open.map((d) => `Dispute ${d.id}: $${(d.amountCents / 100).toFixed(2)}, ${d.status}, reason ${d.reason}, respond by ${d.evidenceDueBy?.toISOString() ?? "unknown"}`).join("\n"),
      };
    },
  },
  {
    id: "email-bounces-week",
    ask: "Which email addresses didn't get our emails in the last week (bounced, refused or marked as spam)?",
    requires: { tools: ["email_delivery"] },
    truth: async ({ prisma, now }) => {
      const failures = await prisma.emailEvent.findMany({ where: { type: { in: FAILED_TYPES }, occurredAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } }, select: { recipient: true }, distinct: ["recipient"] });
      const addresses = failures.map((f) => f.recipient).filter(Boolean);
      if (!addresses.length) return null;
      return {
        expected: addresses.join(", "),
        check: ({ text }) => {
          const missing = addresses.length <= 8 ? includesAll(text, addresses) : [];
          if (missing.length) return `doesn't name ${missing.join(", ")}`;
          return addresses.length > 8 && !mentionsNumber(text, addresses.length, ["address", "email", "bounce", "recipient"]) ? `doesn't say ${addresses.length} addresses` : null;
        },
        fakeAnswer: `These didn't get our emails: ${addresses.join(", ")}.`,
        fakeCalls: [{ name: "email_delivery", input: { view: "bounces", days: 7 } }],
        facts: `Addresses with a bounce, refusal, failure or spam complaint in the last 7 days: ${addresses.join(", ")}.`,
      };
    },
  },
  {
    id: "site-top-page",
    ask: "Which page of the public site got the most views in the latest week of traffic data?",
    requires: { tools: ["site_traffic"] },
    truth: async ({ prisma }) => {
      const last = await prisma.siteTrafficDaily.findFirst({ where: { dimension: "total" }, orderBy: { date: "desc" } });
      if (!last) return null;
      const from = new Date(last.date.getTime() - 6 * DAY_MS);
      const [top] = await prisma.siteTrafficDaily.groupBy({ by: ["key"], where: { dimension: "path", date: { gte: from, lte: last.date } }, _sum: { pageviews: true }, orderBy: { _sum: { pageviews: "desc" } }, take: 1 });
      if (!top) return null;
      const views = top._sum.pageviews ?? 0;
      return {
        expected: `${top.key} (${views} views)`,
        check: ({ text }) => {
          // The home page is "/": "the home page" or a "/" standing on its own both name it
          const named = top.key === "/" ? /\bhome ?page\b|\bthe home\b|(^|[\s(`'"])\/(?=[\s).,`'"]|$)/im.test(text) : text.includes(top.key);
          return named ? null : `doesn't name ${top.key}`;
        },
        fakeAnswer: `${top.key === "/" ? "The home page (/)" : top.key} had the most views: ${views}.`,
        fakeCalls: [{ name: "site_traffic", input: { by: "path" } }],
        facts: `Top page ${top.key} with ${views} page views, ${from.toISOString().slice(0, 10)} to ${last.date.toISOString().slice(0, 10)} (UTC days).`,
      };
    },
  },
  {
    id: "site-week-vs-week",
    ask: "How many page views did the site get in the latest week of traffic data, and was that up or down from the week before?",
    requires: { tools: ["site_traffic"] },
    truth: async ({ prisma }) => {
      const last = await prisma.siteTrafficDaily.findFirst({ where: { dimension: "total" }, orderBy: { date: "desc" } });
      if (!last) return null;
      const sum = async (fromDays: number, toDays: number) =>
        (await prisma.siteTrafficDaily.aggregate({ where: { dimension: "total", date: { gte: new Date(last.date.getTime() - fromDays * DAY_MS), lte: new Date(last.date.getTime() - toDays * DAY_MS) } }, _sum: { pageviews: true } }))._sum.pageviews ?? 0;
      const [current, previous] = [await sum(6, 0), await sum(13, 7)];
      const direction = current >= previous ? "up" : "down";
      return {
        expected: `${current} page views, ${direction} from ${previous}`,
        check: ({ text }) => (!mentionsNumber(text, current, ["view", "page"]) ? `doesn't say ${current} page views` : !new RegExp(direction === "up" ? "\\b(up|more|increase|rose|grew|higher)" : "\\b(down|fewer|less|decrease|dropped|fell|lower)", "i").test(text) ? `doesn't say it went ${direction}` : null),
        fakeAnswer: `${current} page views, ${direction} from ${previous} the week before.`,
        fakeCalls: [{ name: "site_traffic", input: { compare: true } }],
        facts: `Latest 7 snapshot days: ${current} page views; the 7 before: ${previous}. Days are UTC.`,
      };
    },
  },
];
