"use server"

import { EventStatus, Prisma, RegistrationStatus } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import { requireOfficer } from "@/server/auth/guards";
import {
  revalidateEventList,
  revalidateEventDetail,
  revalidateSeriesPages,
} from "@/server/cache/revalidate-public";
import {
  adminOverrideRegistration,
  adminRemoveRegistration,
  reconcileEventWaitlist,
} from "@/server/services/registration.service";
import { updateAttendanceConfig, checkInUser, removeCheckIn } from "@/server/services/attendance.service";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { parseEventForm, parseRegistrationConfigForm } from "@/schemas/event.schema";
import type { ActionResult } from "@/lib/action-result";

/** The status the publish buttons ask for; null leaves it as it is */
function publication(formData: FormData, timezone: string): { status: EventStatus; publishedAt: Date | null } | { error: string } | null {
  const submitAction = formData.get("submitAction");
  if (submitAction === "publish") return { status: "PUBLISHED", publishedAt: new Date() };
  if (submitAction === "draft") return { status: "DRAFT", publishedAt: null };
  if (submitAction === "schedule") {
    const raw = String(formData.get("scheduleDate") ?? "");
    const publishedAt = raw ? fromZonedTime(raw, timezone) : null;
    if (!publishedAt || Number.isNaN(publishedAt.getTime())) return { error: "Pick the date and time to publish it" };
    return { status: "SCHEDULED", publishedAt };
  }
  return null;
}

function slugTaken(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const SLUG_TAKEN = "Another event already uses that URL slug. Pick a different one.";

export async function createEvent(formData: FormData): Promise<ActionResult> {
  const user = await requireOfficer();

  const parsed = parseEventForm(formData);
  if (!parsed.ok) return parsed;
  const fields = parsed.data;

  const publish = publication(formData, fields.timezone) ?? { status: "DRAFT" as const, publishedAt: null };
  if ("error" in publish) return { ok: false, error: publish.error };

  let event;
  try {
    event = await prisma.event.create({
      data: {
        ...fields,
        status: publish.status,
        publishedAt: publish.publishedAt,
        visibility: "public",
        attendanceReportingMode: fields.attendanceEnabled ? "CHECKIN_REQUIRED" : "ASSUME_REGISTERED",
      },
    });
  } catch (error) {
    if (slugTaken(error)) return { ok: false, error: SLUG_TAKEN };
    throw error;
  }

  await createAuditLog({
    actorUserId: user.id,
    actionType: "CREATE",
    entityType: "EVENT",
    entityId: event.id,
    summary: `Created event: ${event.title}`,
    after: event,
  });

  revalidatePath("/admin/events");
  if (event.status === "PUBLISHED" || event.status === "SCHEDULED") {
    revalidateEventList();
    revalidateEventDetail(event.slug);
  }
  redirect("/admin/events");
}

export async function updateEventStatus(eventId: string, status: EventStatus, publishedAt?: Date) {
  const user = await requireOfficer();

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
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Updated event status to ${status}`,
    after: data,
  });

  revalidatePath("/admin/events");
  revalidateEventList();
  revalidateEventDetail(updated.slug);
  redirect("/admin/events");
}

/**
 * Capacity raised (or made unlimited) or the fee removed: spots may have opened for
 * people on the waitlist, so the caller should reconcile.
 */
function waitlistNeedsRefill(
  before: { registrationMax: number | null; registrationFeeCents: number | null } | null,
  registrationMax: number | null,
  registrationFeeCents: number | null
) {
  if (!before) return false;
  const capacityRaised =
    before.registrationMax != null && (registrationMax === null || registrationMax > before.registrationMax);
  const madeFree = (before.registrationFeeCents ?? 0) > 0 && registrationFeeCents === null;
  return capacityRaised || madeFree;
}

export async function updateEvent(id: string, formData: FormData): Promise<ActionResult> {
  const user = await requireOfficer();
  const before = await prisma.event.findUnique({
    where: { id },
    select: { registrationMax: true, registrationFeeCents: true },
  });

  const parsed = parseEventForm(formData);
  if (!parsed.ok) return parsed;
  const fields = parsed.data;

  const publish = publication(formData, fields.timezone);
  if (publish && "error" in publish) return { ok: false, error: publish.error };

  const eventUpdateData: Prisma.EventUpdateInput = {
    ...fields,
    // Turning check-in on from the event form means people have to check in
    ...(fields.attendanceEnabled ? { attendanceReportingMode: "CHECKIN_REQUIRED" as const } : {}),
    // A draft keeps its publish date, as before
    ...(publish ? { status: publish.status, ...(publish.status === "DRAFT" ? {} : { publishedAt: publish.publishedAt }) } : {}),
  };

  let updated;
  try {
    updated = await prisma.event.update({
      where: { id },
      data: eventUpdateData,
      select: { slug: true, seriesId: true },
    });
  } catch (error) {
    if (slugTaken(error)) return { ok: false, error: SLUG_TAKEN };
    throw error;
  }

  if (waitlistNeedsRefill(before, fields.registrationMax, fields.registrationFeeCents)) {
    await reconcileEventWaitlist(id);
  }

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: id,
    summary: `Updated event details for ${fields.title}`,
    after: eventUpdateData,
  });

  revalidatePath("/admin/events");
  revalidateEventList();
  revalidateEventDetail(updated.slug);
  if (updated.seriesId) revalidateSeriesPages();
  redirect("/admin/events");
}

export async function deleteEvent(eventId: string) {
  const user = await requireOfficer();

  const deleted = await prisma.event.delete({
    where: { id: eventId },
    select: { slug: true, seriesId: true },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "DELETE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Deleted event ${eventId}`,
  });

  revalidatePath("/admin/events");
  revalidateEventList();
  revalidateEventDetail(deleted.slug);
  if (deleted.seriesId) revalidateSeriesPages();
}

export async function updateEventRegistrationConfig(eventId: string, formData: FormData): Promise<ActionResult> {
  const user = await requireOfficer();

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { timezone: true, registrationMax: true, waitlistAutoPromote: true, registrationFeeCents: true },
  });
  const timezone = event?.timezone || DEFAULT_TIMEZONE;

  const parsed = parseRegistrationConfigForm(formData, timezone);
  if (!parsed.ok) return parsed;
  const configData = parsed.data;
  const { waitlistAutoPromote, registrationFeeCents } = configData;

  const updated = await prisma.event.update({
    where: { id: eventId },
    data: configData,
    select: { slug: true },
  });

  const autoPromoteSwitchedOn = event != null && !event.waitlistAutoPromote && waitlistAutoPromote;
  const promotedUserIds =
    autoPromoteSwitchedOn || waitlistNeedsRefill(event, configData.registrationMax, registrationFeeCents)
      ? await reconcileEventWaitlist(eventId)
      : [];

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Updated registration configuration for event ${eventId}`,
    metadata: {
      updateType: "registration_config",
      promotedUserIds,
    },
    after: configData,
  });

  revalidatePath(`/admin/events/${eventId}/manage`);
  revalidateEventList();
  revalidateEventDetail(updated.slug);
  return { ok: true };
}

export async function overrideRegistrationStatus(eventId: string, userId: string, status: RegistrationStatus, reason?: string) {
  const user = await requireOfficer();

  await adminOverrideRegistration(user.id, userId, eventId, status, reason);

  const ev = await prisma.event.findUnique({ where: { id: eventId }, select: { slug: true } });
  revalidatePath(`/admin/events/${eventId}/manage`);
  revalidateEventList();
  if (ev) revalidateEventDetail(ev.slug);
}

export async function reorderWaitlist(eventId: string, orderedRegistrationIds: string[]) {
  const user = await requireOfficer();

  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < orderedRegistrationIds.length; i++) {
      await tx.eventRegistration.update({
        where: { id: orderedRegistrationIds[i] },
        data: {
          waitlistOrder: i + 1,
          // Ideally we check status is WAITLISTED, but admin reorder implies waitlist context
        },
      });
    }
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT",
    entityId: eventId,
    summary: `Reordered waitlist for event ${eventId}`,
    metadata: {
      updateType: "waitlist_reorder",
      count: orderedRegistrationIds.length,
    }
  });

  revalidatePath(`/admin/events/${eventId}/manage`);
}

export async function removeRegistration(eventId: string, userId: string) {
  const user = await requireOfficer();

  const { slug } = await adminRemoveRegistration({ eventId, userId, actorUserId: user.id });

  revalidatePath(`/admin/events/${eventId}/manage`);
  revalidateEventDetail(slug);
}

export async function updateEventAttendanceConfig(eventId: string, formData: FormData) {
  const user = await requireOfficer();

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { timezone: true } });
  const timezone = event?.timezone || DEFAULT_TIMEZONE;

  const enabled = formData.get("attendanceEnabled") === "on";
  const opensAtRaw = formData.get("attendanceOpensAt") as string;
  const closesAtRaw = formData.get("attendanceClosesAt") as string;

  await updateAttendanceConfig(
    eventId,
    {
      attendanceEnabled: enabled,
      attendanceOpensAt: opensAtRaw ? fromZonedTime(opensAtRaw, timezone) : null,
      attendanceClosesAt: closesAtRaw ? fromZonedTime(closesAtRaw, timezone) : null,
    },
    user.id
  );

  revalidatePath(`/admin/events/${eventId}/manage`);
}

export async function manualCheckIn(eventId: string, userId: string) {
  const user = await requireOfficer();

  await checkInUser(eventId, userId, "MANUAL", user.id);

  revalidatePath(`/admin/events/${eventId}/manage`);
}

export async function manualRemoveCheckIn(eventId: string, userId: string) {
  const user = await requireOfficer();

  await removeCheckIn(eventId, userId, user.id);

  revalidatePath(`/admin/events/${eventId}/manage`);
}
