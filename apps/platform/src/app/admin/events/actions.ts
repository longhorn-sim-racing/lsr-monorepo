"use server"

import { EventStatus, RegistrationStatus } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import { requireOfficer } from "@/server/auth/guards";
import {
  revalidateEventList,
  revalidateEventDetail,
  revalidatePaths,
  revalidateSeriesPages,
} from "@/server/cache/revalidate-public";
import {
  adminOverrideRegistration,
  adminRemoveRegistration,
} from "@/server/services/registration.service";
import { checkInUser, removeCheckIn } from "@/server/services/attendance.service";
import * as events from "@/server/services/event.service";
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
    if (events.isSlugTaken(error)) return { ok: false, error: events.SLUG_TAKEN };
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

  const result = await events.updateEventStatus({ eventId, status, publishedAt }, { userId: user.id });

  revalidatePaths(result.revalidate);
  redirect("/admin/events");
}

export async function updateEvent(id: string, formData: FormData): Promise<ActionResult> {
  const user = await requireOfficer();

  const parsed = parseEventForm(formData);
  if (!parsed.ok) return parsed;
  const fields = parsed.data;

  const publish = publication(formData, fields.timezone);
  if (publish && "error" in publish) return { ok: false, error: publish.error };

  const result = await events.updateEventDetails({ eventId: id, details: fields, publish }, { userId: user.id });
  if (!result.ok) return result;

  revalidatePaths(result.revalidate);
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

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { timezone: true } });
  const timezone = event?.timezone || DEFAULT_TIMEZONE;

  const parsed = parseRegistrationConfigForm(formData, timezone);
  if (!parsed.ok) return parsed;

  const result = await events.updateEventRegistration({ eventId, settings: parsed.data }, { userId: user.id });

  revalidatePaths(result.revalidate);
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

  const result = await events.updateEventAttendance(
    {
      eventId,
      attendanceEnabled: enabled,
      attendanceOpensAt: opensAtRaw ? fromZonedTime(opensAtRaw, timezone) : null,
      attendanceClosesAt: closesAtRaw ? fromZonedTime(closesAtRaw, timezone) : null,
    },
    { userId: user.id }
  );

  revalidatePaths(result.revalidate);
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
