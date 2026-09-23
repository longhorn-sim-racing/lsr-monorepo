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
// charge.refunded
// ---------------------------------------------------------------------------

async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  // Find payment by the payment_intent stored in providerRef
  const payment = await prisma.payment.findFirst({
    where: { providerRef: charge.payment_intent as string },
  });
  if (!payment) return; // Not a payment we track

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "refunded" },
  });

  await createAuditLog({
    actorUserId: null,
    actionType: "PAYMENT_REFUNDED",
    entityType: "PAYMENT",
    entityId: payment.id,
    summary: `Stripe charge refunded`,
    metadata: { chargeId: charge.id },
  });
}
