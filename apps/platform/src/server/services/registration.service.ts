import { prisma } from "@/server/db";
import { RegistrationStatus, Prisma, Event } from "@prisma/client";
import { createAuditLog } from "@/server/audit/log";
import { sendNotification } from "@/server/services/notification.service";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Core Registration Service
 * Handles transactional logic for Event Registration, Waitlists, and Reconciliation.
 */

type PromotionNotificationEvent = Pick<
  Event,
  "id" | "title" | "slug" | "startsAtUtc" | "timezone" | "heroImageUrl"
>;

/**
 * Notifies users who were auto-promoted off the waitlist (fire and forget).
 * Call after the transaction that promoted them has committed.
 */
export function notifyPromotedUsers(event: PromotionNotificationEvent, promotedUserIds: string[]) {
  for (const promotedUserId of promotedUserIds) {
    sendNotification({
      userId: promotedUserId,
      type: "WAITLIST_PROMOTED",
      title: `You're in! Promoted from waitlist`,
      body: `A spot opened up for ${event.title}.`,
      actionUrl: `/events/${event.slug}`,
      channels: ["IN_APP", "EMAIL"],
      metadata: {
        eventId: event.id,
        title: event.title,
        startsAt: event.startsAtUtc,
        timezone: event.timezone || "America/Chicago",
        slug: event.slug,
        heroImageUrl: event.heroImageUrl,
      },
    }).catch((err) => console.error("[Notification] Failed to send waitlist promotion notification:", err));
  }
}

/**
 * Reconciles the event state:
 * 1. Calculates available slots.
 * 2. Promotes waitlisted users if slots are available (FIFO).
 * 3. Ensures consistency.
 *
 * Must be called within a transaction where the Event is locked.
 */
async function reconcileEvent(tx: Prisma.TransactionClient, eventId: string): Promise<string[]> {
  const event = await tx.event.findUnique({ where: { id: eventId } });
  if (!event) throw new Error("Event not found during reconciliation");

  // Never auto-promote on paid events: a waitlisted person hasn't paid yet. Officers promote by hand.
  if (event.registrationFeeCents != null && event.registrationFeeCents > 0) {
    return [];
  }

  const promotedUserIds: string[] = [];

  // No limit: there's nothing to wait for, so everyone is registered whatever the toggle says.
  if (event.registrationMax === null) {
    const waitlisted = await tx.eventRegistration.findMany({
      where: { eventId, status: "WAITLISTED" },
    });

    for (const reg of waitlisted) {
      await tx.eventRegistration.update({
        where: { id: reg.id },
        data: {
          status: "REGISTERED",
          promotedAt: new Date(),
          promotionSource: "AUTO",
          waitlistOrder: null, // Clear waitlist order
        },
      });
      promotedUserIds.push(reg.userId);
    }
    return promotedUserIds;
  }

  // Limited capacity: only fill open spots when auto-promotion is on for this event.
  if (!event.waitlistAutoPromote) {
    return [];
  }

  const registeredCount = await tx.eventRegistration.count({
    where: { eventId, status: "REGISTERED" },
  });

  const slotsAvailable = event.registrationMax - registeredCount;

  if (slotsAvailable > 0) {
    const promotions = await tx.eventRegistration.findMany({
      where: { eventId, status: "WAITLISTED" },
      orderBy: [
        { waitlistOrder: "asc" }, // Primary: FIFO / Admin Order
        { createdAt: "asc" },     // Fallback
      ],
      take: slotsAvailable,
    });

    for (const reg of promotions) {
      await tx.eventRegistration.update({
        where: { id: reg.id },
        data: {
          status: "REGISTERED",
          promotedAt: new Date(),
          promotionSource: "AUTO",
          waitlistOrder: null,
        },
      });
      promotedUserIds.push(reg.userId);
    }
  }

  return promotedUserIds;
}

/**
 * Member-facing Registration Action
 */
export async function registerForEvent(
  userId: string,
  eventId: string,
  intent: "YES" | "NO"
) {
  const result = await prisma.$transaction(async (tx) => {
    // 1. Lock the Event row to ensure sequential processing of capacity
    // This prevents race conditions where multiple users grab the last spot.
    await tx.$executeRaw`SELECT 1 FROM "Event" WHERE id = ${eventId} FOR UPDATE`;

    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (!event) throw new Error("Event not found");

    // 2. Validations (Member Rules)
    if (!event.registrationEnabled) {
      throw new Error("Registration is closed for this event.");
    }

    const now = new Date();
    if (event.registrationOpensAt && now < event.registrationOpensAt) {
      throw new Error("Registration has not opened yet.");
    }
    if (event.registrationClosesAt && now > event.registrationClosesAt) {
      throw new Error("Registration is closed.");
    }

    // 3. Get Current Registration
    const currentReg = await tx.eventRegistration.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });

    // Track promoted users for notifications
    let promotedUserIds: string[] = [];

    // 4. Handle "NO" (Not Attending)
    if (intent === "NO") {
      if (currentReg) {
        // If they were registered or waitlisted, this might open a spot
        await tx.eventRegistration.update({
          where: { id: currentReg.id },
          data: {
            status: "NOT_ATTENDING",
            waitlistOrder: null,
            // We keep the record to track they explicitly said NO
          },
        });

        // If they were registered, we must reconcile to potentially promote someone
        if (currentReg.status === "REGISTERED") {
          promotedUserIds = await reconcileEvent(tx, eventId);
        }
      } else {
        // Create explicit NO record
        await tx.eventRegistration.create({
          data: {
            eventId,
            userId,
            status: "NOT_ATTENDING",
          },
        });
      }
      return { status: "NOT_ATTENDING" as const, event, promotedUserIds };
    }

    // 5. Handle "YES" (Registering)

    // For paid events, block direct registration — must go through Stripe Checkout.
    // Exception: joining the waitlist is free when the event is full.
    if (event.registrationFeeCents != null && event.registrationFeeCents > 0) {
      let isFull = false;
      if (event.registrationMax !== null) {
        const registeredCount = await tx.eventRegistration.count({
          where: { eventId, status: "REGISTERED" },
        });
        const isAlreadyRegistered = currentReg?.status === "REGISTERED";
        isFull = !isAlreadyRegistered && registeredCount >= event.registrationMax;
      }

      if (!isFull) {
        // Slots available (or unlimited capacity) — must pay to register
        throw new Error("This event requires payment to register.");
      }
      // Event is full — fall through to waitlist logic below
      if (!event.registrationWaitlistEnabled) {
        throw new Error("Event is full and waitlist is disabled.");
      }
    }

    // Determine Target Status based on Capacity
    let targetStatus: RegistrationStatus = "REGISTERED";
    let waitlistOrder: number | null = null;

    if (event.registrationMax !== null) {
      const registeredCount = await tx.eventRegistration.count({
        where: { eventId, status: "REGISTERED" },
      });

      // Check if user is ALREADY registered, they take up a slot, so count remains same for them
      const isAlreadyRegistered = currentReg?.status === "REGISTERED";

      // If others are already waiting (auto-promote is off), nobody takes a freed spot ahead
      // of them, including someone already on the waitlist (they keep their place below).
      const othersWaiting =
        event.registrationWaitlistEnabled && !isAlreadyRegistered
          ? await tx.eventRegistration.count({ where: { eventId, status: "WAITLISTED", userId: { not: userId } } })
          : 0;

      if (!isAlreadyRegistered && (registeredCount >= event.registrationMax || othersWaiting > 0)) {
        // Full -> Waitlist
        if (!event.registrationWaitlistEnabled) {
          throw new Error("Event is full and waitlist is disabled.");
        }
        targetStatus = "WAITLISTED";

        // Calculate new Waitlist Order (Append to end)
        // We get the max order currently in DB
        const maxOrderAgg = await tx.eventRegistration.aggregate({
          where: { eventId, status: "WAITLISTED" },
          _max: { waitlistOrder: true },
        });
        waitlistOrder = (maxOrderAgg._max.waitlistOrder || 0) + 1;
      }
    }

    // Perform Update or Create
    if (currentReg) {
      // If switching from WAITLISTED to REGISTERED, logic is handled by "targetStatus" calculation above.
      // But usually, you can't jump queue manually unless space is free.
      // The logic above says: if space available -> REGISTERED.
      // If user is currently WAITLISTED and space opened up, they should have been auto-promoted.
      // But if they weren't (race condition), we re-evaluate here.

      // Preservation of Waitlist Position:
      // If user is WAITLISTED and stays WAITLISTED, keep order.
      if (currentReg.status === "WAITLISTED" && targetStatus === "WAITLISTED") {
        waitlistOrder = currentReg.waitlistOrder;
      }

      await tx.eventRegistration.update({
        where: { id: currentReg.id },
        data: {
          status: targetStatus,
          waitlistOrder: targetStatus === "WAITLISTED" ? waitlistOrder : null,
          // Reset promotion info if they re-register
          promotedAt: null,
          promotionSource: null,
        },
      });
    } else {
      await tx.eventRegistration.create({
        data: {
          eventId,
          userId,
          status: targetStatus,
          waitlistOrder: targetStatus === "WAITLISTED" ? waitlistOrder : null,
        },
      });
    }

    // Run reconciliation to ensure consistency (e.g. if we just filled the last spot, or if we jumped queue weirdly)
    // Actually, if we just took a spot, reconcile does nothing.
    // If we joined waitlist, reconcile does nothing.
    // But good practice to call it to catch edge cases.
    promotedUserIds = await reconcileEvent(tx, eventId);

    return { status: targetStatus, event, promotedUserIds };
  });

  // Send notifications after transaction commits (fire and forget)
  try {
    // Notify the registering user if they got registered
    if (result.status === "REGISTERED") {
      const tz = result.event.timezone || "America/Chicago";
      const eventDate = formatInTimeZone(result.event.startsAtUtc, tz, "EEEE, MMMM d 'at' h:mm a");
      sendNotification({
        userId,
        type: "REGISTRATION_CONFIRMED",
        title: `You're registered for ${result.event.title}!`,
        body: `See you on ${eventDate}.`,
        actionUrl: `/events/${result.event.slug}`,
        channels: ["IN_APP", "EMAIL"],
        metadata: {
          eventId,
          title: result.event.title,
          startsAt: result.event.startsAtUtc,
          timezone: tz,
          slug: result.event.slug,
          heroImageUrl: result.event.heroImageUrl,
        },
      }).catch((err) => console.error("[Notification] Failed to send registration notification:", err));
    }

    // Notify users who got promoted from waitlist
    notifyPromotedUsers(result.event, result.promotedUserIds);
  } catch (err) {
    // Don't fail the registration if notifications fail
    console.error("[Notification] Error sending notifications:", err);
  }

  return { status: result.status };
}

/**
 * Admin: Override Registration Status
 * Bypasses dates and enabled checks.
 * Triggers reconciliation.
 */
export async function adminOverrideRegistration(
  adminUserId: string,
  targetUserId: string,
  eventId: string,
  newStatus: RegistrationStatus,
  reason?: string
) {
  const result = await prisma.$transaction(async (tx) => {
    // Lock Event
    await tx.$executeRaw`SELECT 1 FROM "Event" WHERE id = ${eventId} FOR UPDATE`;

    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (!event) throw new Error("Event not found");

    const currentReg = await tx.eventRegistration.findUnique({
      where: { eventId_userId: { eventId, userId: targetUserId } },
    });

    // Calculate waitlist order if moving TO waitlist
    let waitlistOrder: number | null = null;
    if (newStatus === "WAITLISTED") {
      if (currentReg?.waitlistOrder) {
        waitlistOrder = currentReg.waitlistOrder;
      } else {
        const maxOrder = await tx.eventRegistration.aggregate({
          where: { eventId, status: "WAITLISTED" },
          _max: { waitlistOrder: true },
        });
        waitlistOrder = (maxOrder._max.waitlistOrder || 0) + 1;
      }
    }

    const wasPromotedByAdmin = newStatus === "REGISTERED" && currentReg?.status !== "REGISTERED";

    const data: Prisma.EventRegistrationUncheckedCreateInput = {
      eventId,
      userId: targetUserId,
      status: newStatus,
      waitlistOrder,
      statusReason: reason,
      promotionSource: wasPromotedByAdmin ? "ADMIN" : undefined,
      promotedAt: wasPromotedByAdmin ? new Date() : undefined,
    };

    if (currentReg) {
      await tx.eventRegistration.update({
        where: { id: currentReg.id },
        data: {
          status: newStatus,
          waitlistOrder: newStatus === "WAITLISTED" ? waitlistOrder : null,
          statusReason: reason,
          promotionSource: data.promotionSource,
          promotedAt: data.promotedAt,
        },
      });
    } else {
      await tx.eventRegistration.create({ data });
    }

    // Audit Log
    await createAuditLog(
      {
        actorUserId: adminUserId,
        actionType: "REGISTRATION_CHANGE",
        entityType: "EVENT_REGISTRATION",
        entityId: currentReg?.id || "NEW",
        targetUserId,
        summary: `Changed registration status for ${targetUserId} to ${newStatus}`,
        metadata: {
          eventId,
          targetUserId,
          oldStatus: currentReg?.status || "NONE",
          newStatus,
          reason,
        },
        before: currentReg ? { status: currentReg.status } : undefined,
        after: { status: newStatus },
      },
      tx
    );

    // Reconcile: E.g., if Admin removed a REGISTERED user, auto-promote next waitlisted.
    const promotedUserIds = await reconcileEvent(tx, eventId);

    return { event, wasPromotedByAdmin, promotedUserIds };
  });

  // Send notifications after transaction commits (fire and forget)
  try {
    // Notify user if they were promoted by admin
    if (result.wasPromotedByAdmin) {
      sendNotification({
        userId: targetUserId,
        type: "WAITLIST_PROMOTED",
        title: `You're in! Promoted from waitlist`,
        body: `An admin has registered you for ${result.event.title}.`,
        actionUrl: `/events/${result.event.slug}`,
        channels: ["IN_APP", "EMAIL"],
        metadata: {
          eventId,
          title: result.event.title,
          startsAt: result.event.startsAtUtc,
          timezone: result.event.timezone || "America/Chicago",
          slug: result.event.slug,
          heroImageUrl: result.event.heroImageUrl,
        },
      }).catch((err) =>
        console.error("[Notification] Failed to send admin promotion notification:", err)
      );
    }

    // Notify users who got auto-promoted from waitlist
    notifyPromotedUsers(result.event, result.promotedUserIds);
  } catch (err) {
    console.error("[Notification] Error sending notifications:", err);
  }
}

/**
 * Admin: Remove a registration entirely.
 * Frees the spot, auto-promotes from the waitlist where allowed, and audits the removal.
 */
export async function adminRemoveRegistration({
  eventId,
  userId,
  actorUserId,
}: {
  eventId: string;
  userId: string;
  actorUserId: string;
}) {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Event" WHERE id = ${eventId} FOR UPDATE`;

    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (!event) throw new Error("Event not found");

    const registration = await tx.eventRegistration.findUnique({
      where: { eventId_userId: { eventId, userId } },
    });
    if (!registration) throw new Error("Registration not found");

    await tx.eventRegistration.delete({ where: { id: registration.id } });

    const promotedUserIds = await reconcileEvent(tx, eventId);

    await createAuditLog(
      {
        actorUserId,
        actionType: "REGISTRATION_CHANGE",
        entityType: "EVENT_REGISTRATION",
        entityId: registration.id,
        targetUserId: userId,
        summary: `Removed registration for ${userId}`,
        metadata: {
          eventId,
          targetUserId: userId,
          oldStatus: registration.status,
          newStatus: "REMOVED",
          promotedUserIds,
        },
        before: {
          status: registration.status,
          waitlistOrder: registration.waitlistOrder,
          sourcePaymentId: registration.sourcePaymentId,
        },
      },
      tx
    );

    return { event, promotedUserIds };
  });

  notifyPromotedUsers(result.event, result.promotedUserIds);

  return { slug: result.event.slug };
}

/**
 * Re-runs waitlist promotion under the event lock, e.g. after capacity is raised
 * or auto-promotion is switched on. Returns the promoted user ids.
 */
export async function reconcileEventWaitlist(eventId: string): Promise<string[]> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT 1 FROM "Event" WHERE id = ${eventId} FOR UPDATE`;

    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (!event) throw new Error("Event not found");

    const promotedUserIds = await reconcileEvent(tx, eventId);
    return { event, promotedUserIds };
  });

  notifyPromotedUsers(result.event, result.promotedUserIds);

  return result.promotedUserIds;
}
