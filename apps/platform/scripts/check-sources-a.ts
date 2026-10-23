/**
 * LOCAL ONLY: checks the sources-a track's database side (Jack 2.0: Stripe, Resend delivery, site
 * traffic) against the local Postgres, where the unit tests only see a mocked Prisma:
 * - a payout or dispute is never replaced by older data (a late webhook vs the daily sync), and two
 *   writers creating the same payout at once leave the newer copy;
 * - a dispute marks its charge, balance transactions set a charge's fee, net and payout, and the
 *   Payments panel's reads (stripeSnapshot, withPayments, openDisputesFor) run as SQL;
 * - delivery events are stored once per svix-id, and statuses, bounce lists and a recipient's mail are
 *   worked out from them; the Delivery tab's SQL counts match the same worked out email by email;
 * - a site traffic snapshot replaces a day's rows together, skips stored days, and the reads add up;
 * - jack_readonly can read StripeCharge (default privileges) and EmailEvent keeps its RLS policy.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-sources-a.ts
 *
 * Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. Everything it writes has a check_ id
 * (or a date in 1999) and is deleted at the end, pass or fail.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Stripe from "stripe";

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
}

async function main() {
  const { localDatabaseProblem } = await import("../src/server/jack/eval-support");
  const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
  if (problem) {
    console.error(`Refusing to run: ${problem}`);
    process.exit(1);
  }

  const { prisma } = await import("../src/server/db");
  const store = await import("../src/server/connectors/stripe/store");
  const read = await import("../src/server/connectors/stripe/read");
  const { emailEventRow, recordEmailEvent } = await import("../src/server/connectors/resend/webhook");
  const delivery = await import("../src/server/connectors/resend/delivery");
  const { snapshotSiteTraffic, windowDays } = await import("../src/server/connectors/site-traffic/snapshot");
  const traffic = await import("../src/server/connectors/site-traffic/read");

  const tag = randomBytes(4).toString("hex");
  const id = (prefix: string) => `${prefix}_check_${tag}`;
  const payoutId = id("po");
  const chargeId = id("ch");
  const disputeId = id("du");
  const refundId = id("re");
  const intent = id("pi");
  const recipient = `check-sources-a-${tag}@example.com`;
  const resendIds = [id("email_bounced"), id("email_ok")];
  const svixPrefix = `msg_check_${tag}`;
  const trafficNow = new Date("1999-02-01T09:00:00Z");
  const t = (seconds: number) => new Date(Date.UTC(2026, 9, 22, 12, 0, seconds));
  const payout = (status: string, extra: Record<string, unknown> = {}) =>
    ({ id: payoutId, amount: 1234, currency: "usd", status, arrival_date: 1_761_177_600, created: 1_761_000_000, method: "standard", failure_code: null, ...extra }) as unknown as Stripe.Payout;

  try {
    // Payouts: newer data wins, whichever arrives first
    check("a new payout is created", await store.savePayout(payout("in_transit"), t(20)));
    check("an older copy (a late webhook) doesn't replace it", !(await store.savePayout(payout("pending"), t(10))));
    let row = await prisma.stripePayout.findUnique({ where: { id: payoutId } });
    check("the stored payout is still the newer one", row?.status === "in_transit", row?.status);
    check("dates round-trip exactly (arrival at midnight UTC)", row?.arrivalDate.toISOString() === "2025-10-23T00:00:00.000Z", row?.arrivalDate.toISOString());
    check("a newer copy replaces it", await store.savePayout(payout("failed", { failure_code: "no_account" }), t(30)));
    row = await prisma.stripePayout.findUnique({ where: { id: payoutId } });
    check("the newer copy's status and failure are stored", row?.status === "failed" && row.failureCode === "no_account", JSON.stringify(row));
    await prisma.stripePayout.delete({ where: { id: payoutId } });
    await Promise.all([store.savePayout(payout("paid"), t(50)), store.savePayout(payout("in_transit"), t(40))]);
    row = await prisma.stripePayout.findUnique({ where: { id: payoutId } });
    check("two writers creating it at once leave the newer copy", row?.status === "paid" && row.syncedAt.getTime() === t(50).getTime(), JSON.stringify(row));

    // Charges, fees, payouts and disputes
    await store.saveCharge({ id: chargeId, payment_intent: intent, amount: 1000, amount_refunded: 0, currency: "usd", status: "succeeded", disputed: false, metadata: {}, created: 1_761_000_000 } as unknown as Stripe.Charge, new Date());
    const linked = await store.applyChargeTransactions([{ id: id("txn"), type: "charge", source: chargeId, fee: 59, net: 941 }, { id: id("txn_po"), type: "payout", source: payoutId, fee: 0, net: -941 }] as unknown as Stripe.BalanceTransaction[], payoutId);
    const charge = await prisma.stripeCharge.findUnique({ where: { id: chargeId } });
    check("a balance transaction sets the charge's fee, net and payout (and skips the payout itself)", linked === 1 && charge?.feeCents === 59 && charge.netCents === 941 && charge.payoutId === payoutId, JSON.stringify(charge));
    await store.saveCharge({ id: chargeId, payment_intent: intent, amount: 1000, amount_refunded: 500, currency: "usd", status: "succeeded", disputed: false, metadata: {}, created: 1_761_000_000 } as unknown as Stripe.Charge, new Date());
    const resynced = await prisma.stripeCharge.findUnique({ where: { id: chargeId } });
    check("re-syncing a charge keeps its fee and payout", resynced?.feeCents === 59 && resynced.payoutId === payoutId && resynced.amountRefundedCents === 500, JSON.stringify(resynced));
    await store.saveDispute({ id: disputeId, charge: chargeId, payment_intent: intent, amount: 1000, status: "needs_response", reason: "fraudulent", created: 1_761_000_000, evidence_details: { due_by: 1_761_500_000 } } as unknown as Stripe.Dispute, t(60));
    check("a dispute marks its charge disputed", (await prisma.stripeCharge.findUnique({ where: { id: chargeId } }))?.disputed === true);
    await store.saveRefund({ id: refundId, charge: chargeId, payment_intent: intent, amount: 500, status: "succeeded", created: 1_761_000_000 } as unknown as Stripe.Refund, new Date());

    const snapshot = await read.stripeSnapshot({ days: 400, limit: 50 });
    check("stripeSnapshot reads the payout with its linked charge", snapshot.payouts.some((p) => p.id === payoutId && p.charges === 1), JSON.stringify(snapshot.payouts.map((p) => [p.id, p.charges])));
    check("stripeSnapshot lists the open dispute first, and the refund", snapshot.disputes[0]?.id === disputeId && snapshot.refunds.some((r) => r.id === refundId), JSON.stringify(snapshot.disputes.map((d) => d.id)));
    const [joined] = await read.withPayments([resynced!]);
    check("withPayments finds no site payment for an unknown PaymentIntent", joined.payment === null && joined.payout?.id === payoutId);
    check("openDisputesFor finds the open dispute by PaymentIntent", (await read.openDisputesFor([intent])).get(intent)?.id === disputeId);

    // Email delivery: once per svix-id, statuses from all events
    const now = Date.now();
    const event = (resendId: string, type: string, minutesAgo: number, n: number, extra: Record<string, unknown> = {}) =>
      emailEventRow({ type, created_at: new Date(now - minutesAgo * 60_000).toISOString(), data: { email_id: resendId, to: [recipient], ...extra } }, `${svixPrefix}_${n}`)!;
    const rows = [
      event(resendIds[0], "email.bounced", 30, 1, { bounce: { type: "Permanent", subType: "General", message: "No such user" } }),
      event(resendIds[0], "email.sent", 31, 2),
      event(resendIds[1], "email.sent", 10, 3),
      event(resendIds[1], "email.delivered", 9, 4),
    ];
    const stored = [];
    for (const r of rows) stored.push(await recordEmailEvent(r));
    check("each event is stored", stored.every(Boolean));
    check("a retried delivery (same svix-id) stores nothing", !(await recordEmailEvent(rows[0])));
    check("the table has one row per svix-id", (await prisma.emailEvent.count({ where: { svixId: { startsWith: svixPrefix } } })) === 4);
    const statuses = await delivery.deliveryFor(resendIds);
    check("statuses come from all of an email's events", statuses.get(resendIds[0])?.status === "bounced" && statuses.get(resendIds[1])?.status === "delivered", JSON.stringify([...statuses]));
    const bounced = await delivery.bouncedRecipients(new Date(now - 3_600_000), 500);
    const mine = bounced.rows.find((r) => r.recipient === recipient);
    check("the bounce list has the address, its reason, and that a later email arrived", mine?.reason === "Permanent: No such user" && mine.deliveredSince === true, JSON.stringify(mine));
    const to = await delivery.emailsTo(recipient.toUpperCase(), new Date(now - 3_600_000));
    check("a recipient's mail, newest first, whatever the address's case", to.map((e) => e.resendId).join() === [resendIds[1], resendIds[0]].join(), JSON.stringify(to.map((e) => e.resendId)));
    // The Delivery tab's SQL counts against the same thing worked out email by email (every row in the window, not just these)
    const countSince = new Date(now - 30 * 86_400_000);
    const sqlCounts = await delivery.deliveryCounts(countSince);
    const ids = await prisma.emailEvent.findMany({ where: { occurredAt: { gte: countSince } }, distinct: ["resendId"], select: { resendId: true } });
    const byEmail = [...(await delivery.deliveryFor(ids.map((row) => row.resendId))).values()];
    const jsCounts = Object.fromEntries(Object.keys(sqlCounts.byStatus).map((status) => [status, byEmail.filter((d) => d.status === status).length]));
    check("deliveryCounts (SQL) matches each email's status worked out in code", sqlCounts.emails === byEmail.length && JSON.stringify(sqlCounts.byStatus) === JSON.stringify(jsCounts), JSON.stringify({ sql: sqlCounts, js: jsCounts }));
    check("deliveryCounts counts the bounced test email", sqlCounts.byStatus.bounced >= 1 && sqlCounts.byStatus.delivered >= 1);
    const allBounced = await delivery.bouncedRecipients(new Date(now - 3_600_000), 5_000);
    check("bouncedRecipientCount matches the bounce list's total", (await delivery.bouncedRecipientCount(new Date(now - 3_600_000))) === allBounced.total, String(allBounced.total));

    // Site traffic: a 1999 window, so no real (or fake) snapshot is touched
    let pathRows = 3;
    const stub = {
      count: async () => ({ pageviews: 10, visitors: 4 }),
      top: async (dimension: string) => (dimension === "path" ? Array.from({ length: pathRows }, (_, i) => ({ key: `/Check-${tag}-${i}`, pageviews: 3 - i, visitors: 1 })) : [{ key: "(direct)", pageviews: 10, visitors: 4 }]),
    };
    const window = windowDays(trafficNow);
    const first = await snapshotSiteTraffic(stub, { now: trafficNow });
    check("the first snapshot fills the whole window", first.counts.days === window.length, first.summary);
    check("a rerun stores nothing new", (await snapshotSiteTraffic(stub, { now: trafficNow })).counts.days === 0);
    const day = new Date(`${window[0]}T00:00:00.000Z`);
    await prisma.siteTrafficDaily.deleteMany({ where: { date: day, dimension: "total" } });
    pathRows = 1;
    await snapshotSiteTraffic(stub, { now: trafficNow });
    check("re-fetching a day replaces all its rows together", (await prisma.siteTrafficDaily.count({ where: { date: day, dimension: "path" } })) === 1);
    const top = await traffic.trafficTop("path", window[0], window[window.length - 1], { match: `check-${tag}`, limit: 5 });
    check("trafficTop adds days up and matches keys whatever their case", top[0]?.key === `/Check-${tag}-0` && top[0].pageviews === 3 * window.length && top[0].days === window.length, JSON.stringify(top[0]));
    const days = await traffic.trafficDaily(window[0], window[window.length - 1]);
    check("trafficDaily reads each day's total", days.length === window.length && days.every((d) => d.pageviews === 10));

    // Jack's SQL role
    const [grants] = await prisma.$queryRaw<{ charge: boolean; events: boolean }[]>`
      SELECT has_table_privilege('jack_readonly', 'public."StripeCharge"', 'SELECT') AS charge,
             EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'EmailEvent' AND 'jack_readonly' = ANY(roles)) AS events`;
    check("jack_readonly can read StripeCharge", grants?.charge === true);
    check("EmailEvent keeps its jack_readonly policy (RLS)", grants?.events === true);
  } finally {
    await prisma.stripeCharge.deleteMany({ where: { id: chargeId } });
    await prisma.stripePayout.deleteMany({ where: { id: payoutId } });
    await prisma.stripeDispute.deleteMany({ where: { id: disputeId } });
    await prisma.stripeRefund.deleteMany({ where: { id: refundId } });
    await prisma.emailEvent.deleteMany({ where: { svixId: { startsWith: svixPrefix } } });
    await prisma.siteTrafficDaily.deleteMany({ where: { date: { lt: new Date("2000-01-01T00:00:00Z") } } });
    await prisma.$disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
