// Changes to an existing event: details, status, registration settings and check-in settings. Used by
// the admin event actions (src/app/admin/events/actions.ts) and by Jack's event.update proposals.
//
// - Callers check permissions and parse their input first (the admin actions keep requireOfficer() and
//   the form parsers); services take plain values and an actor, and return result objects instead of
//   redirecting. Unexpected failures (a missing event, a database error) still throw.
// - Services don't refresh pages: revalidatePath only works inside a request. Each successful result
//   lists the paths it touched in `revalidate`; the caller passes them to revalidatePaths()
//   (src/server/cache/revalidate-public.ts), so the admin page and a proposal refresh the same pages.

import { Prisma, type AttendanceReportingMode, type EventStatus } from "@prisma/client";
import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import { publicPaths } from "@/server/cache/revalidate-public";
import { reconcileEventWaitlist } from "@/server/services/registration.service";
import { updateAttendanceConfig } from "@/server/services/attendance.service";
import { withActorMetadata, type ServiceActor } from "@/server/services/actor";
import type { parseEventForm, parseRegistrationConfigForm } from "@/schemas/event.schema";

/** The event form's fields as Event columns, as parseEventForm returns them */
export type EventDetails = Extract<ReturnType<typeof parseEventForm>, { ok: true }>["data"];

/** The registration settings card's fields, as parseRegistrationConfigForm returns them */
export type EventRegistrationSettings = Extract<ReturnType<typeof parseRegistrationConfigForm>, { ok: true }>["data"];

/** A status to set with the details (the event form's publish buttons) */
export type EventPublication = { status: EventStatus; publishedAt: Date | null };

export const SLUG_TAKEN = "Another event already uses that URL slug. Pick a different one.";

export function isSlugTaken(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const ADMIN_EVENTS = "/admin/events";
const manageEventPath = (eventId: string) => `/admin/events/${eventId}/manage`;

/**
 * Capacity raised (or made unlimited) or the fee removed: spots may have opened for people on the
 * waitlist, so the caller should reconcile. Undefined means the field isn't changing.
 */
function waitlistNeedsRefill(
  before: { registrationMax: number | null; registrationFeeCents: number | null } | null,
  registrationMax: number | null | undefined,
  registrationFeeCents: number | null | undefined,
) {
  if (!before) return false;
  const capacityRaised =
    registrationMax !== undefined &&
    before.registrationMax != null &&
    (registrationMax === null || registrationMax > before.registrationMax);
  const madeFree = (before.registrationFeeCents ?? 0) > 0 && registrationFeeCents === null;
  return capacityRaised || madeFree;
}

export type UpdateEventDetailsResult =
  | {
      ok: true;
      event: { id: string; slug: string; seriesId: string | null; title: string };
      /** People moved off the waitlist because capacity went up or the fee was removed (already notified) */
      promotedUserIds: string[];
      revalidate: string[];
    }
  | { ok: false; error: string };

/**
 * Saves an event's details, as the admin event form does. Fields left out of `details` stay as they
 * are; the admin form sends them all. `publish` sets the status too (a draft keeps its publish date);
 * null or absent leaves it. Turning check-in on means people have to check in. Raising capacity or
 * removing the fee reconciles the waitlist, which promotes and notifies people.
 */
export async function updateEventDetails(
  input: { eventId: string; details: Partial<EventDetails>; publish?: EventPublication | null },
  actor: ServiceActor,
): Promise<UpdateEventDetailsResult> {
  const { eventId, details, publish } = input;
  const before = await prisma.event.findUnique({
    where: { id: eventId },
    select: { registrationMax: true, registrationFeeCents: true },
  });

  const eventUpdateData: Prisma.EventUpdateInput = {
    ...details,
    // Turning check-in on from the event form means people have to check in
    ...(details.attendanceEnabled ? { attendanceReportingMode: "CHECKIN_REQUIRED" as const } : {}),
    // A draft keeps its publish date, as before
    ...(publish ? { status: publish.status, ...(publish.status === "DRAFT" ? {} : { publishedAt: publish.publishedAt }) } : {}),
  };

  let updated;
  try {
    updated = await prisma.event.update({
      where: { id: eventId },
      data: eventUpdateData,
      select: { slug: true, seriesId: true, title: true },
    });
  } catch (error) {
    if (isSlugTaken(error)) return { ok: false, error: SLUG_TAKEN };
    throw error;
  }

  const promotedUserIds = waitlistNeedsRefill(before, details.registrationMax, details.registrationFeeCents)
    ? await reconcileEventWaitlist(eventId)
    : [];

  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Updated event details for ${updated.title}`,
    after: eventUpdateData,
    metadata: withActorMetadata(actor),
  });

  return {
    ok: true,
    event: { id: eventId, ...updated },
    promotedUserIds,
    revalidate: [
      ADMIN_EVENTS,
      publicPaths.events,
      publicPaths.event(updated.slug),
      ...(updated.seriesId ? [publicPaths.series] : []),
    ],
  };
}

export type UpdateEventStatusResult = { ok: true; event: { id: string; slug: string }; revalidate: string[] };

/** Sets an event's status (the admin status override). `publishedAt` absent leaves the publish date as it is. */
export async function updateEventStatus(
  input: { eventId: string; status: EventStatus; publishedAt?: Date },
  actor: ServiceActor,
): Promise<UpdateEventStatusResult> {
  const { eventId, status, publishedAt } = input;
  const data: { status: EventStatus; publishedAt?: Date } = {
    status,
    publishedAt,
  };

  const updated = await prisma.event.update({
    where: { id: eventId },
    data,
    select: { slug: true },
  });

  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Updated event status to ${status}`,
    after: data,
    metadata: withActorMetadata(actor),
  });

  return {
    ok: true,
    event: { id: eventId, slug: updated.slug },
    revalidate: [ADMIN_EVENTS, publicPaths.events, publicPaths.event(updated.slug)],
  };
}

export type UpdateEventRegistrationResult = {
  ok: true;
  event: { id: string; slug: string };
  /** People moved off the waitlist (already notified) */
  promotedUserIds: string[];
  revalidate: string[];
};

/**
 * Saves an event's registration settings (the manage page's registration card). Fields left out stay
 * as they are. Switching auto-promotion on, raising capacity or removing the fee reconciles the
 * waitlist, which promotes and notifies people; the audit entry lists who was promoted.
 */
export async function updateEventRegistration(
  input: { eventId: string; settings: Partial<EventRegistrationSettings> },
  actor: ServiceActor,
): Promise<UpdateEventRegistrationResult> {
  const { eventId, settings } = input;
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { registrationMax: true, waitlistAutoPromote: true, registrationFeeCents: true },
  });

  const updated = await prisma.event.update({
    where: { id: eventId },
    data: settings,
    select: { slug: true },
  });

  const autoPromoteSwitchedOn = event != null && !event.waitlistAutoPromote && settings.waitlistAutoPromote === true;
  const promotedUserIds =
    autoPromoteSwitchedOn || waitlistNeedsRefill(event, settings.registrationMax, settings.registrationFeeCents)
      ? await reconcileEventWaitlist(eventId)
      : [];

  await createAuditLog({
    actorUserId: actor.userId,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Updated registration configuration for event ${eventId}`,
    metadata: withActorMetadata(actor, {
      updateType: "registration_config",
      promotedUserIds,
    }),
    after: settings,
  });

  return {
    ok: true,
    event: { id: eventId, slug: updated.slug },
    promotedUserIds,
    revalidate: [manageEventPath(eventId), publicPaths.events, publicPaths.event(updated.slug)],
  };
}

export type UpdateEventAttendanceResult = {
  ok: true;
  event: { id: string; slug: string; attendanceReportingMode: AttendanceReportingMode };
  revalidate: string[];
};

/**
 * Saves an event's check-in settings (the manage page's check-in card). Turning check-in on means people
 * have to check in. The audit entry is ATTENDANCE_CONFIG_UPDATE, written by the attendance service.
 */
export async function updateEventAttendance(
  input: { eventId: string; attendanceEnabled: boolean; attendanceOpensAt: Date | null; attendanceClosesAt: Date | null },
  actor: ServiceActor,
): Promise<UpdateEventAttendanceResult> {
  const { eventId, attendanceEnabled, attendanceOpensAt, attendanceClosesAt } = input;
  const updated = await updateAttendanceConfig(
    eventId,
    { attendanceEnabled, attendanceOpensAt, attendanceClosesAt },
    actor.userId,
    withActorMetadata(actor),
  );

  return {
    ok: true,
    event: { id: eventId, slug: updated.slug, attendanceReportingMode: updated.attendanceReportingMode },
    revalidate: [manageEventPath(eventId)],
  };
}
