/**
 * Offline checks for the Stripe webhook — no Stripe API calls, no real keys.
 *
 * Creates throwaway users, an event and pending Payments in the LOCAL database,
 * feeds signed webhook events into handleStripeWebhook(), and checks the cases
 * from Alex's review of #95: duplicate and concurrent deliveries, redelivery
 * after a refund, unpaid and delayed payments, refunds after a later membership
 * change, never shortening a membership, and sessions this app didn't create.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/payments-webhook-check.ts
 *
 * Refuses to run against anything but a local database. Cleans up after itself.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "";
  }
})();
if (!["127.0.0.1", "localhost"].includes(dbHost)) {
  console.error(`Refusing to run: DATABASE_URL points at "${dbHost || "nothing"}", not a local database.`);
  process.exit(1);
}

// Signing and verifying webhooks is offline; this key is never sent anywhere.
process.env.STRIPE_SECRET_KEY = "sk_test_offline_webhook_check";
process.env.STRIPE_WEBHOOK_SECRET = `whsec_check_${Date.now()}`;
// db.ts logs every query unless NODE_ENV is production.
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

let failed = false;
let total = 0;
function check(name: string, ok: boolean, note?: string) {
  total++;
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
}

async function main() {
  const { prisma } = await import("../src/server/db");
  const { handleStripeWebhook } = await import("../src/server/services/payment.service");
  const { getStripe } = await import("../src/lib/stripe");
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET!;

  const ts = Date.now();
  let seq = 0;
  const userIds: string[] = [];
  let eventId: string | null = null;

  const send = (type: string, object: Record<string, unknown>) => {
    const payload = JSON.stringify({ id: `evt_check_${ts}_${++seq}`, object: "event", type, data: { object } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return handleStripeWebhook(Buffer.from(payload), header);
  };
  const session = (paymentId: string | null, pi: string, paid = true) => ({
    id: `cs_check_${ts}_${++seq}`,
    object: "checkout.session",
    payment_status: paid ? "paid" : "unpaid",
    payment_intent: pi,
    metadata: paymentId ? { paymentId } : {},
  });
  const refund = (pi: string) => ({
    id: `ch_check_${ts}_${++seq}`,
    object: "charge",
    payment_intent: pi,
    refunded: true,
    amount_refunded: 2000,
  });

  const mkUser = async (tag: string) => {
    const u = await prisma.user.create({
      data: { email: `wh-${tag}-${ts}@example.invalid`, handle: `wh-${tag}-${ts}`, displayName: `WH ${tag}`, marketingOptIn: false },
    });
    userIds.push(u.id);
    return u.id;
  };
  const mkPayment = (userId: string, productId: string | null, metadata?: Record<string, string>) =>
    prisma.payment.create({
      data: { userId, productId, amountCents: 2000, provider: "stripe", status: "pending", metadata },
    });
  const statusOf = async (id: string) => (await prisma.payment.findUnique({ where: { id } }))?.status;
  const activeMember = (userId: string) =>
    prisma.entitlement.findMany({
      where: { userId, kind: "lsr_member", OR: [{ validTo: null }, { validTo: { gt: new Date() } }] },
    });
  const membershipOf = (userId: string) =>
    prisma.userMembership.findFirst({ where: { userId }, orderBy: { validFrom: "desc" } });

  try {
    const dues = await prisma.product.findFirst({ where: { type: "ANNUAL_DUES", active: true, leagueId: null } });
    const tier = await prisma.membershipTier.findUnique({ where: { key: "LSR_MEMBER" } });
    if (!dues || !tier) {
      check("seed data present (dues product, LSR_MEMBER tier)", false, "run: prisma db seed");
      return;
    }
    const day = 86_400_000;

    // 1. The normal path still works, and a repeat delivery changes nothing.
    const u1 = await mkUser("normal");
    const p1 = await mkPayment(u1, dues.id);
    await send("checkout.session.completed", session(p1.id, `pi_${ts}_1`));
    check("paid dues: payment succeeded, one membership granted",
      (await statusOf(p1.id)) === "succeeded" && (await activeMember(u1)).length === 1);
    await send("checkout.session.completed", session(p1.id, `pi_${ts}_1`));
    check("repeat delivery: still one membership", (await activeMember(u1)).length === 1);

    // 2. Concurrent duplicate deliveries grant once (Alex #1).
    const u2 = await mkUser("concurrent");
    const p2 = await mkPayment(u2, dues.id);
    const dup = session(p2.id, `pi_${ts}_2`);
    await Promise.all([send("checkout.session.completed", dup), send("checkout.session.completed", dup)]);
    const grants2 = await prisma.auditLog.count({ where: { entityId: p2.id, actionType: "PAYMENT_SUCCEEDED" } });
    check("concurrent duplicates: one membership, one audit row",
      (await activeMember(u2)).length === 1 && grants2 === 1, `${(await activeMember(u2)).length} active, ${grants2} audits`);

    // 3. A redelivery after a full refund doesn't re-grant (Alex #1).
    await send("charge.refunded", refund(`pi_${ts}_1`));
    check("full refund: membership ended", (await activeMember(u1)).length === 0 && (await statusOf(p1.id)) === "refunded");
    await send("checkout.session.completed", session(p1.id, `pi_${ts}_1`));
    check("redelivery after refund: stays refunded, nothing granted",
      (await statusOf(p1.id)) === "refunded" && (await activeMember(u1)).length === 0);

    // 4. An unpaid session grants nothing; the delayed success does (Alex #2).
    const u3 = await mkUser("delayed");
    const p3 = await mkPayment(u3, dues.id);
    await send("checkout.session.completed", session(p3.id, `pi_${ts}_3`, false));
    check("unpaid completed session: still pending, nothing granted",
      (await statusOf(p3.id)) === "pending" && (await activeMember(u3)).length === 0);
    await send("checkout.session.async_payment_succeeded", session(p3.id, `pi_${ts}_3`));
    check("delayed payment succeeds: membership granted",
      (await statusOf(p3.id)) === "succeeded" && (await activeMember(u3)).length === 1);

    // 5. A delayed failure marks it failed, and nothing can grant it afterwards.
    const u4 = await mkUser("failed");
    const p4 = await mkPayment(u4, dues.id);
    await send("checkout.session.async_payment_failed", session(p4.id, `pi_${ts}_4`, false));
    const failedAudit = await prisma.auditLog.count({ where: { entityId: p4.id, actionType: "PAYMENT_FAILED" } });
    check("delayed payment fails: payment failed, audited", (await statusOf(p4.id)) === "failed" && failedAudit === 1);
    await send("checkout.session.completed", session(p4.id, `pi_${ts}_4`));
    check("paid event after failure: stays failed, nothing granted",
      (await statusOf(p4.id)) === "failed" && (await activeMember(u4)).length === 0);

    // 6. A refund doesn't erase a later membership change (Alex #3).
    const u5 = await mkUser("later-change");
    const p5 = await mkPayment(u5, dues.id);
    await send("checkout.session.completed", session(p5.id, `pi_${ts}_5`));
    const m5 = await membershipOf(u5);
    const extended = new Date(Date.now() + 730 * day);
    await prisma.userMembership.update({ where: { id: m5!.id }, data: { validTo: extended } });
    await send("charge.refunded", refund(`pi_${ts}_5`));
    const m5after = await membershipOf(u5);
    check("refund after an officer extension: extension kept, entitlement ended",
      m5after?.validTo?.getTime() === extended.getTime() && (await activeMember(u5)).length === 0,
      m5after?.validTo?.toISOString());

    // 7. Dues never shorten an open-ended or later-ending membership (Alex #4).
    const u6 = await mkUser("open-ended");
    await prisma.userMembership.create({ data: { userId: u6, tierId: tier.id, validFrom: new Date(Date.now() - 10 * day), validTo: null } });
    const p6 = await mkPayment(u6, dues.id);
    await send("checkout.session.completed", session(p6.id, `pi_${ts}_6`));
    check("open-ended membership: stays open-ended after paying", (await membershipOf(u6))?.validTo === null);
    await send("charge.refunded", refund(`pi_${ts}_6`));
    check("open-ended membership: still open-ended after the refund", (await membershipOf(u6))?.validTo === null);

    const u7 = await mkUser("longer");
    const longer = new Date(Date.now() + 1095 * day);
    await prisma.userMembership.create({ data: { userId: u7, tierId: tier.id, validFrom: new Date(Date.now() - 10 * day), validTo: longer } });
    const p7 = await mkPayment(u7, dues.id);
    await send("checkout.session.completed", session(p7.id, `pi_${ts}_7`));
    check("later-ending membership: not shortened", (await membershipOf(u7))?.validTo?.getTime() === longer.getTime());

    // 8. A shorter membership is still extended, and a refund restores it.
    const u8 = await mkUser("extend");
    const shorter = new Date(Date.now() + 10 * day);
    await prisma.userMembership.create({ data: { userId: u8, tierId: tier.id, validFrom: new Date(Date.now() - 10 * day), validTo: shorter } });
    const p8 = await mkPayment(u8, dues.id);
    await send("checkout.session.completed", session(p8.id, `pi_${ts}_8`));
    const ent8 = (await activeMember(u8))[0];
    check("shorter membership: extended to the dues end date",
      !!ent8 && (await membershipOf(u8))?.validTo?.getTime() === ent8.validTo?.getTime());
    await send("charge.refunded", refund(`pi_${ts}_8`));
    check("shorter membership: refund restores the original end date",
      (await membershipOf(u8))?.validTo?.getTime() === shorter.getTime());

    // 9. Sessions this app didn't create are ignored, not rejected.
    let threw = false;
    try {
      await send("checkout.session.completed", session(null, `pi_${ts}_9`));
      await send("checkout.session.completed", session("00000000-0000-0000-0000-000000000000", `pi_${ts}_9`));
      await send("checkout.session.expired", session(null, `pi_${ts}_9`, false));
    } catch {
      threw = true;
    }
    check("unknown sessions: ignored without an error", !threw);

    // 9b. Paying for something they already have (an officer entered them while the
    // checkout was open) records the payment, grants nothing more, and flags it. No refund.
    const lsc = await prisma.product.findFirst({ where: { type: "LEAGUE_FEE", league: { slug: "lone-star-cup" } } });
    if (lsc?.leagueId) {
      const u8 = await mkUser("dupe");
      // Like a real manual entry: runs to the end of the open season.
      const { getOpenLeagueSeason } = await import("../src/server/services/league-entry.service");
      const openSeason = await getOpenLeagueSeason(lsc.leagueId);
      const manual = await prisma.entitlement.create({
        data: {
          userId: u8, kind: "league_access", leagueId: lsc.leagueId, scope: "season", validFrom: new Date(),
          validTo: openSeason?.endAt ?? new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999), meta: { source: "manual" },
        },
      });
      const p8 = await mkPayment(u8, lsc.id);
      await send("checkout.session.completed", session(p8.id, `pi_${ts}_9b`));
      const after = await prisma.payment.findUnique({ where: { id: p8.id } });
      const entries = await prisma.entitlement.count({ where: { userId: u8, kind: "league_access" } });
      const dupeAudit = await prisma.auditLog.count({ where: { entityId: p8.id, actionType: "PAYMENT_DUPLICATE" } });
      check("already entered: payment kept, no second entry, flagged for an officer",
        after?.status === "succeeded" && entries === 1 &&
          (after.metadata as Record<string, unknown>)?.duplicateOfEntitlementId === manual.id && dupeAudit === 1,
        `status=${after?.status} entries=${entries} audits=${dupeAudit}`);

      // An officer refunds the flagged payment in Stripe: it's marked refunded and the
      // entry it duplicated is untouched.
      await send("charge.refunded", refund(`pi_${ts}_9b`));
      const manualAfter = await prisma.entitlement.findUnique({ where: { id: manual.id } });
      check("refunding a flagged duplicate: refunded, original entry untouched",
        (await statusOf(p8.id)) === "refunded" && manualAfter?.validTo?.getTime() === manual.validTo?.getTime());

      // A shorter existing entry doesn't make a payment a duplicate; the payment grants.
      const u10 = await mkUser("short");
      await prisma.entitlement.create({
        data: { userId: u10, kind: "league_access", leagueId: lsc.leagueId, scope: "season", validFrom: new Date(), validTo: new Date(Date.now() + 60_000), meta: { source: "manual" } },
      });
      const p10 = await mkPayment(u10, lsc.id);
      await send("checkout.session.completed", session(p10.id, `pi_${ts}_9c`));
      const p10After = await prisma.payment.findUnique({ where: { id: p10.id } });
      const u10Entries = await prisma.entitlement.count({ where: { userId: u10, kind: "league_access" } });
      check("shorter existing entry: payment grants, not flagged",
        p10After?.status === "succeeded" && u10Entries === 2 &&
          (p10After.metadata as Record<string, unknown> | null)?.duplicateOfEntitlementId === undefined,
        `entries=${u10Entries}`);
    } else {
      check("LSC product seeded (for the duplicate-payment case)", false, "run: prisma db seed");
    }

    // 10. Paid event seats: concurrent duplicates register once (same claim).
    const event = await prisma.event.create({
      data: {
        slug: `wh-check-${ts}`,
        title: "Webhook check event",
        startsAtUtc: new Date(Date.now() + 7 * day),
        endsAtUtc: new Date(Date.now() + 7 * day + 3_600_000),
        timezone: "America/Chicago",
        registrationEnabled: true,
        registrationMax: 10,
        registrationFeeCents: 1000,
      },
    });
    eventId = event.id;
    const u9 = await mkUser("seat");
    const p9 = await mkPayment(u9, null, { eventId: event.id, eventSlug: event.slug, eventTitle: event.title });
    const seat = session(p9.id, `pi_${ts}_10`);
    await Promise.all([send("checkout.session.completed", seat), send("checkout.session.completed", seat)]);
    const regs = await prisma.eventRegistration.findMany({ where: { eventId: event.id, userId: u9 } });
    const seatAudits = await prisma.auditLog.count({ where: { entityId: p9.id, actionType: "PAYMENT_SUCCEEDED" } });
    check("paid event, concurrent duplicates: one registration, one audit row",
      regs.length === 1 && regs[0].status === "REGISTERED" && regs[0].sourcePaymentId === p9.id && seatAudits === 1,
      `${regs.length} registrations, ${seatAudits} audits`);
  } finally {
    if (userIds.length) {
      await prisma.auditLog.deleteMany({ where: { targetUserId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }); // cascades payments, entitlements, memberships, registrations
    }
    if (eventId) await prisma.event.delete({ where: { id: eventId } });
    await prisma.$disconnect();
    console.log(`\n${failed ? "FAILED" : "ALL PASS"} · ${total} checks · fixtures removed`);
  }
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((e) => {
    console.error("\nwebhook check crashed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
