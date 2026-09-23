/**
 * Service-level smoke test for product payments (dues + league entry).
 *
 * Exercises createProductCheckoutSession() against Stripe TEST mode (real
 * Checkout Sessions, no charges), then feeds signed webhook events straight
 * into handleStripeWebhook() and asserts the database side effects — the
 * checklist in docs/payments-test-checklist.md, steps 1–8, without a browser.
 *
 *   STRIPE_TEST_SECRET_KEY=sk_test_… pnpm --filter @lsr/platform exec tsx scripts/payments-smoke.ts
 *
 * Refuses to run unless the resolved STRIPE_SECRET_KEY is a test-mode key.
 * Needs the local Supabase stack (DATABASE_URL in .env) and seeded Product rows.
 * Creates a throwaway user and deletes it at the end (pass --keep to retain).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// env — load .env.local / .env without overriding what's already set
// ---------------------------------------------------------------------------
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
if (process.env.STRIPE_TEST_SECRET_KEY) {
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_TEST_SECRET_KEY;
}
if (!(process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_")) {
  console.error(
    "Refusing to run: STRIPE_SECRET_KEY is not a test-mode key. " +
      "Pass STRIPE_TEST_SECRET_KEY=sk_test_… in the environment."
  );
  process.exit(1);
}
// The webhook secret only has to match what we sign with below.
process.env.STRIPE_WEBHOOK_SECRET = `whsec_smoke_${Date.now()}`;
process.env.NEXT_PUBLIC_SITE_URL ??= "http://localhost:3000";

const KEEP = process.argv.includes("--keep");
const results: { step: string; ok: boolean; note?: string }[] = [];
let failed = false;

function check(step: string, ok: boolean, note?: string) {
  results.push({ step, ok, note });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${note ? `  — ${note}` : ""}`);
}

async function expectThrow(step: string, fn: () => Promise<unknown>, contains: string) {
  try {
    await fn();
    check(step, false, "did not throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(step, msg.includes(contains), msg);
  }
}

async function main() {
  const { prisma } = await import("../src/server/db");
  const { createProductCheckoutSession, handleStripeWebhook } = await import(
    "../src/server/services/payment.service"
  );
  const { getStripe } = await import("../src/lib/stripe");
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET!;

  const sign = (event: Record<string, unknown>) => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return handleStripeWebhook(Buffer.from(payload), header);
  };
  const completedEvent = (sessionId: string, paymentId: string, paymentIntent: string, n: number) => ({
    id: `evt_smoke_completed_${n}`,
    object: "event",
    api_version: "2024-06-20",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        payment_intent: paymentIntent,
        metadata: { paymentId, kind: "product" },
      },
    },
  });
  const refundedEvent = (paymentIntent: string, full: boolean, n: number) => ({
    id: `evt_smoke_refunded_${n}`,
    object: "event",
    type: "charge.refunded",
    data: {
      object: {
        id: `ch_smoke_${n}`,
        object: "charge",
        payment_intent: paymentIntent,
        refunded: full,
        amount_refunded: full ? 2000 : 500,
      },
    },
  });
  const expiredEvent = (sessionId: string, paymentId: string, n: number) => ({
    id: `evt_smoke_expired_${n}`,
    object: "event",
    type: "checkout.session.expired",
    data: {
      object: { id: sessionId, object: "checkout.session", status: "expired", metadata: { paymentId } },
    },
  });

  const ts = Date.now();
  const sessionsToExpire: string[] = [];

  // ---- preconditions
  const dues = await prisma.product.findFirst({ where: { type: "ANNUAL_DUES", active: true } });
  const lsc = await prisma.product.findFirst({
    where: { type: "LEAGUE_FEE", active: true, league: { slug: "lone-star-cup" } },
  });
  check("seed: Product rows present", !!dues && !!lsc, !dues || !lsc ? "run: pnpm --filter @lsr/platform exec prisma db seed" : undefined);
  if (!dues || !lsc) return finish(prisma, null);

  const user = await prisma.user.create({
    data: {
      email: `payments-smoke-${ts}@example.invalid`,
      handle: `payments-smoke-${ts}`,
      displayName: "Payments Smoke",
      marketingOptIn: false, // no email attempts; in-app notifications only
    },
  });
  console.log(`user ${user.id} (${user.handle})`);

  try {
    // ---- 1. LSC before dues is refused
    await expectThrow(
      "LSC entry without dues → 400",
      () => createProductCheckoutSession(user.id, "LEAGUE_FEE", "lone-star-cup"),
      "membership is required"
    );

    // ---- 2. dues checkout
    const duesUrl = await createProductCheckoutSession(user.id, "ANNUAL_DUES");
    check("dues checkout returns a Stripe URL", duesUrl.startsWith("https://checkout.stripe.com/"), duesUrl.slice(0, 40));
    const duesPayment = await prisma.payment.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
    check(
      "dues Payment pending with productId",
      duesPayment?.status === "pending" && duesPayment.productId === dues.id && !!duesPayment.providerRef?.startsWith("cs_test_")
    );
    if (duesPayment?.providerRef) sessionsToExpire.push(duesPayment.providerRef);

    // ---- 3. complete it
    const pi1 = `pi_smoke_${ts}_1`;
    await sign(completedEvent(duesPayment!.providerRef!, duesPayment!.id, pi1, 1));
    const paid = await prisma.payment.findUnique({ where: { id: duesPayment!.id } });
    check("Payment → succeeded, providerRef = payment_intent", paid?.status === "succeeded" && paid.providerRef === pi1 && !!paid.paidAt);

    const ent = await prisma.entitlement.findFirst({ where: { userId: user.id, kind: "lsr_member" } });
    const now = new Date();
    const expectYear = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
    check(
      "Entitlement lsr_member through Jul 31",
      !!ent && ent.sourcePaymentId === duesPayment!.id && ent.validTo?.getFullYear() === expectYear && ent.validTo.getMonth() === 6 && ent.validTo.getDate() === 31,
      ent?.validTo?.toISOString()
    );
    const meta = ent?.meta as { membership?: { id: string; action: string } } | null;
    check("Entitlement.meta records the membership change", meta?.membership?.action === "created", JSON.stringify(meta));

    const um = await prisma.userMembership.findFirst({
      where: { userId: user.id, tier: { key: "LSR_MEMBER" }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
    });
    check("UserMembership LSR_MEMBER active (dual-write)", !!um && um.validTo?.getTime() === ent?.validTo?.getTime());

    const audit1 = await prisma.auditLog.findFirst({ where: { entityId: duesPayment!.id, actionType: "PAYMENT_SUCCEEDED" } });
    check("AuditLog PAYMENT_SUCCEEDED", !!audit1 && audit1.targetUserId === user.id);

    const notif1 = await prisma.notification.findMany({ where: { userId: user.id, type: "DUES_CONFIRMED" } });
    check(
      "Notification DUES_CONFIRMED in-app only (opted out of email)",
      notif1.length === 1 && notif1[0].channel === "IN_APP" && notif1[0].actionUrl === "/account",
      notif1.map((n) => `${n.channel}:${n.status}`).join(",")
    );

    // ---- 4. replay is a no-op
    const before = await Promise.all([prisma.entitlement.count({ where: { userId: user.id } }), prisma.notification.count({ where: { userId: user.id } }), prisma.auditLog.count({ where: { entityId: duesPayment!.id } })]);
    await sign(completedEvent(duesPayment!.providerRef!, duesPayment!.id, pi1, 1));
    const after = await Promise.all([prisma.entitlement.count({ where: { userId: user.id } }), prisma.notification.count({ where: { userId: user.id } }), prisma.auditLog.count({ where: { entityId: duesPayment!.id } })]);
    check("webhook replay changes nothing", before.join() === after.join(), `${before.join()} → ${after.join()}`);

    // ---- 5. dues again is refused
    await expectThrow("dues again → 400", () => createProductCheckoutSession(user.id, "ANNUAL_DUES"), "already active");

    // ---- 6. LSC entry now allowed
    const lscUrl = await createProductCheckoutSession(user.id, "LEAGUE_FEE", "lone-star-cup");
    check("LSC checkout returns a Stripe URL", lscUrl.startsWith("https://checkout.stripe.com/"));
    const lscPayment = await prisma.payment.findFirst({ where: { userId: user.id, productId: lsc.id } });
    if (lscPayment?.providerRef) sessionsToExpire.push(lscPayment.providerRef);
    const pi2 = `pi_smoke_${ts}_2`;
    await sign(completedEvent(lscPayment!.providerRef!, lscPayment!.id, pi2, 2));
    const lscEnt = await prisma.entitlement.findFirst({ where: { userId: user.id, kind: "league_access" } });
    const season = await prisma.season.findFirst({
      where: { league: { slug: "lone-star-cup" }, OR: [{ endAt: null }, { endAt: { gte: now } }] },
      orderBy: [{ endAt: { sort: "asc", nulls: "last" } }, { year: "desc" }],
    });
    const expectedTo = season?.endAt ?? new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    check(
      "Entitlement league_access through Season.endAt (or Dec 31)",
      !!lscEnt && lscEnt.leagueId === lsc.leagueId && lscEnt.validTo?.getTime() === expectedTo.getTime(),
      `validTo=${lscEnt?.validTo?.toISOString()} season=${season?.slug ?? "none"}`
    );
    const notif2 = await prisma.notification.findFirst({ where: { userId: user.id, type: "LEAGUE_REGISTERED" } });
    check("Notification LEAGUE_REGISTERED → /lone-star-cup", notif2?.actionUrl === "/lone-star-cup");

    // ---- 7. LSC again is refused
    await expectThrow("LSC again → 400", () => createProductCheckoutSession(user.id, "LEAGUE_FEE", "lone-star-cup"), "already entered");

    // ---- 8. full refund of dues revokes entitlement + membership
    await sign(refundedEvent(pi1, true, 1));
    const refunded = await prisma.payment.findUnique({ where: { id: duesPayment!.id } });
    const entAfter = await prisma.entitlement.findUnique({ where: { id: ent!.id } });
    const umAfter = await prisma.userMembership.findUnique({ where: { id: um!.id } });
    check("full refund: Payment refunded", refunded?.status === "refunded");
    check("full refund: entitlement ended", !!entAfter?.validTo && entAfter.validTo <= new Date());
    check("full refund: created membership expired", !!umAfter?.validTo && umAfter.validTo <= new Date());
    const audit2 = await prisma.auditLog.findFirst({ where: { entityId: duesPayment!.id, actionType: "PAYMENT_REFUNDED" } });
    const revoked = (audit2?.metadata as { revokedEntitlementIds?: string[] } | null)?.revokedEntitlementIds ?? [];
    check("full refund: audit lists revoked entitlement", revoked.includes(ent!.id));

    // ---- 9. partial refund of LSC keeps the entitlement
    await sign(refundedEvent(pi2, false, 2));
    const lscEntAfter = await prisma.entitlement.findUnique({ where: { id: lscEnt!.id } });
    const lscPayAfter = await prisma.payment.findUnique({ where: { id: lscPayment!.id } });
    check("partial refund: Payment refunded, entitlement kept", lscPayAfter?.status === "refunded" && lscEntAfter?.validTo?.getTime() === expectedTo.getTime());

    // ---- 10. expired session → failed (dues is purchasable again after the refund)
    const dues2Url = await createProductCheckoutSession(user.id, "ANNUAL_DUES");
    check("dues purchasable again after refund", dues2Url.startsWith("https://checkout.stripe.com/"));
    const dues2 = await prisma.payment.findFirst({ where: { userId: user.id, status: "pending" } });
    if (dues2?.providerRef) sessionsToExpire.push(dues2.providerRef);
    await sign(expiredEvent(dues2!.providerRef!, dues2!.id, 1));
    const dues2After = await prisma.payment.findUnique({ where: { id: dues2!.id } });
    const audit3 = await prisma.auditLog.findFirst({ where: { entityId: dues2!.id, actionType: "PAYMENT_EXPIRED" } });
    check("expired session: Payment failed + audit", dues2After?.status === "failed" && !!audit3);
  } finally {
    // tidy the open test-mode sessions in Stripe (best effort)
    for (const id of sessionsToExpire) {
      await stripe.checkout.sessions.expire(id).catch(() => undefined);
    }
    await finish(prisma, KEEP ? null : user.id);
  }
}

async function finish(prisma: { user: { delete: (a: { where: { id: string } }) => Promise<unknown> }; $disconnect: () => Promise<void> }, deleteUserId: string | null) {
  if (deleteUserId) {
    await prisma.user.delete({ where: { id: deleteUserId } }); // cascades payments, entitlements, memberships, notifications
    console.log("cleaned up test user");
  }
  await prisma.$disconnect();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
