import { getStripe } from "@/lib/stripe";
import { prisma } from "@/server/db";
import { RegistrationStatus } from "@prisma/client";
import { createAuditLog } from "@/server/audit/log";
import { sendNotification } from "@/server/services/notification.service";
import { formatInTimeZone } from "date-fns-tz";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// Checkout Session Creation
// ---------------------------------------------------------------------------

export async function createEventCheckoutSession(
  userId: string,
  eventSlug: string
): Promise<string> {
  const event = await prisma.event.findUnique({ where: { slug: eventSlug } });
  if (!event) throw new Error("Event not found");

  if (!event.registrationEnabled) {
    throw new Error("Registration is closed for this event.");
  }
  if (event.registrationFeeCents == null || event.registrationFeeCents <= 0) {
    throw new Error("This event does not require payment.");
  }

  const now = new Date();
  if (event.registrationOpensAt && now < event.registrationOpensAt) {
    throw new Error("Registration has not opened yet.");
  }
  if (event.registrationClosesAt && now > event.registrationClosesAt) {
    throw new Error("Registration is closed.");
  }

  // Check if already registered
  const existing = await prisma.eventRegistration.findUnique({
    where: { eventId_userId: { eventId: event.id, userId } },
  });
  if (existing?.status === "REGISTERED") {
    throw new Error("You are already registered for this event.");
  }

  // Check capacity — if full, they should join waitlist (free) instead
  if (event.registrationMax !== null) {
    const registeredCount = await prisma.eventRegistration.count({
      where: { eventId: event.id, status: "REGISTERED" },
    });
    if (registeredCount >= event.registrationMax) {
      throw new Error(
        "This event is currently full. You can join the waitlist for free."
      );
    }
  }

  // Create a pending payment record
  const payment = await prisma.payment.create({
    data: {
      userId,
      productId: null,
      amountCents: event.registrationFeeCents,
      currency: "USD",
      provider: "stripe",
      status: "pending",
      metadata: {
        eventId: event.id,
        eventSlug: event.slug,
        eventTitle: event.title,
      },
    },
  });

  const baseUrl = getBaseUrl();

  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: event.registrationFeeCents,
          product_data: {
            name: `${event.title} — Registration`,
          },
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/events/${event.slug}?payment=success`,
    cancel_url: `${baseUrl}/events/${event.slug}?payment=cancelled`,
    metadata: {
      paymentId: payment.id,
      userId,
      eventId: event.id,
    },
    client_reference_id: payment.id,
  });

  // Store the checkout session ID as the provider reference
  await prisma.payment.update({
    where: { id: payment.id },
    data: { providerRef: session.id },
  });

  if (!session.url) {
    throw new Error("Failed to create Stripe Checkout session.");
  }

  return session.url;
}

// ---------------------------------------------------------------------------
// Product Checkout (dues, league entry)
// ---------------------------------------------------------------------------

export type CheckoutProductType = "ANNUAL_DUES" | "LEAGUE_FEE";

/** Where Stripe sends the member back after a product checkout. */
const PRODUCT_RETURN_PATHS: Record<string, string> = {
  "lone-star-cup": "/lone-star-cup",
};

function getBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000")
  );
}

/**
 * Starts a Stripe Checkout for a Product-backed purchase (annual dues or a
 * league entry fee) and returns the hosted checkout URL. The webhook turns the
 * resulting Payment into an Entitlement — see handleCheckoutCompleted.
 */
export async function createProductCheckoutSession(
  userId: string,
  productType: CheckoutProductType,
  leagueSlug?: string
): Promise<string> {
  if (productType === "LEAGUE_FEE" && !leagueSlug) {
    throw new Error("A league is required for a league entry fee.");
  }

  const product = await prisma.product.findFirst({
    where: {
      type: productType,
      active: true,
      ...(productType === "LEAGUE_FEE"
        ? { league: { slug: leagueSlug } }
        : { leagueId: null }),
    },
    include: { league: { select: { id: true, slug: true, name: true } } },
  });
  if (!product) throw new Error("This purchase is not available right now.");
  if (product.amountCents <= 0) {
    throw new Error("This purchase does not require payment.");
  }

  // Active entitlements decide whether there is anything left to buy.
  const now = new Date();
  const entitlements = await prisma.entitlement.findMany({
    where: {
      userId,
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gte: now } }],
    },
    select: { kind: true, leagueId: true },
  });
  const hasMembership = entitlements.some((e) => e.kind === "lsr_member");

  if (productType === "ANNUAL_DUES" && hasMembership) {
    throw new Error("Your LSR membership is already active.");
  }
  if (productType === "LEAGUE_FEE") {
    const alreadyEntered = entitlements.some(
      (e) => e.kind === "league_access" && e.leagueId === product.leagueId
    );
    if (alreadyEntered) {
      throw new Error(`You're already entered in ${product.league?.name ?? "this league"}.`);
    }
    // Pending #82: league entry is gated on an active membership.
    if (!hasMembership) {
      throw new Error("An active LSR membership is required to enter. Pay your dues first.");
    }
  }

  const payment = await prisma.payment.create({
    data: {
      userId,
      productId: product.id,
      amountCents: product.amountCents,
      currency: product.currency,
      provider: "stripe",
      status: "pending",
      metadata: {
        kind: "product",
        productType,
        productName: product.name,
        leagueId: product.leagueId,
        leagueSlug: product.league?.slug ?? null,
      },
    },
  });

  const returnPath =
    (leagueSlug && PRODUCT_RETURN_PATHS[leagueSlug]) || "/account";
  const baseUrl = getBaseUrl();

  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: product.currency.toLowerCase(),
          unit_amount: product.amountCents,
          product_data: { name: product.name },
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}${returnPath}?payment=success`,
    cancel_url: `${baseUrl}${returnPath}?payment=cancelled`,
    metadata: {
      paymentId: payment.id,
      userId,
      kind: "product",
      productType,
      leagueId: product.leagueId ?? "",
    },
    client_reference_id: payment.id,
  });

  await prisma.payment.update({
    where: { id: payment.id },
    data: { providerRef: session.id },
  });

  if (!session.url) {
    throw new Error("Failed to create Stripe Checkout session.");
  }

  return session.url;
}

// ---------------------------------------------------------------------------
// Webhook Handler
// ---------------------------------------------------------------------------

export async function handleStripeWebhook(
  rawBody: Buffer,
  signature: string
): Promise<void> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("Missing STRIPE_WEBHOOK_SECRET environment variable");
  }

  const event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(
        event.data.object as Stripe.Checkout.Session
      );
      break;
    case "charge.refunded":
      await handleChargeRefunded(event.data.object as Stripe.Charge);
      break;
    case "checkout.session.expired":
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
      break;
  }
}

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  const paymentId = session.metadata?.paymentId;
  if (!paymentId) {
    throw new Error("No paymentId in Stripe session metadata");
  }

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new Error(`Payment ${paymentId} not found`);

  // Idempotency: don't process twice
  if (payment.status === "succeeded") return;

  // Product-backed payments (dues, league entry) become entitlements.
  if (payment.productId) {
    await grantProduct(
      { id: payment.id, userId: payment.userId, productId: payment.productId },
      session
    );
    return;
  }

  const meta = payment.metadata as {
    eventId: string;
    eventSlug: string;
    eventTitle: string;
  };

  let registrationStatus: RegistrationStatus = "REGISTERED";
  let waitlistOrder: number | null = null;

  await prisma.$transaction(async (tx) => {
    // Update payment
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "succeeded",
        paidAt: new Date(),
        providerRef: (session.payment_intent as string) ?? session.id,
      },
    });

    // Lock event row for capacity check
    await tx.$executeRaw`SELECT 1 FROM "Event" WHERE id = ${meta.eventId} FOR UPDATE`;
    const event = await tx.event.findUnique({ where: { id: meta.eventId } });
    if (!event) throw new Error("Event not found");

    // Check capacity
    if (event.registrationMax !== null) {
      const registeredCount = await tx.eventRegistration.count({
        where: { eventId: meta.eventId, status: "REGISTERED" },
      });
      if (registeredCount >= event.registrationMax) {
        // Event filled while user was paying — go to waitlist
        registrationStatus = "WAITLISTED";
        const maxOrder = await tx.eventRegistration.aggregate({
          where: { eventId: meta.eventId, status: "WAITLISTED" },
          _max: { waitlistOrder: true },
        });
        waitlistOrder = (maxOrder._max.waitlistOrder || 0) + 1;
      }
    }

    // Upsert registration (user might already be WAITLISTED from a free waitlist join)
    const existing = await tx.eventRegistration.findUnique({
      where: { eventId_userId: { eventId: meta.eventId, userId: payment.userId } },
    });

    if (existing) {
      await tx.eventRegistration.update({
        where: { id: existing.id },
        data: {
          status: registrationStatus,
          waitlistOrder:
            registrationStatus === "WAITLISTED" ? waitlistOrder : null,
          sourcePaymentId: paymentId,
        },
      });
    } else {
      await tx.eventRegistration.create({
        data: {
          eventId: meta.eventId,
          userId: payment.userId,
          status: registrationStatus,
          waitlistOrder:
            registrationStatus === "WAITLISTED" ? waitlistOrder : null,
          sourcePaymentId: paymentId,
        },
      });
    }

    // NOTE: Do NOT call reconcileEvent here. For paid events, auto-promotion
    // is disabled — officers handle waitlist manually.
  });

  // Audit log (after transaction)
  await createAuditLog({
    actorUserId: null,
    actionType: "PAYMENT_SUCCEEDED",
    entityType: "PAYMENT",
    entityId: paymentId,
    targetUserId: payment.userId,
    summary: `Stripe checkout completed for event registration`,
    metadata: { sessionId: session.id, eventId: meta.eventId },
  });

  // Send notification (fire and forget)
  const event = await prisma.event.findUnique({
    where: { id: meta.eventId },
  });
  if (event && registrationStatus === "REGISTERED") {
    const tz = event.timezone || "America/Chicago";
    const eventDate = formatInTimeZone(event.startsAtUtc, tz, "EEEE, MMMM d 'at' h:mm a");
    sendNotification({
      userId: payment.userId,
      type: "REGISTRATION_CONFIRMED",
      title: `You're registered for ${event.title}!`,
      body: `Payment confirmed. See you on ${eventDate}.`,
      actionUrl: `/events/${event.slug}`,
      channels: ["IN_APP", "EMAIL"],
      metadata: {
        eventId: meta.eventId,
        title: event.title,
        startsAt: event.startsAtUtc,
        timezone: tz,
        slug: event.slug,
        heroImageUrl: event.heroImageUrl,
      },
    }).catch((err) =>
      console.error(
        "[Payment] Failed to send registration notification:",
        err
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Product payments → entitlements
// ---------------------------------------------------------------------------

/** End of the membership year (Aug 1 – Jul 31) that contains `now`. */
function membershipValidTo(now: Date): Date {
  const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(startYear + 1, 6, 31, 23, 59, 59, 999);
}

/**
 * Turns a succeeded product-backed Payment into an Entitlement (plus a
 * UserMembership row for dues, so the existing badge and admin tier view stay
 * correct), then audits and notifies. Runs inside handleCheckoutCompleted.
 */
async function grantProduct(
  payment: { id: string; userId: string; productId: string },
  session: Stripe.Checkout.Session
): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: payment.productId },
    include: { league: { select: { id: true, slug: true, name: true } } },
  });
  if (!product) throw new Error(`Product ${payment.productId} not found`);

  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "succeeded",
        paidAt: now,
        providerRef: (session.payment_intent as string) ?? session.id,
      },
    });

    if (product.type === "ANNUAL_DUES") {
      const validTo = membershipValidTo(now);

      // Dual-write: the badge (user-menu, layout) and /admin/users read UserMembership.
      // Mirrors the extend-or-create logic in server/actions/users.ts, and records
      // what it did so a refund can reverse exactly that (see revokeProduct).
      let membership: MembershipChange | null = null;
      const tier = await tx.membershipTier.findUnique({ where: { key: "LSR_MEMBER" } });
      if (tier) {
        const active = await tx.userMembership.findFirst({
          where: {
            userId: payment.userId,
            tierId: tier.id,
            validFrom: { lte: now },
            OR: [{ validTo: null }, { validTo: { gte: now } }],
          },
          orderBy: { validFrom: "desc" },
        });
        if (active) {
          await tx.userMembership.update({ where: { id: active.id }, data: { validTo } });
          membership = {
            id: active.id,
            action: "extended",
            previousValidTo: active.validTo?.toISOString() ?? null,
          };
        } else {
          const created = await tx.userMembership.create({
            data: { userId: payment.userId, tierId: tier.id, validFrom: now, validTo },
          });
          membership = { id: created.id, action: "created", previousValidTo: null };
        }
      }

      const entitlement = await tx.entitlement.create({
        data: {
          userId: payment.userId,
          kind: "lsr_member",
          scope: "year",
          validFrom: now,
          validTo,
          sourcePaymentId: payment.id,
          meta: membership ? { membership } : undefined,
        },
      });

      return { entitlement, validTo };
    }

    if (product.type === "LEAGUE_FEE") {
      if (!product.leagueId) throw new Error(`Product ${product.id} has no league`);

      // Entry runs to the end of the league's current season; the nearest
      // upcoming endAt wins, seasons with no endAt come last, then newest year.
      // Pending #82: confirm Season.endAt is the intended window.
      const season = await tx.season.findFirst({
        where: {
          leagueId: product.leagueId,
          OR: [{ endAt: null }, { endAt: { gte: now } }],
        },
        orderBy: [{ endAt: { sort: "asc", nulls: "last" } }, { year: "desc" }],
        select: { slug: true, endAt: true },
      });
      const validTo =
        season?.endAt ?? new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);

      const entitlement = await tx.entitlement.create({
        data: {
          userId: payment.userId,
          kind: "league_access",
          leagueId: product.leagueId,
          scope: "season",
          validFrom: now,
          validTo,
          sourcePaymentId: payment.id,
          meta: season ? { seasonSlug: season.slug } : undefined,
        },
      });

      return { entitlement, validTo };
    }

    throw new Error(`Product type ${product.type} is not purchasable through checkout`);
  });

  // Audit log (after transaction)
  await createAuditLog({
    actorUserId: null,
    actionType: "PAYMENT_SUCCEEDED",
    entityType: "PAYMENT",
    entityId: payment.id,
    targetUserId: payment.userId,
    summary: `Stripe checkout completed for ${product.name}`,
    metadata: {
      sessionId: session.id,
      productId: product.id,
      productType: product.type,
      leagueId: product.leagueId,
      entitlementId: result.entitlement.id,
      validTo: result.validTo,
    },
    after: result.entitlement,
  });

  // Send notification (fire and forget)
  const isDues = product.type === "ANNUAL_DUES";
  const through = formatInTimeZone(result.validTo, "America/Chicago", "MMMM d, yyyy");
  const leagueName = product.league?.name ?? "the league";
  const actionUrl = isDues
    ? "/account"
    : (product.league?.slug && PRODUCT_RETURN_PATHS[product.league.slug]) || "/account";

  sendNotification({
    userId: payment.userId,
    type: isDues ? "DUES_CONFIRMED" : "LEAGUE_REGISTERED",
    title: isDues ? "You're an LSR member!" : `You're entered in ${leagueName}!`,
    body: isDues
      ? `Payment confirmed. Your membership is active through ${through}.`
      : `Payment confirmed. Your ${leagueName} entry is active through ${through}.`,
    actionUrl,
    channels: ["IN_APP", "EMAIL"],
    metadata: {
      paymentId: payment.id,
      productId: product.id,
      productType: product.type,
      leagueId: product.leagueId,
      entitlementId: result.entitlement.id,
      validTo: result.validTo,
    },
  }).catch((err) =>
    console.error("[Payment] Failed to send product notification:", err)
  );
}

// ---------------------------------------------------------------------------
// charge.refunded
// ---------------------------------------------------------------------------

/** What grantProduct did to the dues UserMembership row, stored in Entitlement.meta. */
type MembershipChange = {
  id: string;
  action: "created" | "extended";
  previousValidTo: string | null;
};

async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  // Find payment by the payment_intent stored in providerRef
  const payment = await prisma.payment.findFirst({
    where: { providerRef: charge.payment_intent as string },
  });
  if (!payment) return; // Not a payment we track

  // Stripe sends charge.refunded for partial refunds too; only a full refund
  // (charge.refunded === true) takes the entitlement away.
  const revoked =
    payment.productId && charge.refunded
      ? await revokeProduct(payment.id, payment.userId)
      : [];

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "refunded" },
  });

  await createAuditLog({
    actorUserId: null,
    actionType: "PAYMENT_REFUNDED",
    entityType: "PAYMENT",
    entityId: payment.id,
    targetUserId: payment.userId,
    summary: revoked.length
      ? `Stripe charge refunded; ${revoked.length} entitlement(s) revoked`
      : `Stripe charge refunded`,
    metadata: {
      chargeId: charge.id,
      fullRefund: charge.refunded,
      amountRefunded: charge.amount_refunded,
      revokedEntitlementIds: revoked,
    },
  });
}

/**
 * Ends every entitlement a product payment granted and undoes the dues
 * dual-write on UserMembership using what grantProduct recorded in meta.
 * Returns the ids of the entitlements it revoked.
 */
async function revokeProduct(paymentId: string, userId: string): Promise<string[]> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const entitlements = await tx.entitlement.findMany({
      where: {
        sourcePaymentId: paymentId,
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
    });

    for (const e of entitlements) {
      await tx.entitlement.update({ where: { id: e.id }, data: { validTo: now } });

      const membership = (e.meta as { membership?: MembershipChange } | null)?.membership;
      if (e.kind === "lsr_member" && membership) {
        const row = await tx.userMembership.findFirst({
          where: { id: membership.id, userId },
        });
        if (row) {
          await tx.userMembership.update({
            where: { id: row.id },
            data: {
              validTo:
                membership.action === "extended"
                  ? membership.previousValidTo
                    ? new Date(membership.previousValidTo)
                    : null
                  : now,
            },
          });
        }
      }
    }

    return entitlements.map((e) => e.id);
  });
}

// ---------------------------------------------------------------------------
// checkout.session.expired
// ---------------------------------------------------------------------------

/** An abandoned Checkout Session: mark the still-pending Payment failed. */
async function handleCheckoutExpired(session: Stripe.Checkout.Session): Promise<void> {
  const paymentId = session.metadata?.paymentId;
  if (!paymentId) return;

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.status !== "pending") return;

  await prisma.payment.update({
    where: { id: paymentId },
    data: { status: "failed" },
  });

  await createAuditLog({
    actorUserId: null,
    actionType: "PAYMENT_EXPIRED",
    entityType: "PAYMENT",
    entityId: paymentId,
    targetUserId: payment.userId,
    summary: `Stripe checkout session expired before payment`,
    metadata: { sessionId: session.id },
  });
}
